import type { DatabaseSync } from 'node:sqlite';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './client.ts';
import { extractAttachment } from './incoming.ts';

/**
 * Update routing and access control.
 *
 * Exactly one chat ID is allowed, established during `setup telegram` and
 * stored in the Keychain. Every other chat is dropped silently: replying
 * "you are not authorized" would confirm the bot exists to anyone who found
 * its username.
 */

export type RoutedAction =
  | { readonly kind: 'ignore'; readonly why: string }
  | {
      readonly kind: 'command';
      readonly command: '/status' | '/health' | '/help' | '/start' | '/settings';
    }
  | { readonly kind: 'callback'; readonly query: TelegramCallbackQuery }
  | { readonly kind: 'unknown_command'; readonly text: string }
  | { readonly kind: 'audio'; readonly message: TelegramMessage }
  | { readonly kind: 'text'; readonly text: string };

export function routeUpdate(update: TelegramUpdate, allowedChatId: number): RoutedAction {
  const callback = update.callback_query;
  if (callback !== undefined) {
    if (callback.message?.chat.id !== allowedChatId) {
      return { kind: 'ignore', why: 'callback chat is not allowlisted' };
    }
    return { kind: 'callback', query: callback };
  }

  const message = update.message;
  if (message === undefined) return { kind: 'ignore', why: 'not a message' };
  if (message.chat.id !== allowedChatId) {
    return { kind: 'ignore', why: 'chat is not allowlisted' };
  }

  const attachment = extractAttachment(message);
  if (attachment !== null) return { kind: 'audio', message };

  const text = (message.text ?? '').trim();
  if (text.length === 0) return { kind: 'ignore', why: 'empty message' };

  if (text.startsWith('/')) {
    // Strip the @botname suffix Telegram adds in groups.
    const command = text.split(/\s+/)[0]?.split('@')[0] ?? '';
    if (
      command === '/status' ||
      command === '/health' ||
      command === '/help' ||
      command === '/start' ||
      command === '/settings'
    ) {
      return { kind: 'command', command };
    }
    return { kind: 'unknown_command', text: command };
  }

  return { kind: 'text', text };
}

/**
 * Records an update id, returning whether it still needs handling.
 *
 * Telegram re-delivers updates that were not acknowledged; without this, a
 * crash between "download the voice note" and "advance the offset" would
 * transcribe and send the same file on every restart. An update recorded but
 * not marked handled is deliberately replayed: the work it enqueues has its
 * own idempotency key, so this closes the crash window without duplicating it.
 */
export function recordUpdate(
  db: DatabaseSync,
  updateId: number,
  kind: string,
  botScope = 'legacy',
): boolean {
  const result = db
    .prepare(
      `INSERT INTO telegram_updates (bot_scope, update_id, received_at, kind)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (bot_scope, update_id) DO NOTHING`,
    )
    .run(botScope, updateId, new Date().toISOString(), kind);
  if (result.changes > 0) return true;

  const row = db
    .prepare('SELECT handled FROM telegram_updates WHERE bot_scope = ? AND update_id = ?')
    .get(botScope, updateId) as { handled: number } | undefined;
  return row?.handled === 0;
}

export function markUpdateHandled(db: DatabaseSync, updateId: number, botScope = 'legacy'): void {
  db.prepare('UPDATE telegram_updates SET handled = 1 WHERE bot_scope = ? AND update_id = ?').run(
    botScope,
    updateId,
  );
}

export class MissingTelegramOffsetError extends Error {
  constructor(botScope: string) {
    super(
      `Telegram update offset is missing for credential scope ${botScope}; ` +
        'run `pnpm openmurmur setup telegram` again',
    );
    this.name = 'MissingTelegramOffsetError';
  }
}

/**
 * The getUpdates offset is persisted, not held in memory: a restart must not
 * replay an hour of updates, nor skip the ones that arrived while down.
 *
 * Only the pre-scoping `legacy` cursor may default to zero. An absent cursor
 * for a concrete credential fingerprint means setup could have died between
 * Keychain and SQLite publication. Polling from zero would cross the fresh
 * `/start` boundary, so startup fails closed until setup re-establishes it.
 */
export function readOffset(db: DatabaseSync, botScope = 'legacy'): number {
  const row = db
    .prepare('SELECT next_offset FROM telegram_offset WHERE bot_scope = ?')
    .get(botScope) as { next_offset: number } | undefined;
  if (row !== undefined) return row.next_offset;
  if (botScope === 'legacy') return 0;
  throw new MissingTelegramOffsetError(botScope);
}

/** Setup-only read before a credential has ever owned a scoped cursor. */
export function readOffsetOrZero(db: DatabaseSync, botScope: string): number {
  const row = db
    .prepare('SELECT next_offset FROM telegram_offset WHERE bot_scope = ?')
    .get(botScope) as { next_offset: number } | undefined;
  return row?.next_offset ?? 0;
}

export function writeOffset(db: DatabaseSync, nextOffset: number, botScope = 'legacy'): void {
  db.prepare(
    `INSERT INTO telegram_offset (bot_scope, next_offset, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (bot_scope) DO UPDATE SET
       next_offset = excluded.next_offset,
       updated_at = excluded.updated_at`,
  ).run(botScope, nextOffset, new Date().toISOString());
}

/** Removes setup state that never became the active Keychain credential. */
export function clearOffset(db: DatabaseSync, botScope: string): void {
  db.prepare('DELETE FROM telegram_offset WHERE bot_scope = ?').run(botScope);
}

/** Highest update_id + 1, which is what Telegram expects as the next offset. */
export function nextOffsetFor(updates: readonly TelegramUpdate[], current: number): number {
  return updates.reduce((max, update) => Math.max(max, update.update_id + 1), current);
}
