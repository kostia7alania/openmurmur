import { spawn } from 'node:child_process';
import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  effectiveAsrLanguage,
  languageListLabel,
  recognitionModeLabel,
} from '../asr/preferences.ts';
import type { Paths } from '../config/paths.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import { transaction } from '../database/db.ts';
import { PartRepository, SessionRepository, TranscriptRepository } from '../database/repository.ts';
import { boundClaimEvidence, type StructuredSummary } from '../llm/schema.ts';
import { formatTimedTranscript, renderTimedTranscriptMessages } from '../telegram/format.ts';
import { Outbox } from '../telegram/outbox.ts';
import {
  liveCaptureProvenance,
  renderProvenanceHtml,
  renderProvenanceMarkdown,
} from '../telegram/provenance.ts';
import {
  renderSessionReport,
  renderSessionReportMarkdown,
  renderSessionSummaryPreview,
} from '../telegram/report.ts';
import { asrSettingsKeyboard } from '../telegram/settings.ts';
import { writeTextAtomically } from '../util/atomic-file.ts';

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
  readonly config: OpenMurmurConfig;
  readonly paths: Paths;
}

export interface EnqueueReportInput extends EnqueueDeliveryInput {
  readonly summary: StructuredSummary;
  /** Exact immutable transcript revision from the summaries row. */
  readonly summaryRevisionId?: string | undefined;
}

export interface DeliveryPlan {
  readonly audioRows: number;
  readonly transcriptRows: number;
  readonly reportRows: number;
  readonly oversizeParts: readonly string[];
}

export async function enqueueSessionDelivery(
  db: DatabaseSync,
  input: EnqueueReportInput,
): Promise<DeliveryPlan> {
  const audio = await enqueueSessionAudio(db, input);
  const transcriptRows = await enqueueSessionTranscript(db, input);
  const reportRows = await enqueueSessionReport(db, input);
  return {
    audioRows: audio.audioRows,
    transcriptRows,
    reportRows,
    oversizeParts: audio.oversizeParts,
  };
}

export async function enqueueSessionAudio(
  db: DatabaseSync,
  input: EnqueueDeliveryInput,
): Promise<Pick<DeliveryPlan, 'audioRows' | 'oversizeParts'>> {
  const parts = new PartRepository(db);
  const outbox = new Outbox(db);

  const session = new SessionRepository(db).get(input.sessionId);
  if (session === undefined) {
    throw new Error(`unknown session ${input.sessionId}`);
  }
  const provenanceCaption = renderProvenanceHtml(liveCaptureProvenance(session));

  const partRows = parts.listForSession(input.sessionId).filter((p) => p.finalized === 1);
  const oversizeParts: string[] = [];
  let audioRows = 0;
  const availableParts: { part: (typeof partRows)[number]; bytes: number }[] = [];

  for (const part of partRows) {
    // A retention proof is the only valid reason for a finalized source to be
    // absent. Preflight every part before publishing any row, otherwise the
    // outbox could send the first half of a multi-part manifest while this job
    // later discovers that the second source disappeared.
    if (part.deleted_at !== null) continue;

    // The recorded size is a record of the past; the *file* is what gets
    // uploaded, so its live size is what the limit is checked against.
    let bytes: number;
    try {
      const info = await stat(part.path);
      if (!info.isFile()) throw new Error('path is not a regular file');
      bytes = info.size;
    } catch (error) {
      throw new Error(`finalized audio part ${part.part_id} is unavailable: ${part.path}`, {
        cause: error,
      });
    }
    availableParts.push({ part, bytes });
  }

  for (const { part, bytes } of availableParts) {
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
          caption: provenanceCaption,
        },
      });
      if (enqueued) audioRows += 1;
      continue;
    }

    // Over the limit: split losslessly rather than re-encoding to a lossy
    // format. The user asked for their source audio, so they get FLAC.
    oversizeParts.push(part.part_id);
    if (await replayUsesExistingAudioDeliveries(db, part.part_id)) {
      continue;
    }
    const chunks = await splitFlacLossless(
      input.config.audio.ffmpegPath,
      part.path,
      input.paths.tempDir,
      input.config.telegram.maxOutgoingBytes,
      part.duration_ms ?? 0,
    );
    const terminalConflictPaths: string[] = [];
    transaction(db, () => {
      for (const [index, chunk] of chunks.entries()) {
        const deliveryPartId = `audio:${part.part_id}:split${index}`;
        const enqueued = outbox.enqueue({
          deliveryPartId,
          kind: 'audio',
          sessionId: input.sessionId,
          ordinal: 0,
          payload: {
            type: 'document',
            path: chunk,
            filename: basename(chunk),
            partId: part.part_id,
            deleteAfterSend: true,
            caption: provenanceCaption,
          },
        });
        if (enqueued) {
          audioRows += 1;
          continue;
        }

        const state = outbox.stateOf(deliveryPartId);
        if (state === 'sent' || state === 'dead') {
          terminalConflictPaths.push(chunk);
          continue;
        }
        throw new Error(
          `audio delivery ${deliveryPartId} appeared while its split manifest was being published`,
        );
      }
    });
    // Filesystem work must not run inside the transaction. A terminal conflict
    // has no live owner, so its recreated deterministic artifact is now stale.
    for (const path of terminalConflictPaths) {
      await rm(path, { force: true });
    }
  }

  return { audioRows, oversizeParts };
}

