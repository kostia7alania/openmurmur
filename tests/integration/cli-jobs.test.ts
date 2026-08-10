import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { JobQueue } from '../../src/jobs/queue.ts';

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'om-cli-jobs-'));
  db = openDatabase({ file: join(root, 'openmurmur.db') });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, ['src/cli/main.ts', ...args, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function exhaust(kind: 'summarize' | 'retention'): string {
  const jobs = new JobQueue(db.handle);
  jobs.enqueue({ kind, idempotencyKey: `${kind}:cli`, payload: {}, maxAttempts: 1 });
  const claimed = jobs.claim([kind]);
  assert.ok(claimed);
  jobs.fail(claimed.jobId, kind === 'summarize' ? 'Ollama is not reachable' : 'legacy failure');
  return claimed.jobId;
}

describe('failed-job CLI recovery', () => {
  it('lists the local cause as JSON and re-queues one selected job', () => {
    const jobId = exhaust('summarize');

    const listed = run('jobs', 'failed', '--json');
    assert.equal(listed.status, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout) as {
      hostName: string;
      failedJobs: { jobId: string; kind: string; lastError: string }[];
    };
    assert.ok(payload.hostName.length > 0);
    assert.deepEqual(payload.failedJobs, [
      {
        ...payload.failedJobs[0],
        jobId,
        kind: 'summarize',
        lastError: 'Ollama is not reachable',
      },
    ]);

    const retried = run('jobs', 'retry', jobId);
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /It will run when the OpenMurmur daemon is running/);
    assert.equal(new JobQueue(db.handle).pendingCount('summarize'), 1);
  });

  it('refuses a legacy kind that no daemon loop can execute', () => {
    const jobId = exhaust('retention');

    const retried = run('jobs', 'retry', jobId);
    assert.equal(retried.status, 1);
    assert.match(retried.stderr, /has no daemon worker and cannot be retried/);
    assert.equal(new JobQueue(db.handle).deadCount(), 1);
  });
});
