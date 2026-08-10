import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WORKER_ARGS } from '../../src/cli/backends.ts';

describe('local audio worker launch contract', () => {
  it('never installs or synchronizes Python dependencies at daemon or doctor runtime', () => {
    assert.deepEqual(WORKER_ARGS.slice(0, 3), ['run', '--no-sync', '--project']);
    assert.equal(WORKER_ARGS.at(-1), 'openmurmur-audio-worker');
  });
});
