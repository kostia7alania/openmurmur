import { mkdir, readFile } from 'node:fs/promises';
import { managedDirectories, type Paths, resolvePaths } from './paths.ts';
import { DEFAULT_CONFIG, type OpenMurmurConfig, parseConfig } from './schema.ts';

export interface LoadedConfig {
  readonly config: OpenMurmurConfig;
  readonly paths: Paths;
  /** False when no config file existed and defaults were used. */
  readonly fromFile: boolean;
}

export async function loadConfig(root?: string): Promise<LoadedConfig> {
  const paths = resolvePaths(root);
  let text: string;
  try {
    text = await readFile(paths.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: DEFAULT_CONFIG, paths, fromFile: false };
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${paths.configFile} is not valid JSON: ${(error as Error).message}`);
  }
  return { config: parseConfig(raw), paths, fromFile: true };
}

export async function ensureDirectories(paths: Paths): Promise<void> {
  for (const dir of managedDirectories(paths)) {
    // 0o700: session audio and transcripts are private to the user.
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}
