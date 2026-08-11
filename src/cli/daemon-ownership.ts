import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type Database, transaction } from '../database/db.ts';
import { JobQueue } from '../jobs/queue.ts';
import { writeTextAtomically } from '../util/atomic-file.ts';

export interface DaemonPidRecord {
  readonly pid: number;
  readonly root: string | null;
  readonly startedAt: string | null;
  readonly processBirth: string | null;
}

export interface DaemonPidClaim extends DaemonPidRecord {
  readonly root: string;
  readonly startedAt: string;
  readonly processBirth: string;
  /** True only when this claim replaced an owner whose process was proven absent. */
  readonly reclaimedPreviousDaemon: boolean;
  /** JobQueue owner whose exact leases may be returned without burning an attempt. */
  readonly reclaimedJobOwner: string | null;
  /** Exact prior-generation leases returned in the ownership transaction. */
  readonly reclaimedJobs: number;
}

export interface DaemonOwnershipRecord {
  readonly pid: number;
  readonly root: string;
  readonly startedAt: string;
  readonly processBirth: string;
}

export function daemonJobOwner(owner: DaemonOwnershipRecord): string {
  return `daemon:${owner.pid}:${owner.startedAt}:${owner.processBirth}`;
}

export interface DaemonProcessState {
  readonly alive: boolean;
  readonly identityMatches: boolean;
  readonly command: string | null;
  readonly processBirth: string | null;
}

export type DaemonControlSnapshot =
  | {
      readonly source: 'sqlite';
      readonly record: DaemonOwnershipRecord;
      readonly process: DaemonProcessState;
    }
  | {
      readonly source: 'legacy';
      readonly record: DaemonPidRecord;
      readonly process: DaemonProcessState;
    }
  | { readonly source: 'none'; readonly record: null; readonly process: null };

export function parseDaemonPid(value: string): DaemonPidRecord | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number.parseInt(trimmed, 10);
    return pid > 0 ? { pid, root: null, startedAt: null, processBirth: null } : null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const pid = parsed['pid'];
    const root = parsed['root'];
    const startedAt = parsed['startedAt'];
    const processBirth = parsed['processBirth'];
    if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
    if (typeof root !== 'string' || typeof startedAt !== 'string') return null;
    if (processBirth !== undefined && typeof processBirth !== 'string') return null;
    return {
      pid: pid as number,
      root,
      startedAt,
      processBirth: processBirth ?? null,
    };
  } catch {
    return null;
  }
}

export async function readDaemonPid(pidFile: string): Promise<DaemonPidRecord | null> {
  try {
    return parseDaemonPid(await readFile(pidFile, 'utf8'));
  } catch {
    return null;
  }
}

