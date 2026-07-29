import { spawn } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Paths } from '../config/paths.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import { PartRepository, SessionRepository, TranscriptRepository } from '../database/repository.ts';
import type { StructuredSummary } from '../llm/schema.ts';
import { renderTranscriptMessages } from '../telegram/format.ts';
import { Outbox } from '../telegram/outbox.ts';
import { renderSessionReport } from '../telegram/report.ts';

/**
 * Turns a finished, transcribed session into an ordered set of outbox rows.
 *
 * Order matters and is encoded in `ordinal`:
 *   0  original FLAC parts   (the source audio, never a re-encode)
 *   10 transcript messages
 *   20 structured report
 *
 * Every row has a stable `delivery_part_id`, so running this twice for the
 * same session — after a crash, or a retried job — enqueues nothing new.
 */

export interface EnqueueDeliveryInput {
  readonly sessionId: string;
  readonly summary: StructuredSummary;
  readonly config: OpenMurmurConfig;
  readonly paths: Paths;
}

export interface DeliveryPlan {
  readonly audioRows: number;
  readonly transcriptRows: number;
  readonly reportRows: number;
  readonly oversizeParts: readonly string[];
}

export async function enqueueSessionDelivery(
  db: DatabaseSync,
  input: EnqueueDeliveryInput,
): Promise<DeliveryPlan> {
  const sessions = new SessionRepository(db);
  const parts = new PartRepository(db);
  const transcripts = new TranscriptRepository(db);
  const outbox = new Outbox(db);

  const session = sessions.get(input.sessionId);
  if (session === undefined) throw new Error(`unknown session ${input.sessionId}`);
  const transcript = transcripts.current(input.sessionId);
  if (transcript === undefined) throw new Error(`session ${input.sessionId} has no transcript`);

  const partRows = parts.listForSession(input.sessionId).filter((p) => p.finalized === 1);
  const oversizeParts: string[] = [];
  let audioRows = 0;

  for (const part of partRows) {
    // The recorded size is a record of the past; the *file* is what gets
    // uploaded, so its live size is what the limit is checked against.
    let bytes: number;
    try {
      bytes = (await stat(part.path)).size;
    } catch {
      continue; // already retained away; the transcript still goes out
    }

    if (bytes <= input.config.telegram.maxOutgoingBytes) {
      const enqueued = outbox.enqueue({
        deliveryPartId: `audio:${part.part_id}`,
        kind: 'audio',
        sessionId: input.sessionId,
        ordinal: 0,
        payload: {
          type: 'document',
          path: part.path,
          filename: basename(part.path),
          partId: part.part_id,
        },
      });
      if (enqueued) audioRows += 1;
      continue;
    }

    // Over the limit: split losslessly rather than re-encoding to a lossy
    // format. The user asked for their source audio, so they get FLAC.
    oversizeParts.push(part.part_id);
    const chunks = await splitFlacLossless(
      input.config.audio.ffmpegPath,
      part.path,
      input.paths.tempDir,
      input.config.telegram.maxOutgoingBytes,
      part.duration_ms ?? 0,
    );
    chunks.forEach((chunk, index) => {
      const enqueued = outbox.enqueue({
        deliveryPartId: `audio:${part.part_id}:split${index}`,
        kind: 'audio',
        sessionId: input.sessionId,
        ordinal: 0,
        payload: {
          type: 'document',
          path: chunk,
          filename: basename(chunk),
          partId: part.part_id,
        },
      });
      if (enqueued) audioRows += 1;
    });
  }

  // --- Transcript --------------------------------------------------------
  const messages = renderTranscriptMessages(
    input.sessionId,
    transcript.text,
    input.config.telegram.transcriptInlineLimit,
  );
  let transcriptRows = 0;
  for (const message of messages) {
    const enqueued = outbox.enqueue({
      deliveryPartId: `transcript:${input.sessionId}:${message.partNumber}`,
      kind: 'transcript',
      sessionId: input.sessionId,
      ordinal: 10,
      payload: { type: 'text', text: message.text, parseMode: 'HTML' },
    });
    if (enqueued) transcriptRows += 1;
  }

  // A transcript that needed splitting also travels as one .md file, so the
  // user has a single searchable artefact rather than nine chat messages.
  if (messages.length > 1) {
    const mdPath = join(input.paths.transcriptsDir, `${input.sessionId}.md`);
    await writeFile(
      mdPath,
      renderTranscriptMarkdown(input.sessionId, session.started_at, transcript.text),
      {
        mode: 0o600,
      },
    );
    const enqueued = outbox.enqueue({
      deliveryPartId: `transcript-md:${input.sessionId}`,
      kind: 'transcript',
      sessionId: input.sessionId,
      ordinal: 11,
      payload: { type: 'document', path: mdPath, filename: `${input.sessionId}.md` },
    });
    if (enqueued) transcriptRows += 1;
  }

  // --- Structured report --------------------------------------------------
  const languages = session.languages === null ? [] : (JSON.parse(session.languages) as string[]);
  const report = renderSessionReport({
    sessionId: input.sessionId,
    startedWallMs: Date.parse(session.started_at),
    endedWallMs: session.ended_at === null ? Date.now() : Date.parse(session.ended_at),
    durationMs: session.duration_ms ?? 0,
    speechMs: session.speech_ms,
    languages,
    partCount: session.part_count,
    summary: input.summary,
  });
  const reportRows = outbox.enqueue({
    deliveryPartId: `report:${input.sessionId}`,
    kind: 'report',
    sessionId: input.sessionId,
    ordinal: 20,
    payload: { type: 'text', text: report, parseMode: 'HTML' },
  })
    ? 1
    : 0;

  sessions.setState(input.sessionId, 'DELIVERING');
  return { audioRows, transcriptRows, reportRows, oversizeParts };
}

