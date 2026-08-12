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
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

const REPO = resolve(import.meta.dirname, '../..');
const UNINSTALLER = join(REPO, 'scripts', 'uninstall-launch-agents');
const PLISTS = [
  'io.openmurmur.daemon.plist',
  'io.openmurmur.telegram.plist',
  'io.openmurmur.digest.plist',
] as const;
const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function runUninstaller(home: string, bin: string) {
  return spawnSync('bash', [UNINSTALLER], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  });
}

describe('launch agent removal', () => {
  it('preserves every plist until all services are proven absent', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'om-uninstall-launchd-')));
    roots.push(home);
    const agents = join(home, 'Library', 'LaunchAgents');
    const bin = join(home, 'bin');
    const state = join(home, 'launch-state');
    const log = join(home, 'launchctl.log');
    const failLabel = join(home, 'fail-label');
    const failMove = join(home, 'fail-move');
    const replacePlist = join(home, 'replace-plist');
    mkdirSync(agents, { recursive: true });
    mkdirSync(bin);
    mkdirSync(state);
    writeFileSync(log, '');

    for (const name of PLISTS) {
      writeFileSync(join(agents, name), `${name}\n`, { mode: 0o600 });
      writeFileSync(join(state, name.replace(/\.plist$/, '')), 'loaded\n');
    }

    const launchctl = join(bin, 'launchctl');
    writeFileSync(
      launchctl,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        `label="\${2##*/}"`,
        'case "$1" in',
        '  print)',
        `    status="$(/bin/cat ${JSON.stringify(state)}/$label 2>/dev/null || printf absent)"`,
        '    case "$status" in',
        '      loaded) exit 0 ;;',
        '      removing:*)',
        `        remaining="\${status#removing:}"`,
        '        if [ "$remaining" -gt 0 ]; then',
        `          printf 'removing:%s\\n' "$((remaining - 1))" > ${JSON.stringify(state)}/$label`,
        '          exit 0',
        '        fi',
        `        printf 'absent\\n' > ${JSON.stringify(state)}/$label`,
        '        ;;',
        '    esac',
        `    if [ "$label" = "io.openmurmur.daemon" ] && [ -f ${JSON.stringify(replacePlist)} ]; then`,
        `      printf 'concurrent replacement\\n' > ${JSON.stringify(join(agents, PLISTS[0]))}`,
        `      /bin/rm -f ${JSON.stringify(replacePlist)}`,
        '    fi',
        '    exit 1',
        '    ;;',
        '  bootout)',
        `    [ "$(/bin/cat ${JSON.stringify(failLabel)} 2>/dev/null)" != "$label" ] || exit 5`,
        `    printf 'removing:2\\n' > ${JSON.stringify(state)}/$label`,
        '    exit 0',
        '    ;;',
        '  bootstrap)',
        `    label="\${3##*/}"`,
        `    label="\${label%.plist}"`,
        `    printf 'loaded\\n' > ${JSON.stringify(state)}/$label`,
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
    const mv = join(bin, 'mv');
    writeFileSync(
      mv,
      [
        '#!/bin/sh',
        `if [ "$(/bin/cat ${JSON.stringify(failMove)} 2>/dev/null)" = "$1" ]; then`,
        `  /bin/rm -f ${JSON.stringify(failMove)}`,
        '  exit 5',
        'fi',
        'exec /bin/mv "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    chmodSync(mv, 0o700);

    const outside = join(home, 'outside.plist');
    writeFileSync(outside, 'outside\n');
    const unsafe = join(agents, PLISTS[0]);
    unlinkSync(unsafe);
    symlinkSync(outside, unsafe);
    const symlinkRejected = runUninstaller(home, bin);
    assert.equal(symlinkRejected.status, 1);
    assert.match(symlinkRejected.stderr, /unsafe launch agent path/);
    assert.equal(readFileSync(log, 'utf8'), '', 'unsafe paths must fail before launchctl');
    assert.equal(readFileSync(outside, 'utf8'), 'outside\n');

    unlinkSync(unsafe);
    writeFileSync(unsafe, `${PLISTS[0]}\n`, { mode: 0o600 });
    writeFileSync(failLabel, 'io.openmurmur.digest\n');
    const bootoutRejected = runUninstaller(home, bin);
    assert.equal(bootoutRejected.status, 1);
    assert.match(bootoutRejected.stderr, /Could not unload io\.openmurmur\.digest/);
    assert.doesNotMatch(bootoutRejected.stdout, /Agents removed|✓ unloaded/);
    for (const name of PLISTS) {
      assert.equal(existsSync(join(agents, name)), true, `${name} must be preserved`);
      assert.equal(
        readFileSync(join(state, name.replace(/\.plist$/, '')), 'utf8').trim(),
        'loaded',
        `${name} must be registered again`,
      );
    }

    unlinkSync(failLabel);
    for (const name of PLISTS) {
      writeFileSync(join(state, name.replace(/\.plist$/, '')), 'loaded\n');
    }
    writeFileSync(replacePlist, 'replace\n');
    const identityRejected = runUninstaller(home, bin);
    assert.equal(identityRejected.status, 1);
    assert.match(identityRejected.stderr, /identity changed before removal/);
    for (const name of PLISTS) {
      assert.equal(readFileSync(join(agents, name), 'utf8'), `${name}\n`);
      assert.equal(
        readFileSync(join(state, name.replace(/\.plist$/, '')), 'utf8').trim(),
        'loaded',
      );
    }
    const identityEvidence = readdirSync(agents).filter((name) =>
      name.startsWith('.openmurmur-uninstall.'),
    );
    assert.equal(identityEvidence.length, 1);
    assert.equal(
      readFileSync(join(agents, identityEvidence[0] ?? '', `${PLISTS[0]}.conflict`), 'utf8'),
      'concurrent replacement\n',
    );

    for (const name of PLISTS) {
      writeFileSync(join(state, name.replace(/\.plist$/, '')), 'loaded\n');
    }
    writeFileSync(failMove, PLISTS[1]);
    const removalRejected = runUninstaller(home, bin);
    assert.equal(removalRejected.status, 5);
    assert.match(
      removalRejected.stderr,
      /previous plist files and registered-service set were restored/,
    );
    assert.doesNotMatch(removalRejected.stdout, /Agents removed|✓ unloaded/);
    for (const name of PLISTS) {
      assert.equal(readFileSync(join(agents, name), 'utf8'), `${name}\n`);
      assert.equal(
        readFileSync(join(state, name.replace(/\.plist$/, '')), 'utf8').trim(),
        'loaded',
      );
    }

    for (const name of PLISTS) {
      writeFileSync(join(state, name.replace(/\.plist$/, '')), 'loaded\n');
    }
    const removed = runUninstaller(home, bin);
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`);
    assert.match(removed.stdout, /Agents removed/);
    assert.equal((readFileSync(log, 'utf8').match(/^print /gm) ?? []).length > 3, true);
    for (const name of PLISTS) {
      assert.equal(existsSync(join(agents, name)), false, `${name} must be removed`);
      assert.equal(
        readFileSync(join(state, name.replace(/\.plist$/, '')), 'utf8').trim(),
        'absent',
      );
    }
  });
});
