import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function referenceProgram(): string {
  const document = readFileSync(join(REPOSITORY, 'docs', 'INSTALL.md'), 'utf8');
  const match = document.match(
    /Index the earlier persistent D121 evidence[\s\S]*?<<'NODE'\n([\s\S]*?)\nNODE\n```\n\nFor a custom state root/,
  );
  const program = match?.[1];
  assert.ok(program, 'the exact D121 reference program must be extractable');
  return program;
}

it('publishes the D121 reference crash-convergently without overwriting conflicts', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'openmurmur-d121-reference-')));
  const d121 = join(root, 'd121');
  const release = join(root, 'release');
  mkdirSync(d121, { mode: 0o700 });
  mkdirSync(release, { mode: 0o700 });
  const artifactName = 'rollback.status.json';
  const artifactPath = join(d121, artifactName);
  writeFileSync(artifactPath, '{"ok":true}\n', { mode: 0o600 });
  const artifactBytes = readFileSync(artifactPath);
  const commit = 'a'.repeat(40);
  const manifestPath = join(d121, 'D121.evidence-manifest.json');
  const output = join(release, 'D121.reference.json');
  const manifest = {
    schemaVersion: 1,
    kind: 'openmurmur-d121-evidence',
    repositoryCommit: commit,
    evidenceDirectory: d121,
    files: [
      {
        path: artifactName,
        bytes: artifactBytes.length,
        sha256: createHash('sha256').update(artifactBytes).digest('hex'),
      },
    ],
  };
  const writeManifest = () =>
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeManifest();
  writeFileSync(
    join(release, 'release-signoff-v2.json'),
    `${JSON.stringify({
      releaseCommit: commit,
      requiredLiveEvidenceReferences: { D121: output },
    })}\n`,
    { mode: 0o600 },
  );

  const run = () =>
    spawnSync(process.execPath, ['--input-type=module', '-', manifestPath, output, release], {
      input: referenceProgram(),
      encoding: 'utf8',
    });
  const runAsync = () => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-', manifestPath, output, release],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end(referenceProgram());
    return new Promise<{ status: number | null; stderr: string }>((resolve) => {
      child.once('close', (status) => resolve({ status, stderr }));
    });
  };
  const waitForStage = async () => {
    const deadline = Date.now() + 5000;
    while (!readdirSync(release).some((name) => name.startsWith('.D121-reference.'))) {
      if (Date.now() >= deadline) throw new Error('timed out waiting for private reference stage');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const referenceBytes = readFileSync(output);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(release).toSorted(), [
      'D121.reference.json',
      'release-signoff-v2.json',
    ]);

    const rerun = run();
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.deepEqual(readFileSync(output), referenceBytes);

    rmSync(output);
    writeFileSync(output, 'foreign-reference\n', { mode: 0o600 });
    const conflict = run();
    assert.notEqual(conflict.status, 0);
    assert.equal(readFileSync(output, 'utf8'), 'foreign-reference\n');

    rmSync(output);
    writeFileSync(output, referenceBytes, { mode: 0o600 });
    chmodSync(output, 0o600);
    const visibleBeforeFsync = run();
    assert.equal(visibleBeforeFsync.status, 0, visibleBeforeFsync.stderr);
    assert.deepEqual(readFileSync(output), referenceBytes);

    rmSync(output);
    const largeArtifact = Buffer.alloc(32 * 1024 * 1024, 0x61);
    writeFileSync(artifactPath, largeArtifact);
    manifest.files[0] = {
      path: artifactName,
      bytes: largeArtifact.length,
      sha256: createHash('sha256').update(largeArtifact).digest('hex'),
    };
    writeManifest();
    const mutationRun = runAsync();
    await waitForStage();
    const artifactFd = openSync(artifactPath, 'r+');
    try {
      writeSync(artifactFd, Buffer.from([0x62]), 0, 1, 0);
    } finally {
      closeSync(artifactFd);
    }
    const mutationResult = await mutationRun;
    assert.notEqual(mutationResult.status, 0, 'artifact mutation must fail final reproof');
    assert.equal(readdirSync(release).includes('D121.reference.json'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
