import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(REPO, 'scripts', 'install-launch-agents');
const PLISTS = ['io.openmurmur.daemon.plist', 'io.openmurmur.digest.plist'] as const;
let nativeFixtureRoot = '';

function makeHome(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function nativeCaptureFixture(): string {
  if (nativeFixtureRoot !== '') {
    return join(nativeFixtureRoot, 'OpenMurmur Capture.app');
  }

  nativeFixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'om-launchd-native-fixture-')));
  const digestResult = spawnSync(
    'bash',
    [join(REPO, 'native', 'OpenMurmurCapture', 'build.sh'), '--source-digest'],
    { cwd: REPO, encoding: 'utf8' },
  );
  assert.equal(digestResult.status, 0, `${digestResult.stdout}\n${digestResult.stderr}`);
  const digest = digestResult.stdout.trim();
  assert.match(digest, /^[0-9a-f]{64}$/);

  const app = join(nativeFixtureRoot, 'OpenMurmur Capture.app');
  const executable = join(app, 'Contents', 'MacOS', 'OpenMurmurCapture');
  const resources = join(app, 'Contents', 'Resources');
  const source = join(nativeFixtureRoot, 'helper.c');
  const entitlements = join(nativeFixtureRoot, 'Entitlements.plist');
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    source,
    [
      '#include <stdio.h>',
      '#include <stdlib.h>',
      '#include <string.h>',
      '#include <unistd.h>',
      '',
      'int main(int argc, char **argv) {',
      '  if (argc != 2) return 64;',
      '  if (strcmp(argv[1], "--source-digest") == 0) {',
      `    puts("${digest}");`,
      '    return 0;',
      '  }',
      '  if (strcmp(argv[1], "--self-check") == 0) return 0;',
      '  if (strcmp(argv[1], "--authorization-status") == 0) {',
      '    const char *home = getenv("HOME");',
      '    char denied[4096];',
      '    if (home != NULL) {',
      '      snprintf(denied, sizeof(denied), "%s/native-capture-denied", home);',
      '      if (access(denied, F_OK) == 0) {',
      '        puts("{\\"authorized\\":false,\\"status\\":\\"denied\\"}");',
      '        return 77;',
      '      }',
      '    }',
      '    puts("{\\"authorized\\":true,\\"status\\":\\"authorized\\"}");',
      '    return 0;',
      '  }',
      '  return 64;',
      '}',
      '',
    ].join('\n'),
  );
  const compile = spawnSync('/usr/bin/xcrun', ['clang', source, '-o', executable], {
    encoding: 'utf8',
  });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  chmodSync(executable, 0o700);

  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
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
  writeFileSync(join(resources, 'source.sha256'), `${digest}\n`);
  writeFileSync(
    entitlements,
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
  const signed = spawnSync(
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, app],
    { encoding: 'utf8' },
  );
  assert.equal(signed.status, 0, `${signed.stdout}\n${signed.stderr}`);
  return app;
}

function prepareNativeCapture(home: string, stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(
    join(stateRoot, 'openmurmur.json'),
    `${JSON.stringify({ audio: { captureBackend: 'native' } })}\n`,
  );
  const applications = join(home, 'Applications');
  const installed = join(applications, 'OpenMurmur Capture.app');
  mkdirSync(applications, { recursive: true });
  rmSync(installed, { recursive: true, force: true });
  const copied = spawnSync('/bin/cp', ['-R', nativeCaptureFixture(), installed], {
    encoding: 'utf8',
  });
  assert.equal(copied.status, 0, `${copied.stdout}\n${copied.stderr}`);
}

