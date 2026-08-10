import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LoadedConfig } from '../config/load.ts';
import { compareVersions, MINIMUM_SQLITE_VERSION, sqliteVersionOf } from '../database/db.ts';
import { diskFreeGb } from '../health/monitor.ts';
import { nullLogger } from '../logging/logger.ts';
import { REPO_ROOT, WORKER_ARGS } from './backends.ts';

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  readonly name: string;
  readonly level: CheckLevel;
  readonly detail: string;
  readonly fix?: string;
}

export const MINIMUM_NODE_VERSION = '26.7.0';

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk: string) => {
      if (out.length < 8192) out += chunk;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

/**
 * Each check is an independent async function over the loaded config, so a new
 * dependency is one entry in the list below rather than another branch in a
 * 150-line function. They run in order and every one always reports.
 */
type CheckFn = (loaded: LoadedConfig) => Promise<Check> | Check;

function checkPlatform(): Check {
  const ok = platform() === 'darwin' && arch() === 'arm64';
  return {
    name: 'platform',
    level: ok ? 'ok' : 'fail',
    detail: `${platform()}/${arch()}`,
    ...(ok
      ? {}
      : {
          fix: 'OpenMurmur targets macOS on Apple Silicon. MLX requires Metal on an M-series chip.',
        }),
  };
}

function checkNode(): Check {
  const ok = nodeVersionIsSupported(process.versions.node);
  return {
    name: 'node',
    level: ok ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    ...(ok ? {} : { fix: `Install Node ${MINIMUM_NODE_VERSION} or newer (see .nvmrc).` }),
  };
}

export function nodeVersionIsSupported(version: string): boolean {
  return compareVersions(version, MINIMUM_NODE_VERSION) >= 0;
}

function checkSqlite(): Check {
  const probe = new DatabaseSync(':memory:');
  const version = sqliteVersionOf(probe);
  probe.close();

  const ok = compareVersions(version, MINIMUM_SQLITE_VERSION) >= 0;
  return {
    name: 'sqlite',
    level: ok ? 'ok' : 'warn',
    detail: `node:sqlite runtime ${version} (target >= ${MINIMUM_SQLITE_VERSION})`,
    ...(ok
      ? {}
      : {
          fix:
            'This is the SQLite compiled into Node itself; installing sqlite3 via Homebrew does ' +
            'not change it. Nothing in the schema needs a newer version — see ' +
            'docs/adr/0004-sqlite-driver.md. It resolves when Node ships a newer SQLite.',
        }),
  };
}

function binaryCheck(name: string, command: string, fix: string): CheckFn {
  return async () => {
    const output = await commandVersion(command, ['-version']);
    return {
      name,
      level: output === null ? 'fail' : 'ok',
      detail: output === null ? 'not found' : (output.split('\n')[0] ?? 'present'),
      ...(output === null ? { fix } : {}),
    };
  };
}

async function checkAudioDevices(loaded: LoadedConfig): Promise<Check> {
  // Listing devices does not open the microphone, so this does not trigger the
  // macOS TCC prompt — important for a read-only command.
  const devices = await listAvfoundationDevices(loaded.config.audio.ffmpegPath);
  return {
    name: 'audio_devices',
    level: devices.length > 0 ? 'ok' : 'warn',
    detail:
      devices.length > 0
        ? devices.map((d) => `[${d.index}] ${d.name}`).join(', ')
        : 'no AVFoundation audio devices reported',
    ...(devices.length > 0
      ? {}
      : { fix: 'Check System Settings -> Sound -> Input, then re-run doctor.' }),
  };
}

async function checkUv(loaded: LoadedConfig): Promise<Check> {
  const output = await commandVersion('uv', ['--version']);
  const required = loaded.config.asr.backend !== 'fake';
  return {
    name: 'uv',
    level: output === null ? (required ? 'fail' : 'warn') : 'ok',
    detail: output === null ? 'not found' : output.trim(),
    ...(output === null ? { fix: 'curl -LsSf https://astral.sh/uv/install.sh | sh' } : {}),
  };
}

/**
 * Scores one frame of real audio through the real worker.
 *
 * Reporting `vad=silero` from the config would only prove the config says so.
 * The thing worth knowing before leaving a daemon running all day is whether
 * the detector actually loads and answers, so this starts the worker, sends a
 * frame and shuts it down again.
 */
async function checkSpeechDetection(loaded: LoadedConfig): Promise<Check> {
  if (loaded.config.sessionizer.vadBackend === 'energy') {
    return {
      name: 'speech_detection',
      level: 'warn',
      detail: 'energy gate (Silero disabled in the config)',
      fix:
        'sessionizer.vadBackend is "energy". It measures loudness, not speech, so a fan or a ' +
        'television can start a session and quiet speech can be missed.',
    };
  }

  const { WorkerProcess } = await import('../asr/worker-process.ts');
  const { SileroStreamVad, WorkerFrameScorer, FRAME_BYTES } = await import(
    '../sessionizer/silero.ts'
  );
  const worker = new WorkerProcess({
    command: 'uv',
    args: [...WORKER_ARGS],
    cwd: REPO_ROOT,
    logger: nullLogger,
    label: 'VAD',
  });

  const started = Date.now();
  try {
    const vad = new SileroStreamVad({
      scorer: new WorkerFrameScorer(worker, 60_000),
      logger: nullLogger,
      // Report the real failure instead of quietly answering from the gate.
      failureThreshold: 1,
      fallback: {
        name: 'none',
        probability: () => Number.NaN,
        reset: () => {},
      },
    });
    const probability = await vad.probability(new Uint8Array(FRAME_BYTES));
    if (!Number.isFinite(probability)) throw new Error('the worker returned no probability');
    return {
      name: 'speech_detection',
      level: 'ok',
      detail: `Silero VAD answered in ${Date.now() - started} ms`,
    };
  } catch (error) {
    return {
      name: 'speech_detection',
      level: 'fail',
      detail: (error as Error).message.split('\n')[0] ?? 'unavailable',
      fix:
        'Sessions cannot be detected without it. Install the local model stack:\n' +
        '  uv sync --project python/openmurmur_audio --extra mlx\n' +
        'Or set sessionizer.vadBackend to "energy" to cut sessions by loudness instead, ' +
        'accepting that noise will be recorded as speech.',
    };
  } finally {
    await worker.close(randomUUID());
  }
}

/**
 * Checks the diarization models are on disk, when it is switched on.
 *
 * Reported before the daemon runs rather than as a warning buried in a log at
 * three in the morning: without the models every session is transcribed
 * without speaker labels and nothing else complains.
 */
async function checkDiarization(loaded: LoadedConfig): Promise<Check> {
  const { enabled, maxSpeakers } = loaded.config.diarization;
  if (!enabled) {
    return {
      name: 'diarization',
      level: 'info',
      detail: 'off — transcripts will not say who spoke',
      fix: 'Enable with diarization.enabled, after ./scripts/fetch-diarization-models (~44 MB).',
    };
  }

  const models = join(loaded.paths.root, 'models');
  const required = [
    join(models, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'),
    join(models, '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'),
  ];

  const missing: string[] = [];
  for (const path of required) {
    try {
      await access(path, constants.R_OK);
    } catch {
      missing.push(basename(path));
    }
  }

  if (missing.length > 0) {
    return {
      name: 'diarization',
      level: 'fail',
      detail: `enabled, but the models are missing: ${missing.join(', ')}`,
      fix: 'Fetch them (~44 MB, no account or token): ./scripts/fetch-diarization-models',
    };
  }

  return {
    name: 'diarization',
    level: 'ok',
    detail: `on, at most ${maxSpeakers} voice(s) per session`,
  };
}

async function checkOllama(loaded: LoadedConfig): Promise<Check> {
  const { baseUrl, model } = loaded.config.llm;
  const result = await probeOllama(baseUrl, model);
  return {
    name: 'ollama',
    level: result.ok ? 'ok' : 'warn',
    detail: result.detail,
    ...(result.ok
      ? {}
      : {
          fix:
            'Summaries need a local LLM. Audio and transcripts are delivered without it.\n' +
            '  brew install ollama\n' +
            '  brew services start ollama\n' +
            `  ollama pull ${model}`,
        }),
  };
}

async function checkStateDirectory(loaded: LoadedConfig): Promise<Check> {
  let writable = true;
  try {
    await access(loaded.paths.root, constants.W_OK);
  } catch {
    writable = false;
  }
  return {
    name: 'state_directory',
    level: writable ? 'ok' : 'warn',
    detail: `${loaded.paths.root}${writable ? '' : ' (missing or not writable)'}`,
    ...(writable ? {} : { fix: 'Run `openmurmur setup` to create it.' }),
  };
}

async function checkDisk(loaded: LoadedConfig): Promise<Check> {
  const threshold = loaded.config.health.diskFreeWarnGb;
  let target = process.cwd();
  try {
    await access(loaded.paths.root, constants.W_OK);
    target = loaded.paths.root;
  } catch {
    // Fall back to the working directory when the state root does not exist.
  }
  const freeGb = await diskFreeGb(target);
  return {
    name: 'disk',
    level: freeGb < threshold ? 'warn' : 'ok',
    detail: `${freeGb.toFixed(0)} GB free`,
    ...(freeGb < threshold ? { fix: `Below the ${threshold} GB alert threshold.` } : {}),
  };
}

function checkConfigSource(loaded: LoadedConfig): Check {
  return {
    name: 'config',
    level: 'info',
    detail: loaded.fromFile
      ? loaded.paths.configFile
      : 'using built-in defaults (no config file yet)',
  };
}

function checkBackends(loaded: LoadedConfig): Check {
  const { asr, llm, sessionizer } = loaded.config;
  const energyVad = sessionizer.vadBackend === 'energy';
  const degraded = asr.backend === 'fake' || llm.backend === 'fake' || energyVad;

  const fixes = [
    asr.backend === 'fake'
      ? 'asr.backend is "fake": transcripts will be placeholders, not real speech.'
      : null,
    energyVad
      ? 'sessionizer.vadBackend is "energy": sessions are cut by loudness, so a fan or a ' +
        'television can start one and quiet speech can be missed.'
      : null,
  ].filter((fix) => fix !== null);

  return {
    name: 'backends',
    level: degraded ? 'warn' : 'info',
    detail: `asr=${asr.backend}, llm=${llm.backend}, vad=${sessionizer.vadBackend}`,
    ...(fixes.length > 0 ? { fix: fixes.join(' ') } : {}),
  };
}

function checkTelegram(): Check {
  // Presence only. Reading the Keychain here would pop an authentication
  // prompt on what is documented as a read-only command.
  return {
    name: 'telegram',
    level: 'info',
    detail: 'run `openmurmur setup telegram` to configure; secrets live in the macOS Keychain',
  };
}

const CHECKS: readonly CheckFn[] = [
  checkPlatform,
  checkNode,
  checkSqlite,
  (loaded) => binaryCheck('ffmpeg', loaded.config.audio.ffmpegPath, 'brew install ffmpeg')(loaded),
  (loaded) =>
    binaryCheck('ffprobe', loaded.config.audio.ffprobePath, 'brew install ffmpeg')(loaded),
  checkAudioDevices,
  checkUv,
  checkSpeechDetection,
  checkDiarization,
  checkOllama,
  checkStateDirectory,
  checkDisk,
  checkConfigSource,
  checkBackends,
  checkTelegram,
];

/**
 * `openmurmur doctor` — strictly read-only.
 *
 * It never installs, never downloads, never writes a config, never touches the
 * Keychain. A user must be able to run it on a machine they do not fully trust
 * and know that all it did was look.
 */
export async function runDoctor(loaded: LoadedConfig): Promise<Check[]> {
  const checks: Check[] = [];
  for (const check of CHECKS) checks.push(await check(loaded));
  return checks;
}

export interface AvDevice {
  readonly index: string;
  readonly name: string;
}

/**
 * Parses `ffmpeg -f avfoundation -list_devices true -i ""`, which exits
 * non-zero by design and prints the device table on stderr.
 */
export function parseAvfoundationDevices(stderr: string): AvDevice[] {
  const devices: AvDevice[] = [];
  let inAudio = false;
  for (const line of stderr.split('\n')) {
    if (line.includes('AVFoundation audio devices')) {
      inAudio = true;
      continue;
    }
    if (line.includes('AVFoundation video devices')) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      devices.push({ index: match[1], name: match[2] });
    }
  }
  return devices;
}

function listAvfoundationDevices(ffmpegPath: string): Promise<AvDevice[]> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 32_768) stderr += chunk;
    });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(parseAvfoundationDevices(stderr)));
  });
}

async function probeOllama(
  baseUrl: string,
  model: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} from ${baseUrl}` };
    const body = (await response.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name ?? '');
    const found = names.some((n) => n === model || n.startsWith(`${model}:`));
    return found
      ? { ok: true, detail: `${model} available at ${baseUrl}` }
      : {
          ok: false,
          detail: `running, but ${model} is not pulled (have: ${names.join(', ') || 'none'})`,
        };
  } catch {
    return { ok: false, detail: `not reachable at ${baseUrl}` };
  }
}

export function formatChecks(checks: readonly Check[]): string {
  const icon: Record<CheckLevel, string> = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ' };
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${icon[check.level]} ${check.name.padEnd(18)} ${check.detail}`);
    if (check.fix !== undefined) {
      for (const fixLine of check.fix.split('\n')) lines.push(`   ↳ ${fixLine}`);
    }
  }
  const failures = checks.filter((c) => c.level === 'fail').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  lines.push('');
  lines.push(
    failures > 0
      ? `${failures} blocking problem(s), ${warnings} warning(s).`
      : warnings > 0
        ? `No blocking problems. ${warnings} warning(s).`
        : 'All checks passed.',
  );
  return lines.join('\n');
}

export function doctorExitCode(checks: readonly Check[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
