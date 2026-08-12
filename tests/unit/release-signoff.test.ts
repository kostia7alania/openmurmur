import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_SIGNOFF = join(REPO, 'scripts', 'release-signoff');
const DIGEST = 'a'.repeat(64);

function run(command: string, args: readonly string[], cwd: string, home?: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env:
      home === undefined
        ? process.env
        : { ...process.env, HOME: home, PATH: `${join(home, 'tool-bin')}:${process.env['PATH']}` },
  });
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = run('/usr/bin/git', args, cwd);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function writePlist(
  path: string,
  label: 'io.openmurmur.daemon' | 'io.openmurmur.digest',
  repository: string,
  node: string,
  stateRoot: string,
): void {
  const command = label.endsWith('daemon')
    ? ['start', '--root', stateRoot]
    : ['digest', 'scheduled', '--root', stateRoot];
  const argumentsXml = [node, join(repository, 'src', 'cli', 'main.ts'), ...command]
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join('\n');
  writeFileSync(
    path,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '  <dict>',
      '    <key>Label</key>',
      `    <string>${label}</string>`,
      '    <key>ProgramArguments</key>',
      '    <array>',
      argumentsXml,
      '    </array>',
      '    <key>WorkingDirectory</key>',
      `    <string>${escapeXml(repository)}</string>`,
      '  </dict>',
      '</plist>',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
}

function writeInstalledBoundary(home: string, repository: string, stateRoot: string): void {
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const node = realpathSync(process.execPath);
  writePlist(
    join(agents, 'io.openmurmur.daemon.plist'),
    'io.openmurmur.daemon',
    repository,
    node,
    stateRoot,
  );
  writePlist(
    join(agents, 'io.openmurmur.digest.plist'),
    'io.openmurmur.digest',
    repository,
    node,
    stateRoot,
  );
}

function createFixtureRepository(root: string): string {
  const repository = join(root, 'source');
  const node = realpathSync(process.execPath).replaceAll("'", "'\"'\"'");
  mkdirSync(join(repository, 'scripts'), { recursive: true });
  mkdirSync(join(repository, 'src', 'cli'), { recursive: true });
  copyFileSync(RELEASE_SIGNOFF, join(repository, 'scripts', 'release-signoff'));
  chmodSync(join(repository, 'scripts', 'release-signoff'), 0o700);
  writeFileSync(join(repository, 'src', 'cli', 'main.ts'), 'process.stdout.write("fixture");\n');
  writeFileSync(
    join(repository, 'runtime-requirements.json'),
    `${JSON.stringify({ schemaVersion: 1, nodeMinimum: '26.7.0', sqliteMinimum: '3.53.4', pnpmExact: '10.19.0' }, null, 2)}\n`,
  );
  writeFileSync(
    join(repository, 'scripts', 'install-capture-app'),
    [
      '#!/bin/bash',
      'set -e',
      '[ "$#" -eq 1 ] && [ "$1" = --check ]',
      'count_file="$HOME/capture-check-count"',
      'count=0',
      '[ ! -f "$count_file" ] || count="$(cat "$count_file")"',
      'count=$((count + 1))',
      'printf "%s\\n" "$count" > "$count_file"',
      'if [ -f "$HOME/mutate-on-second-check" ] && [ "$count" -eq 2 ]; then',
      '  printf "\\n" >> "$HOME/Library/LaunchAgents/io.openmurmur.daemon.plist"',
      'fi',
      'if [ -f "$HOME/mutate-staged-receipt" ]; then',
      '  evidence_dir="$(cat "$HOME/mutate-staged-receipt")"',
      '  set -- "$evidence_dir"/.release-signoff.*/release-verification-v1.json',
      '  if [ "$#" -eq 1 ] && [ -f "$1" ]; then',
      `    '${node}' --input-type=module -e 'import { readFileSync, writeFileSync } from "node:fs"; const path = process.argv[1]; const value = JSON.parse(readFileSync(path, "utf8")); value.gates[0].stdoutSha256 = "b".repeat(64); writeFileSync(path, JSON.stringify(value, null, 2) + "\\n");' "$1"`,
      '  fi',
      'fi',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(join(repository, 'scripts', 'install-capture-app'), 0o700);
  runGit(repository, ['init', '-q']);
  runGit(repository, ['config', 'user.email', 'release-signoff@example.invalid']);
  runGit(repository, ['config', 'user.name', 'Release Signoff Fixture']);
  runGit(repository, ['add', '.']);
  runGit(repository, ['commit', '-q', '-m', 'fixture']);
  return realpathSync(repository);
}

function createNativeHelper(home: string): void {
  const executable = join(
    home,
    'Applications',
    'OpenMurmur Capture.app',
    'Contents',
    'MacOS',
    'OpenMurmurCapture',
  );
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(
    executable,
    [
      '#!/bin/bash',
      `case "\${1:-}" in`,
      `  --source-digest) printf '%s\\n' '${DIGEST}' ;;`,
      `  --authorization-status) printf '%s\\n' '{"authorized":true,"status":"authorized"}' ;;`,
      '  *) exit 64 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
}

function createReleaseTools(home: string): void {
  const tools = join(home, 'tool-bin');
  mkdirSync(tools, { recursive: true });
  const node = realpathSync(process.execPath).replaceAll("'", "'\"'\"'");
  writeFileSync(
    join(tools, 'pnpm'),
    [
      '#!/bin/bash',
      'set -eu',
      `case "\${1:-}" in`,
      '  --version) [ "$#" -eq 1 ]; printf \'%s\\n\' 10.19.0 ;;',
      '  exec)',
      '    [ "$#" -eq 4 ] && [ "$2" = node ] && [ "$3" = -p ] && [ "$4" = process.execPath ]',
      `    printf '%s\\n' '${node}'`,
      '    ;;',
      '  install)',
      '    [ "$#" -eq 3 ] && [ "$2" = --offline ] && [ "$3" = --frozen-lockfile ]',
      "    printf '%s\\n' 'pnpm install --offline --frozen-lockfile' >> \"$HOME/release-gates.log\"",
      "    printf '%s\\n' 'offline install complete'",
      '    ;;',
      '  run)',
      '    [ "$#" -eq 2 ] && [ "$2" = check ]',
      "    printf '%s\\n' 'pnpm run check' >> \"$HOME/release-gates.log\"",
      '    if [ -f "$HOME/fail-node-check" ]; then',
      "      printf '%s\\n' 'deterministic check failure' >&2",
      '      exit 9',
      '    fi',
      "    printf '%s\\n' 'node check complete'",
      '    ;;',
      '  *) exit 64 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  writeFileSync(
    join(tools, 'uv'),
    [
      '#!/bin/bash',
      'set -eu',
      'if [ "$#" -eq 1 ] && [ "$1" = --version ]; then',
      "  printf '%s\\n' 'uv 0.12.2 (fixture)'",
      '  exit 0',
      'fi',
      '[ "$#" -eq 6 ]',
      '[ "$1" = run ] && [ "$2" = --offline ] && [ "$3" = --no-sync ]',
      '[ "$4" = --project ] && [ "$5" = python/openmurmur_audio ] && [ "$6" = pytest ]',
      "printf '%s\\n' 'uv run --offline --no-sync --project python/openmurmur_audio pytest' >> \"$HOME/release-gates.log\"",
      "printf '%s\\n' 'python tests complete'",
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(join(tools, 'pnpm'), 0o700);
  chmodSync(join(tools, 'uv'), 0o700);
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

describe('release sign-off provenance', () => {
  it('publishes only green offline gates and rejects receipt or source drift', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'openmurmur-release-signoff-')));
    try {
      const repository = createFixtureRepository(root);
      const home = join(root, 'home');
      const stateRoot = join(root, 'state');
      const evidence = join(root, 'evidence');
      const failedEvidence = join(root, 'failed-evidence');
      const racedEvidence = join(root, 'raced-evidence');
      mkdirSync(join(home, 'Library'), { recursive: true });
      mkdirSync(stateRoot, { recursive: true });
      mkdirSync(evidence, { mode: 0o700 });
      mkdirSync(failedEvidence, { mode: 0o700 });
      mkdirSync(racedEvidence, { mode: 0o700 });
      chmodSync(evidence, 0o700);
      chmodSync(failedEvidence, 0o700);
      chmodSync(racedEvidence, 0o700);
      createNativeHelper(home);
      createReleaseTools(home);
      writeInstalledBoundary(home, repository, stateRoot);

      writeFileSync(join(home, 'fail-node-check'), 'armed\n');
      const failedPrepare = run(
        'bash',
        [
          join(repository, 'scripts', 'release-signoff'),
          '--prepare',
          '--evidence-dir',
          failedEvidence,
          '--root',
          stateRoot,
        ],
        repository,
        home,
      );
      assert.notEqual(failedPrepare.status, 0);
      assert.match(failedPrepare.stderr, /node-check failed with exit code 9/);
      assert.throws(() => readFileSync(join(failedEvidence, 'release-verification-v1.json')));
      assert.throws(() => readFileSync(join(failedEvidence, 'release-signoff-v2.json')));
      rmSync(join(home, 'fail-node-check'));
      rmSync(join(home, 'release-gates.log'));

      writeFileSync(join(home, 'mutate-staged-receipt'), `${racedEvidence}\n`);
      const racedPrepare = run(
        'bash',
        [
          join(repository, 'scripts', 'release-signoff'),
          '--prepare',
          '--evidence-dir',
          racedEvidence,
          '--root',
          stateRoot,
        ],
        repository,
        home,
      );
      assert.notEqual(racedPrepare.status, 0);
      assert.match(racedPrepare.stderr, /staged release receipt changed before publication/);
      assert.throws(() => readFileSync(join(racedEvidence, 'release-verification-v1.json')));
      assert.throws(() => readFileSync(join(racedEvidence, 'release-signoff-v2.json')));
      rmSync(join(home, 'mutate-staged-receipt'));
      rmSync(join(home, 'release-gates.log'));

      const prepare = run(
        'bash',
        [
          join(repository, 'scripts', 'release-signoff'),
          '--prepare',
          '--evidence-dir',
          evidence,
          '--root',
          stateRoot,
        ],
        repository,
        home,
      );
      assert.equal(prepare.status, 0, `${prepare.stdout}\n${prepare.stderr}`);
      const receiptPath = join(evidence, 'release-verification-v1.json');
      const manifestPath = join(evidence, 'release-signoff-v2.json');
      const receiptRaw = readFileSync(receiptPath, 'utf8');
      const receipt = JSON.parse(receiptRaw);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.releaseCommit, runGit(repository, ['rev-parse', 'HEAD']));
      assert.equal(manifest.repository.path, repository);
      assert.equal(manifest.verificationReceipt.path, receiptPath);
      assert.equal(manifest.verificationReceipt.sha256, sha256(receiptRaw));
      assert.equal(receipt.releaseCommit, manifest.releaseCommit);
      assert.equal(receipt.tools.pnpm.version, '10.19.0');
      assert.equal(receipt.tools.uv.version, 'uv 0.12.2 (fixture)');
      assert.deepEqual(
        receipt.gates.map((gate: { id: string; exitCode: number }) => [gate.id, gate.exitCode]),
        [
          ['pnpm-install', 0],
          ['node-check', 0],
          ['python-pytest', 0],
        ],
      );
      assert.equal(
        manifest.requiredLiveEvidenceReferences.D122,
        join(evidence, 'D122.reference.json'),
      );
      const gateLog = readFileSync(join(home, 'release-gates.log'), 'utf8');

      const exactCheck = run(
        'bash',
        [join(repository, 'scripts', 'release-signoff'), '--check', '--evidence-dir', evidence],
        repository,
        home,
      );
      assert.equal(exactCheck.status, 0, `${exactCheck.stdout}\n${exactCheck.stderr}`);
      assert.equal(readFileSync(join(home, 'release-gates.log'), 'utf8'), gateLog);

      const tamperedReceipt = JSON.parse(receiptRaw);
      tamperedReceipt.gates[0].stdoutSha256 = 'b'.repeat(64);
      writeFileSync(receiptPath, `${JSON.stringify(tamperedReceipt, null, 2)}\n`, { mode: 0o600 });
      const tamperedCheck = run(
        'bash',
        [join(repository, 'scripts', 'release-signoff'), '--check', '--evidence-dir', evidence],
        repository,
        home,
      );
      assert.notEqual(tamperedCheck.status, 0);
      assert.match(tamperedCheck.stderr, /release provenance drift detected/);
      writeFileSync(receiptPath, receiptRaw, { mode: 0o600 });

      rmSync(join(home, 'capture-check-count'));
      writeFileSync(join(home, 'mutate-on-second-check'), 'armed\n');
      const incoherentCheck = run(
        'bash',
        [join(repository, 'scripts', 'release-signoff'), '--check', '--evidence-dir', evidence],
        repository,
        home,
      );
      assert.notEqual(incoherentCheck.status, 0);
      assert.match(incoherentCheck.stderr, /provenance changed during inspection/);
      rmSync(join(home, 'mutate-on-second-check'));
      rmSync(join(home, 'capture-check-count'));
      writeInstalledBoundary(home, repository, stateRoot);

      writeFileSync(join(repository, 'untracked-release-change'), 'dirty\n');
      const dirtyCheck = run(
        'bash',
        [join(repository, 'scripts', 'release-signoff'), '--check', '--evidence-dir', evidence],
        repository,
        home,
      );
      assert.notEqual(dirtyCheck.status, 0);
      assert.match(dirtyCheck.stderr, /worktree is dirty/);
      rmSync(join(repository, 'untracked-release-change'));

      const otherCheckout = join(root, 'other-source');
      runGit(root, ['clone', '-q', repository, otherCheckout]);
      writeInstalledBoundary(home, realpathSync(otherCheckout), stateRoot);
      const wrongCheckout = run(
        'bash',
        [join(repository, 'scripts', 'release-signoff'), '--check', '--evidence-dir', evidence],
        repository,
        home,
      );
      assert.notEqual(wrongCheckout.status, 0);
      assert.match(
        wrongCheckout.stderr,
        /installed agents do not point at the selected source repository/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
