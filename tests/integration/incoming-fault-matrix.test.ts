import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FakeAsr } from '../../src/asr/fake.ts';
import {
  enqueueIncomingRequest,
  ensureIncomingWav,
  findIncomingFile,
} from '../../src/cli/daemon.ts';
import { managedDirectories, resolvePaths } from '../../src/config/paths.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { appendIncomingTranscript, IncomingFileRepository } from '../../src/database/repository.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import type { TelegramClient } from '../../src/telegram/client.ts';
import {
  downloadToQuarantine,
  extractAttachment,
  quarantineTemporaryPathFor,
} from '../../src/telegram/incoming.ts';
import { reconcileIncomingArtifacts } from '../../src/telegram/incoming-recovery.ts';
import { Outbox } from '../../src/telegram/outbox.ts';
import { recordUpdate } from '../../src/telegram/router.ts';

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'om-incoming-fault-matrix-'));
  const paths = resolvePaths(root);
  for (const directory of managedDirectories(paths)) mkdirSync(directory, { recursive: true });
  db = openDatabase({ file: paths.databaseFile });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function restart(): void {
  db.close();
  db = openDatabase({ file: resolvePaths(root).databaseFile });
}

function count(sql: string, ...params: (string | number)[]): number {
  return (db.handle.prepare(sql).get(...params) as { count: number }).count;
}

function silentWav(): Buffer {
  const samples = 1_600;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function fakeMediaTools(): { ffmpeg: string; ffprobe: string; calls: string } {
  const ffmpeg = join(root, 'fake-ffmpeg');
  const ffprobe = join(root, 'fake-ffprobe');
  const calls = join(root, 'fake-ffmpeg.calls');
  writeFileSync(
    ffmpeg,
    `#!/bin/sh\ninput=''\noutput=''\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '-i' ]; then\n    shift\n    input="$1"\n  fi\n  output="$1"\n  shift\ndone\n/usr/bin/printf x >> "${calls}"\n/bin/cp "$input" "$output"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    ffprobe,
    '#!/bin/sh\nfor candidate do path="$candidate"; done\n' +
      '[ -f "$path" ] || exit 1\n' +
      `/usr/bin/printf '%s\\n' '${JSON.stringify({
        streams: [
          {
            codec_type: 'audio',
            codec_name: 'pcm_s16le',
            duration: '0.1',
            channels: 1,
            sample_rate: '16000',
          },
        ],
        format: { format_name: 'wav', duration: '0.1' },
      })}'\n`,
    { mode: 0o700 },
  );
  chmodSync(ffmpeg, 0o700);
  chmodSync(ffprobe, 0o700);
  return { ffmpeg, ffprobe, calls };
}

