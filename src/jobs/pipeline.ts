import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AsrBackend } from '../asr/types.ts';
import type { Paths } from '../config/paths.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import {
  countWords,
  PartRepository,
  type PartRow,
  SessionRepository,
  TranscriptRepository,
  VadSegmentRepository,
} from '../database/repository.ts';
import type { LlmBackend } from '../llm/ollama.ts';
import { EMPTY_SUMMARY } from '../llm/schema.ts';
import type { Logger } from '../logging/logger.ts';
import { Outbox } from '../telegram/outbox.ts';
import { enqueueSessionDelivery } from './delivery.ts';
import type { Job, JobQueue } from './queue.ts';

/**
 * Job handlers for the post-silence pipeline:
 *
 *   asr  ->  summarize  ->  deliver
 *
 * Each stage is a separate job so that a failing LLM cannot cost the user
 * their transcript, and a failing Telegram cannot cost them either.
 */

export interface PipelineDeps {
  readonly db: DatabaseSync;
  readonly config: OpenMurmurConfig;
  readonly paths: Paths;
  readonly asr: AsrBackend;
  readonly llm: LlmBackend;
  readonly jobs: JobQueue;
  readonly logger: Logger;
}

export async function handleJob(deps: PipelineDeps, job: Job): Promise<void> {
  switch (job.kind) {
    case 'asr':
      await handleAsr(deps, job);
      return;
    case 'summarize':
      await handleSummarize(deps, job);
      return;
    case 'deliver':
      await handleDeliver(deps, job);
      return;
    default:
      throw new Error(`no handler for job kind ${job.kind}`);
  }
}

function sessionIdOf(job: Job): string {
  const value = job.payload['sessionId'];
  if (typeof value !== 'string') throw new Error(`job ${job.jobId} has no sessionId`);
  return value;
}

/**
 * Step 6 of the post-silence pipeline: a final VAD pass over the closed files.
 *
 * The streaming pass that drove the sessionizer saw 32 ms at a time and could
 * not look ahead, so its boundaries were provisional. This pass sees each
 * complete part and stores the authoritative segments, offset so their times
 * refer to the whole session rather than to one part.
 *
 * It is best-effort by design. A VAD failure must not cost the user their
 * transcript, so it is logged and the pipeline continues — the segments are a
 * refinement, not a prerequisite. Nothing here decides what to delete.
 */
async function runFinalVadPass(
  deps: PipelineDeps,
  sessionId: string,
  parts: readonly PartRow[],
): Promise<void> {
  const repository = new VadSegmentRepository(deps.db);
  const collected: { startMs: number; endMs: number; meanProbability: number }[] = [];
  let offsetMs = 0;

  for (const part of parts) {
    try {
      const segments = await deps.asr.vadSegments({
        audioPath: part.path,
        threshold: deps.config.sessionizer.vadThreshold,
      });
      for (const segment of segments) {
        collected.push({
          startMs: segment.startMs + offsetMs,
          endMs: segment.endMs + offsetMs,
          meanProbability: segment.meanProbability,
        });
      }
    } catch (error) {
      deps.logger.warn('final VAD pass failed for a part; continuing without it', {
        sessionId,
        partId: part.part_id,
        error: (error as Error).message,
      });
    }
    offsetMs += part.duration_ms ?? 0;
  }

  if (collected.length === 0) return;

  repository.replaceForSession(sessionId, collected);
  deps.logger.info('final VAD pass stored', {
    sessionId,
    segments: collected.length,
    speechMs: repository.totalSpeechMs(sessionId),
  });
}

