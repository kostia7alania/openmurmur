import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALLER = join(REPO, 'scripts', 'install-launch-agents');
const PLISTS = ['io.openmurmur.daemon.plist', 'io.openmurmur.digest.plist'] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderInstalledPlists(home: string, stateRoot: string): void {
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
  writeFileSync(
    launchctl,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${launchLog}"`,
      'case "$1" in',
      '  print|bootstrap|bootout) exit 0 ;;',
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
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-runtime-'));
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

  it('accepts rendered agents only when runtime, root and templates all match', () => {
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-current-'));
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
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-drift-'));
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
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-unregistered-'));
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
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-rollback-'));
    const stateRoot = join(home, 'state');
    try {
      renderInstalledPlists(home, stateRoot);
      const agents = join(home, 'Library', 'LaunchAgents');
      const previous = new Map(
        PLISTS.map((name) => [name, readFileSync(join(agents, name), 'utf8')] as const),
      );
      const mockBin = join(home, 'mock-bin');
      const failedOnce = join(home, 'bootstrap-failed-once');
      mkdirSync(mockBin);
      const launchctl = join(mockBin, 'launchctl');
      writeFileSync(
        launchctl,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  print|bootout) exit 0 ;;',
          '  bootstrap)',
          '    case "$3" in',
          `      *io.openmurmur.digest.plist) if [ ! -e "${failedOnce}" ]; then touch "${failedOnce}"; exit 1; fi ;;`,
          '    esac',
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
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-registration-rollback-'));
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
      const printCount = join(home, 'print-count');
      mkdirSync(mockBin);
      const launchctl = join(mockBin, 'launchctl');
      writeFileSync(
        launchctl,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  print)',
          '    count=0',
          `    [ ! -f "${printCount}" ] || count="$(/bin/cat "${printCount}")"`,
          '    count=$((count + 1))',
          `    printf '%s\\n' "$count" > "${printCount}"`,
          '    [ "$count" -ne 4 ] || exit 1',
          '    exit 0',
          '    ;;',
          '  bootstrap|bootout) exit 0 ;;',
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
      assert.equal(readFileSync(printCount, 'utf8').trim(), '6');
      for (const [name, content] of previous) {
        assert.equal(readFileSync(join(agents, name), 'utf8'), content, `${name} was not restored`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('commits only after the daemon reports exact local readiness', () => {
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-health-success-'));
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

  it('fully rolls back when registration succeeds but daemon health never becomes ready', () => {
    const home = mkdtempSync(join(tmpdir(), 'om-launchd-health-rollback-'));
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
