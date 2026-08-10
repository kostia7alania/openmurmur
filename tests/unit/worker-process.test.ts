import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WorkerProcess } from '../../src/asr/worker-process.ts';
import { nullLogger } from '../../src/logging/logger.ts';

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
