import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { Clock } from '../util/clock.ts';
import { type CaptureBackend, type CaptureBackendOptions, CaptureError } from './backend.ts';
import { FfmpegCapture } from './ffmpeg.ts';
import { ProcessPcmCapture } from './process-pcm.ts';

export interface NativeCaptureOptions extends CaptureBackendOptions {
  readonly executable?: string;
  readonly clock: Clock;
  readonly firstSourceFrameTimeoutMs?: number;
}

export interface CaptureBackendSelectionOptions extends CaptureBackendOptions {
  readonly backend: 'ffmpeg' | 'native';
  readonly ffmpegPath: string;
  readonly clock: Clock;
  readonly platform?: NodeJS.Platform;
}

export function defaultNativeCaptureExecutable(): string {
  return join(
    homedir(),
    'Applications',
    'OpenMurmur Capture.app',
    'Contents',
    'MacOS',
    'OpenMurmurCapture',
  );
}

const EXPECTED_BUNDLE_ID = 'io.openmurmur.capture';
const EXPECTED_EXECUTABLE_NAME = 'OpenMurmurCapture';
const AUDIO_INPUT_ENTITLEMENT = 'com.apple.security.device.audio-input';
const COMMAND_TIMEOUT_MS = 3_000;

interface CommandOutput {
  readonly stdout: string;
}

function runBundleProbe(command: string, args: readonly string[], input?: string): CommandOutput {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error('native capture bundle probe failed');
  }
  return { stdout: result.stdout };
}

function readPlist(path: string): Record<string, unknown> {
  const output = runBundleProbe('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]).stdout;
  const value: unknown = JSON.parse(output);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('native capture plist is not a dictionary');
  }
  return value as Record<string, unknown>;
}

function readPlistText(text: string): Record<string, unknown> {
  const output = runBundleProbe(
    '/usr/bin/plutil',
    ['-convert', 'json', '-o', '-', '-'],
    text,
  ).stdout;
  const value: unknown = JSON.parse(output);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('native capture entitlements are not a dictionary');
  }
  return value as Record<string, unknown>;
}

function requireDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('native capture bundle directory is invalid');
  }
}

function requireFile(path: string, executable = false): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('native capture bundle file is invalid');
  }
  if (executable) accessSync(path, constants.X_OK);
}

function verifyNativeCaptureBundle(executable: string): void {
  const macOSDirectory = dirname(executable);
  const contentsDirectory = dirname(macOSDirectory);
  const appDirectory = dirname(contentsDirectory);
  const applicationsDirectory = dirname(appDirectory);
  const infoPlist = join(contentsDirectory, 'Info.plist');
  const resourcesDirectory = join(contentsDirectory, 'Resources');
  const sourceDigestFile = join(resourcesDirectory, 'source.sha256');

  if (
    executable !== join(appDirectory, 'Contents', 'MacOS', EXPECTED_EXECUTABLE_NAME) ||
    appDirectory !== join(applicationsDirectory, 'OpenMurmur Capture.app') ||
    realpathSync(executable) !== executable
  ) {
    throw new Error('native capture bundle path is not canonical');
  }

  requireDirectory(applicationsDirectory);
  requireDirectory(appDirectory);
  requireDirectory(contentsDirectory);
  requireDirectory(macOSDirectory);
  requireDirectory(resourcesDirectory);
  requireFile(executable, true);
  requireFile(infoPlist);
  requireFile(sourceDigestFile);

  const info = readPlist(infoPlist);
  if (
    info['CFBundleIdentifier'] !== EXPECTED_BUNDLE_ID ||
    info['CFBundleExecutable'] !== EXPECTED_EXECUTABLE_NAME
  ) {
    throw new Error('native capture bundle identity is invalid');
  }

  runBundleProbe('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', appDirectory]);
  const entitlementsXml = runBundleProbe('/usr/bin/codesign', [
    '-d',
    '--entitlements',
    ':-',
    appDirectory,
  ]).stdout;
  if (readPlistText(entitlementsXml)[AUDIO_INPUT_ENTITLEMENT] !== true) {
    throw new Error('native capture bundle lacks the audio-input entitlement');
  }

  const sourceDigest = readFileSync(sourceDigestFile, 'utf8');
  if (!/^[0-9a-f]{64}\n$/.test(sourceDigest)) {
    throw new Error('native capture source digest is invalid');
  }
  const helperDigest = runBundleProbe(executable, ['--source-digest']).stdout;
  if (helperDigest !== sourceDigest) {
    throw new Error('native capture source digest does not match the signed helper');
  }
}

export function nativeCaptureExecutableIsUsable(
  executable = defaultNativeCaptureExecutable(),
): boolean {
  try {
    verifyNativeCaptureBundle(executable);
    return true;
  } catch {
    return false;
  }
}

function classifyExit(stderr: string, code: number | null): CaptureError {
  const detail = stderr.trim();
  const lower = detail.toLowerCase();
  const message =
    detail.length > 0
      ? `native capture helper exited with code ${code}: ${detail}`
      : `native capture helper exited with code ${code}`;
  if (code === 77 || lower.includes('permission') || lower.includes('not authorized')) {
    return new CaptureError('permission', message);
  }
  if (lower.includes('device') || lower.includes('input unavailable')) {
    return new CaptureError('device', message);
  }
  return new CaptureError('exit', message);
}

/** Raw 16 kHz mono s16le capture from the signed native helper. */
export class NativeCapture extends ProcessPcmCapture {
  constructor(options: NativeCaptureOptions) {
    if (options.sampleRate !== 16_000 || options.channels !== 1) {
      throw new CaptureError('spawn', 'The native capture helper requires 16000 Hz mono audio.');
    }
    if (options.device !== 'default') {
      throw new CaptureError(
        'device',
        'The native capture helper currently supports only audio.captureDevice="default".',
      );
    }
    super({
      name: 'native-avfoundation',
      command: options.executable ?? defaultNativeCaptureExecutable(),
      args: ['--stream'],
      sampleRate: options.sampleRate,
      channels: options.channels,
      device: options.device,
      frameSamples: options.frameSamples,
      clock: options.clock,
      classifyExit,
      ...(options.firstSourceFrameTimeoutMs === undefined
        ? {}
        : { firstSourceFrameTimeoutMs: options.firstSourceFrameTimeoutMs }),
    });
  }
}

export function createCaptureBackend(options: CaptureBackendSelectionOptions): CaptureBackend {
  if (options.backend === 'ffmpeg') {
    return new FfmpegCapture({
      sampleRate: options.sampleRate,
      channels: options.channels,
      device: options.device,
      frameSamples: options.frameSamples,
      ffmpegPath: options.ffmpegPath,
      clock: options.clock,
    });
  }
  if ((options.platform ?? platform()) !== 'darwin') {
    throw new CaptureError('spawn', 'The native capture helper requires macOS.');
  }
  const executable = defaultNativeCaptureExecutable();
  if (!nativeCaptureExecutableIsUsable(executable)) {
    throw new CaptureError(
      'spawn',
      `audio.captureBackend="native" requires the verified signed helper at ${executable}`,
    );
  }
  return new NativeCapture({
    sampleRate: options.sampleRate,
    channels: options.channels,
    device: options.device,
    frameSamples: options.frameSamples,
    executable,
    clock: options.clock,
  });
}