after(() => {
  if (nativeFixtureRoot !== '') {
    rmSync(nativeFixtureRoot, { recursive: true, force: true });
  }
});

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderInstalledPlists(home: string, stateRoot: string): void {
  prepareNativeCapture(home, stateRoot);
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  for (const name of PLISTS) {
    const template = readFileSync(join(REPO, 'launchd', `${name}.example`), 'utf8');
    const rendered = template
      .replaceAll('__REPO_DIR__', escapeXml(REPO))
      .replaceAll('__NODE_BIN__', escapeXml(process.execPath))
      .replaceAll('__HOME__', escapeXml(home))
      .replaceAll('__STATE_ROOT__', escapeXml(resolve(stateRoot)));
    writeFileSync(join(agents, name), rendered, { mode: 0o600 });
  }
}

function runCheck(
  home: string,
  stateRoot: string,
  node = process.execPath,
  registeredLabels: readonly string[] = PLISTS.map((name) => name.replace(/\.plist$/, '')),
) {
  const mockBin = join(home, 'check-bin');
  mkdirSync(mockBin, { recursive: true });
  const launchctl = join(mockBin, 'launchctl');
  writeFileSync(
    launchctl,
    [
      '#!/bin/sh',
      '[ "$1" = "print" ] || exit 2',
      'case "$2" in',
      ...registeredLabels.map((label) => `  */${label}) exit 0 ;;`),
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(launchctl, 0o700);

  return spawnSync('bash', [INSTALLER, '--check', '--node', node, '--root', stateRoot], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${mockBin}:${process.env['PATH'] ?? ''}` },
  });
}

function prepareLaunchctlHealthMocks(
  home: string,
  healthStatus: Record<string, unknown>,
  unregisterDelayPolls = 0,
): {
  readonly bin: string;
  readonly launchLog: string;
  readonly node: string;
  readonly probes: string;
} {
  const bin = join(home, 'health-bin');
  const launchLog = join(home, 'launchctl.log');
  const probes = join(home, 'health-probes.log');
  const node = join(bin, 'node');
  mkdirSync(bin);

  writeFileSync(
    node,
    [
      '#!/bin/sh',
      `if [ "$1" = "--input-type=module" ] && [ "$3" = "${join(REPO, 'runtime-requirements.json')}" ]; then`,
      `  printf '%s\\t26.7.0\\t3.53.4' "${node}"`,
      '  exit 0',
      'fi',
      `if [ "$1" = "${join(REPO, 'src', 'cli', 'main.ts')}" ]; then`,
      `  printf 'probe\\n' >> "${probes}"`,
      `  printf '%s\\n' '${JSON.stringify(healthStatus)}'`,
      '  exit 0',
      'fi',
      `exec "${process.execPath}" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(node, 0o700);

  const launchctl = join(bin, 'launchctl');
  const launchState = join(home, 'launch-state');
  mkdirSync(launchState);
  for (const name of PLISTS) {
    writeFileSync(join(launchState, name.replace(/\.plist$/, '')), 'loaded\n');
  }
  writeFileSync(
    launchctl,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${launchLog}"`,
      'case "$1" in',
      '  print)',
      `    label="\${2##*/}"`,
      `    state="$(/bin/cat "${launchState}/$label" 2>/dev/null || printf absent)"`,
      '    if [ "$state" = "loaded" ]; then exit 0; fi',
      '    if [ "$state" = "removing" ]; then',
      `      remaining="$(/bin/cat "${launchState}/$label.remaining")"`,
      '      if [ "$remaining" -gt 0 ]; then',
      `        printf '%s\\n' "$((remaining - 1))" > "${launchState}/$label.remaining"`,
      '        exit 0',
      '      fi',
      `      printf 'absent\\n' > "${launchState}/$label"`,
      '    fi',
      '    exit 1',
      '    ;;',
      '  bootout)',
      `    label="\${2##*/}"`,
      `    printf 'removing\\n' > "${launchState}/$label"`,
      `    printf '%s\\n' "${unregisterDelayPolls}" > "${launchState}/$label.remaining"`,
      '    exit 0',
      '    ;;',
      '  bootstrap)',
      `    label="\${3##*/}"`,
      `    label="\${label%.plist}"`,
      `    [ "$(/bin/cat "${launchState}/$label" 2>/dev/null)" = "absent" ] || exit 37`,
      `    printf 'loaded\\n' > "${launchState}/$label"`,
      '    exit 0',
      '    ;;',
      'esac',
      'exit 2',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(launchctl, 0o700);

  const sleep = join(bin, 'sleep');
  writeFileSync(sleep, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(sleep, 0o700);

  return { bin, launchLog, node, probes };
}

describe('launch agent installation check', () => {
  it('rejects the runtime before touching the installation directory', () => {
    const home = makeHome('om-launchd-runtime-');
    try {
      const rejectedNode = join(home, 'incompatible-node');
      writeFileSync(
        rejectedNode,
        '#!/bin/sh\nprintf "%s\\n" "Node 26.2.0 is below 26.7.0; node:sqlite 3.53.1 is below 3.53.4" >&2\nexit 1\n',
        { mode: 0o700 },
      );
      chmodSync(rejectedNode, 0o700);

      const result = runCheck(home, join(home, 'state'), rejectedNode);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /Requested Node is incompatible/);
      assert.match(result.stderr, /Node 26\.2\.0 is below 26\.7\.0/);
      assert.equal(
        existsSync(join(home, 'Library', 'LaunchAgents')),
        false,
        'a rejected runtime must not create the install directory',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('gates launchd on native configuration and nonprompt capture authorization before writes', () => {
    const home = makeHome('om-launchd-capture-gate-');
    const stateRoot = join(home, 'state');
    const installerTmp = join(home, 'installer-tmp');
    const mockBin = join(home, 'capture-gate-bin');
    const launchLog = join(home, 'launchctl.log');
    const deniedMarker = join(home, 'native-capture-denied');
    try {
      mkdirSync(stateRoot);
      mkdirSync(installerTmp);
      mkdirSync(mockBin);
      writeFileSync(
        join(mockBin, 'launchctl'),
        ['#!/bin/sh', `printf '%s\n' "$*" >> "${launchLog}"`, '[ "$1" = "print" ]', ''].join('\n'),
        { mode: 0o700 },
      );
      chmodSync(join(mockBin, 'launchctl'), 0o700);

      const run = (args: readonly string[]) =>
        spawnSync('bash', [INSTALLER, ...args, '--node', process.execPath, '--root', stateRoot], {
          cwd: REPO,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            PATH: `${mockBin}:${process.env['PATH'] ?? ''}`,
            TMPDIR: installerTmp,
          },
        });

      const defaultFfmpeg = run(['--yes']);
      assert.equal(defaultFfmpeg.status, 1, `${defaultFfmpeg.stdout}\n${defaultFfmpeg.stderr}`);
      assert.match(defaultFfmpeg.stderr, /effective backend is ffmpeg/);
      assert.match(defaultFfmpeg.stderr, /pnpm openmurmur start/);
      assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);
      assert.equal(existsSync(launchLog), false);
      assert.deepEqual(readdirSync(installerTmp), []);

      writeFileSync(
        join(stateRoot, 'openmurmur.json'),
        `${JSON.stringify({ audio: { captureBackend: null } })}\n`,
      );
      const invalid = run(['--yes']);
      assert.equal(invalid.status, 1, `${invalid.stdout}\n${invalid.stderr}`);
      assert.match(invalid.stderr, /audio\.captureBackend must be "ffmpeg" or "native"/);
      assert.equal(existsSync(launchLog), false);
      assert.deepEqual(readdirSync(installerTmp), []);

      prepareNativeCapture(home, stateRoot);
      writeFileSync(deniedMarker, 'denied\n');
      const unauthorized = run(['--yes']);
      assert.equal(unauthorized.status, 1, `${unauthorized.stdout}\n${unauthorized.stderr}`);
      assert.match(unauthorized.stderr, /Native capture app preflight failed/);
      assert.match(unauthorized.stderr, /not authorized for the microphone/);
      assert.equal(existsSync(join(home, 'Library', 'LaunchAgents')), false);
      assert.equal(existsSync(launchLog), false);
      assert.deepEqual(readdirSync(installerTmp), []);

      rmSync(deniedMarker);
      renderInstalledPlists(home, stateRoot);
      const ready = run(['--check']);
      assert.equal(ready.status, 0, `${ready.stdout}\n${ready.stderr}`);
      assert.match(ready.stdout, /native capture app is signed, current and authorized/);
      assert.match(ready.stdout, /installed launch agents match this checkout/);
      assert.equal(readFileSync(launchLog, 'utf8').trim().split('\n').length, 2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts rendered agents only when runtime, root and templates all match', () => {
    const home = makeHome('om-launchd-current-');
    const stateRoot = join(home, 'state with spaces & privacy');
    try {
      renderInstalledPlists(home, stateRoot);

      const result = runCheck(home, stateRoot);

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /installed launch agents match this checkout/);
      assert.doesNotMatch(result.stderr, /mismatch|drift/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports runtime, state-root and template drift without rewriting the plists', () => {
    const home = makeHome('om-launchd-drift-');
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const digest = join(home, 'Library', 'LaunchAgents', 'io.openmurmur.digest.plist');
      const drifted = readFileSync(digest, 'utf8')
        .replace(`<string>${escapeXml(process.execPath)}</string>`, '<string>/wrong/node</string>')
        .replaceAll(escapeXml(resolve(stateRoot)), '/wrong/state');
      writeFileSync(digest, drifted, { mode: 0o600 });
      const before = readFileSync(digest, 'utf8');

      const result = runCheck(home, stateRoot);
      const output = `${result.stdout}\n${result.stderr}`;

      assert.equal(result.status, 1, output);
      assert.match(output, /runtime mismatch/);
      assert.match(output, /state-root mismatch/);
      assert.match(output, /template drift/);
      assert.equal(
        readFileSync(digest, 'utf8'),
        before,
        '--check must not rewrite installed state',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports an unregistered service separately from matching plist files', () => {
    const home = makeHome('om-launchd-unregistered-');
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const agents = join(home, 'Library', 'LaunchAgents');
      const before = new Map(
        PLISTS.map((name) => [name, readFileSync(join(agents, name), 'utf8')] as const),
      );

      const result = runCheck(home, stateRoot, process.execPath, ['io.openmurmur.daemon']);
      const output = `${result.stdout}\n${result.stderr}`;

      assert.equal(result.status, 1, output);
      assert.match(output, /io\.openmurmur\.digest is not registered with launchd/);
      assert.doesNotMatch(output, /runtime mismatch|state-root mismatch|template drift/);
      for (const [name, content] of before) {
        assert.equal(readFileSync(join(agents, name), 'utf8'), content, `${name} was rewritten`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('restores both previous plists when a mocked bootstrap fails', () => {
    const home = makeHome('om-launchd-rollback-');
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const agents = join(home, 'Library', 'LaunchAgents');
      const previous = new Map(
        PLISTS.map((name) => [name, readFileSync(join(agents, name), 'utf8')] as const),
      );
      const mockBin = join(home, 'mock-bin');
      const failedOnce = join(home, 'bootstrap-failed-once');
      const launchState = join(home, 'rollback-launch-state');
      mkdirSync(mockBin);
      mkdirSync(launchState);
      for (const name of PLISTS) {
        writeFileSync(join(launchState, name.replace(/\.plist$/, '')), 'loaded\n');
      }
      const launchctl = join(mockBin, 'launchctl');
      writeFileSync(
        launchctl,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  print)',
          `    label="\${2##*/}"`,
          `    [ "$(/bin/cat "${launchState}/$label" 2>/dev/null)" = "loaded" ]`,
          '    ;;',
          '  bootout)',
          `    label="\${2##*/}"`,
          `    printf 'absent\\n' > "${launchState}/$label"`,
          '    exit 0',
          '    ;;',
          '  bootstrap)',
          `    label="\${3##*/}"`,
          `    label="\${label%.plist}"`,
          '    case "$3" in',
          `      *io.openmurmur.digest.plist) if [ ! -e "${failedOnce}" ]; then touch "${failedOnce}"; exit 1; fi ;;`,
          '    esac',
          `    printf 'loaded\\n' > "${launchState}/$label"`,
          '    exit 0',
          '    ;;',
          'esac',
          'exit 2',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      chmodSync(launchctl, 0o700);

      const result = spawnSync(
        'bash',
        [INSTALLER, '--yes', '--node', process.execPath, '--root', stateRoot],
        {
          cwd: REPO,
          encoding: 'utf8',
          env: { ...process.env, HOME: home, PATH: `${mockBin}:${process.env['PATH'] ?? ''}` },
        },
      );

      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /previous installation was restored/);
      for (const [name, content] of previous) {
        assert.equal(readFileSync(join(agents, name), 'utf8'), content, `${name} was not restored`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rolls back when bootstrap succeeds but launchctl print cannot find a label', () => {
    const home = makeHome('om-launchd-registration-rollback-');
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const agents = join(home, 'Library', 'LaunchAgents');
      for (const name of PLISTS) {
        const path = join(agents, name);
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace('</plist>', `<!-- previous ${name} -->\n</plist>`),
          { mode: 0o600 },
        );
      }
      const previous = new Map(
        PLISTS.map((name) => [name, readFileSync(join(agents, name), 'utf8')] as const),
      );

      const mockBin = join(home, 'mock-bin');
      const launchState = join(home, 'registration-launch-state');
      const skippedRegistration = join(home, 'skipped-registration');
      mkdirSync(mockBin);
      mkdirSync(launchState);
      for (const name of PLISTS) {
        writeFileSync(join(launchState, name.replace(/\.plist$/, '')), 'loaded\n');
      }
      const launchctl = join(mockBin, 'launchctl');
      writeFileSync(
        launchctl,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  print)',
          `    label="\${2##*/}"`,
          `    [ "$(/bin/cat "${launchState}/$label" 2>/dev/null)" = "loaded" ]`,
          '    ;;',
          '  bootout)',
          `    label="\${2##*/}"`,
          `    printf 'absent\\n' > "${launchState}/$label"`,
          '    exit 0',
          '    ;;',
          '  bootstrap)',
          `    label="\${3##*/}"`,
          `    label="\${label%.plist}"`,
          `    if [ "$label" = "io.openmurmur.digest" ] && [ ! -e "${skippedRegistration}" ]; then`,
          `      touch "${skippedRegistration}"`,
          '      exit 0',
          '    fi',
          `    printf 'loaded\\n' > "${launchState}/$label"`,
          '    exit 0',
          '    ;;',
          'esac',
          'exit 2',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
      chmodSync(launchctl, 0o700);

      const result = spawnSync(
        'bash',
        [INSTALLER, '--yes', '--node', process.execPath, '--root', stateRoot],
        {
          cwd: REPO,
          encoding: 'utf8',
          env: { ...process.env, HOME: home, PATH: `${mockBin}:${process.env['PATH'] ?? ''}` },
        },
      );

      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /is not registered; the previous installation was restored/);
      for (const [name, content] of previous) {
        assert.equal(readFileSync(join(agents, name), 'utf8'), content, `${name} was not restored`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('commits only after the daemon reports exact local readiness', () => {
    const home = makeHome('om-launchd-health-success-');
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const mocks = prepareLaunchctlHealthMocks(home, {
        daemon: 'running',
        pid: 123,
        heartbeatStatus: 'fresh',
        recorderRunning: true,
        lastSourceFrameAgeMs: 12,
      });

      const result = spawnSync(
        'bash',
        [INSTALLER, '--yes', '--node', mocks.node, '--root', stateRoot],
        {
          cwd: REPO,
          encoding: 'utf8',
          env: { ...process.env, HOME: home, PATH: `${mocks.bin}:${process.env['PATH'] ?? ''}` },
        },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /daemon heartbeat is fresh and audio frames are arriving/);
      assert.equal(readFileSync(mocks.probes, 'utf8'), 'probe\n');
      const launchLines = readFileSync(mocks.launchLog, 'utf8').trim().split('\n');
      assert.equal(launchLines.filter((line) => line.startsWith('bootstrap ')).length, 2);
      for (const name of PLISTS) {
        assert.match(
          readFileSync(join(home, 'Library', 'LaunchAgents', name), 'utf8'),
          /health-bin/,
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('waits for delayed launchd removal before bootstrapping replacements', () => {
    const home = makeHome('om-launchd-delayed-bootout-');
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const mocks = prepareLaunchctlHealthMocks(
        home,
        {
          daemon: 'running',
          pid: 123,
          heartbeatStatus: 'fresh',
          recorderRunning: true,
          lastSourceFrameAgeMs: 12,
        },
        2,
      );

      const result = spawnSync(
        'bash',
        [INSTALLER, '--yes', '--node', mocks.node, '--root', stateRoot],
        {
          cwd: REPO,
          encoding: 'utf8',
          env: { ...process.env, HOME: home, PATH: `${mocks.bin}:${process.env['PATH'] ?? ''}` },
        },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const launchLines = readFileSync(mocks.launchLog, 'utf8').trim().split('\n');
      for (const name of PLISTS) {
        const label = name.replace(/\.plist$/, '');
        const bootout = launchLines.findIndex(
          (line) => line.startsWith('bootout ') && line.endsWith(`/${label}`),
        );
        const bootstrap = launchLines.findIndex(
          (line) => line.startsWith('bootstrap ') && line.endsWith(`/${name}`),
        );
        assert.ok(bootout >= 0 && bootstrap > bootout, `${label} was not replaced in order`);
        assert.ok(
          launchLines
            .slice(bootout + 1, bootstrap)
            .filter((line) => line.startsWith('print ') && line.endsWith(`/${label}`)).length >= 3,
          `${label} bootstrap did not wait for delayed removal`,
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fully rolls back when registration succeeds but daemon health never becomes ready', () => {
    const home = makeHome('om-launchd-health-rollback-');
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const agents = join(home, 'Library', 'LaunchAgents');
      for (const name of PLISTS) {
        const path = join(agents, name);
        writeFileSync(
          path,
          readFileSync(path, 'utf8').replace('</plist>', `<!-- previous ${name} -->\n</plist>`),
          { mode: 0o600 },
        );
      }
      const previous = new Map(
        PLISTS.map((name) => [name, readFileSync(join(agents, name), 'utf8')] as const),
      );
      const mocks = prepareLaunchctlHealthMocks(home, {
        daemon: 'running',
        pid: 123,
        heartbeatStatus: 'fresh',
        recorderRunning: true,
        lastSourceFrameAgeMs: null,
      });

      const result = spawnSync(
        'bash',
        [INSTALLER, '--yes', '--node', mocks.node, '--root', stateRoot],
        {
          cwd: REPO,
          encoding: 'utf8',
          env: { ...process.env, HOME: home, PATH: `${mocks.bin}:${process.env['PATH'] ?? ''}` },
        },
      );

      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Daemon readiness failed.*no audio frame has been observed/);
      assert.equal(readFileSync(mocks.probes, 'utf8').trim().split('\n').length, 20);
      const launchLines = readFileSync(mocks.launchLog, 'utf8').trim().split('\n');
      assert.equal(launchLines.filter((line) => line.startsWith('bootstrap ')).length, 4);
      assert.equal(launchLines.filter((line) => line.startsWith('bootout ')).length, 4);
      for (const [name, content] of previous) {
        assert.equal(readFileSync(join(agents, name), 'utf8'), content, `${name} was not restored`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
