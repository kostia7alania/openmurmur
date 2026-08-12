import { openAsBlob } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { redact } from '../logging/redact.ts';
import {
  TELEGRAM_CALLBACK_QUERY_TEXT_LIMIT,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
} from './format.ts';

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
  readonly clientShutdown: boolean | undefined;
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

export function isClientShutdown(error: unknown): boolean {
  return (error as Partial<TelegramApiError>)?.clientShutdown === true;
}

function apiError(
  method: string,
  message: string,
  errorCode?: number,
  retryAfterSeconds?: number,
  retryWithoutAttempt?: boolean,
  clientShutdown?: boolean,
): TelegramApiError {
  const error = new Error(redact(message)) as Error & {
    errorCode: number | undefined;
    retryAfterSeconds: number | undefined;
    method: string;
    retryWithoutAttempt: boolean | undefined;
    clientShutdown: boolean | undefined;
  };
  error.name = 'TelegramApiError';
  error.errorCode = errorCode;
  error.retryAfterSeconds = retryAfterSeconds;
  error.method = method;
  error.retryWithoutAttempt = retryWithoutAttempt;
  error.clientShutdown = clientShutdown;
  return error;
}

function assertTextLength(
  method: string,
  field: string,
  value: string,
  minimum: number,
  maximum: number,
  parseMode?: 'HTML',
): void {
  const length = telegramEntityTextLength(value, parseMode);
  if (length >= minimum && length <= maximum) return;
  throw apiError(
    method,
    `${field} is ${length} UTF-16 code units after entity parsing; ` +
      `OpenMurmur allows ${minimum}-${maximum}`,
    400,
  );
}

function telegramEntityTextLength(value: string, parseMode?: 'HTML'): number {
  if (parseMode !== 'HTML') return value.length;

  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '<') {
      const tagEnd = htmlTagEnd(value, index);
      if (tagEnd !== null) {
        index = tagEnd;
        continue;
      }
    }

    if (value[index] === '&') {
      const entity = htmlEntityAt(value, index);
      if (entity !== null) {
        length += entity.codeUnits;
        index += entity.sourceLength - 1;
        continue;
      }
    }

    length += 1;
  }
  return length;
}

function htmlEntityAt(
  value: string,
  start: number,
): { readonly sourceLength: number; readonly codeUnits: number } | null {
  const entity = /^&(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i.exec(value.slice(start));
  if (entity === null) return null;
  const body = entity[1] ?? '';
  if (!body.startsWith('#')) return { sourceLength: entity[0].length, codeUnits: 1 };

  const hexadecimal = body[1]?.toLowerCase() === 'x';
  const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  return {
    sourceLength: entity[0].length,
    codeUnits: Number.isFinite(codePoint) && codePoint > 0xffff ? 2 : 1,
  };
}

function htmlTagEnd(value: string, start: number): number | null {
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return null;
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
  /** Present when Telegram preserved an earlier message's origin. */
  forward_origin?: TelegramMessageOrigin;
}

export interface TelegramMessageOrigin {
  readonly type: 'user' | 'hidden_user' | 'chat' | 'channel';
  /** Original Unix timestamp supplied by Telegram, distinct from message.date. */
  readonly date: number;
}

export interface TelegramAudioLike {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
  file_name?: string;
}

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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
const LONG_POLL_GRACE_MS = 10_000;

export function telegramLongPollDeadlineMs(
  requestTimeoutMs: number,
  timeoutSeconds: number,
): number {
  return Math.max(requestTimeoutMs, timeoutSeconds * 1000 + LONG_POLL_GRACE_MS);
}

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

  setMyCommands(commands: readonly TelegramBotCommand[]): Promise<true> {
    return this.#json<true>('setMyCommands', { commands });
  }

  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.#json<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      },
      telegramLongPollDeadlineMs(this.#requestTimeoutMs, timeoutSeconds),
    );
  }

  sendMessage(
    chatId: number,
    text: string,
    options: {
      parseMode?: 'HTML' | undefined;
      disablePreview?: boolean;
      replyMarkup?: TelegramInlineKeyboardMarkup;
    } = {},
  ): Promise<TelegramMessage> {
    assertTextLength('sendMessage', 'text', text, 1, TELEGRAM_MESSAGE_LIMIT, options.parseMode);
    return this.#json<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(options.parseMode !== undefined ? { parse_mode: options.parseMode } : {}),
      ...(options.replyMarkup !== undefined ? { reply_markup: options.replyMarkup } : {}),
      link_preview_options: { is_disabled: options.disablePreview !== false },
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<true> {
    if (text !== undefined) {
      assertTextLength('answerCallbackQuery', 'text', text, 0, TELEGRAM_CALLBACK_QUERY_TEXT_LIMIT);
    }
    return this.#json<true>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text !== undefined ? { text } : {}),
    });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: { parseMode?: 'HTML'; replyMarkup?: TelegramInlineKeyboardMarkup } = {},
  ): Promise<TelegramMessage | true> {
    assertTextLength('editMessageText', 'text', text, 1, TELEGRAM_MESSAGE_LIMIT, options.parseMode);
    return this.#json<TelegramMessage | true>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options.parseMode !== undefined ? { parse_mode: options.parseMode } : {}),
      ...(options.replyMarkup !== undefined ? { reply_markup: options.replyMarkup } : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: TelegramInlineKeyboardMarkup,
  ): Promise<TelegramMessage | true> {
    return this.#json<TelegramMessage | true>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  async sendDocument(
    chatId: number,
    document: string | Blob,
    options: {
      caption?: string;
      filename?: string;
      parseMode?: 'HTML';
      replyMarkup?: TelegramInlineKeyboardMarkup;
    } = {},
  ): Promise<TelegramMessage> {
    if (options.caption !== undefined) {
      assertTextLength(
        'sendDocument',
        'caption',
        options.caption,
        0,
        TELEGRAM_CAPTION_LIMIT,
        options.parseMode,
      );
    }
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (options.caption !== undefined) form.set('caption', options.caption);
    if (options.parseMode !== undefined) form.set('parse_mode', options.parseMode);
    if (options.replyMarkup !== undefined) {
      form.set('reply_markup', JSON.stringify(options.replyMarkup));
    }
    // Path-backed documents stream from disk. Integrity-fenced generated
    // documents arrive as an already verified immutable Blob.
    const blob = typeof document === 'string' ? await openAsBlob(document) : document;
    const filename =
      options.filename ?? (typeof document === 'string' ? basename(document) : 'document');
    form.set('document', blob, filename);
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
    throw apiError(
      method,
      `${method} interrupted by client shutdown`,
      undefined,
      undefined,
      true,
      true,
    );
  }

  #transportError(
    method: string,
    prefix: string,
    error: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): TelegramApiError {
    const interrupted = signal.aborted;
    const clientShutdown = this.#shutdown.signal.aborted;
    const detail = clientShutdown
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
      clientShutdown,
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
