import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { foreignScripts, reconcileLanguages } from '../asr/languages.ts';
import { effectiveAsrLanguage } from '../asr/preferences.ts';
import { assignSpeaker, offsetTurns, speakerCount } from '../asr/speakers.ts';
import type { AsrBackend, SpeakerTurn } from '../asr/types.ts';
import type { Paths } from '../config/paths.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import { transaction } from '../database/db.ts';
import {
  countWords,
  PartRepository,
  type PartRow,
  SessionRepository,
  SpeakerTurnRepository,
  TranscriptRepository,
  VadSegmentRepository,
} from '../database/repository.ts';
import type { LlmBackend } from '../llm/ollama.ts';
import { EMPTY_SUMMARY } from '../llm/schema.ts';
import type { Logger } from '../logging/logger.ts';
import { Outbox } from '../telegram/outbox.ts';
import {
  enqueueSessionAudio,
  enqueueSessionDelivery,
  enqueueSessionReport,
  enqueueSessionTranscript,
} from './delivery.ts';
import type { Job, JobQueue } from './queue.ts';

/**
 * Job handlers for the post-silence pipeline:
 *
 *   deliver_audio ────────────────┐
 *   asr -> deliver_transcript     ├─> Telegram outbox
 *       └-> summarize -> report   ┘
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
    case 'deliver_audio':
      await handleDeliverAudio(deps, job);
      return;
    case 'asr':
      await handleAsr(deps, job);
      return;
    case 'deliver_transcript':
      await handleDeliverTranscript(deps, job);
      return;
    case 'summarize':
      await handleSummarize(deps, job);
      return;
    case 'deliver_report':
      await handleDeliverReport(deps, job);
      return;
    case 'deliver':
      await handleDeliver(deps, job);
      return;
    default:
      throw new Error(`no handler for job kind ${job.kind}`);
  }
}

async function handleDeliverAudio(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const plan = await enqueueSessionAudio(deps.db, {
    sessionId,
    config: deps.config,
    paths: deps.paths,
  });
  deps.logger.info('audio delivery enqueued', {
    sessionId,
    audio: plan.audioRows,
    oversizeParts: plan.oversizeParts.length,
  });
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

/**
 * Splits the session into stretches by voice, best-effort.
 *
 * Never fatal: a transcript without speaker labels is the product working, a
 * failed session is not. Each part is diarized on its own and speakers are
 * renumbered into a session-wide space, because the clustering never compared
 * voices across parts and pretending otherwise would merge strangers.
 */
