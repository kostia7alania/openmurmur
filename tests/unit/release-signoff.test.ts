import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    env: home === undefined ? process.env : { ...process.env, HOME: home },
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

describe('release sign-off provenance', () => {
  it('binds a clean installed checkout and rejects dirty or different source', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'openmurmur-release-signoff-')));
    try {
      const repository = createFixtureRepository(root);
      const home = join(root, 'home');
      const stateRoot = join(root, 'state');
      const evidence = join(root, 'evidence');
      mkdirSync(join(home, 'Library'), { recursive: true });
      mkdirSync(stateRoot, { recursive: true });
      mkdirSync(evidence, { mode: 0o700 });
      chmodSync(evidence, 0o700);
      createNativeHelper(home);
      writeInstalledBoundary(home, repository, stateRoot);

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
      const manifest = JSON.parse(readFileSync(join(evidence, 'release-signoff-v1.json'), 'utf8'));
      assert.equal(manifest.releaseCommit, runGit(repository, ['rev-parse', 'HEAD']));
      assert.equal(manifest.repository.path, repository);
      assert.equal(
        manifest.requiredLiveEvidenceReferences.D122,
        join(evidence, 'D122.reference.json'),
      );

      const exactCheck = run(
        'bash',
        [join(repository, 'scripts', 'release-signoff'), '--check', '--evidence-dir', evidence],
        repository,
        home,
      );
      assert.equal(exactCheck.status, 0, `${exactCheck.stdout}\n${exactCheck.stderr}`);

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
