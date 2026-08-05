import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Logger } from '../logging/logger.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';
import { decodeResponse, encodeRequest, LineSplitter } from './protocol.ts';

/**
 * A long-lived Python worker process speaking NDJSON.
 *
 * Shared by the two things that need one, for the same reason in both cases:
 * loading a model per request would cost more than the request itself.
 *
 * They get *separate processes* rather than sharing one. The worker handles
 * requests strictly in order on a single thread, so a transcription that takes
 * thirty seconds would hold up every streaming VAD frame behind it — and the
 * frames it delayed are the ones deciding whether someone is speaking right
 * now. A second process costs a few hundred megabytes of onnxruntime; a stalled
 * recorder costs the recording.
 */

export interface WorkerProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logger: Logger;
  /** Appears in log lines, so two workers can be told apart. */
  readonly label: string;
  /** Called when the process exits, expectedly or not. */
  readonly onExit?: () => void;
}

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class WorkerProcess {
  readonly #options: WorkerProcessOptions;
  readonly #pending = new Map<string, Pending>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #startPromise: Promise<void> | null = null;

  constructor(options: WorkerProcessOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  ensureStarted(): Promise<void> {
    if (this.#child !== null) return Promise.resolve();
    if (this.#startPromise !== null) return this.#startPromise;

    this.#startPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.#options.command, [...this.#options.args], {
          cwd: this.#options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          // The worker gets no secrets. It only ever sees audio.
          env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        });
      } catch (error) {
        reject(new Error(`could not start the ${this.#options.label} worker: ${asMessage(error)}`));
        return;
      }

      const splitter = new LineSplitter();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) this.#dispatch(line);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.#options.logger.debug(`${this.#options.label} worker stderr`, {
          text: chunk.trimEnd().slice(0, 2000),
        });
      });

      child.on('error', (error) => {
        this.#failAll(new Error(`${this.#options.label} worker failed to start: ${error.message}`));
        reject(new Error(missingWorkerHint(this.#options.command, error.message)));
      });

      child.on('close', (code) => {
        this.#child = null;
        this.#startPromise = null;
        this.#failAll(new Error(`${this.#options.label} worker exited with code ${code}`));
        this.#options.onExit?.();
      });

      this.#child = child;
      resolve();
    }).finally(() => {
      this.#startPromise = null;
    });

    return this.#startPromise;
  }

  send(request: WorkerRequest, timeoutMs: number): Promise<WorkerResponse> {
    const child = this.#child;
    if (child === null) {
      return Promise.reject(new Error(`${this.#options.label} worker is not running`));
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(
          new Error(
            `${this.#options.label} worker did not answer "${request.op}" within ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(request.id, { resolve, reject, timer });
      child.stdin.write(encodeRequest(request), (error) => {
        if (!error) return;
        this.#pending.delete(request.id);
        clearTimeout(timer);
        reject(new Error(`could not write to the ${this.#options.label} worker: ${error.message}`));
      });
    });
  }

  async close(shutdownId: string): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    try {
      await this.send({ id: shutdownId, op: 'shutdown' }, 5000);
    } catch {
      // Already gone or wedged; SIGTERM below is the fallback.
    }
    child.kill('SIGTERM');
    this.#child = null;
  }

  #dispatch(line: string): void {
    let response: WorkerResponse;
    try {
      response = decodeResponse(line);
    } catch (error) {
      this.#options.logger.warn('discarding malformed worker line', { error: asMessage(error) });
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  #failAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function missingWorkerHint(command: string, detail: string): string {
  return (
    `Could not start the local audio worker ("${command}"): ${detail}\n\n` +
    'OpenMurmur transcribes on-device and does not fall back to any cloud service.\n' +
    'Fix it with:\n' +
    '  ./scripts/bootstrap          # installs uv and the Python environment\n' +
    '  openmurmur doctor            # re-checks every dependency\n\n' +
    'To run without models (delivery pipeline only), set asr.backend to "fake" in the config.'
  );
}
