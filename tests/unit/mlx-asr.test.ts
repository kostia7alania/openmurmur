import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { MlxAsr } from '../../src/asr/mlx.ts';
import { nullLogger } from '../../src/logging/logger.ts';

const FAKE_MLX_WORKER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[1];
const dir = process.argv[2];
fs.writeFileSync(path.join(dir, 'started'), String(process.pid));

let buffered = '';
let loadAttempts = 0;
const send = (response) => process.stdout.write(JSON.stringify(response) + '\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const request = JSON.parse(line);
    if (request.op === 'ping') {
      if (mode === 'slow-ping') {
        setTimeout(() => send({ id: request.id, ok: true, op: 'ping', worker_version: 'fake' }), 75);
        continue;
      }
      send(mode === 'fail-ping'
        ? { id: request.id, ok: false, code: 'worker_not_ready', error: 'initialization failed' }
        : { id: request.id, ok: true, op: 'ping', worker_version: 'fake' });
      continue;
    }
    if (request.op === 'load') {
      loadAttempts += 1;
      fs.writeFileSync(path.join(dir, 'load.started'), String(loadAttempts));
      if ((mode === 'fail-once' || mode === 'fail-once-slow-retry') && loadAttempts === 1) {
        send({ id: request.id, ok: false, code: 'model_load_failed', error: 'weights missing; run uv sync --extra mlx' });
      } else if (mode === 'fail-once-slow-retry') {
        setTimeout(() => send({ id: request.id, ok: true, op: 'load', model: request.model, load_ms: 25 }), 100);
      } else if (mode === 'wrong-op') {
        send({ id: request.id, ok: true, op: 'ping', worker_version: 'fake' });
      } else if (mode === 'wrong-model') {
        send({ id: request.id, ok: true, op: 'load', model: 'other/model', load_ms: 7 });
      } else if (mode === 'negative-load-ms') {
        send({ id: request.id, ok: true, op: 'load', model: request.model, load_ms: -1 });
      } else if (mode === 'string-load-ms') {
        send({ id: request.id, ok: true, op: 'load', model: request.model, load_ms: '7' });
      } else if (mode === 'slow-load') {
        setTimeout(() => send({ id: request.id, ok: true, op: 'load', model: request.model, load_ms: 25 }), 100);
      } else {
        send({ id: request.id, ok: true, op: 'load', model: request.model, load_ms: 7 });
      }
      continue;
    }
    if (request.op === 'transcribe') {
      if (mode === 'timeout-transcribe') continue;
      if (mode === 'exit-transcribe') process.exit(23);
      send({
        id: request.id,
        ok: true,
        op: 'transcribe',
        text: 'ok',
        languages: ['en'],
        segments: mode === 'coarse-provenance'
          ? [{ start_ms: 0, end_ms: 500, timestamp_source: 'coarse', language: 'th', text: 'สวัสดี' }]
          : [],
        model: 'expected/model',
        duration_ms: 1,
      });
      continue;
    }
    if (request.op === 'shutdown') {
      send({ id: request.id, ok: true, op: 'shutdown' });
      process.exit(0);
    }
  }
});
`;

function backend(
  t: TestContext,
  mode: string,
  requestTimeoutMs = 1_000,
): { readonly asr: MlxAsr; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'openmurmur-mlx-health-'));
  const asr = new MlxAsr({
    command: process.execPath,
    args: ['-e', FAKE_MLX_WORKER, mode, dir],
    cwd: process.cwd(),
    model: 'expected/model',
    quantization: '8bit',
    alignerLanguages: [],
    requestTimeoutMs,
    logger: nullLogger,
  });
  t.after(async () => {
    await asr.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { asr, dir };
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForFileValue(path: string, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) || readFileSync(path, 'utf8') !== expected) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}=${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('MLX ASR model load health', () => {
  it('reports idle, loading and exact loaded state without probing from health()', async (t) => {
    const { asr, dir } = backend(t, 'slow-load');

    assert.deepEqual(asr.health(), {
      ok: false,
      reason: 'ASR worker is idle; readiness probe pending',
      recovering: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(existsSync(join(dir, 'started')), false, 'health must not spawn the worker');

    const readiness = Promise.all([asr.ready(), asr.ready()]);
    await waitForFile(join(dir, 'load.started'));
    assert.deepEqual(asr.health(), {
      ok: false,
      reason: 'ASR model is loading',
      recovering: true,
    });
    assert.deepEqual(await readiness, [{ ok: true }, { ok: true }]);
    assert.equal(readFileSync(join(dir, 'load.started'), 'utf8'), '1');
    assert.deepEqual(asr.health(), {
      ok: true,
      detail: 'model loaded: expected/model (25 ms)',
    });

    await asr.close();
    assert.equal(asr.health().ok, false, 'close must invalidate the generation-local load fact');
  });

  it('keeps a live worker unhealthy after load failure and clears it on exact recovery', async (t) => {
    const { asr } = backend(t, 'fail-once');

    const failed = await asr.ready();
    assert.deepEqual(failed, {
      ok: false,
      reason: 'could not load expected/model: weights missing; run uv sync --extra mlx',
    });
    assert.deepEqual(asr.health(), {
      ok: false,
      reason: 'could not load expected/model: weights missing; run uv sync --extra mlx',
    });

    assert.deepEqual(await asr.ready(), { ok: true });
    assert.deepEqual(asr.health(), {
      ok: true,
      detail: 'model loaded: expected/model (7 ms)',
    });
  });

  it('keeps the prior failure active until a replacement load succeeds exactly', async (t) => {
    const { asr, dir } = backend(t, 'fail-once-slow-retry');
    const failed = await asr.ready();
    assert.equal(failed.ok, false);

    const recovery = asr.ready();
    await waitForFileValue(join(dir, 'load.started'), '2');
    assert.deepEqual(asr.health(), {
      ok: false,
      reason: 'could not load expected/model: weights missing; run uv sync --extra mlx',
    });
    assert.deepEqual(await recovery, { ok: true });
    assert.deepEqual(asr.health(), {
      ok: true,
      detail: 'model loaded: expected/model (25 ms)',
    });
  });

  it('persists an explicit ping rejection as failed readiness', async (t) => {
    const { asr } = backend(t, 'fail-ping');

    assert.deepEqual(await asr.ready(), {
      ok: false,
      reason: 'ASR worker readiness failed: initialization failed',
    });
    assert.deepEqual(asr.health(), {
      ok: false,
      reason: 'ASR worker readiness failed: initialization failed',
    });
  });

  it('allows cold worker startup to use the configured ASR timeout for readiness ping', async (t) => {
    const { asr } = backend(t, 'slow-ping', 150);

    assert.deepEqual(await asr.ready(), { ok: true });
    assert.deepEqual(asr.health(), {
      ok: true,
      detail: 'model loaded: expected/model (7 ms)',
    });
  });

  it('rejects every inexact successful load acknowledgement', async (t) => {
    const cases = [
      ['wrong-op', /replied to "load" with "ping"/],
      ['wrong-model', /loaded "other\/model" instead of "expected\/model"/],
      ['negative-load-ms', /invalid model load duration/],
      ['string-load-ms', /invalid model load duration/],
    ] as const;

    for (const [mode, expected] of cases) {
      await t.test(mode, async (t) => {
        const { asr } = backend(t, mode);
        const readiness = await asr.ready();
        assert.equal(readiness.ok, false);
        if (!readiness.ok) assert.match(readiness.reason, expected);
        const health = asr.health();
        assert.equal(health.ok, false);
        if (!health.ok) assert.match(health.reason, expected);
      });
    }
  });

  it('invalidates loaded state on request timeout and recovers in a new generation', async (t) => {
    const { asr } = backend(t, 'timeout-transcribe', 30);
    assert.deepEqual(await asr.ready(), { ok: true });
    assert.equal(asr.health().ok, true);

    await assert.rejects(
      asr.transcribe({ audioPath: '/tmp/ignored.wav', requestId: 'timeout' }),
      /did not answer "transcribe" within 30 ms/,
    );
    assert.deepEqual(asr.health(), {
      ok: false,
      reason: 'ASR worker exited; the queued job will restart it',
    });

    assert.deepEqual(await asr.ready(), { ok: true });
    assert.deepEqual(asr.health(), {
      ok: true,
      detail: 'model loaded: expected/model (7 ms)',
    });
  });

  it('invalidates loaded state when the worker exits unexpectedly', async (t) => {
    const { asr } = backend(t, 'exit-transcribe');
    assert.deepEqual(await asr.ready(), { ok: true });

    await assert.rejects(
      asr.transcribe({ audioPath: '/tmp/ignored.wav', requestId: 'exit' }),
      /worker exited with code 23/,
    );
    assert.deepEqual(asr.health(), {
      ok: false,
      reason: 'ASR worker exited; the queued job will restart it',
    });
  });

  it('preserves coarse timestamp provenance across the Python worker boundary', async (t) => {
    const { asr } = backend(t, 'coarse-provenance');
    const result = await asr.transcribe({ audioPath: '/tmp/ignored.wav', requestId: 'coarse' });

    assert.deepEqual(result.segments, [
      {
        startMs: 0,
        endMs: 500,
        timestampSource: 'coarse',
        language: 'th',
        text: 'สวัสดี',
      },
    ]);
  });
});
