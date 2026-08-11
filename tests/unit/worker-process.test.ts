import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { missingWorkerHint, WorkerProcess } from '../../src/asr/worker-process.ts';
import { nullLogger } from '../../src/logging/logger.ts';

const FAKE_WORKER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[1];
const dir = process.argv[2];
const firstPidPath = path.join(dir, 'first.pid');
const termPath = path.join(dir, 'term.seen');
const readyPath = path.join(dir, 'ready');
const first = !fs.existsSync(firstPidPath);
if (first) fs.writeFileSync(firstPidPath, String(process.pid));

process.on('SIGTERM', () => {
  fs.appendFileSync(termPath, String(process.pid) + '\n');
  if (mode === 'stuck' || (mode === 'timeout-once' && first)) return;
  process.exit(0);
});
fs.writeFileSync(readyPath, String(process.pid));

if (mode === 'exit-once' && first) {
  setTimeout(() => process.exit(23), 10);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    const lines = input.split('\n');
    input = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      if (mode === 'stuck' || (mode === 'timeout-once' && first)) continue;
      const request = JSON.parse(line);
      const response = request.op === 'shutdown'
        ? { id: request.id, ok: true, op: 'shutdown' }
        : { id: request.id, ok: true, op: 'ping', worker_version: 'fake' };
      process.stdout.write(JSON.stringify(response) + '\n');
      if (request.op === 'shutdown') setImmediate(() => process.exit(0));
    }
  });
  process.stdin.resume();
}
`;

function fakeWorker(
  mode: 'timeout-once' | 'stuck' | 'exit-once',
  dir: string,
  onExit?: () => void,
): WorkerProcess {
  return new WorkerProcess({
    command: process.execPath,
    args: ['-e', FAKE_WORKER, mode, dir],
    cwd: process.cwd(),
    logger: nullLogger,
    label: 'fake',
    shutdownTimeoutMs: 100,
    terminationGraceMs: 100,
    ...(onExit ? { onExit } : {}),
  });
}

function readFirstPid(dir: string): number {
  return Number(readFileSync(join(dir, 'first.pid'), 'utf8'));
}

function assertProcessExited(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
}

async function waitForReady(dir: string, timeoutMs = 5000): Promise<void> {
  const ready = join(dir, 'ready');
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(ready)) {
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for the fake worker to be ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('worker shutdown lifecycle', () => {
  it('does not start again after an intentional close', async () => {
    const worker = new WorkerProcess({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      cwd: process.cwd(),
      logger: nullLogger,
      label: 'ASR',
    });

    await worker.close('shutdown-before-start');
    await assert.rejects(worker.ensureStarted(), /ASR worker is closed/);
  });

  it('can restart after an unexpected process exit during normal operation', async () => {
    let resolveExit = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const worker = new WorkerProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(23)'],
      cwd: process.cwd(),
      logger: nullLogger,
      label: 'ASR',
      onExit: resolveExit,
    });

    await worker.ensureStarted();
    await exited;
    await worker.ensureStarted();
    await worker.close('shutdown-after-restart');
  });

  it('fences a timed-out child and serves the next request from a fresh process', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'openmurmur-worker-'));
    const generationFile = join(directory, 'generation');
    t.after(() => rm(directory, { force: true, recursive: true }));

    const worker = new WorkerProcess({
      command: process.execPath,
      args: ['-e', GENERATIONAL_WORKER, generationFile],
      cwd: process.cwd(),
      logger: nullLogger,
      label: 'ASR',
    });
    t.after(() => worker.close('shutdown-after-timeout-test'));

    await worker.ensureStarted();
    await waitForGeneration(generationFile, 1);

    const outcomes = await Promise.allSettled([
      worker.send({ id: 'timed-out', op: 'ping' }, 30),
      worker.send({ id: 'blocked-behind-timeout', op: 'ping' }, 5000),
    ]);
    assert.equal(outcomes[0]?.status, 'rejected');
    assert.equal(outcomes[1]?.status, 'rejected');
    if (outcomes[0]?.status !== 'rejected' || outcomes[1]?.status !== 'rejected') return;
    assert.match(outcomes[0].reason.message, /did not answer "ping" within 30 ms/);
    assert.equal(outcomes[1].reason.message, outcomes[0].reason.message);
    assert.equal(worker.running, false);

    await worker.ensureStarted();
    await waitForGeneration(generationFile, 2);
    const response = await worker.send({ id: 'fresh-child', op: 'ping' }, 1000);
    assert.equal(response.ok, true);
    assert.equal(response.op, 'ping');
    if (response.ok && response.op === 'ping') assert.equal(response.worker_version, '2');
  });

  it('SIGKILLs a timed-out generation and serves the next request on a fresh child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openmurmur-worker-timeout-'));
    let exits = 0;
    const worker = fakeWorker('timeout-once', dir, () => {
      exits += 1;
    });
    try {
      await worker.ensureStarted();
      await waitForReady(dir);
      const results = await Promise.allSettled([
        worker.send({ id: 'wedged', op: 'ping' }, 200),
        worker.send({ id: 'queued-behind-wedge', op: 'ping' }, 5000),
      ]);
      assert.equal(results[0]?.status, 'rejected');
      assert.equal(results[1]?.status, 'rejected', 'all work queued on the wedged child must fail');
      assert.equal(exits, 1, 'the retired generation invalidates owner state exactly once');
      assert.match(
        results[0]?.status === 'rejected' ? String(results[0].reason) : '',
        /did not answer "ping" within 200 ms/,
      );

      await worker.ensureStarted();
      const response = await worker.send({ id: 'fresh', op: 'ping' }, 1000);
      assert.equal(response.ok, true);
      assert.equal(response.id, 'fresh');
      assert.equal(exits, 1, 'the old physical close must not invalidate the fresh generation');
      assert.equal(existsSync(join(dir, 'term.seen')), true, 'the old child received SIGTERM');
      assertProcessExited(readFirstPid(dir));
    } finally {
      await worker.close('shutdown-timeout-test');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds intentional close even when shutdown and SIGTERM are ignored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openmurmur-worker-close-'));
    const worker = fakeWorker('stuck', dir);
    try {
      await worker.ensureStarted();
      await waitForReady(dir);
      const pending = assert.rejects(
        worker.send({ id: 'active-during-close', op: 'ping' }, 5000),
        /fake worker is closed/,
      );
      await worker.close('shutdown-stuck');
      await pending;

      assert.equal(existsSync(join(dir, 'term.seen')), true);
      assertProcessExited(readFirstPid(dir));
      await assert.rejects(worker.ensureStarted(), /fake worker is closed/);
      await assert.rejects(worker.send({ id: 'after-close', op: 'ping' }, 100), /worker is closed/);
    } finally {
      await worker.close('shutdown-stuck-again');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let an old close event clear the generation started by its exit callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openmurmur-worker-generation-'));
    let worker: WorkerProcess;
    let exitCount = 0;
    let resolveRestart = () => {};
    let rejectRestart = (_error: unknown) => {};
    const restarted = new Promise<void>((resolve, reject) => {
      resolveRestart = resolve;
      rejectRestart = reject;
    });
    worker = fakeWorker('exit-once', dir, () => {
      exitCount += 1;
      if (exitCount === 1) void worker.ensureStarted().then(resolveRestart, rejectRestart);
    });

    try {
      await worker.ensureStarted();
      await restarted;
      assert.equal(worker.running, true);
      const response = await worker.send({ id: 'new-generation', op: 'ping' }, 1000);
      assert.equal(response.id, 'new-generation');
    } finally {
      await worker.close('shutdown-generation-test');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('worker recovery hint', () => {
  it('prints a doctor command that is runnable from the source checkout', () => {
    const hint = missingWorkerHint('uv', 'not found');

    assert.match(hint, /^ {2}pnpm openmurmur doctor\s+# re-checks every dependency$/m);
    assert.doesNotMatch(hint, /^ {2}openmurmur doctor/m);
  });
});

const GENERATIONAL_WORKER = String.raw`
const fs = require('node:fs');
const generationFile = process.argv[1];
let generation = 1;
try {
  generation = Number(fs.readFileSync(generationFile, 'utf8')) + 1;
} catch {}
fs.writeFileSync(generationFile, String(generation));

process.stdin.setEncoding('utf8');
let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '' || generation === 1) continue;
    const request = JSON.parse(line);
    const response = request.op === 'shutdown'
      ? { id: request.id, ok: true, op: 'shutdown' }
      : { id: request.id, ok: true, op: 'ping', worker_version: String(generation) };
    process.stdout.write(JSON.stringify(response) + '\n');
    if (request.op === 'shutdown') process.exit(0);
  }
});
`;

async function waitForGeneration(file: string, expected: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(file, 'utf8')) === String(expected)) return;
    } catch {
      // The child has not reached its first instruction yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`worker generation ${expected} did not start`);
}
