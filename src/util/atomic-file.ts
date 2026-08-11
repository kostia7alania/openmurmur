import { randomUUID } from 'node:crypto';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface AtomicTextOptions {
  /** Re-check external ownership after fsync but before the atomic publication. */
  readonly beforePublish?: (() => void) | undefined;
}

/** Publishes a private text artefact without ever exposing a partial file. */
export async function writeTextAtomically(
  path: string,
  contents: string,
  options: AtomicTextOptions = {},
): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | null = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    options.beforePublish?.();
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch {
    // Some filesystems reject directory fsync. Rename is still atomic; only
    // the power-loss durability window is wider on those filesystems.
  } finally {
    await handle.close();
  }
}
