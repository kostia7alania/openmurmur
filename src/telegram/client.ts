import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
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
}

export function isRetryable(error: unknown): boolean {
  const e = error as Partial<TelegramApiError>;
  if (typeof e?.errorCode !== 'number') return true; // network-level failure
  if (e.errorCode === 429) return true;
  return e.errorCode >= 500;
}

function apiError(
  method: string,
  message: string,
  errorCode?: number,
  retryAfterSeconds?: number,
): TelegramApiError {
  const error = new Error(redact(message)) as Error & {
    errorCode: number | undefined;
    retryAfterSeconds: number | undefined;
    method: string;
  };
  error.name = 'TelegramApiError';
  error.errorCode = errorCode;
  error.retryAfterSeconds = retryAfterSeconds;
  error.method = method;
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
}

export class TelegramClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: TelegramClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async #call<T>(
    method: string,
    body?: string | FormData,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.#baseUrl}/bot${this.#token}/${method}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        ...(body !== undefined ? { body } : {}),
        ...(headers !== undefined ? { headers } : {}),
      });
    } catch (error) {
      // fetch embeds the URL — and therefore the token — in network errors.
      throw apiError(method, `network failure calling ${method}: ${(error as Error).message}`);
    }

    let payload: ApiResponse<T>;
    try {
      payload = (await response.json()) as ApiResponse<T>;
    } catch {
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

  #json<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.#call<T>(method, JSON.stringify(params), { 'content-type': 'application/json' });
  }

  getMe(): Promise<TelegramUser> {
    return this.#call<TelegramUser>('getMe');
  }

  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.#json<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    });
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
    return this.#call<TelegramMessage>('sendDocument', form);
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.#json<TelegramFile>('getFile', { file_id: fileId });
  }

  /**
   * Returns the raw download response for a `getFile` path. The caller streams
   * it to quarantine; nothing here is buffered.
   */
  async downloadFile(filePath: string): Promise<Response> {
    const url = `${this.#baseUrl}/file/bot${this.#token}/${filePath}`;
    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch (error) {
      throw apiError('downloadFile', `download failed: ${(error as Error).message}`);
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
}
