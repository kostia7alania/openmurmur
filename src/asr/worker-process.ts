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
  /** Called once when a generation exits or is retired, expectedly or not. */
  readonly onExit?: () => void;
  /** How long an intentional close waits for the protocol shutdown response. */
  readonly shutdownTimeoutMs?: number;
  /** Grace after SIGTERM and again after SIGKILL while joining the child. */
  readonly terminationGraceMs?: number;
}

interface Pending {
  generation: number;
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerGeneration {
  readonly id: number;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  resolveExited: () => void;
  didExit: boolean;
  exitNotified: boolean;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_TERMINATION_GRACE_MS = 1000;

export class WorkerProcess {
  readonly #options: WorkerProcessOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #stopping = new Map<number, Promise<void>>();
  #child: WorkerGeneration | null = null;
  #startPromise: Promise<void> | null = null;
  #startingGeneration: number | null = null;
  #closePromise: Promise<void> | null = null;
  #nextGeneration = 0;
  #closed = false;

  constructor(options: WorkerProcessOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#child !== null;
  }

  ensureStarted(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error(`${this.#options.label} worker is closed`));
    }
    if (this.#child !== null) return Promise.resolve();
    if (this.#startPromise !== null) return this.#startPromise;

    // A timed-out worker may still be between SIGTERM and SIGKILL. Never put a
    // fresh sequential worker beside it until the bounded join has completed.
    const stopping = [...this.#stopping.values()];
    if (stopping.length > 0) {
      return Promise.all(stopping).then(() => this.ensureStarted());
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#options.command, [...this.#options.args], {
        cwd: this.#options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // The worker gets no secrets. It only ever sees audio.
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      });
    } catch (error) {
      return Promise.reject(
        new Error(`could not start the ${this.#options.label} worker: ${asMessage(error)}`),
      );
    }

    let resolveExited = () => {};
    const generation: WorkerGeneration = {
      id: ++this.#nextGeneration,
      child,
      exited: new Promise<void>((resolve) => {
        resolveExited = resolve;
      }),
      resolveExited: () => resolveExited(),
      didExit: false,
      exitNotified: false,
    };
    this.#child = generation;

    const started = new Promise<void>((resolve, reject) => {
      const splitter = new LineSplitter();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of splitter.push(chunk)) this.#dispatch(generation.id, line);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.#options.logger.debug(`${this.#options.label} worker stderr`, {
          text: chunk.trimEnd().slice(0, 2000),
        });
      });

      let startSettled = false;
      child.once('spawn', () => {
        startSettled = true;
        resolve();
      });

      child.once('error', (error) => {
        const failure = new Error(missingWorkerHint(this.#options.command, error.message));
        if (!startSettled) {
          startSettled = true;
          reject(failure);
        }
        void this.#recycle(generation, failure);
      });

      child.once('close', (code, signal) => {
        generation.didExit = true;
        generation.resolveExited();
        if (this.#child?.id === generation.id) this.#child = null;
        if (this.#startingGeneration === generation.id) {
          this.#startPromise = null;
          this.#startingGeneration = null;
        }
        const detail = signal === null ? `code ${code}` : `signal ${signal}`;
        const failure = new Error(`${this.#options.label} worker exited with ${detail}`);
        this.#failGeneration(generation.id, failure);
        if (!startSettled) {
          startSettled = true;
          reject(failure);
        }
        this.#notifyExit(generation);
      });
    });

    const tracked = started.finally(() => {
      if (this.#startPromise === tracked) {
        this.#startPromise = null;
        this.#startingGeneration = null;
      }
    });
    this.#startPromise = tracked;
    this.#startingGeneration = generation.id;
    return tracked;
  }

  send(request: WorkerRequest, timeoutMs: number): Promise<WorkerResponse> {
    if (this.#closed) {
      return Promise.reject(new Error(`${this.#options.label} worker is closed`));
    }
    const generation = this.#child;
    if (generation === null) {
      return Promise.reject(new Error(`${this.#options.label} worker is not running`));
    }
    return this.#send(generation, request, timeoutMs, false);
  }

  async close(shutdownId: string): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    const closedError = new Error(`${this.#options.label} worker is closed`);

    this.#closePromise = (async () => {
      const starting = this.#startPromise;
      if (starting !== null) await starting.catch(() => {});

      const generation = this.#child;
      if (generation !== null) {
        // Do not leave callers waiting behind a shutdown request in the
        // worker's strictly sequential queue.
        this.#failGeneration(generation.id, closedError);
        try {
          await this.#send(
            generation,
            { id: shutdownId, op: 'shutdown' },
            this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
            true,
          );
        } catch {
          // Already gone or wedged; bounded termination below is the fallback.
        }
        await this.#recycle(generation, closedError);
      }

      await Promise.all([...this.#stopping.values()]);
      this.#failAll(closedError);
    })();

    return this.#closePromise;
  }

  #send(
    generation: WorkerGeneration,
    request: WorkerRequest,
    timeoutMs: number,
    allowClosed: boolean,
  ): Promise<WorkerResponse> {
    if (!allowClosed && this.#closed) {
      return Promise.reject(new Error(`${this.#options.label} worker is closed`));
    }
    if (generation.didExit || this.#child?.id !== generation.id) {
      return Promise.reject(new Error(`${this.#options.label} worker is not running`));
    }
    if (this.#pending.has(request.id)) {
      return Promise.reject(
        new Error(`${this.#options.label} worker already has request "${request.id}" pending`),
      );
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timeoutError = new Error(
        `${this.#options.label} worker did not answer "${request.op}" within ${timeoutMs} ms`,
      );
      const timer = setTimeout(() => {
        const pending = this.#pending.get(request.id);
        if (pending?.generation !== generation.id) return;
        this.#options.logger.warn(`${this.#options.label} worker request timed out`, {
          requestId: request.id,
          operation: request.op,
          timeoutMs,
        });
        // A worker is single-threaded. If one request times out, every request
        // behind it is blocked too, and reusing that process would only burn
        // more job attempts. Fence it before rejecting anything so a caller can
        // immediately start a fresh process without stale events reaching it.
        void this.#recycle(generation, timeoutError);
      }, timeoutMs);
      this.#pending.set(request.id, { generation: generation.id, resolve, reject, timer });

      const failWrite = (error: Error) => {
        const pending = this.#pending.get(request.id);
        if (pending?.generation !== generation.id) return;
        const failure = new Error(
          `could not write to the ${this.#options.label} worker: ${error.message}`,
        );
        void this.#recycle(generation, failure);
      };
      try {
        generation.child.stdin.write(encodeRequest(request), (error) => {
          if (error) failWrite(error);
        });
      } catch (error) {
        failWrite(error as Error);
      }
    });
  }

  #recycle(generation: WorkerGeneration, failure: Error): Promise<void> {
    const existing = this.#stopping.get(generation.id);
    if (existing !== undefined) return existing;

    if (this.#child?.id === generation.id) this.#child = null;
    this.#failGeneration(generation.id, failure);

    const stop = this.#terminateAndJoin(generation).catch((error) => {
      this.#options.logger.warn(`${this.#options.label} worker cleanup failed`, {
        error: asMessage(error),
      });
    });
    const tracked = stop.finally(() => {
      if (this.#stopping.get(generation.id) === tracked) {
        this.#stopping.delete(generation.id);
      }
    });
    this.#stopping.set(generation.id, tracked);
    // Invalidate generation-local owner state (for example "model loaded")
    // before ensureStarted is allowed to create the replacement. The eventual
    // physical close is guarded against notifying a second time.
    this.#notifyExit(generation);
    return tracked;
  }

  async #terminateAndJoin(generation: WorkerGeneration): Promise<void> {
    if (generation.didExit) return;
    const graceMs = this.#options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;

    this.#kill(generation, 'SIGTERM');
    if (await waitForExit(generation, graceMs)) return;

    this.#kill(generation, 'SIGKILL');
    if (await waitForExit(generation, graceMs)) return;

    this.#options.logger.warn(`${this.#options.label} worker did not exit after SIGKILL`, {
      generation: generation.id,
    });
  }

  #kill(generation: WorkerGeneration, signal: NodeJS.Signals): void {
    if (generation.didExit) return;
    try {
      generation.child.kill(signal);
    } catch (error) {
      this.#options.logger.warn(`could not send ${signal} to the ${this.#options.label} worker`, {
        error: asMessage(error),
      });
    }
  }

  #notifyExit(generation: WorkerGeneration): void {
    if (generation.exitNotified) return;
    generation.exitNotified = true;
    this.#options.onExit?.();
  }

  #dispatch(generation: number, line: string): void {
    let response: WorkerResponse;
    try {
      response = decodeResponse(line);
    } catch (error) {
      this.#options.logger.warn('discarding malformed worker line', { error: asMessage(error) });
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined || pending.generation !== generation) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  #failGeneration(generation: number, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #failAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function waitForExit(generation: WorkerGeneration, timeoutMs: number): Promise<boolean> {
  if (generation.didExit) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    void generation.exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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
    '  pnpm openmurmur doctor       # re-checks every dependency\n\n' +
    'To run without models (delivery pipeline only), set asr.backend to "fake" in the config.'
  );
}
