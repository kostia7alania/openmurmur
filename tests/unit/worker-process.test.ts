import assert from 'node:assert/strict';
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
});