async function readDaemonPidForClaim(pidFile: string): Promise<DaemonPidRecord | null> {
  let text: string;
  try {
    text = await readFile(pidFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const record = parseDaemonPid(text);
  if (record === null) {
    throw new Error(`daemon pid file is invalid; inspect it manually: ${pidFile}`);
  }
  return record;
}

export function commandLooksLikeOpenMurmurDaemon(command: string): boolean {
  return command.toLowerCase().includes('openmurmur') && /(?:^|\s)start(?:\s|$)/.test(command);
}

export function processIdentityMatches(
  command: string | null,
  actualBirth: string | null,
  expectedBirth: string | null,
): boolean {
  return (
    command !== null &&
    actualBirth !== null &&
    expectedBirth !== null &&
    actualBirth === expectedBirth &&
    commandLooksLikeOpenMurmurDaemon(command)
  );
}

function processCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', ['-p', String(pid), '-o', 'command='], (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const command = stdout.trim();
        resolve(command.length > 0 ? command : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function processBirthMarker(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], (error, stdout) => {
        const marker = stdout.trim();
        resolve(error || marker.length === 0 ? null : marker);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function inspectDaemonProcess(
  pid: number,
  expectedBirth: string | null,
): Promise<DaemonProcessState> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      return { alive: false, identityMatches: false, command: null, processBirth: null };
    }
  }

  const [command, processBirth] = await Promise.all([processCommand(pid), processBirthMarker(pid)]);
  return {
    alive: true,
    identityMatches: processIdentityMatches(command, processBirth, expectedBirth),
    command,
    processBirth,
  };
}

interface DaemonPidClaimDependencies {
  readonly birthMarker?: (pid: number) => Promise<string | null>;
  readonly inspect?: typeof inspectDaemonProcess;
  readonly beforeMirrorPublish?: () => void;
}

function canonicalUtc(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function daemonOwnershipError(detail: string): Error {
  return new Error(`invalid daemon ownership: ${detail}; refusing to assume the daemon is stopped`);
}

export function readDaemonOwnership(
  db: Database['handle'],
  expectedRoot?: string,
): DaemonOwnershipRecord | null {
  const row = db
    .prepare(
      `SELECT daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at
         FROM daemon_ownership
        WHERE ownership_id = 1`,
    )
    .get() as
    | {
        daemon_pid: number;
        daemon_root: string;
        daemon_started_at: string;
        process_birth: string;
        claimed_at: string;
      }
    | undefined;
  if (row === undefined) return null;
  if (!Number.isSafeInteger(row.daemon_pid) || row.daemon_pid <= 0) {
    throw daemonOwnershipError('daemon_pid is not a positive safe integer');
  }
  if (row.daemon_root.trim().length === 0 || row.process_birth.trim().length === 0) {
    throw daemonOwnershipError('root and process birth must be non-empty');
  }
  if (!canonicalUtc(row.daemon_started_at) || !canonicalUtc(row.claimed_at)) {
    throw daemonOwnershipError('timestamps are not canonical UTC instants');
  }
  if (expectedRoot !== undefined && row.daemon_root !== expectedRoot) {
    throw daemonOwnershipError('the stored root does not match this database root');
  }
  return {
    pid: row.daemon_pid,
    root: row.daemon_root,
    startedAt: row.daemon_started_at,
    processBirth: row.process_birth,
  };
}

function sameDaemonPidRecord(
  left: DaemonOwnershipRecord | DaemonPidRecord | null,
  right: DaemonOwnershipRecord | DaemonPidRecord | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.pid === right.pid &&
    left.root === right.root &&
    left.startedAt === right.startedAt &&
    left.processBirth === right.processBirth
  );
}

function sameDaemonOwnership(
  left: DaemonOwnershipRecord | DaemonPidRecord | null,
  right: DaemonOwnershipRecord,
): boolean {
  return sameDaemonPidRecord(left, right);
}

function readDaemonPidSyncForClaim(pidFile: string): DaemonPidRecord | null {
  try {
    const record = parseDaemonPid(readFileSync(pidFile, 'utf8'));
    if (record === null) {
      throw new Error(`daemon pid file is invalid; inspect it manually: ${pidFile}`);
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function removeObservedDaemonMirror(pidFile: string, observed: DaemonPidRecord | null): boolean {
  const current = readDaemonPidSyncForClaim(pidFile);
  if (!sameDaemonPidRecord(current, observed)) return false;
  if (current !== null) rmSync(pidFile, { force: true });
  return true;
}

function insertDaemonOwnership(
  db: Database['handle'],
  pidFile: string,
  observedMirror: DaemonPidRecord | null,
  identity: DaemonOwnershipRecord,
  reclaimedJobOwner: string | null,
): { readonly acquired: boolean; readonly reclaimedJobs: number } {
  return transaction(db, () => {
    if (readDaemonOwnership(db) !== null) return { acquired: false, reclaimedJobs: 0 };
    if (!removeObservedDaemonMirror(pidFile, observedMirror)) {
      return { acquired: false, reclaimedJobs: 0 };
    }
    const result = db
      .prepare(
        `INSERT INTO daemon_ownership
           (ownership_id, daemon_pid, daemon_root, daemon_started_at, process_birth, claimed_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.pid,
        identity.root,
        identity.startedAt,
        identity.processBirth,
        new Date().toISOString(),
      );
    if (Number(result.changes) !== 1) return { acquired: false, reclaimedJobs: 0 };
    return {
      acquired: true,
      reclaimedJobs:
        reclaimedJobOwner === null
          ? 0
          : new JobQueue(db).recoverLeasesAfterProvenDaemonDeath(reclaimedJobOwner),
    };
  });
}

function replaceDaemonOwnership(
  db: Database['handle'],
  pidFile: string,
  observedMirror: DaemonPidRecord | null,
  expected: DaemonOwnershipRecord,
  replacement: DaemonOwnershipRecord,
): { readonly acquired: boolean; readonly reclaimedJobs: number } {
  return transaction(db, () => {
    if (!sameDaemonOwnership(readDaemonOwnership(db), expected)) {
      return { acquired: false, reclaimedJobs: 0 };
    }
    if (!removeObservedDaemonMirror(pidFile, observedMirror)) {
      return { acquired: false, reclaimedJobs: 0 };
    }
    const result = db
      .prepare(
        `UPDATE daemon_ownership
            SET daemon_pid = ?, daemon_root = ?, daemon_started_at = ?, process_birth = ?,
                claimed_at = ?
          WHERE ownership_id = 1
            AND daemon_pid = ? AND daemon_root = ?
            AND daemon_started_at = ? AND process_birth = ?`,
      )
      .run(
        replacement.pid,
        replacement.root,
        replacement.startedAt,
        replacement.processBirth,
        new Date().toISOString(),
        expected.pid,
        expected.root,
        expected.startedAt,
        expected.processBirth,
      );
    if (Number(result.changes) !== 1) return { acquired: false, reclaimedJobs: 0 };
    return {
      acquired: true,
      reclaimedJobs: new JobQueue(db).recoverLeasesAfterProvenDaemonDeath(daemonJobOwner(expected)),
    };
  });
}

function deleteDaemonOwnership(
  db: Database['handle'],
  pidFile: string,
  expected: DaemonOwnershipRecord,
): boolean {
  return transaction(db, () => {
    if (!sameDaemonOwnership(readDaemonOwnership(db), expected)) return false;
    try {
      const mirror = parseDaemonPid(readFileSync(pidFile, 'utf8'));
      if (sameDaemonOwnership(mirror, expected)) rmSync(pidFile, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = db
      .prepare(
        `DELETE FROM daemon_ownership
          WHERE ownership_id = 1
            AND daemon_pid = ? AND daemon_root = ?
            AND daemon_started_at = ? AND process_birth = ?`,
      )
      .run(expected.pid, expected.root, expected.startedAt, expected.processBirth);
    return Number(result.changes) === 1;
  });
}

function daemonAlreadyRunningError(
  owner: DaemonOwnershipRecord | DaemonPidRecord,
  identityMatches: boolean,
): Error {
  const detail = identityMatches ? 'OpenMurmur is already running' : 'pid is in use';
  return new Error(`${detail} (pid ${owner.pid}); refusing to replace daemon ownership`);
}

async function assertNoAmbiguousLegacyDaemon(
  db: Database['handle'],
  inspect: typeof inspectDaemonProcess,
): Promise<void> {
  const heartbeat = db
    .prepare(
      `SELECT daemon_pid
         FROM daemon_heartbeat
        WHERE heartbeat_id = 1`,
    )
    .get() as { readonly daemon_pid: number } | undefined;
  if (heartbeat !== undefined) {
    if (!Number.isSafeInteger(heartbeat.daemon_pid) || heartbeat.daemon_pid <= 0) {
      throw daemonOwnershipError('legacy heartbeat has an invalid pid');
    }
    if ((await inspect(heartbeat.daemon_pid, null)).alive) {
      throw new Error(
        `a live legacy daemon may still own this database (pid ${heartbeat.daemon_pid}); ` +
          'refusing to create concurrent daemon ownership',
      );
    }
  }

  const leases = db
    .prepare("SELECT lease_expires_at FROM jobs WHERE state = 'leased'")
    .all() as unknown as readonly { readonly lease_expires_at: string | null }[];
  const now = Date.now();
  if (
    leases.some((row) => {
      if (row.lease_expires_at === null) return true;
      const expiresAt = Date.parse(row.lease_expires_at);
      return !Number.isFinite(expiresAt) || expiresAt > now;
    })
  ) {
    throw new Error(
      'unexpired work leases make legacy daemon ownership ambiguous; refusing concurrent startup',
    );
  }
}

async function assertNoConflictingLiveDaemon(
  db: Database['handle'],
  pidFile: string,
  owner: DaemonOwnershipRecord,
  inspect: typeof inspectDaemonProcess,
): Promise<DaemonPidRecord | null> {
  const mirror = await readDaemonPidForClaim(pidFile);
  if (mirror !== null && !sameDaemonOwnership(mirror, owner)) {
    if ((await inspect(mirror.pid, mirror.processBirth)).alive) {
      throw new Error(
        `PID mirror identifies another live daemon (pid ${mirror.pid}); refusing ownership takeover`,
      );
    }
  }

  const heartbeat = db
    .prepare(
      `SELECT daemon_pid, daemon_started_at
         FROM daemon_heartbeat
        WHERE heartbeat_id = 1`,
    )
    .get() as { readonly daemon_pid: number; readonly daemon_started_at: string } | undefined;
  if (
    heartbeat !== undefined &&
    (heartbeat.daemon_pid !== owner.pid || heartbeat.daemon_started_at !== owner.startedAt) &&
    (await inspect(heartbeat.daemon_pid, null)).alive
  ) {
    throw new Error(
      `heartbeat identifies another live daemon (pid ${heartbeat.daemon_pid}); ` +
        'refusing ownership takeover',
    );
  }
  return mirror;
}

export async function inspectDaemonControl(
  db: Database['handle'],
  pidFile: string,
  root: string,
  dependencies: Pick<DaemonPidClaimDependencies, 'inspect'> = {},
): Promise<DaemonControlSnapshot> {
  const inspect = dependencies.inspect ?? inspectDaemonProcess;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = readDaemonOwnership(db, root);
    if (owner !== null) {
      const process = await inspect(owner.pid, owner.processBirth);
      if (!sameDaemonOwnership(readDaemonOwnership(db, root), owner)) continue;
      return { source: 'sqlite', record: owner, process };
    }

    const legacy = await readDaemonPidForClaim(pidFile);
    if (legacy === null) {
      await assertNoAmbiguousLegacyDaemon(db, inspect);
      if (readDaemonOwnership(db, root) !== null) continue;
      if ((await readDaemonPidForClaim(pidFile)) !== null) continue;
      return { source: 'none', record: null, process: null };
    }
    if (legacy.root !== null && legacy.root !== root) {
      throw new Error('legacy daemon PID mirror belongs to another OpenMurmur root');
    }
    const process = await inspect(legacy.pid, legacy.processBirth);
    if (readDaemonOwnership(db, root) !== null) continue;
    if (
      !sameDaemonOwnership(await readDaemonPidForClaim(pidFile), legacy as DaemonOwnershipRecord)
    ) {
      continue;
    }
    return { source: 'legacy', record: legacy, process };
  }
  throw new Error('daemon ownership kept changing during inspection; retry the command');
}

async function daemonControlStillCurrent(
  db: Database['handle'],
  pidFile: string,
  root: string,
  snapshot: Exclude<DaemonControlSnapshot, { readonly source: 'none' }>,
): Promise<boolean> {
  if (snapshot.source === 'sqlite') {
    return sameDaemonOwnership(readDaemonOwnership(db, root), snapshot.record);
  }
  return (
    readDaemonOwnership(db, root) === null &&
    sameDaemonOwnership(
      await readDaemonPidForClaim(pidFile),
      snapshot.record as DaemonOwnershipRecord,
    )
  );
}

async function clearDeadDaemonControl(
  db: Database['handle'],
  pidFile: string,
  snapshot: Exclude<DaemonControlSnapshot, { readonly source: 'none' }>,
): Promise<boolean> {
  return snapshot.source === 'legacy' || releaseDaemonPid(db, pidFile, snapshot.record);
}

export async function stopOwnedDaemon(
  db: Database['handle'],
  pidFile: string,
  root: string,
  dependencies: Pick<DaemonPidClaimDependencies, 'inspect'> & {
    readonly signal?: (pid: number) => void;
  } = {},
): Promise<{
  readonly outcome: 'not_running' | 'stale' | 'identity_mismatch' | 'signalled';
  readonly pid: number | null;
}> {
  const signal = dependencies.signal ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await inspectDaemonControl(db, pidFile, root, dependencies);
    if (snapshot.source === 'none' || snapshot.record === null || snapshot.process === null) {
      return { outcome: 'not_running', pid: null };
    }
    if (!snapshot.process.alive) {
      if (!(await clearDeadDaemonControl(db, pidFile, snapshot))) continue;
      return { outcome: 'stale', pid: snapshot.record.pid };
    }
    if (!snapshot.process.identityMatches) {
      return { outcome: 'identity_mismatch', pid: snapshot.record.pid };
    }

    if (!(await daemonControlStillCurrent(db, pidFile, root, snapshot))) continue;
    signal(snapshot.record.pid);
    return { outcome: 'signalled', pid: snapshot.record.pid };
  }
  throw new Error('daemon ownership kept changing before it could be stopped; retry the command');
}

export async function claimDaemonPid(
  db: Database['handle'],
  pidFile: string,
  root: string,
  dependencies: DaemonPidClaimDependencies = {},
): Promise<DaemonPidClaim> {
  const birthMarker = dependencies.birthMarker ?? processBirthMarker;
  const inspect = dependencies.inspect ?? inspectDaemonProcess;
  const processBirth = await birthMarker(process.pid);
  if (processBirth === null) {
    throw new Error('could not establish daemon process birth identity');
  }
  const identity: DaemonOwnershipRecord = {
    pid: process.pid,
    root,
    startedAt: new Date().toISOString(),
    processBirth,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner = readDaemonOwnership(db, root);
    let reclaimedJobOwner: string | null = null;
    let acquisition = { acquired: false, reclaimedJobs: 0 };
    if (owner === null) {
      // Upgrade boundary: a daemon from the pre-SQLite ownership protocol may
      // still be live even though the new table is empty.
      const legacy = await readDaemonPidForClaim(pidFile);
      if (legacy !== null) {
        const state = await inspect(legacy.pid, legacy.processBirth);
        if (state.alive) throw daemonAlreadyRunningError(legacy, state.identityMatches);
        // Releases before SQLite ownership used the daemon PID as JobQueue owner.
        reclaimedJobOwner = String(legacy.pid);
      } else {
        await assertNoAmbiguousLegacyDaemon(db, inspect);
      }
      acquisition = insertDaemonOwnership(db, pidFile, legacy, identity, reclaimedJobOwner);
    } else {
      const state = await inspect(owner.pid, owner.processBirth);
      if (state.alive) throw daemonAlreadyRunningError(owner, state.identityMatches);
      const observedMirror = await assertNoConflictingLiveDaemon(db, pidFile, owner, inspect);
      acquisition = replaceDaemonOwnership(db, pidFile, observedMirror, owner, identity);
      if (acquisition.acquired) {
        reclaimedJobOwner = daemonJobOwner(owner);
      }
    }
    if (!acquisition.acquired) continue;

    const claim = {
      ...identity,
      reclaimedPreviousDaemon: reclaimedJobOwner !== null,
      reclaimedJobOwner,
      reclaimedJobs: acquisition.reclaimedJobs,
    } satisfies DaemonPidClaim;
    try {
      await writeTextAtomically(pidFile, `${JSON.stringify(identity)}\n`, {
        beforePublish: () => {
          if (!sameDaemonOwnership(readDaemonOwnership(db, root), identity)) {
            throw new Error('daemon ownership changed before PID publication');
          }
          dependencies.beforeMirrorPublish?.();
        },
        replaceExisting: false,
      });
      return claim;
    } catch (error) {
      await releaseDaemonPid(db, pidFile, claim);
      throw error;
    }
  }

  throw new Error('could not claim daemon ownership after concurrent changes');
}

export async function releaseDaemonPid(
  db: Database['handle'],
  pidFile: string,
  expected: DaemonOwnershipRecord,
): Promise<boolean> {
  return deleteDaemonOwnership(db, pidFile, expected);
}
