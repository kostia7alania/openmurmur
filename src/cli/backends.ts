import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeAsr } from '../asr/fake.ts';
import { MlxAsr } from '../asr/mlx.ts';
import type { AsrBackend } from '../asr/types.ts';
import { WorkerProcess } from '../asr/worker-process.ts';
import type { LoadedConfig } from '../config/load.ts';
import type { OpenMurmurConfig } from '../config/schema.ts';
import { FakeLlm, type LlmBackend, OllamaLlm } from '../llm/ollama.ts';
import type { Logger } from '../logging/logger.ts';
import { SileroStreamVad, WorkerFrameScorer } from '../sessionizer/silero.ts';
import { EnergyVad, type Vad } from '../sessionizer/vad.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PYTHON_PROJECT = join(REPO_ROOT, 'python', 'openmurmur_audio');
export const WORKER_ARGS = [
  'run',
  '--no-sync',
  '--project',
  PYTHON_PROJECT,
  'openmurmur-audio-worker',
] as const;

/**
 * Backend selection.
 *
 * The `fake` backends exist so CI and the delivery/retention tests can run
 * without a 1.7B model, Metal, or a network. They are never a silent fallback:
 * choosing them requires an explicit config change, and `doctor` reports it as
 * a warning, because a user who thinks they are getting real transcripts and
 * is getting placeholders has a much worse problem than a clear error.
 */
export function createAsrBackend(loaded: LoadedConfig, logger: Logger): AsrBackend {
  if (loaded.config.asr.backend === 'fake') return new FakeAsr();

  return new MlxAsr({
    command: 'uv',
    args: [...WORKER_ARGS],
    cwd: REPO_ROOT,
    model: loaded.config.asr.model,
    quantization: loaded.config.asr.quantization,
    alignerLanguages: loaded.config.asr.alignerLanguages,
    requestTimeoutMs: loaded.config.asr.pythonWorkerTimeoutMs,
    workerIdleTimeoutMs: loaded.config.asr.workerIdleTimeoutMs,
    logger: logger.child('asr'),
  });
}

export interface VadBackendHooks {
  readonly onDegraded?: (reason: string) => void;
  readonly onRecovered?: () => void;
}

/**
 * The live speech detector.
 *
 * It gets its own Python process rather than sharing the ASR worker: that one
 * handles requests in order, so a transcription in flight would hold up every
 * frame behind it — and those frames are what decide whether the microphone is
 * hearing speech right now.
 */
export function createVadBackend(
  loaded: LoadedConfig,
  logger: Logger,
  hooks: VadBackendHooks = {},
): Vad {
  if (loaded.config.sessionizer.vadBackend === 'energy') return new EnergyVad();

  const worker = new WorkerProcess({
    command: 'uv',
    args: [...WORKER_ARGS],
    cwd: REPO_ROOT,
    logger: logger.child('vad'),
    label: 'VAD',
  });

  return new SileroStreamVad({
    scorer: new WorkerFrameScorer(worker),
    logger: logger.child('vad'),
    ...(hooks.onDegraded ? { onDegraded: hooks.onDegraded } : {}),
    ...(hooks.onRecovered ? { onRecovered: hooks.onRecovered } : {}),
  });
}

export function createLlmBackend(config: OpenMurmurConfig): LlmBackend {
  if (config.llm.backend === 'fake') return new FakeLlm();
  return new OllamaLlm(config.llm);
}

export { PYTHON_PROJECT, REPO_ROOT };
