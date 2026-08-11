import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MINIMUM_SQLITE_VERSION } from '../config/runtime-requirements.ts';

export { MINIMUM_SQLITE_VERSION } from '../config/runtime-requirements.ts';

/**
 * Minimum SQLite runtime we are willing to run against.
 *
 * Node 26.7.0 bundles 3.53.4, matching this target. We still query the actual
 * runtime because `node:sqlite` is compiled into Node; a Homebrew sqlite3
 * upgrade does not change it. See docs/adr/0004-sqlite-driver.md.
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface OpenDatabaseOptions {
  readonly file: string;
  /** Fail rather than warn when the runtime SQLite is older than the minimum. */
  readonly strictVersion?: boolean;
  readonly onVersionWarning?: (message: string) => void;
}

export interface Database {
  readonly handle: DatabaseSync;
  readonly sqliteVersion: string;
  close(): void;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function sqliteVersionOf(handle: DatabaseSync): string {
  const row = handle.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  return row.v;
}

export function openDatabase(options: OpenDatabaseOptions): Database {
  const handle = new DatabaseSync(options.file);
  const version = sqliteVersionOf(handle);

  if (compareVersions(version, MINIMUM_SQLITE_VERSION) < 0) {
    const message =
      `SQLite runtime ${version} is older than the ${MINIMUM_SQLITE_VERSION} target ` +
      `(node:sqlite is compiled into Node ${process.versions.node}; a Homebrew sqlite3 ` +
      'does not change it). See docs/adr/0004-sqlite-driver.md.';
    if (options.strictVersion) {
      handle.close();
      throw new Error(message);
    }
    options.onVersionWarning?.(message);
  }

  // WAL lets the Telegram poller and health checks read while the recorder
  // writes. busy_timeout covers the brief exclusive moments (checkpoint).
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA synchronous = NORMAL');

  migrate(handle);

  return {
    handle,
    sqliteVersion: version,
    close: () => handle.close(),
  };
}

/**
 * Applies every unapplied migration in filename order inside one transaction
 * each. Re-running is a no-op, which is what makes daemon restarts safe.
 */
export function migrate(handle: DatabaseSync): readonly string[] {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    ) STRICT
  `);

  const applied = new Set(
    (handle.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const newlyApplied: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    handle.exec('BEGIN');
    try {
      handle.exec(sql);
      handle
        .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(name, new Date().toISOString());
      handle.exec('COMMIT');
      newlyApplied.push(name);
    } catch (error) {
      handle.exec('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
    }
  }
  return newlyApplied;
}

/**
 * Runs `fn` in an IMMEDIATE transaction. IMMEDIATE takes the write lock up
 * front so two writers fail fast with SQLITE_BUSY instead of deadlocking after
 * doing work.
 */
export function transaction<T>(handle: DatabaseSync, fn: () => T): T {
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // Rollback can fail if the transaction was already aborted; the original
      // error is the one worth surfacing.
    }
    throw error;
  }
}
