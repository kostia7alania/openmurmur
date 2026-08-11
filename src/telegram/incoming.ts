import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fsyncDirectory, fsyncFile } from '../capture/writer.ts';
import type { TelegramAudioLike, TelegramClient, TelegramMessage } from './client.ts';
import { formatBytes, formatDuration } from './format.ts';

/**
 * Ingest of audio a user sends to the bot.
 *
 * Everything on this path is untrusted: the filename, the MIME type, the
 * declared size, the container, and — critically — the transcript that comes
 * out of it. None of it may influence control flow beyond this module.
 */

export const SUPPORTED_EXTENSIONS = [
  '.ogg',
  '.opus',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.flac',
] as const;

/** Codecs ffprobe may report. Anything else is refused. */
export const SUPPORTED_CODECS = new Set([
  'opus',
  'vorbis',
  'mp3',
  'aac',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_f32le',
  'flac',
  'alac',
]);

export type IncomingRejection =
  | 'not_allowlisted'
  | 'unsupported_media'
  | 'too_large_declared'
  | 'too_large_actual'
  | 'too_long'
  | 'corrupt_media'
  | 'unsupported_codec'
  | 'no_audio_stream';

export class IncomingRejected extends Error {
  readonly reason: IncomingRejection;
  constructor(reason: IncomingRejection, message: string) {
    super(message);
    this.name = 'IncomingRejected';
    this.reason = reason;
  }
}

export interface ExtractedAttachment {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly declaredBytes: number | undefined;
  readonly declaredMime: string | undefined;
  readonly declaredDurationSeconds: number | undefined;
  /** Purely for logging. Never used to build a path. */
  readonly claimedFilename: string | undefined;
  readonly source: 'voice' | 'audio' | 'document' | 'video_note';
}

/**
 * Picks the audio attachment out of a message, if any.
 *
 * Documents are accepted only when the *extension we derive ourselves* is an
 * audio one — a `.pdf` claiming `audio/mpeg` is refused, and so is an `.mp3`
 * claiming `application/pdf` only after ffprobe disagrees.
 */
export function extractAttachment(message: TelegramMessage): ExtractedAttachment | null {
  const build = (
    media: TelegramAudioLike,
    source: ExtractedAttachment['source'],
  ): ExtractedAttachment => ({
    fileId: media.file_id,
    fileUniqueId: media.file_unique_id,
    declaredBytes: media.file_size,
    declaredMime: media.mime_type,
    declaredDurationSeconds: media.duration,
    claimedFilename: media.file_name,
    source,
  });

  if (message.voice) return build(message.voice, 'voice');
  if (message.audio) return build(message.audio, 'audio');
  if (message.video_note) return build(message.video_note, 'video_note');
  if (message.document) {
    const doc = message.document;
    const ext = safeExtension(doc.file_name);
    const mimeLooksAudio = (doc.mime_type ?? '').startsWith('audio/');
    if (ext !== null || mimeLooksAudio) return build(doc, 'document');
  }
  return null;
}

/**
 * Extracts a lowercase extension from a claimed filename, but only if it is one
 * we support. Returns null otherwise. The result is used *only* to pick a
 * container hint for ffprobe, never to build a path.
 */
