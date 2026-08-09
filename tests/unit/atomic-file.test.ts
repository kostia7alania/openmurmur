import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeTextAtomically } from '../../src/util/atomic-file.ts';

describe('atomic text files', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openmurmur-atomic-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('replaces the destination and leaves no temporary artefact', async () => {
    const path = join(directory, 'report.md');
    await writeTextAtomically(path, 'first');
    await writeTextAtomically(path, 'complete replacement');

    assert.equal(await readFile(path, 'utf8'), 'complete replacement');
    assert.deepEqual(await readdir(directory), ['report.md']);
  });
});