type ExistingDeliveryState = 'pending' | 'sending' | 'sent' | 'failed' | 'dead';

interface ExistingAudioDelivery {
  readonly delivery_part_id: string;
  readonly state: ExistingDeliveryState;
  readonly payload: string;
}

/**
 * A retried delivery job must not replace deterministic split paths already
 * referenced by the outbox. Live split rows own those files until Telegram
 * reaches a terminal result; terminal split rows make replay a no-op without
 * recreating artifacts that may already have been cleaned up.
 *
 * The direct id is checked separately. It can exist when maxOutgoingBytes was
 * lowered after the source row was queued. Silently accepting a live direct row
 * here would let it fail the new size check and permanently block completion,
 * while creating split rows beside it would leave that dead row in the same
 * session manifest. Refuse the ambiguous migration explicitly instead.
 */
async function replayUsesExistingAudioDeliveries(
  db: DatabaseSync,
  partId: string,
): Promise<boolean> {
  const directId = `audio:${partId}`;
  const splitPrefix = `${directId}:split`;
  const rows = db
    .prepare(
      `SELECT delivery_part_id, state, payload
         FROM telegram_outbox
        WHERE kind = 'audio'
          AND (delivery_part_id = ? OR substr(delivery_part_id, 1, ?) = ?)`,
    )
    .all(directId, splitPrefix.length, splitPrefix) as unknown as ExistingAudioDelivery[];
  if (rows.length === 0) return false;

  for (const row of rows) {
    if (row.delivery_part_id === directId) {
      if (row.state === 'sent' || row.state === 'dead') continue;
      if (row.state === 'pending' || row.state === 'sending') {
        throw new Error(
          `unsplit audio delivery ${directId} is ${row.state} but the source now exceeds the current upload limit; refusing to publish a second manifest`,
        );
      }
      throw new Error(`unsplit audio delivery ${directId} has unsupported state ${row.state}`);
    }

    if (row.state === 'sent' || row.state === 'dead') continue;
    if (row.state !== 'pending' && row.state !== 'sending') {
      throw new Error(
        `audio delivery ${row.delivery_part_id} has unsupported replay state ${row.state}`,
      );
    }

    const path = ownedAudioPath(row, partId);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error('path is not a regular file');
    } catch (error) {
      throw new Error(
        `audio delivery ${row.delivery_part_id} is ${row.state} but its owned artifact is unavailable: ${path}`,
        { cause: error },
      );
    }
  }
  return true;
}