export function safeExtension(claimedFilename: string | undefined): string | null {
  if (claimedFilename === undefined) return null;
  // Strip any directory component a hostile client may have embedded.
  const base = claimedFilename.replaceAll('\\', '/').split('/').pop() ?? '';
  const ext = extname(base).toLowerCase();
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/**
 * Builds the quarantine path for a download.
 *
 * The filename is a fresh UUID plus a whitelisted extension. Telegram's
 * `file_path` and the claimed `file_name` never reach the filesystem, so
 * `../../../.ssh/authorized_keys`, absolute paths, NUL bytes and Unicode
 * lookalikes are all structurally impossible rather than filtered.
 */
export function quarantinePathFor(
  quarantineDir: string,
  claimedFilename: string | undefined,
  fileUid: string = randomUUID(),
): { fileUid: string; path: string } {
  const ext = safeExtension(claimedFilename) ?? '.bin';
  const path = join(quarantineDir, `${fileUid}${ext}`);
  assertContained(quarantineDir, path);
  return { fileUid, path };
}

/** One bounded crash artefact per durable UID; a retry truncates and reuses it. */
export function quarantineTemporaryPathFor(
  quarantineDir: string,
  fileUid: string,
  attemptId?: string,
): string {
  const attemptSuffix =
    attemptId === undefined ? '' : `.${attemptId.replace(/[^A-Za-z0-9-]/g, '_')}`;
  const temporary = join(quarantineDir, `.${fileUid}${attemptSuffix}.download.part`);
  assertContained(quarantineDir, temporary);
  return temporary;
}

async function removeSupersededDownloadTemps(
  quarantineDir: string,
  fileUid: string,
  current: string,
): Promise<void> {
  const prefix = `.${fileUid}.`;
  for (const entry of await readdir(quarantineDir)) {
    if (
      entry !== basename(current) &&
      entry.startsWith(prefix) &&
      entry.endsWith('.download.part')
    ) {
      await rm(join(quarantineDir, entry), { force: true });
    }
  }
}

/** Defence in depth: proves a resolved path really is inside its directory. */
export function assertContained(directory: string, candidate: string): void {
  const root = resolve(directory);
  const target = resolve(candidate);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new IncomingRejected(
      'unsupported_media',
      `refusing to write outside the quarantine directory`,
    );
  }
}

export interface DownloadLimits {
  readonly maxIncomingBytes: number;
  readonly maxDurationSeconds: number;
}

export interface DownloadResult {
  readonly fileUid: string;
  readonly path: string;
  readonly actualBytes: number;
}

export interface DownloadAttemptOptions {
  /** Unique job claim generation; omitted by compatibility and direct recovery callers. */
  readonly attemptId?: string | undefined;
  /** Re-proves the claim before removing an old attempt and before publication. */
  readonly assertCurrent?: (() => void) | undefined;
}

/**
 * Downloads an attachment into quarantine.
 *
 * Two size checks, deliberately: the declared size avoids the round trip, and
 * the streamed byte count is the one that actually protects the disk — a
 * server that lies about `file_size` (or a decompression bomb) is cut off
 * mid-stream rather than after the fact.
 */