async function runDiarization(
  deps: PipelineDeps,
  sessionId: string,
  parts: readonly PartRow[],
): Promise<readonly SpeakerTurn[]> {
  if (!deps.config.diarization.enabled) return [];

  const collected: SpeakerTurn[] = [];
  let offsetMs = 0;
  let speakerBase = 0;

  for (const part of parts) {
    try {
      const turns = await deps.asr.diarize({
        audioPath: part.path,
        maxSpeakers: deps.config.diarization.maxSpeakers,
        minTurnSeconds: deps.config.diarization.minTurnSeconds,
      });
      collected.push(...offsetTurns(turns, offsetMs, speakerBase));
      speakerBase += speakerCount(turns);
    } catch (error) {
      deps.logger.warn('diarization failed for a part; continuing without speakers', {
        sessionId,
        partId: part.part_id,
        error: (error as Error).message,
      });
    }
    offsetMs += part.duration_ms ?? 0;
  }

  if (collected.length === 0) return [];

  new SpeakerTurnRepository(deps.db).replaceForSession(sessionId, collected);
  deps.logger.info('diarization stored', {
    sessionId,
    turns: collected.length,
    speakers: speakerCount(collected),
  });
  return collected;
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

  if (replayStoredTranscript(deps, sessions, sessionId)) {
    deps.logger.info('existing transcript replayed into downstream jobs', { sessionId });
    return;
  }

  await runFinalVadPass(deps, sessionId, finalized);
  const turns = await runDiarization(deps, sessionId, finalized);

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
  const forcedLanguage = forcedLanguageOf(job, deps);

  for (const part of finalized) {
    const result = await deps.asr.transcribe({
      audioPath: part.path,
      requestId: randomUUID(),
      ...(forcedLanguage === null ? {} : { languageHints: [forcedLanguage] }),
      ...(deps.config.asr.context.length > 0 ? { context: deps.config.asr.context } : {}),
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
  if (rejectInsufficientTranscript(deps, sessions, sessionId, words, finalized.length)) return;

  // The model reports the language it settled on, which is incomplete on
  // genuinely mixed speech: a real Thai-English conversation came back as
  // ["th"] with more Latin characters in it than Thai.
  const declaredLanguages = [...languages];
  const foreign = foreignScripts(declaredLanguages, text);
  const { languages: reconciled, added } = reconcileLanguages(declaredLanguages, text);
  if (added.length > 0) {
    deps.logger.info('added languages the text contains but the model did not report', {
      sessionId,
      declared: declaredLanguages,
      added,
    });
  }

  // Drift, not code-switching: Chinese characters in a Thai transcript mean
  // the model wandered. Reported, never edited out — silently rewriting a
  // transcript would be worse than an odd one.
  if (foreign.length > 0) {
    deps.logger.warn('transcript contains scripts no detected language accounts for', {
      sessionId,
      scripts: foreign,
    });
  }

  transcripts.append(
    {
      sessionId,
      engine,
      model,
      languages: reconciled,
      forcedLanguage,
      text,
      segments: segments.map((segment) => ({
        ...segment,
        speaker: assignSpeaker(segment.startMs, segment.endMs, turns),
      })),
    },
    () => {
      sessions.setLanguages(sessionId, reconciled);
      enqueuePostAsrJobs(deps, sessionId);
    },
  );
  deps.logger.info('transcript stored', {
    sessionId,
    words,
    languages: reconciled,
    forcedLanguage,
    speakers: speakerCount(turns),
  });
}

function forcedLanguageOf(job: Job, deps: PipelineDeps): string | null {
  if (!Object.hasOwn(job.payload, 'forcedLanguage')) {
    return effectiveAsrLanguage(deps.db, deps.config.asr.languageHints);
  }
  const value = job.payload['forcedLanguage'];
  if (value === null || typeof value === 'string') return value;
  throw new Error(`job ${job.jobId} has an invalid forcedLanguage`);
}

function rejectInsufficientTranscript(
  deps: PipelineDeps,
  sessions: SessionRepository,
  sessionId: string,
  words: number,
  finalizedParts: number,
): boolean {
  if (words >= deps.config.sessionizer.minTranscriptWords) return false;

  const reason = words === 0 ? 'asr_empty' : 'insufficient_words';
  transaction(deps.db, () => {
    sessions.reject(sessionId, reason, 0, finalizedParts);
    new Outbox(deps.db).enqueue({
      deliveryPartId: `session-status:asr-rejected:${sessionId}`,
      kind: 'status',
      sessionId,
      ordinal: 15,
      payload: {
        type: 'text',
        text: 'ℹ️ Аудио сохранено, но в расшифровке слишком мало слов — транскрипт и отчёт не отправляю.',
      },
    });
  });
  deps.logger.info('session rejected after ASR', { sessionId, words });
  return true;
}

function replayStoredTranscript(
  deps: PipelineDeps,
  sessions: SessionRepository,
  sessionId: string,
): boolean {
  const existing = deps.db
    .prepare(
      `SELECT languages FROM transcript_revisions
        WHERE session_id = ? AND is_current = 1`,
    )
    .get(sessionId) as { languages: string } | undefined;
  if (existing === undefined) return false;

  const languages = JSON.parse(existing.languages) as string[];
  transaction(deps.db, () => {
    sessions.setLanguages(sessionId, languages);
    enqueuePostAsrJobs(deps, sessionId);
  });
  return true;
}

/** Makes transcript delivery and summarization independently replayable. */
function enqueuePostAsrJobs(deps: PipelineDeps, sessionId: string): void {
  deps.jobs.enqueue({
    kind: 'deliver_transcript',
    idempotencyKey: `deliver-transcript:${sessionId}`,
    payload: { sessionId },
  });
  deps.jobs.enqueue({
    kind: 'summarize',
    idempotencyKey: `summarize:${sessionId}`,
    payload: { sessionId },
  });
}

async function handleDeliverTranscript(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const rows = await enqueueSessionTranscript(deps.db, {
    sessionId,
    config: deps.config,
    paths: deps.paths,
  });
  deps.logger.info('transcript delivery enqueued', { sessionId, transcript: rows });
}

async function handleSummarize(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const transcripts = new TranscriptRepository(deps.db);
  const sessions = new SessionRepository(deps.db);

  const current = transcripts.current(sessionId);
  if (current === undefined) throw new Error(`session ${sessionId} has no transcript`);
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown session ${sessionId}`);

  const existing = deps.db
    .prepare(
      `SELECT payload FROM summaries
        WHERE session_id = ? AND revision_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId, current.revision_id) as { payload: string } | undefined;
  if (existing !== undefined) {
    deps.jobs.enqueue({
      kind: 'deliver_report',
      idempotencyKey: `deliver-report:${sessionId}`,
      payload: { sessionId },
    });
    return;
  }

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

  transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO summaries
           (summary_id, session_id, revision_id, engine, model, payload, created_at)
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
      kind: 'deliver_report',
      idempotencyKey: `deliver-report:${sessionId}`,
      payload: { sessionId },
    });
  });
}

async function handleDeliverReport(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const row = deps.db
    .prepare(
      'SELECT payload FROM summaries WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get(sessionId) as { payload: string } | undefined;
  const summary = row === undefined ? EMPTY_SUMMARY : JSON.parse(row.payload);
  const rows = await enqueueSessionReport(deps.db, {
    sessionId,
    summary,
    config: deps.config,
    paths: deps.paths,
  });
  deps.logger.info('report delivery enqueued', { sessionId, report: rows });
}

async function handleDeliver(deps: PipelineDeps, job: Job): Promise<void> {
  const sessionId = sessionIdOf(job);
  const row = deps.db
    .prepare(
      'SELECT payload FROM summaries WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
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

  if (
    !outbox.allDelivered(sessionId, 'audio') ||
    !outbox.allDelivered(sessionId, 'transcript') ||
    !outbox.allDelivered(sessionId, 'report')
  ) {
    return;
  }

  sessions.setState(sessionId, 'DONE');
  logger.info('session fully delivered', { sessionId });
}

/** Marks the audio parts confirmed by a successful `audio` outbox send. */
export function markAudioDelivered(db: DatabaseSync, partId: string): void {
  const directId = `audio:${partId}`;
  const splitPrefix = `${directId}:split`;
  const rows = db
    .prepare(
      `SELECT count(*) AS total,
              SUM(CASE WHEN state = 'sent' THEN 1 ELSE 0 END) AS sent
         FROM telegram_outbox
        WHERE kind = 'audio'
          AND (delivery_part_id = ? OR substr(delivery_part_id, 1, ?) = ?)`,
    )
    .get(directId, splitPrefix.length, splitPrefix) as { total: number; sent: number | null };
  if (rows.total > 0 && rows.sent === rows.total) {
    new PartRepository(db).markDelivered(partId);
  }
}