function ownedAudioPath(row: ExistingAudioDelivery, partId: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch (error) {
    throw new Error(`audio delivery ${row.delivery_part_id} has invalid payload JSON`, {
      cause: error,
    });
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`audio delivery ${row.delivery_part_id} has a non-object payload`);
  }
  const record = payload as Record<string, unknown>;
  if (
    record['type'] !== 'document' ||
    typeof record['path'] !== 'string' ||
    record['partId'] !== partId
  ) {
    throw new Error(`audio delivery ${row.delivery_part_id} does not own a valid part artifact`);
  }
  return record['path'];
}

export async function enqueueSessionTranscript(
  db: DatabaseSync,
  input: EnqueueDeliveryInput,
): Promise<number> {
  const sessions = new SessionRepository(db);
  const transcripts = new TranscriptRepository(db);
  const outbox = new Outbox(db);
  const session = sessions.get(input.sessionId);
  if (session === undefined) throw new Error(`unknown session ${input.sessionId}`);
  const transcript = transcripts.current(input.sessionId);
  if (transcript === undefined) throw new Error(`session ${input.sessionId} has no transcript`);
  const provenance = liveCaptureProvenance(session);
  const settingsKeyboard = input.config.telegram.receiveUpdates
    ? asrSettingsKeyboard(effectiveAsrLanguage(db, input.config.asr.languageHints), 'transcript')
    : undefined;

  // Timestamped blocks, not one wall of text. The segments are already stored
  // with their timings; a recorded session is the *main* output and was the
  // only path still sending the flat blob, while audio sent to the bot got the
  // readable form. `renderTimedTranscriptMessages` falls back to the flat text
  // when no segment carries a timestamp, which is what Thai gets when the
  // aligner cannot run.
  const messages = renderTimedTranscriptMessages(
    input.sessionId,
    transcripts.segments(transcript.revision_id).map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speaker: segment.speaker ?? null,
    })),
    transcript.text,
    input.config.telegram.transcriptInlineLimit,
    renderProvenanceHtml(provenance),
    {
      languages: JSON.parse(transcript.languages) as string[],
      forcedLanguage: transcript.forced_language,
      showSettingsHint: settingsKeyboard !== undefined,
    },
  );
  let transcriptRows = 0;
  if (messages.length === 1) {
    const message = messages[0];
    if (message !== undefined) {
      const enqueued = outbox.enqueue({
        deliveryPartId: `transcript:${input.sessionId}:1`,
        kind: 'transcript',
        sessionId: input.sessionId,
        ordinal: 10,
        payload: {
          type: 'text',
          text: message.text,
          parseMode: 'HTML',
          ...(settingsKeyboard === undefined ? {} : { replyMarkup: settingsKeyboard }),
        },
      });
      if (enqueued) transcriptRows += 1;
    }
  }

  // A long transcript travels only as one .md file: sending the same content
  // as many quote chunks would still flood the chat even when each chunk can
  // be collapsed.
  if (messages.length > 1) {
    const mdPath = join(input.paths.transcriptsDir, `${input.sessionId}.md`);
    const segments = transcripts.segments(transcript.revision_id).map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      speaker: segment.speaker ?? null,
    }));
    const hasSpeakers = segments.some((segment) => segment.speaker !== null);
    await writeTextAtomically(
      mdPath,
      renderTranscriptMarkdown(
        input.sessionId,
        session.started_at,
        transcript.text,
        segments,
        renderProvenanceMarkdown(provenance),
        {
          languages: JSON.parse(transcript.languages) as string[],
          forcedLanguage: transcript.forced_language,
        },
      ),
    );
    const enqueued = outbox.enqueue({
      deliveryPartId: `transcript-md:${input.sessionId}`,
      kind: 'transcript',
      sessionId: input.sessionId,
      ordinal: 11,
      payload: {
        type: 'document',
        path: mdPath,
        filename: `${input.sessionId}.md`,
        caption:
          `📝 Транскрипт с таймингами${hasSpeakers ? ' и голосами' : ''}\n\n` +
          renderProvenanceHtml(provenance),
        ...(settingsKeyboard === undefined ? {} : { replyMarkup: settingsKeyboard }),
      },
    });
    if (enqueued) transcriptRows += 1;
  }

  sessions.setState(input.sessionId, 'DELIVERING');
  return transcriptRows;
}

