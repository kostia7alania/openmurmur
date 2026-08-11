import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(REPO, 'scripts', 'install-capture-app');

function writeFixtureRepository(root: string): void {
  const scripts = join(root, 'scripts');
  const native = join(root, 'native', 'OpenMurmurCapture');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(native, { recursive: true });
  copyFileSync(INSTALLER, join(scripts, 'install-capture-app'));
  chmodSync(join(scripts, 'install-capture-app'), 0o700);

  const helperSource = join(native, 'helper.c');
  const helperFixture = join(native, 'helper-fixture');
  writeFileSync(
    helperSource,
    [
      '#include <limits.h>',
      '#include <stdio.h>',
      '#include <stdlib.h>',
      '#include <string.h>',
      '#include <unistd.h>',
      '',
      'static void log_mode(const char *mode) {',
      '  const char *path = getenv("CAPTURE_HELPER_LOG");',
      '  if (path == NULL) return;',
      '  FILE *file = fopen(path, "a");',
      '  if (file == NULL) return;',
      '  fprintf(file, "%s\\n", mode);',
      '  fclose(file);',
      '}',
      '',
      'int main(int argc, char **argv) {',
      '  if (argc != 2) return 64;',
      '  log_mode(argv[1]);',
      '  if (strcmp(argv[1], "--authorization-status") == 0) {',
      '    puts("{\\"authorized\\":true,\\"status\\":\\"authorized\\"}");',
      '    return 0;',
      '  }',
      '  if (strcmp(argv[1], "--self-check") == 0) return 0;',
      '  if (strcmp(argv[1], "--source-digest") == 0) {',
      '    char executable[PATH_MAX];',
      '    if (realpath(argv[0], executable) == NULL) return 70;',
      '    char *marker = strstr(executable, "/Contents/MacOS/OpenMurmurCapture");',
      '    if (marker == NULL) return 70;',
      '    strcpy(marker, "/Contents/Resources/source.sha256");',
      '    FILE *file = fopen(executable, "r");',
      '    if (file == NULL) return 70;',
      '    char digest[66];',
      '    if (fgets(digest, sizeof(digest), file) == NULL) return 70;',
      '    fclose(file);',
      '    fputs(digest, stdout);',
      '    return 0;',
      '  }',
      '  return 64;',
      '}',
      '',
    ].join('\n'),
  );
  const compile = spawnSync('/usr/bin/xcrun', ['clang', helperSource, '-o', helperFixture], {
    encoding: 'utf8',
  });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);

  writeFileSync(
    join(native, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleExecutable</key>',
      '  <string>OpenMurmurCapture</string>',
      '  <key>CFBundleIdentifier</key>',
      '  <string>io.openmurmur.capture</string>',
      '  <key>CFBundlePackageType</key>',
      '  <string>APPL</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );
  writeFileSync(join(native, 'digest.txt'), `${'a'.repeat(64)}\n`);
  writeFileSync(
    join(native, 'Entitlements.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '  <key>com.apple.security.device.audio-input</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(native, 'build.sh'),
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'native_dir="$(cd "$(dirname "$0")" && pwd)"',
      `if [ "\${1:-}" = "--source-digest" ]; then`,
      '  [ "$#" -eq 1 ] || exit 64',
      '  /bin/cat "$native_dir/digest.txt"',
      '  exit 0',
      'fi',
      '[ "$#" -eq 0 ] || exit 64',
      `build_dir="\${OPENMURMUR_CAPTURE_BUILD_DIR:?}"`,
      'app="$build_dir/OpenMurmur Capture.app"',
      '/bin/mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"',
      '/bin/cp "$native_dir/Info.plist" "$app/Contents/Info.plist"',
      '/bin/cp "$native_dir/helper-fixture" "$app/Contents/MacOS/OpenMurmurCapture"',
      '/bin/chmod 700 "$app/Contents/MacOS/OpenMurmurCapture"',
      '/bin/cp "$native_dir/digest.txt" "$app/Contents/Resources/source.sha256"',
      '/usr/bin/codesign --force --sign - --options runtime --entitlements "$native_dir/Entitlements.plist" "$app" >/dev/null',
      'printf "%s\\n" "$app"',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(join(native, 'build.sh'), 0o700);
}

it('installs at the stable path, checks drift, and restores or preserves rollback evidence', () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'om-capture-installer-')));
  const home = join(fixture, 'home');
  const mockBin = join(fixture, 'bin');
  const helperLog = join(fixture, 'helper.log');
  const failMarker = join(fixture, 'publish-failed');
  const installer = join(fixture, 'repo', 'scripts', 'install-capture-app');
  const digestFile = join(fixture, 'repo', 'native', 'OpenMurmurCapture', 'digest.txt');
  const installedApp = join(home, 'Applications', 'OpenMurmur Capture.app');
  const installedDigest = join(installedApp, 'Contents', 'Resources', 'source.sha256');
  const entitlements = join(fixture, 'repo', 'native', 'OpenMurmurCapture', 'Entitlements.plist');
  let preservedBuild = '';

  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(mockBin, { recursive: true });
    writeFixtureRepository(join(fixture, 'repo'));

    writeFileSync(
      join(mockBin, 'mv'),
      [
        '#!/bin/bash',
        'set -euo pipefail',
        `if [ "\${FAIL_CAPTURE_PUBLISH:-0}" = "1" ] && [[ "$1" == */staged.app ]]; then`,
        `  if [ ! -e "\${FAIL_CAPTURE_MARKER:?}" ]; then`,
        `    : > "\${FAIL_CAPTURE_MARKER}"`,
        '    exit 71',
        '  fi',
        'fi',
        `if [ "\${FAIL_CAPTURE_ROLLBACK:-0}" = "1" ] && [[ "$1" == */previous.app ]]; then`,
        '  exit 72',
        'fi',
        'exec /bin/mv "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(join(mockBin, 'mv'), 0o700);

    const run = (args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      spawnSync('bash', [installer, ...args], {
        cwd: join(fixture, 'repo'),
        encoding: 'utf8',
        env: {
          ...process.env,
          ...extraEnv,
          CAPTURE_HELPER_LOG: helperLog,
          HOME: home,
          PATH: `${mockBin}:${process.env['PATH'] ?? ''}`,
        },
      });

    const redirectedApplications = join(fixture, 'redirected-applications');
    mkdirSync(redirectedApplications);
    symlinkSync(redirectedApplications, join(home, 'Applications'));
    const redirected = run([]);
    assert.equal(redirected.status, 1, `${redirected.stdout}\n${redirected.stderr}`);
    assert.match(redirected.stderr, /HOME\/Applications is not a real directory/);
    assert.equal(existsSync(join(redirectedApplications, 'OpenMurmur Capture.app')), false);
    rmSync(join(home, 'Applications'));

    const installed = run([]);
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
    assert.match(installed.stdout, /Installed .*OpenMurmur Capture\.app/);
    assert.match(installed.stdout, /ad-hoc \(local proof only/);
    assert.equal(readFileSync(installedDigest, 'utf8'), `${'a'.repeat(64)}\n`);

    const checked = run(['--check']);
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    assert.match(checked.stdout, /Microphone authorization is granted/);

    const weakenedSignature = spawnSync(
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--entitlements', entitlements, installedApp],
      { encoding: 'utf8' },
    );
    assert.equal(
      weakenedSignature.status,
      0,
      `${weakenedSignature.stdout}\n${weakenedSignature.stderr}`,
    );
    const notHardened = run(['--check']);
    assert.equal(notHardened.status, 1, `${notHardened.stdout}\n${notHardened.stderr}`);
    assert.match(notHardened.stderr, /does not enable hardened runtime/);
    const restoredSignature = spawnSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        '-',
        '--options',
        'runtime',
        '--entitlements',
        entitlements,
        installedApp,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      restoredSignature.status,
      0,
      `${restoredSignature.stdout}\n${restoredSignature.stderr}`,
    );

    writeFileSync(digestFile, `${'b'.repeat(64)}\n`);
    const drifted = run(['--check']);
    assert.equal(drifted.status, 1, `${drifted.stdout}\n${drifted.stderr}`);
    assert.match(drifted.stderr, /source digest drift/);
    assert.equal(readFileSync(installedDigest, 'utf8'), `${'a'.repeat(64)}\n`);

    const rolledBack = run([], {
      FAIL_CAPTURE_MARKER: failMarker,
      FAIL_CAPTURE_PUBLISH: '1',
    });
    assert.equal(rolledBack.status, 1, `${rolledBack.stdout}\n${rolledBack.stderr}`);
    assert.match(rolledBack.stderr, /previous capture app was restored/);
    assert.equal(readFileSync(installedDigest, 'utf8'), `${'a'.repeat(64)}\n`);

    rmSync(failMarker);
    const updated = run([]);
    assert.equal(updated.status, 0, `${updated.stdout}\n${updated.stderr}`);
    assert.equal(readFileSync(installedDigest, 'utf8'), `${'b'.repeat(64)}\n`);

    writeFileSync(digestFile, `${'c'.repeat(64)}\n`);
    const incomplete = run([], {
      FAIL_CAPTURE_MARKER: failMarker,
      FAIL_CAPTURE_PUBLISH: '1',
      FAIL_CAPTURE_ROLLBACK: '1',
    });
    assert.equal(incomplete.status, 1, `${incomplete.stdout}\n${incomplete.stderr}`);
    assert.match(incomplete.stderr, /rollback evidence was preserved/);
    assert.equal(existsSync(installedApp), false);
    const evidence = readdirSync(join(home, 'Applications')).filter((name) =>
      name.startsWith('.openmurmur-capture-install.'),
    );
    assert.equal(evidence.length, 1);
    assert.equal(existsSync(join(home, 'Applications', evidence[0] ?? '', 'previous.app')), true);

    preservedBuild =
      incomplete.stderr.match(
        /build:\s+(\/private\/tmp\/openmurmur-capture-install\.[^\s]+)/,
      )?.[1] ?? '';
    assert.notEqual(preservedBuild, '');

    const invokedModes = readFileSync(helperLog, 'utf8');
    assert.match(invokedModes, /--self-check/);
    assert.match(invokedModes, /--authorization-status/);
    assert.doesNotMatch(invokedModes, /--authorize|--stream/);
  } finally {
    if (preservedBuild.startsWith('/private/tmp/openmurmur-capture-install.')) {
      rmSync(preservedBuild, { recursive: true, force: true });
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});
