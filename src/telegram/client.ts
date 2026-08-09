import { openAsBlob } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { redact } from '../logging/redact.ts';

/**
 * Thin client over the official Bot API using Node's built-in fetch.
 *
 * No Telegraf/grammY: we need six methods, strict control over retry and rate
 * limiting, and no third-party code touching the token.
 */

export interface TelegramApiError extends Error {
  readonly errorCode: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly method: string;
  /** A local deadline or shutdown interrupted the request before Telegram answered. */
  readonly retryWithoutAttempt: boolean | undefined;
}

export function isRetryable(error: unknown): boolean {
  const e = error as Partial<TelegramApiError>;
  if (typeof e?.errorCode !== 'number') return true; // network-level failure
  if (e.errorCode === 429) return true;
  return e.errorCode >= 500;
}

export function shouldRetryWithoutAttempt(error: unknown): boolean {
  return (error as Partial<TelegramApiError>)?.retryWithoutAttempt === true;
}

function apiError(
  method: string,
  message: string,
  errorCode?: number,
  retryAfterSeconds?: number,
  retryWithoutAttempt?: boolean,
): TelegramApiError {
  const error = new Error(redact(message)) as Error & {
    errorCode: number | undefined;
    retryAfterSeconds: number | undefined;
    method: string;
    retryWithoutAttempt: boolean | undefined;
  };
  error.name = 'TelegramApiError';
  error.errorCode = errorCode;
  error.retryAfterSeconds = retryAfterSeconds;
  error.method = method;
  error.retryWithoutAttempt = retryWithoutAttempt;
  return error;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; username?: string; title?: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  voice?: TelegramAudioLike;
  audio?: TelegramAudioLike;
  document?: TelegramAudioLike;
  video_note?: TelegramAudioLike;
}

export interface TelegramAudioLike {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
  file_name?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramClientOptions {
  readonly token: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Internal transport deadline. Long polls extend it to cover their requested wait. */
  readonly requestTimeoutMs?: number;
  /** Internal deadline for streamed uploads and downloads. */
  readonly transferTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
const LONG_POLL_GRACE_MS = 5_000;

export class TelegramClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #transferTimeoutMs: number;
  readonly #shutdown = new AbortController();

  constructor(options: TelegramClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#transferTimeoutMs = options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new Error('Telegram requestTimeoutMs must be a positive finite number');
    }
    if (!Number.isFinite(this.#transferTimeoutMs) || this.#transferTimeoutMs <= 0) {
      throw new Error('Telegram transferTimeoutMs must be a positive finite number');
    }
  }

  async #call<T>(
    method: string,
    body?: string | FormData,
    headers?: Record<string, string>,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<T> {
    this.#throwIfClosed(method);
    const url = `${this.#baseUrl}/bot${this.#token}/${method}`;
    const signal = this.#requestSignal(timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        ...(body !== undefined ? { body } : {}),
        ...(headers !== undefined ? { headers } : {}),
      });
    } catch (error) {
      // fetch embeds the URL — and therefore the token — in network errors.
      throw this.#transportError(method, 'network failure', error, signal, timeoutMs);
    }

    let payload: ApiResponse<T>;
    try {
      payload = (await response.json()) as ApiResponse<T>;
    } catch (error) {
      if (signal.aborted) {
        throw this.#transportError(method, 'response interrupted', error, signal, timeoutMs);
      }
      throw apiError(
        method,
        `${method} returned non-JSON (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!payload.ok || payload.result === undefined) {
      throw apiError(
        method,
        `${method} failed: ${payload.description ?? 'unknown error'}`,
        payload.error_code ?? response.status,
        payload.parameters?.retry_after,
      );
    }
    return payload.result;
  }

  #json<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.#call<T>(
      method,
      JSON.stringify(params),
      { 'content-type': 'application/json' },
      timeoutMs,
    );
  }

  getMe(): Promise<TelegramUser> {
    return this.#call<TelegramUser>('getMe');
  }

  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.#json<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      },
      Math.max(this.#requestTimeoutMs, timeoutSeconds * 1000 + LONG_POLL_GRACE_MS),
    );
  }

  sendMessage(
    chatId: number,
    text: string,
    options: { parseMode?: 'HTML' | undefined; disablePreview?: boolean } = {},
  ): Promise<TelegramMessage> {
    return this.#json<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(options.parseMode !== undefined ? { parse_mode: options.parseMode } : {}),
      link_preview_options: { is_disabled: options.disablePreview !== false },
    });
  }

  async sendDocument(
    chatId: number,
    filePath: string,
    options: { caption?: string; filename?: string; parseMode?: 'HTML' } = {},
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (options.caption !== undefined) form.set('caption', options.caption);
    if (options.parseMode !== undefined) form.set('parse_mode', options.parseMode);
    // openAsBlob streams from disk instead of buffering a 50 MB file in RAM.
    const blob = await openAsBlob(filePath);
    form.set('document', blob, options.filename ?? basename(filePath));
    return this.#call<TelegramMessage>('sendDocument', form, undefined, this.#transferTimeoutMs);
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.#json<TelegramFile>('getFile', { file_id: fileId });
  }

  /**
   * Returns the raw download response for a `getFile` path. The caller streams
   * it to quarantine; nothing here is buffered.
   */
  async downloadFile(filePath: string): Promise<Response> {
    this.#throwIfClosed('downloadFile');
    const signal = this.#requestSignal(this.#transferTimeoutMs);
    if (this.#isLocalServer() && isAbsolute(filePath)) {
      try {
        const blob = await openAsBlob(filePath);
        const bounded = blob
          .stream()
          .pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal });
        return new Response(bounded);
      } catch (error) {
        throw apiError('downloadFile', `local file download failed: ${(error as Error).message}`);
      }
    }

    const url = `${this.#baseUrl}/file/bot${this.#token}/${filePath}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { redirect: 'error', signal });
    } catch (error) {
      throw this.#transportError(
        'downloadFile',
        'download failed',
        error,
        signal,
        this.#transferTimeoutMs,
      );
    }
    if (!response.ok) {
      throw apiError(
        'downloadFile',
        `download failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return response;
  }

  /** Permanently stops this client and aborts every in-flight HTTP operation. */
  close(): void {
    if (!this.#shutdown.signal.aborted) this.#shutdown.abort();
  }

  #requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(timeoutMs)]);
  }

  #throwIfClosed(method: string): void {
    if (!this.#shutdown.signal.aborted) return;
    throw apiError(method, `${method} interrupted by client shutdown`, undefined, undefined, true);
  }

  #transportError(
    method: string,
    prefix: string,
    error: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): TelegramApiError {
    const interrupted = signal.aborted;
    const detail = this.#shutdown.signal.aborted
      ? 'client shutdown'
      : interrupted
        ? `request timed out after ${timeoutMs} ms`
        : (error as Error).message;
    return apiError(
      method,
      `${prefix} calling ${method}: ${detail}`,
      undefined,
      undefined,
      interrupted,
    );
  }

  #isLocalServer(): boolean {
    try {
      const url = new URL(this.#baseUrl);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }
}