interface ReportTranscriptRevision {
  readonly revision_id: string;
  readonly text: string;
  readonly word_count: number;
  readonly languages: string;
  readonly forced_language: string | null;
}

function reportTranscriptRevision(
  db: DatabaseSync,
  transcripts: TranscriptRepository,
  sessionId: string,
  revisionId: string | undefined,
): ReportTranscriptRevision | undefined {
  if (revisionId === undefined) return transcripts.current(sessionId);
  const transcript = db
    .prepare(
      `SELECT revision_id, text, word_count, languages, forced_language
         FROM transcript_revisions
        WHERE revision_id = ? AND session_id = ?`,
    )
    .get(revisionId, sessionId) as ReportTranscriptRevision | undefined;
  if (transcript === undefined) {
    throw new Error(
      `summary transcript revision ${revisionId} does not belong to session ${sessionId}`,
    );
  }
  return transcript;
}

export async function enqueueSessionReport(
  db: DatabaseSync,
  input: EnqueueReportInput,
): Promise<number> {
  const sessions = new SessionRepository(db);
  const transcripts = new TranscriptRepository(db);
  const outbox = new Outbox(db);
  const session = sessions.get(input.sessionId);
  if (session === undefined) throw new Error(`unknown session ${input.sessionId}`);

  if (input.summary.claimEvidence.length > 0 && input.summaryRevisionId === undefined) {
    throw new Error('claim-level summary evidence requires an exact transcript revision');
  }
  const transcript = reportTranscriptRevision(
    db,
    transcripts,
    input.sessionId,
    input.summaryRevisionId,
  );
  const languages =
    transcript === undefined
      ? session.languages === null
        ? []
        : (JSON.parse(session.languages) as string[])
      : (JSON.parse(transcript.languages) as string[]);
  const transcriptSegments =
    transcript === undefined
      ? []
      : transcripts.segments(transcript.revision_id).map((segment) => ({
          startMs: segment.startMs,
          endMs: segment.endMs,
          text: segment.text,
          speaker: segment.speaker ?? null,
        }));
  const summary = boundClaimEvidence(input.summary, transcriptSegments.length);
  const reportInput = {
    sessionId: input.sessionId,
    startedWallMs: Date.parse(session.started_at),
    endedWallMs: session.ended_at === null ? Date.now() : Date.parse(session.ended_at),
    durationMs: session.duration_ms ?? 0,
    speechMs: session.speech_ms,
    languages,
    partCount: session.part_count,
    summary,
    transcriptRevisionId: transcript?.revision_id,
    transcript: transcript?.text ?? '',
    transcriptSegments,
    timezone: session.capture_timezone ?? 'UTC',
    provenance: liveCaptureProvenance(session),
  };
  const report = renderSessionReport(reportInput);
  let reportRows = 0;
  if (report.length <= input.config.telegram.transcriptInlineLimit) {
    reportRows = outbox.enqueue({
      deliveryPartId: `report:${input.sessionId}`,
      kind: 'report',
      sessionId: input.sessionId,
      ordinal: 20,
      payload: { type: 'text', text: report, parseMode: 'HTML' },
    })
      ? 1
      : 0;
  } else {
    const reportPath = join(input.paths.transcriptsDir, `${input.sessionId}.report.md`);
    await writeTextAtomically(reportPath, renderSessionReportMarkdown(reportInput));
    const preview = renderSessionSummaryPreview(reportInput);
    if (preview.length > 0) {
      reportRows += outbox.enqueue({
        deliveryPartId: `report-summary:${input.sessionId}`,
        kind: 'report',
        sessionId: input.sessionId,
        ordinal: 20,
        payload: { type: 'text', text: preview, parseMode: 'HTML' },
      })
        ? 1
        : 0;
    }
    reportRows = outbox.enqueue({
      deliveryPartId: `report:${input.sessionId}`,
      kind: 'report',
      sessionId: input.sessionId,
      ordinal: 21,
      payload: {
        type: 'document',
        path: reportPath,
        filename: `${input.sessionId}.report.md`,
        caption: `📄 Полный отчёт по сессии\n\n${renderProvenanceHtml(reportInput.provenance)}`,
      },
    })
      ? reportRows + 1
      : reportRows;
  }

  sessions.setState(input.sessionId, 'DELIVERING');
  return reportRows;
}

