import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MINIMUM_SQLITE_VERSION } from '../config/runtime-requirements.ts';

export { MINIMUM_SQLITE_VERSION } from '../config/runtime-requirements.ts';

/**
 * Minimum SQLite runtime we are willing to run against.
 *
 * Node 26.8.1 bundles 3.53.4, matching this target. We still query the actual
 * runtime because `node:sqlite` is compiled into Node; a Homebrew sqlite3
 * upgrade does not change it. See docs/adr/0004-sqlite-driver.md.
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function migrationFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

interface MigrationLedgerColumn {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: unknown;
  readonly pk: number;
  readonly hidden: number;
}

interface MigrationLedgerRow {
  readonly name: unknown;
  readonly applied_at: unknown;
}

function invalidMigrationLedger(detail: string): Error {
  return new Error(
    `Invalid database migration ledger: ${detail}. ` +
      'Restore a valid database or upgrade OpenMurmur before retrying; ' +
      'refusing to downgrade or write this database.',
  );
}

/**
 * A database created by a newer build must never be silently opened by an
 * older binary. Keep this guard read-only so it can run before WAL or any
 * migration changes the file.
 */
function assertKnownMigrationLedger(
  handle: DatabaseSync,
  localMigrations: readonly string[],
): Set<string> {
  const ledgerObject = handle
    .prepare("SELECT type FROM sqlite_schema WHERE name = 'schema_migrations'")
    .get() as { readonly type: string } | undefined;
  if (ledgerObject === undefined) return new Set();
  if (ledgerObject.type !== 'table') {
    throw invalidMigrationLedger(`schema_migrations is a ${ledgerObject.type}, not a table`);
  }

  let columns: readonly MigrationLedgerColumn[];
  let tableShape:
    | {
        readonly schema: string;
        readonly name: string;
        readonly type: string;
        readonly ncol: number;
        readonly wr: number;
        readonly strict: number;
      }
    | undefined;
  let rows: readonly MigrationLedgerRow[];
  try {
    columns = handle
      .prepare("PRAGMA main.table_xinfo('schema_migrations')")
      .all() as unknown as readonly MigrationLedgerColumn[];
    tableShape = handle.prepare("PRAGMA main.table_list('schema_migrations')").get() as
      | {
          readonly schema: string;
          readonly name: string;
          readonly type: string;
          readonly ncol: number;
          readonly wr: number;
          readonly strict: number;
        }
      | undefined;
    rows = handle
      .prepare('SELECT name, applied_at FROM main.schema_migrations')
      .all() as unknown as readonly MigrationLedgerRow[];
  } catch (cause) {
    throw new Error(
      'Cannot validate database schema_migrations. Restore a valid database or upgrade ' +
        'OpenMurmur before retrying; do not edit or downgrade the migration ledger.',
      { cause },
    );
  }

  const exactColumns =
    columns.length === 2 &&
    columns[0]?.cid === 0 &&
    columns[0].name === 'name' &&
    columns[0].type === 'TEXT' &&
    columns[0].notnull === 1 &&
    columns[0].dflt_value === null &&
    columns[0].pk === 1 &&
    columns[0].hidden === 0 &&
    columns[1]?.cid === 1 &&
    columns[1].name === 'applied_at' &&
    columns[1].type === 'TEXT' &&
    columns[1].notnull === 1 &&
    columns[1].dflt_value === null &&
    columns[1].pk === 0 &&
    columns[1].hidden === 0;
  const exactTable =
    tableShape?.schema === 'main' &&
    tableShape.name === 'schema_migrations' &&
    tableShape.type === 'table' &&
    tableShape.ncol === 2 &&
    tableShape.wr === 0 &&
    tableShape.strict === 1;
  if (!exactColumns || !exactTable) {
    throw invalidMigrationLedger('schema_migrations does not have the canonical STRICT shape');
  }

  const names: string[] = [];
  for (const row of rows) {
    const canonicalAppliedAt =
      typeof row.applied_at === 'string' &&
      Number.isFinite(Date.parse(row.applied_at)) &&
      new Date(row.applied_at).toISOString() === row.applied_at;
    if (typeof row.name !== 'string' || row.name.trim().length === 0 || !canonicalAppliedAt) {
      throw invalidMigrationLedger(
        'migration names must be non-empty text and applied_at must be a canonical UTC timestamp',
      );
    }
    names.push(row.name);
  }

  const applied = new Set(names);
  if (applied.size !== names.length) {
    throw invalidMigrationLedger('duplicate migration names are not allowed');
  }
  const known = new Set(localMigrations);
  const unknown = [...applied].filter((name) => !known.has(name)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `Database contains unknown or future migrations: ${unknown.join(', ')}. ` +
        'Upgrade OpenMurmur to a compatible version; refusing to downgrade or write this database.',
    );
  }

  const sortedApplied = [...applied].sort();
  const expectedPrefix = localMigrations.slice(0, sortedApplied.length);
  const firstMismatch = sortedApplied.findIndex((name, index) => name !== expectedPrefix[index]);
  if (firstMismatch !== -1) {
    throw invalidMigrationLedger(
      `applied migrations are not a contiguous filename-ordered prefix; expected ${expectedPrefix[firstMismatch] ?? 'no additional migration'} but found ${sortedApplied[firstMismatch]}`,
    );
  }
  return applied;
}

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
  try {
    const version = sqliteVersionOf(handle);
    assertKnownMigrationLedger(handle, migrationFiles());

    if (compareVersions(version, MINIMUM_SQLITE_VERSION) < 0) {
      const message =
        `SQLite runtime ${version} is older than the ${MINIMUM_SQLITE_VERSION} target ` +
        `(node:sqlite is compiled into Node ${process.versions.node}; a Homebrew sqlite3 ` +
        'does not change it). See docs/adr/0004-sqlite-driver.md.';
      if (options.strictVersion) throw new Error(message);
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
  } catch (error) {
    handle.close();
    throw error;
  }
}

/**
 * Applies every unapplied migration in filename order inside one transaction
 * each. Re-running is a no-op, which is what makes daemon restarts safe.
 */
export function migrate(handle: DatabaseSync): readonly string[] {
  const files = migrationFiles();
  const applied = assertKnownMigrationLedger(handle, files);

  handle.exec(`
    CREATE TABLE IF NOT EXISTS main.schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    ) STRICT
  `);

  const newlyApplied: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    handle.exec('BEGIN');
    try {
      handle.exec(sql);
      handle
        .prepare('INSERT INTO main.schema_migrations (name, applied_at) VALUES (?, ?)')
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
