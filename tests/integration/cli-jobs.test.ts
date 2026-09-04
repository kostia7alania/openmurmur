import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { markExhaustedIncomingFile } from '../../src/cli/daemon.ts';
import { shellQuotedStateRoot } from '../../src/cli/setup.ts';
import { type Database, openDatabase } from '../../src/database/db.ts';
import { appendIncomingTranscript, IncomingFileRepository } from '../../src/database/repository.ts';
import {
  renderDeadJobAlert,
  TELEGRAM_RECOVERY_COMMAND_CONTEXT,
} from '../../src/jobs/diagnostics.ts';
import { JobQueue } from '../../src/jobs/queue.ts';
import { Outbox } from '../../src/telegram/outbox.ts';

let root: string;
let temporaryRoot: string;
let db: Database;

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'om-cli-jobs-'));
  root = join(temporaryRoot, "state root's files");
  mkdirSync(root);
  db = openDatabase({ file: join(root, 'openmurmur.db') });
});

afterEach(() => {
  db.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, ['src/cli/main.ts', ...args, '--root', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function exhaust(kind: 'summarize' | 'retention'): string {
  const jobs = new JobQueue(db.handle);
  jobs.enqueue({ kind, idempotencyKey: `${kind}:cli`, payload: {}, maxAttempts: 1 });
  const claimed = jobs.claim([kind]);
  assert.ok(claimed);
  jobs.fail(claimed, kind === 'summarize' ? 'Ollama is not reachable' : 'legacy failure');
  return claimed.jobId;
}

describe('failed-job CLI recovery', () => {
  it('lists the local cause as JSON and re-queues one selected job', () => {
    const jobId = exhaust('summarize');

    const listed = run('jobs', 'failed', '--json');
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(!listed.stdout.includes(root), 'JSON diagnostics must not add the selected root');
    const payload = JSON.parse(listed.stdout) as {
      hostName: string;
      failedJobs: { jobId: string; kind: string; lastError: string }[];
    };
    assert.ok(payload.hostName.length > 0);
    assert.deepEqual(payload.failedJobs, [
      {
        ...payload.failedJobs[0],
        jobId,
        kind: 'summarize',
        lastError: 'Ollama is not reachable',
      },
    ]);

    const retried = run('jobs', 'retry', jobId);
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /It will run when the OpenMurmur daemon is running/);
    assert.equal(new JobQueue(db.handle).pendingCount('summarize'), 1);
  });

  it('refuses a legacy kind that no daemon loop can execute', () => {
    const jobId = exhaust('retention');

    const retried = run('jobs', 'retry', jobId);
    assert.equal(retried.status, 1);
    assert.match(retried.stderr, /has no daemon worker and cannot be retried/);
    assert.equal(new JobQueue(db.handle).deadCount(), 1);
  });

  it('retries retained incoming audio with an atomic forced-language snapshot', () => {
    const jobs = new JobQueue(db.handle);
    const message = {
      message_id: 9,
      date: 0,
      chat: { id: 42, type: 'private' },
      voice: { file_id: 'voice-9', file_unique_id: 'voice-unique-9' },
    };
    const incomingFiles = new IncomingFileRepository(db.handle);
    const incoming = incomingFiles.claim({
      telegramFileId: message.voice.file_id,
      telegramUniqueId: message.voice.file_unique_id,
      chatId: message.chat.id,
      messageId: message.message_id,
      updateId: 9,
      telegramSource: 'direct',
      attachmentType: 'voice',
      claimedFilename: null,
      telegramMessageAt: '1970-01-01T00:00:00.000Z',
      originalSentAt: null,
      daemonHost: 'test-mac.local',
      declaredBytes: 12,
      declaredMime: 'audio/ogg',
    });
    const sourceDir = join(root, 'quarantine');
    const sourcePath = join(sourceDir, `${incoming.fileUid}.ogg`);
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(sourcePath, 'retained audio');
    incomingFiles.markDownloaded(incoming.fileUid, sourcePath, 14);

    jobs.enqueue({
      kind: 'incoming_audio',
      idempotencyKey: 'incoming:job-9',
      payload: { fileUid: incoming.fileUid, message, forcedLanguage: null },
      maxAttempts: 1,
    });
    const claimed = jobs.claim(['incoming_audio']);
    assert.ok(claimed);
    jobs.fail(claimed, 'ASR failed: Japanese tokenization requires optional dependency `nagisa`.');
    assert.equal(markExhaustedIncomingFile(db.handle, claimed.payload), true);

    const invalid = run('jobs', 'retry', claimed.jobId, '--language', 'ja');
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /--language must be one of: ru, th, en, zh/);
    assert.equal(jobs.deadCount(), 1, 'an invalid correction must not mutate the dead job');

    const retried = run('jobs', 'retry', claimed.jobId, '--language', 'ru', '--json');
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(JSON.parse(retried.stdout), {
      jobId: claimed.jobId,
      requeued: true,
      forcedLanguage: 'Russian',
    });

    const stored = db.handle
      .prepare('SELECT state, attempts, payload FROM jobs WHERE job_id = ?')
      .get(claimed.jobId) as { state: string; attempts: number; payload: string };
    assert.equal(stored.state, 'pending');
    assert.equal(stored.attempts, 0);
    assert.deepEqual(JSON.parse(stored.payload), {
      fileUid: incoming.fileUid,
      message,
      forcedLanguage: 'Russian',
    });
    assert.deepEqual(
      {
        state: incomingFiles.get(incoming.fileUid)?.state,
        rejectionReason: (
          db.handle
            .prepare('SELECT rejection_reason FROM incoming_telegram_files WHERE file_uid = ?')
            .get(incoming.fileUid) as { rejection_reason: string | null }
        ).rejection_reason,
        quarantinePath: incomingFiles.get(incoming.fileUid)?.quarantinePath,
      },
      { state: 'received', rejectionReason: null, quarantinePath: sourcePath },
    );
    assert.equal(new Outbox(db.handle).stateOf(`incoming-failed:${incoming.fileUid}`), null);

    const retryClaim = jobs.claim(['incoming_audio']);
    assert.ok(retryClaim);
    assert.equal(retryClaim.payload['forcedLanguage'], 'Russian');
    assert.deepEqual(retryClaim.payload['message'], message);

    assert.equal(
      jobs.fail(
        retryClaim,
        'ASR failed: Japanese tokenization requires optional dependency `nagisa`.',
      ),
      'dead',
    );
    assert.equal(markExhaustedIncomingFile(db.handle, retryClaim.payload), true);
    assert.equal(new Outbox(db.handle).stateOf(`incoming-failed:${incoming.fileUid}`), 'pending');

    const telegramAlert = renderDeadJobAlert(
      'test-mac.local',
      jobs.deadJobs(),
      'qwen3.8:27b',
      TELEGRAM_RECOVERY_COMMAND_CONTEXT,
    );
    assert.ok(!telegramAlert.detail.includes(root), 'Telegram must not expose the state root');
    const recoveryCommands = telegramAlert.detail.split('\n').flatMap((line) => {
      const start = line.indexOf('pnpm openmurmur ');
      return start === -1 ? [] : [line.slice(start)];
    });
    assert.equal(recoveryCommands.length, 5, 'doctor plus four language retries');
    assert.ok(
      recoveryCommands.every((command) =>
        command.includes(TELEGRAM_RECOVERY_COMMAND_CONTEXT.stateRootArgument),
      ),
    );
    const russianRetry = recoveryCommands.find((command) => command.endsWith('--language ru'));
    assert.ok(russianRetry);

    const unsetEnvironment = { ...process.env };
    delete unsetEnvironment['OPENMURMUR_STATE_ROOT'];
    const unset = spawnSync('/bin/sh', ['-c', russianRetry], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: unsetEnvironment,
    });
    assert.notEqual(unset.status, 0);
    assert.match(unset.stderr, /set exact daemon state root locally/);
    assert.equal(jobs.deadCount(), 1, 'unset placeholder must fail before the CLI mutates a job');

    const localReport = run('jobs', 'failed');
    assert.equal(localReport.status, 0, localReport.stderr);
    const quotedRoot = shellQuotedStateRoot(root);
    assert.ok(quotedRoot);
    assert.match(localReport.stdout, new RegExp(`--root ${escapeRegExp(quotedRoot)}`));

    const quotedNode = shellQuotedStateRoot(process.execPath);
    assert.ok(quotedNode);
    const productionScriptRetry = [
      'pnpm() {',
      '  [ "$1" = openmurmur ] || return 97',
      '  shift',
      `  ${quotedNode} src/cli/main.ts "$@"`,
      '}',
      russianRetry,
    ].join('\n');
    const finalRetry = spawnSync('/bin/sh', ['-c', productionScriptRetry], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, OPENMURMUR_STATE_ROOT: root },
    });
    assert.equal(finalRetry.status, 0, `${finalRetry.stderr}\n${finalRetry.stdout}`);
    const finalClaim = jobs.claim(['incoming_audio']);
    assert.ok(finalClaim);
    assert.equal(finalClaim.payload['forcedLanguage'], 'Russian');
    appendIncomingTranscript(db.handle, {
      incomingFileId: incoming.fileUid,
      engine: 'fake-local',
      model: 'fake-asr',
      languages: ['ru'],
      forcedLanguage: finalClaim.payload['forcedLanguage'] as string,
      text: 'восстановленная расшифровка',
      segments: [],
    });
    assert.equal(jobs.complete(finalClaim), true);

    const converged = db.handle
      .prepare(
        `SELECT f.state, f.rejection_reason, f.quarantine_path, r.forced_language
           FROM incoming_telegram_files f
           JOIN transcript_revisions r ON r.incoming_file_id = f.file_uid AND r.is_current = 1
          WHERE f.file_uid = ?`,
      )
      .get(incoming.fileUid) as {
      state: string;
      rejection_reason: string | null;
      quarantine_path: string | null;
      forced_language: string | null;
    };
    assert.deepEqual(
      { ...converged },
      {
        state: 'transcribed',
        rejection_reason: null,
        quarantine_path: sourcePath,
        forced_language: 'Russian',
      },
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