describe('incoming Telegram fault and restart matrix', () => {
  it('isolates concurrent lease generations while publishing one complete download', async () => {
    const paths = resolvePaths(root);
    const body = silentWav();
    const fileUid = '123e4567-e89b-42d3-a456-426614174000';
    const attachment = {
      fileId: 'concurrent-file',
      fileUniqueId: 'concurrent-unique',
      declaredBytes: body.byteLength,
      declaredMime: 'audio/wav',
      declaredDurationSeconds: 1,
      claimedFilename: 'concurrent.wav',
      source: 'audio' as const,
    };
    const getFile = async (fileId: string) => ({
      file_id: fileId,
      file_unique_id: attachment.fileUniqueId,
      file_size: body.byteLength,
      file_path: 'audio/concurrent.wav',
    });
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstClient = {
      getFile,
      async downloadFile() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body.subarray(0, 128));
              void firstReleased.then(() => {
                controller.enqueue(body.subarray(128));
                controller.close();
              });
            },
          }),
        );
      },
    } as unknown as TelegramClient;
    let firstCurrent = true;
    const first = downloadToQuarantine(
      firstClient,
      attachment,
      paths.quarantineDir,
      { maxIncomingBytes: 1_000_000, maxDurationSeconds: 60 },
      fileUid,
      {
        attemptId: 'lease-A',
        assertCurrent: () => {
          if (!firstCurrent) throw new Error('lease A lost');
        },
      },
    );
    const firstTemp = quarantineTemporaryPathFor(paths.quarantineDir, fileUid, 'lease-A');
    for (let attempt = 0; attempt < 100 && !existsSync(firstTemp); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(existsSync(firstTemp), true, 'generation A reached its private temp');

    firstCurrent = false;
    const secondClient = {
      getFile,
      async downloadFile() {
        return new Response(body);
      },
    } as unknown as TelegramClient;
    const second = await downloadToQuarantine(
      secondClient,
      attachment,
      paths.quarantineDir,
      { maxIncomingBytes: 1_000_000, maxDurationSeconds: 60 },
      fileUid,
      { attemptId: 'lease-B', assertCurrent: () => {} },
    );
    releaseFirst?.();
    await assert.rejects(first);

    assert.equal(readFileSync(second.path).equals(body), true);
    assert.deepEqual(
      readdirSync(paths.quarantineDir).filter((name) => name.endsWith('.download.part')),
      [],
      'the winner removes the stale generation and both attempts consume their own temps',
    );
  });

  it('converges every durable boundary on one UID, one transcript and owned artifacts', async () => {
    const paths = resolvePaths(root);
    const body = silentWav();
    const message = {
      message_id: 10,
      date: Date.parse('2026-08-11T12:00:00.000Z') / 1000,
      chat: { id: 42, type: 'private' },
      audio: {
        file_id: 'matrix-file',
        file_unique_id: 'matrix-unique',
        file_name: 'matrix.wav',
        mime_type: 'audio/wav',
        file_size: body.byteLength,
        duration: 1,
      },
    };
    const attachment = extractAttachment(message);
    assert.ok(attachment);
    const client = {
      async getFile(fileId: string) {
        return {
          file_id: fileId,
          file_unique_id: attachment.fileUniqueId,
          file_size: body.byteLength,
          file_path: 'voice/matrix.wav',
        };
      },
      async downloadFile() {
        return new Response(body);
      },
    } as unknown as TelegramClient;

    // claim/insert: the update cannot become handled without its row, job and ACK.
    assert.equal(recordUpdate(db.handle, 900, 'audio'), true);
    db.handle.exec(`CREATE TRIGGER fail_matrix_ack
      BEFORE INSERT ON telegram_outbox
      WHEN NEW.delivery_part_id = 'ack:900'
      BEGIN SELECT RAISE(ABORT, 'matrix ack fault'); END`);
    assert.throws(
      () => enqueueIncomingRequest(db.handle, 900, message, 'matrix-host'),
      /matrix ack fault/,
    );
    restart();
    assert.equal(findIncomingFile(db.handle, attachment.fileUniqueId), undefined);
    assert.equal(
      count("SELECT count(*) AS count FROM jobs WHERE idempotency_key = 'incoming:900'"),
      0,
    );
    assert.equal(
      (
        db.handle.prepare('SELECT handled FROM telegram_updates WHERE update_id = 900').get() as {
          handled: number;
        }
      ).handled,
      0,
    );
    db.handle.exec('DROP TRIGGER fail_matrix_ack');
    const incoming = enqueueIncomingRequest(db.handle, 900, message, 'matrix-host');
    restart();
    assert.equal(new IncomingFileRepository(db.handle).get(incoming.fileUid)?.state, 'received');

    // download publication/path persist: a completed pre-DB artifact remains owned by UID;
    // the deterministic retry replaces it rather than leaking another UUID/path.
    const firstDownload = await downloadToQuarantine(
      client,
      attachment,
      paths.quarantineDir,
      { maxIncomingBytes: 1_000_000, maxDurationSeconds: 60 },
      incoming.fileUid,
    );
    db.handle.exec(`CREATE TRIGGER fail_matrix_download_state
      BEFORE UPDATE OF quarantine_path ON incoming_telegram_files
      BEGIN SELECT RAISE(ABORT, 'matrix download-state fault'); END`);
    assert.throws(
      () =>
        new IncomingFileRepository(db.handle).markDownloaded(
          incoming.fileUid,
          firstDownload.path,
          firstDownload.actualBytes,
        ),
      /matrix download-state fault/,
    );
    restart();
    assert.equal(new IncomingFileRepository(db.handle).get(incoming.fileUid)?.quarantinePath, null);
    assert.equal(existsSync(firstDownload.path), true);
    const crashCleanup = await reconcileIncomingArtifacts(db.handle, paths, nullLogger, {
      remove: true,
    });
    assert.equal(crashCleanup.removed, 0);
    db.handle.exec('DROP TRIGGER fail_matrix_download_state');
    const retryDownload = await downloadToQuarantine(
      client,
      attachment,
      paths.quarantineDir,
      { maxIncomingBytes: 1_000_000, maxDurationSeconds: 60 },
      incoming.fileUid,
    );
    assert.equal(retryDownload.path, firstDownload.path);
    new IncomingFileRepository(db.handle).markDownloaded(
      incoming.fileUid,
      retryDownload.path,
      retryDownload.actualBytes,
    );
    restart();
    assert.equal(new IncomingFileRepository(db.handle).get(incoming.fileUid)?.state, 'downloaded');

    // A prior successful attempt can leave a non-NULL path whose file is later missing. A
    // streamed retry must never expose its partial bytes at that final path. A hard crash may
    // leave only the one deterministic temp, which the next retry truncates and consumes.
    const downloadTemporary = quarantineTemporaryPathFor(paths.quarantineDir, incoming.fileUid);
    rmSync(retryDownload.path);
    let partialSent = false;
    const interruptedClient = {
      getFile: (fileId: string) => client.getFile(fileId),
      async downloadFile() {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!partialSent) {
                partialSent = true;
                controller.enqueue(body.subarray(0, 128));
                return;
              }
              controller.error(new Error('matrix stream fault'));
            },
          }),
        );
      },
    } as unknown as TelegramClient;
    await assert.rejects(
      downloadToQuarantine(
        interruptedClient,
        attachment,
        paths.quarantineDir,
        { maxIncomingBytes: 1_000_000, maxDurationSeconds: 60 },
        incoming.fileUid,
      ),
      /matrix stream fault/,
    );
    assert.equal(partialSent, true);
    assert.equal(existsSync(retryDownload.path), false, 'partial bytes never reach the final path');
    assert.equal(existsSync(downloadTemporary), false, 'a caught stream fault cleans its temp');
    assert.equal(
      new IncomingFileRepository(db.handle).get(incoming.fileUid)?.quarantinePath,
      retryDownload.path,
      'the prior durable path remains unchanged for restart retry',
    );

    writeFileSync(downloadTemporary, body.subarray(0, 128), { mode: 0o600 });
    restart();
    assert.equal(
      new IncomingFileRepository(db.handle).get(incoming.fileUid)?.quarantinePath,
      retryDownload.path,
    );
    assert.deepEqual(
      readdirSync(paths.quarantineDir).filter((name) => name.endsWith('.download.part')),
      [`.${incoming.fileUid}.download.part`],
      'a hard crash can strand at most one stable temp for this UID/path',
    );
    const recoveredDownload = await downloadToQuarantine(
      client,
      attachment,
      paths.quarantineDir,
      { maxIncomingBytes: 1_000_000, maxDurationSeconds: 60 },
      incoming.fileUid,
    );
    assert.equal(recoveredDownload.path, retryDownload.path);
    assert.equal(readFileSync(recoveredDownload.path).equals(body), true);
    assert.equal(existsSync(downloadTemporary), false, 'successful publication consumes the temp');
    new IncomingFileRepository(db.handle).markDownloaded(
      incoming.fileUid,
      recoveredDownload.path,
      recoveredDownload.actualBytes,
    );
    restart();

    // normalized reservation/publication/state: the path is durable before ffmpeg, and a
    // completed WAV is reused after its state update faults.
    const normalizedPath = join(paths.quarantineDir, `${incoming.fileUid}.16k.wav`);
    new IncomingFileRepository(db.handle).reserveNormalizedPath(incoming.fileUid, normalizedPath);
    restart();
    let row = new IncomingFileRepository(db.handle).get(incoming.fileUid);
    assert.ok(row);
    const media = fakeMediaTools();
    const publishedWav = await ensureIncomingWav(
      media.ffmpeg,
      media.ffprobe,
      retryDownload.path,
      row,
    );
    assert.equal(publishedWav, normalizedPath);
    assert.equal(readFileSync(media.calls, 'utf8'), 'x');
    db.handle.exec(`CREATE TRIGGER fail_matrix_normalized_state
      BEFORE UPDATE OF state ON incoming_telegram_files
      WHEN NEW.state = 'validated'
      BEGIN SELECT RAISE(ABORT, 'matrix normalized-state fault'); END`);
    assert.throws(
      () =>
        new IncomingFileRepository(db.handle).markNormalized(
          incoming.fileUid,
          normalizedPath,
          'wav',
          100,
        ),
      /matrix normalized-state fault/,
    );
    const publishedIdentity = statSync(normalizedPath).ino;
    restart();
    db.handle.exec('DROP TRIGGER fail_matrix_normalized_state');
    row = new IncomingFileRepository(db.handle).get(incoming.fileUid);
    assert.ok(row);
    assert.equal(
      await ensureIncomingWav(media.ffmpeg, media.ffprobe, retryDownload.path, row),
      normalizedPath,
    );
    assert.equal(readFileSync(media.calls, 'utf8'), 'x', 'restart reuses the complete WAV');
    assert.equal(statSync(normalizedPath).ino, publishedIdentity);
    new IncomingFileRepository(db.handle).markNormalized(
      incoming.fileUid,
      normalizedPath,
      'wav',
      100,
    );
    restart();
    assert.equal(new IncomingFileRepository(db.handle).get(incoming.fileUid)?.state, 'validated');

    // ASR: a transient failure changes no ownership facts; restart can read the same WAV.
    const fakeAsr = new FakeAsr();
    let asrAttempts = 0;
    const transcribe = async () => {
      asrAttempts += 1;
      if (asrAttempts === 1) throw new Error('matrix ASR fault');
      return fakeAsr.transcribe({
        audioPath: normalizedPath,
        requestId: incoming.fileUid,
      });
    };
    await assert.rejects(transcribe, /matrix ASR fault/);
    new IncomingFileRepository(db.handle).markFailedIfUntranscribed(incoming.fileUid);
    restart();
    assert.equal(new IncomingFileRepository(db.handle).get(incoming.fileUid)?.state, 'failed');
    assert.equal(existsSync(normalizedPath), true);
    const result = await transcribe();
    assert.equal(asrAttempts, 2);

    // transcript insert/outbox: failure of the manifest rolls back revision, segments and state.
    const deliveryPartId = `incoming:${incoming.fileUid}:1`;
    db.handle.exec(`CREATE TRIGGER fail_matrix_transcript_outbox
      BEFORE INSERT ON telegram_outbox
      WHEN NEW.delivery_part_id = '${deliveryPartId}'
      BEGIN SELECT RAISE(ABORT, 'matrix transcript-outbox fault'); END`);
    const append = () =>
      appendIncomingTranscript(
        db.handle,
        {
          incomingFileId: incoming.fileUid,
          engine: result.engine,
          model: result.model,
          languages: result.languages,
          text: result.text,
          segments: result.segments,
        },
        () => {
          new Outbox(db.handle).enqueue({
            deliveryPartId,
            kind: 'incoming_transcript',
            ordinal: 10,
            payload: {
              type: 'text',
              text: result.text,
              replyMarkup: { inline_keyboard: [] },
            },
          });
        },
      );
    assert.throws(append, /matrix transcript-outbox fault/);
    new IncomingFileRepository(db.handle).markFailedIfUntranscribed(incoming.fileUid);
    restart();
    assert.equal(
      count(
        'SELECT count(*) AS count FROM transcript_revisions WHERE incoming_file_id = ?',
        incoming.fileUid,
      ),
      0,
    );
    assert.equal(
      count("SELECT count(*) AS count FROM telegram_outbox WHERE kind = 'incoming_transcript'"),
      0,
    );
    assert.equal(new IncomingFileRepository(db.handle).get(incoming.fileUid)?.state, 'failed');
    db.handle.exec('DROP TRIGGER fail_matrix_transcript_outbox');
    append();
    restart();
    assert.equal(new IncomingFileRepository(db.handle).get(incoming.fileUid)?.state, 'transcribed');

    // A distinct update resending Telegram's same file resolves to the original UID. The
    // current transcript and stable manifest are reused, while the new request still gets ACKed.
    const resentMessage = { ...message, message_id: 11 };
    assert.equal(recordUpdate(db.handle, 901, 'audio'), true);
    const resent = enqueueIncomingRequest(db.handle, 901, resentMessage, 'other-host');
    assert.equal(resent.fileUid, incoming.fileUid);
    assert.equal(
      new Outbox(db.handle).enqueue({
        deliveryPartId,
        kind: 'incoming_transcript',
        ordinal: 10,
        payload: {
          type: 'text',
          text: result.text,
          replyMarkup: { inline_keyboard: [] },
        },
      }),
      false,
    );
    restart();

    assert.equal(count('SELECT count(*) AS count FROM incoming_telegram_files'), 1);
    assert.equal(
      count(
        'SELECT count(*) AS count FROM transcript_revisions WHERE incoming_file_id = ?',
        incoming.fileUid,
      ),
      1,
    );
    assert.equal(
      count(
        'SELECT count(*) AS count FROM transcript_segments WHERE revision_id IN (SELECT revision_id FROM transcript_revisions WHERE incoming_file_id = ?)',
        incoming.fileUid,
      ),
      1,
    );
    assert.equal(
      count("SELECT count(*) AS count FROM telegram_outbox WHERE kind = 'incoming_transcript'"),
      1,
    );
    assert.equal(count("SELECT count(*) AS count FROM jobs WHERE kind = 'incoming_audio'"), 2);
    const jobPayloads = db.handle
      .prepare("SELECT payload FROM jobs WHERE kind = 'incoming_audio'")
      .all() as { payload: string }[];
    assert.ok(
      jobPayloads.every(
        ({ payload }) => (JSON.parse(payload) as { fileUid?: string }).fileUid === incoming.fileUid,
      ),
      'every queued job resolves to the one durable incoming owner',
    );
    assert.deepEqual(db.handle.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(readdirSync(paths.quarantineDir).sort(), [
      `${incoming.fileUid}.16k.wav`,
      `${incoming.fileUid}.wav`,
    ]);
    const finalCleanup = await reconcileIncomingArtifacts(db.handle, paths, nullLogger, {
      remove: true,
    });
    assert.equal(finalCleanup.removed, 0);
    assert.deepEqual(finalCleanup.superseded, []);
  });
});
