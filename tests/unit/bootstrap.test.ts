import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOTSTRAP = join(REPO, 'scripts', 'bootstrap');

function writeExecutable(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePnpm(path: string, version: string): void {
  writeExecutable(path, [
    '#!/bin/sh',
    'printf \'pnpm %s\\n\' "$*" >> "$BOOTSTRAP_LOG"',
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' '${version}'`,
    '  exit 0',
    'fi',
  ]);
}

function runBootstrap(initialPnpmVersion?: string, nodeVersion = '26.8.1') {
  const home = mkdtempSync(join(tmpdir(), 'om-bootstrap-'));
  const bin = join(home, 'bin');
  const log = join(home, 'commands.log');
  const installedPnpm = join(home, 'installed-pnpm');
  mkdirSync(bin);
  writeFileSync(log, '');

  symlinkSync('/bin/cat', join(bin, 'cat'));
  symlinkSync('/usr/bin/dirname', join(bin, 'dirname'));
  symlinkSync('/usr/bin/head', join(bin, 'head'));

  writeExecutable(join(bin, 'uname'), [
    '#!/bin/sh',
    'case "$1" in',
    "  -s) printf 'Darwin\\n' ;;",
    "  -m) printf 'arm64\\n' ;;",
    '  *) exit 2 ;;',
    'esac',
  ]);
  writeExecutable(join(bin, 'node'), [
    '#!/bin/sh',
    `if [ "$1" = "-v" ]; then printf 'v%s\\n' '${nodeVersion}'; exit 0; fi`,
    'if [ "$1" = "--input-type=module" ]; then',
    `  if [ '${nodeVersion}' = '26.8.1' ]; then`,
    "    printf '26.8.1\\t3.53.4\\t11.25.0'",
    '    exit 0',
    '  fi',
    `  printf 'Node %s is below 26.8.1' '${nodeVersion}' >&2`,
    '  exit 1',
    'fi',
    'exit 0',
  ]);
  writePnpm(installedPnpm, '11.25.0');
  writeExecutable(join(bin, 'npm'), [
    '#!/bin/sh',
    'printf \'npm %s\\n\' "$*" >> "$BOOTSTRAP_LOG"',
    '/bin/cp "$INSTALLED_PNPM" "$PNPM_DESTINATION"',
    '/bin/chmod 700 "$PNPM_DESTINATION"',
  ]);
  writeExecutable(join(bin, 'ffmpeg'), ['#!/bin/sh', "printf 'ffmpeg version mock\\n'"]);
  writeExecutable(join(bin, 'uv'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then printf \'uv 0.9.0\\n\'; exit 0; fi',
    'printf \'uv %s\\n\' "$*" >> "$BOOTSTRAP_LOG"',
  ]);

  if (initialPnpmVersion !== undefined) {
    writePnpm(join(bin, 'pnpm'), initialPnpmVersion);
  }

  const result = spawnSync('/bin/bash', [BOOTSTRAP], {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      BOOTSTRAP_LOG: log,
      HOME: home,
      INSTALLED_PNPM: installedPnpm,
      PATH: bin,
      PNPM_DESTINATION: join(bin, 'pnpm'),
    },
  });

  return {
    cleanup: () => rmSync(home, { recursive: true, force: true }),
    log: readFileSync(log, 'utf8'),
    result,
  };
}

describe('bootstrap package-manager provisioning', () => {
  it('installs the exact pnpm version with npm when pnpm and Corepack are absent', () => {
    const run = runBootstrap();
    try {
      assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
      assert.match(run.log, /^npm install --global pnpm@11\.25\.0$/m);
      assert.match(run.result.stdout, /pnpm 11\.25\.0/);
      assert.doesNotMatch(`${run.result.stdout}\n${run.result.stderr}`, /corepack/i);
    } finally {
      run.cleanup();
    }
  });

  it('replaces a different pnpm version with the exact pinned version', () => {
    const run = runBootstrap('9.15.0');
    try {
      assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
      assert.match(run.result.stdout, /pnpm 9\.15\.0 found/);
      assert.match(run.log, /^npm install --global pnpm@11\.25\.0$/m);
      assert.match(run.result.stdout, /pnpm 11\.25\.0/);
    } finally {
      run.cleanup();
    }
  });

  it('does not reinstall an already-correct pnpm', () => {
    const run = runBootstrap('11.25.0');
    try {
      assert.equal(run.result.status, 0, `${run.result.stdout}\n${run.result.stderr}`);
      assert.doesNotMatch(run.log, /^npm /m);
      assert.match(run.log, /^pnpm install --frozen-lockfile$/m);
      assert.match(run.result.stdout, /pnpm 11\.25\.0/);
    } finally {
      run.cleanup();
    }
  });

  it('rejects pnpm before use when the active Node runtime is incompatible', () => {
    const run = runBootstrap('11.25.0', '26.2.0');
    try {
      assert.equal(run.result.status, 1, `${run.result.stdout}\n${run.result.stderr}`);
      assert.match(run.result.stderr, /Node 26\.2\.0 is below 26\.8\.1/);
      assert.doesNotMatch(run.log, /^(npm|pnpm) /m);
    } finally {
      run.cleanup();
    }
  });
});