async function handleAsr(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const sessions = new SessionRepository(deps.db);
  const parts = new PartRepository(deps.db);
  const transcripts = new TranscriptRepository(deps.db);

  const finalized = parts.listForSession(sessionId).filter((p) => p.finalized === 1);
  if (finalized.length === 0) {
    throw new Error(`session ${sessionId} has no finalized audio parts`);
  }

  await runFinalVadPass(deps, sessionId, finalized);

  // Parts are transcribed in order and concatenated. Timestamps are offset by
  // the cumulative duration so segment times refer to the whole session.
  const texts: string[] = [];
  const languages = new Set<string>();
  const segments: {
    startMs: number | null;
    endMs: number | null;
    timestampSource: 'aligner' | 'vad' | 'none';
    language: string | null;
    text: string;
  }[] = [];

  let offsetMs = 0;
  let engine = deps.asr.name;
  let model = 'unknown';

  for (const part of finalized) {
    const result = await deps.asr.transcribe({
      audioPath: part.path,
      requestId: randomUUID(),
      ...(deps.config.asr.languageHints.length > 0
        ? { languageHints: deps.config.asr.languageHints }
        : {}),
    });
    engine = result.engine;
    model = result.model;
    for (const language of result.languages) languages.add(language);
    if (result.text.trim().length > 0) texts.push(result.text.trim());
    for (const segment of result.segments) {
      segments.push({
        startMs: segment.startMs === null ? null : segment.startMs + offsetMs,
        endMs: segment.endMs === null ? null : segment.endMs + offsetMs,
        timestampSource: segment.timestampSource,
        language: segment.language,
        text: segment.text,
      });
    }
    offsetMs += part.duration_ms ?? 0;
  }

  const text = texts.join('\n\n');
  const words = countWords(text);

  // Second rejection gate: enough speech by duration, but nothing meaningful
  // was said. Rejecting here rather than sending keeps the chat usable.
  if (words < deps.config.sessionizer.minTranscriptWords) {
    sessions.reject(
      sessionId,
      words === 0 ? 'asr_empty' : 'insufficient_words',
      0,
      finalized.length,
    );
    deps.logger.info('session rejected after ASR', { sessionId, words });
    return;
  }

  transcripts.append({
    sessionId,
    engine,
    model,
    languages: [...languages],
    text,
    segments,
  });
  sessions.setLanguages(sessionId, [...languages]);

  deps.jobs.enqueue({
    kind: 'summarize',
    idempotencyKey: `summarize:${sessionId}`,
    payload: { sessionId },
  });
  deps.logger.info('transcript stored', { sessionId, words, languages: [...languages] });
}

async function handleSummarize(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const transcripts = new TranscriptRepository(deps.db);
  const sessions = new SessionRepository(deps.db);

  const current = transcripts.current(sessionId);
  if (current === undefined) throw new Error(`session ${sessionId} has no transcript`);
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown session ${sessionId}`);

  const segments = transcripts.segments(current.revision_id).map((s) => s.text);
  let summary = EMPTY_SUMMARY;
  try {
    summary = await deps.llm.summarize({
      transcript: current.text,
      segments,
      languages: session.languages === null ? [] : (JSON.parse(session.languages) as string[]),
      durationMs: session.duration_ms ?? 0,
    });
  } catch (error) {
    // A missing or broken LLM degrades the report, never the delivery. The
    // audio and transcript still reach the user.
    deps.logger.warn('summary unavailable, delivering without it', {
      sessionId,
      error: (error as Error).message,
    });
  }

  deps.db
    .prepare(
      `INSERT INTO summaries (summary_id, session_id, revision_id, engine, model, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      sessionId,
      current.revision_id,
      deps.llm.name,
      deps.config.llm.model,
      JSON.stringify(summary),
      new Date().toISOString(),
    );

  deps.jobs.enqueue({
    kind: 'deliver',
    idempotencyKey: `deliver:${sessionId}`,
    payload: { sessionId },
  });
}

async function handleDeliver(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const row = deps.db
    .prepare('SELECT payload FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(sessionId) as { payload: string } | undefined;

  const summary = row === undefined ? EMPTY_SUMMARY : JSON.parse(row.payload);
  const plan = await enqueueSessionDelivery(deps.db, {
    sessionId,
    summary,
    config: deps.config,
    paths: deps.paths,
  });

  deps.logger.info('delivery enqueued', {
    sessionId,
    audio: plan.audioRows,
    transcript: plan.transcriptRows,
    report: plan.reportRows,
    oversizeParts: plan.oversizeParts.length,
  });
}

/**
 * Called after each successful Telegram send. Once every row for a session has
 * gone out, the session is DONE — which is exactly the fact retention requires
 * before it will consider deleting the audio.
 */
export function reconcileSessionDelivery(
  db: DatabaseSync,
  sessionId: string,
  logger: Logger,
): void {
  const outbox = new Outbox(db);
  const sessions = new SessionRepository(db);

  const pending = db
    .prepare(
      `SELECT count(*) AS c FROM telegram_outbox
        WHERE session_id = ? AND state IN ('pending','sending')`,
    )
    .get(sessionId) as { c: number };
  if (pending.c > 0) return;

  if (!outbox.allDelivered(sessionId, 'audio') || !outbox.allDelivered(sessionId, 'transcript')) {
    return;
  }

  sessions.setState(sessionId, 'DONE');
  logger.info('session fully delivered', { sessionId });
}

/** Marks the audio parts confirmed by a successful `audio` outbox send. */
export function markAudioDelivered(db: DatabaseSync, partId: string): void {
  new PartRepository(db).markDelivered(partId);
}
