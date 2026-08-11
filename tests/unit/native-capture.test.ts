import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CaptureError } from '../../src/capture/backend.ts';
import {
  createCaptureBackend,
  defaultNativeCaptureExecutable,
  NativeCapture,
  nativeCaptureExecutableIsUsable,
} from '../../src/capture/native.ts';
import { FakeClock } from '../../src/util/clock.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native PCM capture helper', () => {
  it('bounds startup and stderr, reaps a stuck helper, and restarts with framed PCM', async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'om-native-capture-'));
    roots.push(root);
    const applications = join(root, 'Applications');
    const app = join(applications, 'OpenMurmur Capture.app');
    const executable = join(app, 'Contents', 'MacOS', 'OpenMurmurCapture');
    const resources = join(app, 'Contents', 'Resources');
    const sourceDigest = 'a'.repeat(64);
    const invocationFile = join(root, 'invocations');
    const botToken = `123456789:${'A'.repeat(35)}`;
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    mkdirSync(resources, { recursive: true });
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.openmurmur.capture</string>
<key>CFBundleExecutable</key><string>OpenMurmurCapture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`,
    );
    writeFileSync(join(resources, 'source.sha256'), `${sourceDigest}\n`);
    const helperSource = join(root, 'fake-helper.c');
    writeFileSync(
      helperSource,
      `#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  if (strcmp(argv[1], "--source-digest") == 0) {
    fputs(${JSON.stringify(`${sourceDigest}\n`)}, stdout);
    return 0;
  }
  if (strcmp(argv[1], "--stream") != 0) return 64;
  signal(SIGTERM, SIG_IGN);
  int count = 0;
  FILE *invocations = fopen(${JSON.stringify(invocationFile)}, "r");
  if (invocations != NULL) {
    fscanf(invocations, "%d", &count);
    fclose(invocations);
  }
  count += 1;
  invocations = fopen(${JSON.stringify(invocationFile)}, "w");
  fprintf(invocations, "%d", count);
  fclose(invocations);
  char pid_path[1024];
  snprintf(pid_path, sizeof(pid_path), "%s%d", ${JSON.stringify(join(root, 'pid-'))}, count);
  FILE *pid_file = fopen(pid_path, "w");
  fprintf(pid_file, "%d", getpid());
  fclose(pid_file);
  if (count == 1) {
    fputs("microphone authorization required: run --authorize from the GUI", stderr);
    return 77;
  }
  if (count == 2) {
    while (1) pause();
  }
  const unsigned char pcm[] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
  fwrite(pcm, 1, sizeof(pcm), stdout);
  fflush(stdout);
  usleep(250000);
  for (int i = 0; i < 9000; i += 1) fputc('x', stderr);
  fputs(${JSON.stringify(botToken)}, stderr);
  return 7;
}
`,
    );
    execFileSync('/usr/bin/xcrun', ['clang', '-O2', helperSource, '-o', executable]);
    chmodSync(executable, 0o700);
    const entitlements = join(root, 'entitlements.plist');
    writeFileSync(
      entitlements,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.device.audio-input</key><true/>
</dict></plist>`,
    );
    execFileSync('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      entitlements,
      app,
    ]);

    assert.equal(
      defaultNativeCaptureExecutable(),
      join(
        homedir(),
        'Applications',
        'OpenMurmur Capture.app',
        'Contents',
        'MacOS',
        'OpenMurmurCapture',
      ),
    );
    assert.equal(nativeCaptureExecutableIsUsable(executable), true);
    const linkedHome = join(root, 'linked-home');
    mkdirSync(linkedHome);
    symlinkSync(applications, join(linkedHome, 'Applications'), 'dir');
    assert.equal(
      nativeCaptureExecutableIsUsable(
        join(
          linkedHome,
          'Applications',
          'OpenMurmur Capture.app',
          'Contents',
          'MacOS',
          'OpenMurmurCapture',
        ),
      ),
      false,
      'a signed helper reached through a symlinked bundle ancestor must be rejected',
    );

    const clock = new FakeClock(1_700_000_000_000, 1_000);
    const options = {
      sampleRate: 16_000,
      channels: 1,
      device: 'default',
      frameSamples: 2,
      executable,
      clock,
      firstSourceFrameTimeoutMs: 1_000,
    } as const;
    assert.throws(
      () => new NativeCapture({ ...options, device: '2' }),
      /supports only audio\.captureDevice="default"/,
    );
    assert.throws(
      () => new NativeCapture({ ...options, sampleRate: 8_000 }),
      /requires 16000 Hz mono audio/,
    );
    assert.equal(
      createCaptureBackend({
        ...options,
        backend: 'ffmpeg',
        device: '2',
        ffmpegPath: '/fake/ffmpeg',
        platform: 'darwin',
      }).name,
      'ffmpeg-avfoundation',
      'an installed helper must not change an explicit FFmpeg configuration',
    );
    assert.equal(
      nativeCaptureExecutableIsUsable(join(root, 'missing-helper')),
      false,
      'a missing helper must fail closed',
    );

    const capture = new NativeCapture(options);
    assert.equal(capture.name, 'native-avfoundation');
    const permissionFailure = await capture
      .start()
      .next()
      .catch((error: unknown) => error);
    assert.ok(permissionFailure instanceof CaptureError);
    assert.equal(permissionFailure.kind, 'permission');
    assert.match(permissionFailure.message, /microphone authorization required/);

    await assert.rejects(capture.start().next(), /No source audio frame arrived within 1 seconds/);
    const firstPid = Number(readFileSync(join(root, 'pid-2'), 'utf8'));
    assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' });

    const restarted = capture.start();
    const first = await restarted.next();
    assert.equal(first.done, false);
    assert.deepEqual([...first.value.pcm], [1, 2, 3, 4]);
    assert.equal(first.value.durationMs, 0.125);
    assert.equal(capture.processingLagMs(), 0.25);
    clock.advance(100);
    assert.equal(capture.msSinceLastFrame(), 100);
    assert.deepEqual([...(await restarted.next()).value.pcm], [5, 6, 7, 8]);
    assert.deepEqual([...(await restarted.next()).value.pcm], [9, 10, 11, 12]);

    const failure = await restarted.next().catch((error: unknown) => error as Error);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /native capture helper exited with code 7/);
    assert.match(failure.message, /\[REDACTED\]/);
    assert.equal(failure.message.includes(botToken), false);
    assert.ok(failure.message.length <= 8_300, `stderr error was ${failure.message.length} bytes`);
    assert.equal(readFileSync(invocationFile, 'utf8'), '3');
  });
});
