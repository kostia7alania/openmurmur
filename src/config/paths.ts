import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * All OpenMurmur state lives under a single root so that uninstall is one
 * `rm -rf` and so that a user can point the whole install at an external disk.
 */
export interface Paths {
  readonly root: string;
  readonly configFile: string;
  readonly databaseFile: string;
  /** Finalized session audio, organized by UTC date. */
  readonly audioDir: string;
  /** In-progress writes. Never read by anything but the recorder. */
  readonly tempDir: string;
  /** Untrusted files downloaded from Telegram, before validation. */
  readonly quarantineDir: string;
  readonly transcriptsDir: string;
  readonly logsDir: string;
  readonly modelsDir: string;
  readonly runtimeDir: string;
  readonly pidFile: string;
}

const DEFAULT_ROOT = join(homedir(), 'Library', 'Application Support', 'OpenMurmur');

export function resolvePaths(root: string = process.env['OPENMURMUR_HOME'] ?? DEFAULT_ROOT): Paths {
  return {
    root,
    configFile: join(root, 'openmurmur.json'),
    databaseFile: join(root, 'openmurmur.db'),
    audioDir: join(root, 'audio'),
    tempDir: join(root, 'tmp'),
    quarantineDir: join(root, 'quarantine'),
    transcriptsDir: join(root, 'transcripts'),
    logsDir: join(root, 'logs'),
    modelsDir: join(root, 'models'),
    runtimeDir: join(root, 'run'),
    pidFile: join(root, 'run', 'daemon.pid'),
  };
}

/** Directories that must exist before the daemon starts. */
export function managedDirectories(paths: Paths): readonly string[] {
  return [
    paths.root,
    paths.audioDir,
    paths.tempDir,
    paths.quarantineDir,
    paths.transcriptsDir,
    paths.logsDir,
    paths.modelsDir,
    paths.runtimeDir,
  ];
}