export async function downloadToQuarantine(
  client: TelegramClient,
  attachment: ExtractedAttachment,
  quarantineDir: string,
  limits: DownloadLimits,
  fileUid?: string,
  attempt: DownloadAttemptOptions = {},
): Promise<DownloadResult> {
  if (
    attachment.declaredBytes !== undefined &&
    attachment.declaredBytes > limits.maxIncomingBytes
  ) {
    throw new IncomingRejected(
      'too_large_declared',
      `file is ${attachment.declaredBytes} bytes; the configured incoming limit is ` +
        `${limits.maxIncomingBytes} bytes`,
    );
  }
  if (
    attachment.declaredDurationSeconds !== undefined &&
    attachment.declaredDurationSeconds > limits.maxDurationSeconds
  ) {
    throw new IncomingRejected(
      'too_long',
      `file is ${attachment.declaredDurationSeconds}s; the limit is ${limits.maxDurationSeconds}s`,
    );
  }

  const file = await client.getFile(attachment.fileId);
  if (file.file_path === undefined) {
    throw new IncomingRejected('unsupported_media', 'Telegram returned no downloadable file path');
  }
  if (file.file_size !== undefined && file.file_size > limits.maxIncomingBytes) {
    throw new IncomingRejected(
      'too_large_declared',
      `file is ${file.file_size} bytes, over the ${limits.maxIncomingBytes} byte limit`,
    );
  }

  const target = quarantinePathFor(quarantineDir, attachment.claimedFilename, fileUid);
  const { path } = target;
  const temporary = quarantineTemporaryPathFor(quarantineDir, target.fileUid, attempt.attemptId);
  if (attempt.attemptId !== undefined) {
    attempt.assertCurrent?.();
    await removeSupersededDownloadTemps(quarantineDir, target.fileUid, temporary);
    attempt.assertCurrent?.();
  }
  const response = await client.downloadFile(file.file_path);
  if (response.body === null) {
    throw new IncomingRejected('corrupt_media', 'Telegram returned an empty body');
  }

  let written = 0;
  const capped = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > limits.maxIncomingBytes) {
        controller.error(
          new IncomingRejected(
            'too_large_actual',
            `download exceeded ${limits.maxIncomingBytes} bytes`,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  let handle: FileHandle | null = null;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await pipeline(
      Readable.fromWeb(response.body.pipeThrough(capped) as never),
      handle.createWriteStream(),
    );
    handle = null;
    const info = await stat(temporary);
    if (info.size === 0) {
      throw new IncomingRejected('corrupt_media', 'downloaded file is empty');
    }
    await fsyncFile(temporary);
    attempt.assertCurrent?.();
    await rename(temporary, path);
    await fsyncDirectory(dirname(path));
    return { fileUid: target.fileUid, path, actualBytes: info.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export interface ProbeResult {
  readonly codec: string;
  readonly formatName: string;
  readonly durationSeconds: number;
  readonly channels: number;
  readonly sampleRate: number;
}

/**
 * Validates a quarantined file against the *actual* container, ignoring
 * whatever it claimed to be.
 */
export function validateProbe(probe: ProbeResult | null, limits: DownloadLimits): ProbeResult {
  if (probe === null) {
    throw new IncomingRejected('corrupt_media', 'ffprobe could not read the file');
  }
  if (!SUPPORTED_CODECS.has(probe.codec)) {
    throw new IncomingRejected(
      'unsupported_codec',
      `audio codec "${probe.codec}" is not supported`,
    );
  }
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
    throw new IncomingRejected('corrupt_media', 'file reports no usable audio duration');
  }
  if (probe.durationSeconds > limits.maxDurationSeconds) {
    throw new IncomingRejected(
      'too_long',
      `audio is ${Math.round(probe.durationSeconds)}s; the limit is ${limits.maxDurationSeconds}s`,
    );
  }
  return probe;
}

/**
 * Stable chat copy for an incoming-file rejection.
 *
 * The exception detail is deliberately not accepted here: it may contain an
 * ffmpeg error, a Telegram response or a local path. Callers keep that detail
 * in the redacted local log while the chat receives only bounded product copy.
 */
export function rejectionMessage(reason: IncomingRejection, limits: DownloadLimits): string {
  switch (reason) {
    case 'too_large_declared':
    case 'too_large_actual':
      return (
        '⚠️ Файл слишком большой.\n\n' +
        `Лимит этого бота: ${formatBytes(limits.maxIncomingBytes)}.\n\n` +
        'Если бот использует официальный Cloud Bot API, его предел входящего файла — 20 MB. ' +
        'Для больших файлов нужен локальный Telegram Bot API server и больший ' +
        '`telegram.maxIncomingBytes`.'
      );
    case 'too_long':
      return (
        '⚠️ Запись слишком длинная.\n\n' +
        `Максимальная длительность: ${formatDuration(limits.maxDurationSeconds * 1000)}.`
      );
    case 'unsupported_media':
    case 'unsupported_codec':
      return `⚠️ Формат не поддерживается.\n\nПоддерживаются: ${SUPPORTED_EXTENSIONS.join(', ')}`;
    case 'corrupt_media':
      return '⚠️ Файл не читается.\n\nПроверьте аудио и отправьте файл ещё раз.';
    case 'no_audio_stream':
      return '⚠️ В файле нет аудиодорожки.';
    case 'not_allowlisted':
      return '';
  }
}