export function renderTranscriptMarkdown(
  sessionId: string,
  startedAt: string,
  text: string,
): string {
  return [
    '# OpenMurmur transcript',
    '',
    `- Session: \`${sessionId}\``,
    `- Started: ${startedAt}`,
    '',
    '---',
    '',
    text,
    '',
  ].join('\n');
}

/**
 * Splits a FLAC file into time-based chunks that each fit the upload limit.
 *
 * `-c copy` keeps the original FLAC frames untouched — no decode, no re-encode,
 * no quality loss. The chunk duration is derived from the file's own bitrate
 * with a safety margin, because FLAC bitrate varies with content and a chunk
 * that lands one byte over the limit is a failed delivery.
 */
export async function splitFlacLossless(
  ffmpegPath: string,
  sourcePath: string,
  tempDir: string,
  maxBytes: number,
  durationMs: number,
): Promise<string[]> {
  const info = await stat(sourcePath);
  if (info.size <= maxBytes) return [sourcePath];

  const durationSeconds = durationMs > 0 ? durationMs / 1000 : 1;
  const bytesPerSecond = info.size / durationSeconds;
  // 85% of the limit absorbs per-chunk header overhead and bitrate variation.
  const chunkSeconds = Math.max(30, Math.floor((maxBytes * 0.85) / bytesPerSecond));

  const stem = basename(sourcePath).replace(/\.flac$/i, '');
  const pattern = join(tempDir, `${stem}.split%03d.flac`);

  await runFfmpeg(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    sourcePath,
    '-c',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    String(chunkSeconds),
    '-reset_timestamps',
    '1',
    '-y',
    pattern,
  ]);

  const produced: string[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const candidate = join(tempDir, `${stem}.split${String(index).padStart(3, '0')}.flac`);
    try {
      await stat(candidate);
      produced.push(candidate);
    } catch {
      break;
    }
  }
  return produced.length > 0 ? produced : [sourcePath];
}

function runFfmpeg(ffmpegPath: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`));
    });
  });
}
