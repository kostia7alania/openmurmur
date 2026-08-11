import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, readdir, readFile, stat } from 'node:fs/promises';
import { arch, homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LoadedConfig } from '../config/load.ts';
import { MINIMUM_NODE_VERSION } from '../config/runtime-requirements.ts';
import { compareVersions, MINIMUM_SQLITE_VERSION, sqliteVersionOf } from '../database/db.ts';
import { diskFreeGb } from '../health/monitor.ts';
import { nullLogger } from '../logging/logger.ts';
import {
  keychainSetupReadiness,
  type TelegramSetupReadinessProvider,
} from '../telegram/keychain.ts';
import { PYTHON_PROJECT, REPO_ROOT, WORKER_ARGS } from './backends.ts';

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  readonly name: string;
  readonly level: CheckLevel;
  readonly detail: string;
  readonly fix?: string;
}

export { MINIMUM_NODE_VERSION } from '../config/runtime-requirements.ts';

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

const REQUIRED_MLX_PACKAGES = [{ name: 'mlx' }, { name: 'mlx-qwen3-asr' }] as const;
const MINIMUM_MLX_CACHE_FREE_GB = 6;

export interface MlxReadinessOptions {
  readonly pythonEnvironment?: string;
  readonly cacheRoot?: string;
  readonly diskProbe?: (path: string) => Promise<number | null>;
}

function resolveConfiguredPath(value: string, relativeTo: string): string {
  const home = homedir();
  const expanded = value
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}/g, home)
    .replaceAll('$HOME', home);
  return isAbsolute(expanded) ? expanded : resolve(relativeTo, expanded);
}

function huggingFaceCacheRoot(): string {
  const explicit =
    process.env['HF_HUB_CACHE']?.trim() || process.env['HUGGINGFACE_HUB_CACHE']?.trim();
  if (explicit) return resolveConfiguredPath(explicit, REPO_ROOT);
  const hfHome = process.env['HF_HOME']?.trim();
  if (hfHome) return join(resolveConfiguredPath(hfHome, REPO_ROOT), 'hub');
  const xdgCache = process.env['XDG_CACHE_HOME']?.trim();
  if (xdgCache) {
    return join(resolveConfiguredPath(xdgCache, REPO_ROOT), 'huggingface', 'hub');
  }
  return join(homedir(), '.cache', 'huggingface', 'hub');
}

async function inspectMlxPackages(
  environment: string,
): Promise<{ environmentPresent: boolean; missing: string[] }> {
  try {
    const python = join(environment, 'bin', 'python');
    await access(python, constants.X_OK);
    const pythonInfo = await stat(python);
    if (!pythonInfo.isFile() || pythonInfo.size === 0) throw new Error('invalid Python executable');
  } catch {
    return {
      environmentPresent: false,
      missing: REQUIRED_MLX_PACKAGES.map((dependency) => dependency.name),
    };
  }

  const metadataNames = new Set<string>();
  try {
    const libraryEntries = await readdir(join(environment, 'lib'), { withFileTypes: true });
    for (const libraryEntry of libraryEntries) {
      if (!libraryEntry.isDirectory() || !libraryEntry.name.startsWith('python')) continue;
      const sitePackages = join(environment, 'lib', libraryEntry.name, 'site-packages');
      for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith('.dist-info')) continue;
        const metadata = await readFile(join(sitePackages, entry.name, 'METADATA'), 'utf8');
        const name = metadata.match(/^Name:\s*([^\r\n]+)\s*$/m)?.[1]?.trim();
        if (name !== undefined) metadataNames.add(name);
      }
    }
  } catch {
    // A malformed or partial environment is present, but no package metadata
    // is trusted from it.
  }

  return {
    environmentPresent: true,
    missing: REQUIRED_MLX_PACKAGES.filter((dependency) => !metadataNames.has(dependency.name)).map(
      (dependency) => dependency.name,
    ),
  };
}

function isSafeSnapshotFile(snapshot: string, relativeFile: string): boolean {
  const resolved = resolve(snapshot, relativeFile);
  return resolved.startsWith(`${snapshot}${sep}`);
}

