import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compactJobError,
  deadJobFingerprint,
  failureCategory,
  publicJobFailureReason,
  renderAsrUnavailableDetail,
  renderDeadJobAlert,
  renderLlmUnavailableDetail,
  TELEGRAM_RECOVERY_COMMAND_CONTEXT,
} from '../../src/jobs/diagnostics.ts';
import type { DeadJob } from '../../src/jobs/queue.ts';

const LOCAL_COMMAND_CONTEXT = { stateRootArgument: "'/tmp/openmurmur'" } as const;

function deadJob(overrides: Partial<DeadJob> = {}): DeadJob {
  return {
    jobId: 'job-1',
    kind: 'asr',
    idempotencyKey: 'asr:session-1',
    attempts: 5,
    maxAttempts: 5,
    updatedAt: '2026-08-10T10:00:00.000Z',
    lastError: 'model_load_failed: mlx is missing',
    ...overrides,
  };
}

describe('failed job diagnostics', () => {
  it('shows host, job kind, bounded cause, install hint and retry command', () => {
    const alert = renderDeadJobAlert(
      'prod-mac.local',
      [deadJob()],
      'qwen3.6:27b',
      LOCAL_COMMAND_CONTEXT,
    );

    assert.equal(alert.active, true);
    assert.match(alert.detail, /Демон: prod-mac\.local/);
    assert.match(alert.detail, /asr — job-1/);
    assert.match(alert.detail, /Локальный ASR\/MLX worker/);
    assert.match(alert.detail, /uv sync --project python\/openmurmur_audio --extra mlx/);
    assert.match(alert.detail, /pnpm openmurmur --root '\/tmp\/openmurmur' jobs retry job-1/);
  });

  it('suggests the configured Ollama model for a summary failure', () => {
    const alert = renderDeadJobAlert(
      'prod-mac.local',
      [deadJob({ kind: 'summarize', lastError: 'Ollama is not reachable' })],
      'qwen3.6:27b',
      LOCAL_COMMAND_CONTEXT,
    );
    assert.match(alert.detail, /ollama pull qwen3\.6:27b/);
  });

  it('turns the optional-tokenizer failure into exact forced-language recovery commands', () => {
    const lastError =
      'ASR failed: RuntimeError: Japanese tokenization requires optional dependency `nagisa`. Install with: pip install "mlx-qwen3-asr[aligner]"';
    const alert = renderDeadJobAlert(
      'prod-mac.local',
      [
        deadJob({
          kind: 'incoming_audio',
          lastError,
        }),
      ],
      'qwen3.6:27b',
      LOCAL_COMMAND_CONTEXT,
      { technicalDetails: true },
    );

    assert.match(alert.detail, /requires optional dependency `nagisa`/);
    assert.match(alert.detail, /jobs retry job-1 --language ru/);
    assert.match(alert.detail, /jobs retry job-1 --language th/);
    assert.match(alert.detail, /jobs retry job-1 --language en/);
    assert.match(alert.detail, /jobs retry job-1 --language zh/);
    assert.match(compactJobError(lastError), /pip install/);
    assert.ok(!alert.detail.includes('pip install'));
    assert.ok(!alert.detail.includes('uv sync --project python/openmurmur_audio --extra mlx'));
  });

  it('keeps technical exceptions local and makes copyable model commands safe', () => {
    const privateError = 'Ollama failed reading /Users/alice/private/recording.flac';
    const telegram = renderDeadJobAlert(
      'prod.local',
      [deadJob({ lastError: privateError })],
      'qwen\nrm -rf data',
      TELEGRAM_RECOVERY_COMMAND_CONTEXT,
    );
    assert.ok(!telegram.detail.includes('/Users/alice'));
    assert.ok(!telegram.detail.includes('rm -rf'));

    const local = renderDeadJobAlert(
      'prod.local',
      [deadJob({ lastError: privateError })],
      'qwen',
      LOCAL_COMMAND_CONTEXT,
      { technicalDetails: true },
    );
    assert.match(local.detail, /\/Users\/alice\/private/);
  });

  it('classifies stable public causes without exposing volatile error text', () => {
    assert.equal(failureCategory('model_load_failed: mlx missing at /Users/a'), 'asr_dependency');
    assert.equal(failureCategory('Ollama is not reachable'), 'llm_dependency');
    assert.match(publicJobFailureReason('operation timed out after 5s'), /превысила/);
  });

  it('gives local repair steps for unavailable ASR and Ollama dependencies', () => {
    assert.match(
      renderAsrUnavailableDetail('prod.local', 'worker exited', LOCAL_COMMAND_CONTEXT),
      /uv sync --project python\/openmurmur_audio --extra mlx/,
    );
    const llm = renderLlmUnavailableDetail(
      'prod.local',
      'not reachable',
      'qwen3.6:27b',
      LOCAL_COMMAND_CONTEXT,
    );
    assert.match(llm, /Аудио и расшифровки продолжают работать/);
    assert.match(llm, /brew services start ollama/);
    assert.match(llm, /ollama pull qwen3\.6:27b/);
  });

  it('fingerprints the whole set independent of query order', () => {
    const first = deadJobFingerprint([deadJob(), deadJob({ jobId: 'job-2' })]);
    const reordered = deadJobFingerprint([deadJob({ jobId: 'job-2' }), deadJob()]);
    assert.equal(first, reordered);
    assert.notEqual(first, deadJobFingerprint([deadJob()]));
    assert.notEqual(
      deadJobFingerprint([deadJob()]),
      deadJobFingerprint([
        deadJob({
          updatedAt: '2026-08-10T11:00:00.000Z',
          lastError: 'model still missing after retry',
        }),
      ]),
      'the same row dying again is a new failure generation',
    );
  });

  it('redacts tokens and bounds an untrusted stored error', () => {
    const token = `123456789:${'A'.repeat(36)}`;
    const compact = compactJobError(`request ${token} ${'x'.repeat(500)}`);
    assert.ok(!compact.includes('123456789:'));
    assert.ok(compact.length <= 240);
  });
});
