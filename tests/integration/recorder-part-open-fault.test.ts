import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { CaptureBackend, CaptureFrame } from '../../src/capture/backend.ts';
import { resolvePaths } from '../../src/config/paths.ts';
import { DEFAULT_CONFIG } from '../../src/config/schema.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { nullLogger } from '../../src/logging/logger.ts';
import { Recorder } from '../../src/sessionizer/recorder.ts';
import type { Vad } from '../../src/sessionizer/vad.ts';

const FRAME_MS = 100;
const WALL_START = Date.UTC(2026, 7, 11, 1, 0, 0);

let dir: string;
let db: Database;
let pidLog: string;

class ScriptedCapture implements CaptureBackend {
  readonly name = 'part-open-fault-script';
  #lastMonotonicMs: number | null = null;
  #stopped = false;

  async *start(): AsyncIterableIterator<CaptureFrame> {
    // Two complete sessions. The first audio_parts INSERT is faulted; the
    // second session proves the recorder itself remains usable afterwards.
    const speechByFrame = [true, true, true, false, false, true, true, true, false, false];
    const monotonicByFrame = [100, 200, 300, 400, 1_300, 1_400, 1_500, 1_600, 1_700, 2_600];
    const markerByFrame = [0x11, 0x12, 0x13, 0x14, 0x15, 0x21, 0x22, 0x23, 0x24, 0x25];
    for (let index = 0; index < monotonicByFrame.length; index += 1) {
      if (this.#stopped) return;
      const monotonicMs = monotonicByFrame[index] ?? 0;
      this.#lastMonotonicMs = monotonicMs;
      yield {
        pcm: new Uint8Array([speechByFrame[index] === true ? 1 : 0, markerByFrame[index] ?? 0]),
        monotonicMs,
        wallMs: WALL_START + monotonicMs,
        durationMs: FRAME_MS,
      };
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }

  msSinceLastFrame(): number | null {
    return this.#lastMonotonicMs === null ? null : 0;
  }
}

const markerVad: Vad = {
  name: 'marker-vad',
  probability: (pcm) => (pcm[0] === 1 ? 1 : 0),
  reset: () => {},
};

function fakeEncoderPath(): string {
  const path = join(dir, 'fake-flac-encoder.cjs');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const { appendFileSync, closeSync, fsyncSync, openSync, writeSync } = require('node:fs');
const output = process.argv.at(-1);
appendFileSync(${JSON.stringify(pidLog)}, String(process.pid) + '\\n');
const fd = openSync(output, 'w', 0o600);
process.stdin.on('data', (chunk) => writeSync(fd, chunk));
process.stdin.on('end', () => {
  fsyncSync(fd);
  closeSync(fd);
});
`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return path;
}

function loggedPids(): number[] {
  if (!existsSync(pidLog)) return [];
  return readFileSync(pidLog, 'utf8')
    .trim()
    .split('\n')
    .filter((value) => value.length > 0)
    .map(Number);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'om-recorder-part-open-fault-'));
  pidLog = join(dir, 'encoder-pids.log');
  for (const subdir of ['audio', 'tmp']) {
    mkdirSync(join(dir, subdir), { recursive: true });
  }
  db = openDatabase({ file: join(dir, 'openmurmur.db') });
});

afterEach(() => {
  for (const pid of loggedPids()) {
    if (processIsAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recorder audio part open fault', () => {
  it('reaps the unpublished writer and records the next session after the part row insert fails', async () => {
    let failNextPartInsert = true;
    let writerWasStartedBeforeFault = false;
    db.handle.function('fail_part_insert_after_writer_start', () => {
      if (!failNextPartInsert) return 0;
      failNextPartInsert = false;

      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const tempFiles = readdirSync(join(dir, 'tmp'));
        if (loggedPids().length > 0 && tempFiles.some((name) => name.endsWith('.part'))) {
          writerWasStartedBeforeFault = true;
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return 1;
    });
    db.handle.exec(`
      CREATE TRIGGER fault_first_audio_part_insert
      BEFORE INSERT ON audio_parts
      WHEN fail_part_insert_after_writer_start() = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected audio part insert failure');
      END
    `);

    const recorder = new Recorder({
      config: {
        ...DEFAULT_CONFIG,
        sessionizer: {
          ...DEFAULT_CONFIG.sessionizer,
          preRollSeconds: 1,
          speechCandidateMs: 200,
          silenceTimeoutSeconds: 1,
          maxPartSeconds: 10,
          minSpeechSeconds: 0.2,
        },
        audio: { ...DEFAULT_CONFIG.audio, ffmpegPath: fakeEncoderPath() },
      },
      paths: resolvePaths(dir),
      db: db.handle,
      capture: new ScriptedCapture(),
      vad: markerVad,
      logger: nullLogger,
      captureHost: 'fault-test-host',
      captureTimezone: 'UTC',
    });

    await assert.doesNotReject(recorder.run());
    assert.equal(
      writerWasStartedBeforeFault,
      true,
      'the fault must happen after child/temp creation',
    );

    const sessions = db.handle
      .prepare(
        `SELECT session_id, state, rejection_reason, part_count
           FROM audio_sessions
          ORDER BY started_at`,
      )
      .all() as unknown as {
      session_id: string;
      state: string;
      rejection_reason: string | null;
      part_count: number;
    }[];
    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map(({ state, rejection_reason, part_count }) => ({
        state,
        rejection_reason,
        part_count,
      })),
      [
        { state: 'FAILED', rejection_reason: 'audio_finalize_failed', part_count: 0 },
        { state: 'PROCESSING', rejection_reason: null, part_count: 1 },
      ],
      'the faulted session must not pretend to process while the next one finalizes normally',
    );

    const parts = db.handle
      .prepare('SELECT session_id, path, finalized FROM audio_parts ORDER BY created_at')
      .all() as unknown as { session_id: string; path: string; finalized: number }[];
    assert.deepEqual(
      parts.map(({ session_id, finalized }) => ({ session_id, finalized })),
      [{ session_id: sessions[1]?.session_id, finalized: 1 }],
    );
    assert.deepEqual(
      [...readFileSync(parts[0]?.path ?? '')],
      [1, 0x21, 1, 0x22, 1, 0x23, 0, 0x24],
      'the successful artifact contains only its own pre-roll/body frames',
    );
    assert.equal(
      (
        db.handle.prepare('SELECT count(*) AS count FROM audio_finalization_journal').get() as {
          count: number;
        }
      ).count,
      0,
      'the failed pre-publication open must not invent a recovery journal',
    );
    assert.deepEqual(
      db.handle
        .prepare(
          `SELECT kind, json_extract(payload, '$.sessionId') AS session_id
             FROM jobs
            ORDER BY created_at, rowid`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { kind: 'deliver_audio', session_id: sessions[1]?.session_id },
        { kind: 'asr', session_id: sessions[1]?.session_id },
      ],
    );

    assert.deepEqual(readdirSync(join(dir, 'tmp')), [], 'no unpublished temp may survive');
    assert.equal(
      readdirSync(join(dir, 'audio'), { recursive: true }).filter((name) =>
        String(name).endsWith('.flac'),
      ).length,
      1,
      'only the successfully registered second session may be published',
    );
    const pids = loggedPids();
    assert.equal(pids.length, 2, 'one encoder was started for each session');
    assert.ok(
      pids.every((pid) => !processIsAlive(pid)),
      'all encoder children must be reaped',
    );
  });
});