export function renderTranscriptMarkdown(
  sessionId: string,
  startedAt: string,
  text: string,
  segments: readonly {
    readonly startMs: number | null;
    readonly endMs: number | null;
    readonly text: string;
    readonly speaker?: number | null;
  }[] = [],
  provenanceMarkdown?: string,
  languageInfo?: { readonly languages: readonly string[]; readonly forcedLanguage: string | null },
): string {
  const timed = formatTimedTranscript(segments);
  return [
    '# Расшифровка OpenMurmur',
    '',
    ...(provenanceMarkdown === undefined
      ? [`- UID сессии: \`${sessionId}\``]
      : [provenanceMarkdown]),
    `- Начало: ${startedAt}`,
    ...(languageInfo === undefined
      ? []
      : [
          `- Языки: ${languageListLabel(languageInfo.languages)}`,
          `- Режим: ${recognitionModeLabel(languageInfo.forcedLanguage)}`,
        ]),
    '',
    '---',
    '',
    timed.length > 0 ? timed : text,
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
  // The estimate is only a starting point: FLAC bitrate is content-dependent,
  // so every produced file is measured and retried with shorter segments.
  let chunkSeconds = Math.max(1, Math.floor((maxBytes * 0.85) / bytesPerSecond));

  const stem = basename(sourcePath).replace(/\.flac$/i, '');
  const pattern = join(tempDir, `${stem}.split%03d.flac`);

  for (;;) {
    await removeSplitArtifacts(tempDir, stem);
    try {
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
    } catch (error) {
      await removeSplitArtifacts(tempDir, stem);
      throw error;
    }

    const produced = await listSplitArtifacts(tempDir, stem);
    if (produced.length === 0) {
      throw new Error(`ffmpeg produced no FLAC chunks for ${sourcePath}`);
    }

    const sizes = await Promise.all(produced.map(async (path) => (await stat(path)).size));
    if (sizes.every((size) => size <= maxBytes)) return produced;

    await removeSplitArtifacts(tempDir, stem);
    if (chunkSeconds === 1) {
      throw new Error(
        `cannot split ${sourcePath} below the Telegram limit of ${maxBytes} bytes without re-encoding`,
      );
    }
    chunkSeconds = Math.max(1, Math.floor(chunkSeconds / 2));
  }
}

async function listSplitArtifacts(tempDir: string, stem: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tempDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const prefix = `${stem}.split`;
  return entries
    .filter((entry) => {
      if (!entry.startsWith(prefix) || !entry.endsWith('.flac')) return false;
      return /^\d{3}$/.test(entry.slice(prefix.length, -'.flac'.length));
    })
    .sort()
    .map((entry) => join(tempDir, entry));
}

async function removeSplitArtifacts(tempDir: string, stem: string): Promise<void> {
  for (const path of await listSplitArtifacts(tempDir, stem)) {
    await rm(path, { force: true });
  }
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