async function modelSnapshotEvidencePresent(snapshot: string): Promise<boolean> {
  const requiredMetadata = [
    'config.json',
    'preprocessor_config.json',
    'tokenizer_config.json',
    'vocab.json',
    'merges.txt',
  ];
  try {
    for (const file of requiredMetadata) {
      const path = join(snapshot, file);
      await access(path, constants.R_OK);
      const info = await stat(path);
      if (!info.isFile() || info.size === 0) return false;
    }

    const indexText = await readFile(join(snapshot, 'model.safetensors.index.json'), 'utf8');
    const index: unknown = JSON.parse(indexText);
    if (typeof index !== 'object' || index === null || Array.isArray(index)) return false;
    const weightMap = (index as Record<string, unknown>)['weight_map'];
    if (typeof weightMap !== 'object' || weightMap === null || Array.isArray(weightMap))
      return false;
    const shards = [...new Set(Object.values(weightMap))];
    if (shards.length === 0 || shards.some((shard) => typeof shard !== 'string')) return false;
    for (const shard of shards as string[]) {
      if (!isSafeSnapshotFile(snapshot, shard)) return false;
      const shardPath = resolve(snapshot, shard);
      await access(shardPath, constants.R_OK);
      const shardInfo = await stat(shardPath);
      if (!shardInfo.isFile() || shardInfo.size === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function configuredModelIsCached(cacheRoot: string, model: string): Promise<boolean> {
  const repository = model.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (repository?.[1] !== undefined && repository[2] !== undefined) {
    const repositoryCache = join(cacheRoot, `models--${repository[1]}--${repository[2]}`);
    try {
      const revision = (await readFile(join(repositoryCache, 'refs', 'main'), 'utf8')).trim();
      if (!/^[0-9a-f]{7,64}$/.test(revision)) return false;
      return modelSnapshotEvidencePresent(join(repositoryCache, 'snapshots', revision));
    } catch {
      return false;
    }
  }
  if (!isAbsolute(model)) return false;
  return modelSnapshotEvidencePresent(model);
}

async function nearestExistingDirectory(path: string): Promise<string | null> {
  let current = path;
  while (true) {
    try {
      await access(current, constants.R_OK);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Metadata-only MLX readiness: no Python import, model load, cache write or network. */
export async function checkMlxReadiness(
  asr: Pick<LoadedConfig['config']['asr'], 'backend' | 'model'>,
  options: MlxReadinessOptions = {},
): Promise<Check> {
  if (asr.backend === 'fake') {
    return {
      name: 'mlx_readiness',
      level: 'info',
      detail: 'not required because asr.backend is fake',
    };
  }

  const environment = options.pythonEnvironment ?? join(PYTHON_PROJECT, '.venv');
  const cacheRoot = options.cacheRoot ?? huggingFaceCacheRoot();
  const packages = await inspectMlxPackages(environment);
  const modelCached = await configuredModelIsCached(cacheRoot, asr.model);
  const diskTarget = await nearestExistingDirectory(cacheRoot);
  const freeGb = diskTarget === null ? null : await (options.diskProbe ?? diskFreeGb)(diskTarget);
  const packageFailure = !packages.environmentPresent || packages.missing.length > 0;
  const diskLow = freeGb !== null && freeGb < MINIMUM_MLX_CACHE_FREE_GB;
  const level: CheckLevel =
    packageFailure || !modelCached ? 'fail' : diskLow || freeGb === null ? 'warn' : 'ok';

  const details = [
    packages.environmentPresent ? 'Python environment present' : 'Python environment missing',
    packages.missing.length === 0
      ? 'MLX package metadata present'
      : `missing package metadata: ${packages.missing.join(', ')}`,
    modelCached
      ? 'configured model snapshot evidence present'
      : 'configured model snapshot evidence missing',
    freeGb === null
      ? 'cache-volume free space unknown'
      : `${freeGb.toFixed(0)} GB free on cache volume`,
  ];
  const fixes: string[] = [];
  if (packageFailure) {
    fixes.push(
      'Install the local package stack: /usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx',
    );
  }
  if (!modelCached) {
    fixes.push(
      'Download the configured ASR weights explicitly in the foreground; see docs/INSTALL.md step 7, then rerun doctor.',
    );
  }
  if (diskLow) {
    fixes.push(`Free at least ${MINIMUM_MLX_CACHE_FREE_GB} GB on the ASR cache volume.`);
  } else if (freeGb === null) {
    fixes.push('Check free space on the ASR cache volume, then rerun doctor.');
  }

  return {
    name: 'mlx_readiness',
    level,
    detail: details.join('; '),
    ...(fixes.length === 0 ? {} : { fix: fixes.join('\n') }),
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
        '  /usr/bin/env -u UV_PROJECT_ENVIRONMENT uv sync --project python/openmurmur_audio --extra mlx\n' +
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
    ...(writable ? {} : { fix: 'Run `pnpm openmurmur setup` to create it.' }),
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
  if (freeGb === null) {
    return {
      name: 'disk',
      level: 'warn',
      detail: 'free-space probe failed',
      fix: `Check that ${target} exists and is readable, then rerun doctor.`,
    };
  }
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

export async function checkTelegramSetup(
  readiness: TelegramSetupReadinessProvider,
): Promise<Check> {
  const result = await readiness.inspect();
  if (result.status === 'configured') {
    return {
      name: 'telegram_setup',
      level: 'ok',
      detail:
        `${result.format === 'combined' ? 'credential item' : 'legacy credential items'} present ` +
        'in the macOS Keychain; secret readability and Telegram connectivity were not tested',
    };
  }
  if (result.status === 'not_configured') {
    return {
      name: 'telegram_setup',
      level: 'warn',
      detail: 'no Telegram credential items found in the macOS Keychain',
      fix: 'Set telegram.receiveUpdates for this host, then run either `pnpm openmurmur setup telegram owner` or `pnpm openmurmur setup telegram send-only` from the repository checkout.',
    };
  }
  if (result.status === 'incomplete_legacy') {
    return {
      name: 'telegram_setup',
      level: 'warn',
      detail: 'an incomplete legacy Telegram credential pair is present in the macOS Keychain',
      fix: 'Set telegram.receiveUpdates for this host, then run either `pnpm openmurmur setup telegram owner` or `pnpm openmurmur setup telegram send-only` to replace it atomically.',
    };
  }
  return {
    name: 'telegram_setup',
    level: 'warn',
    detail: `Keychain metadata is inaccessible: ${result.detail}`,
    fix: 'Run doctor from the logged-in GUI user session and verify the login Keychain is available.',
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
  (loaded) => checkMlxReadiness(loaded.config.asr),
  checkSpeechDetection,
  checkDiarization,
  checkOllama,
  checkStateDirectory,
  checkDisk,
  checkConfigSource,
  checkBackends,
  () => checkTelegramSetup(keychainSetupReadiness),
];

/**
 * `pnpm openmurmur doctor` — strictly read-only from the repository checkout.
 *
 * It never installs, never downloads, never writes a config and never reads
 * Keychain password data. Telegram setup readiness searches item metadata
 * without `security -g`/`-w`; it cannot trigger a password-data authorization
 * prompt or mutate legacy credentials.
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
