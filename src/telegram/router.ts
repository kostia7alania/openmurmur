import type { DatabaseSync } from 'node:sqlite';
import type { TelegramMessage, TelegramUpdate } from './client.ts';
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
  | { readonly kind: 'command'; readonly command: '/status' | '/health' | '/help' | '/start' }
  | { readonly kind: 'unknown_command'; readonly text: string }
  | { readonly kind: 'audio'; readonly message: TelegramMessage }
  | { readonly kind: 'text'; readonly text: string };

export function routeUpdate(update: TelegramUpdate, allowedChatId: number): RoutedAction {
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
      command === '/start'
    ) {
      return { kind: 'command', command };
    }
    return { kind: 'unknown_command', text: command };
  }

  return { kind: 'text', text };
}

/**
 * Records an update id, returning false when it has been seen before.
 *
 * Telegram re-delivers updates that were not acknowledged; without this, a
 * crash between "download the voice note" and "advance the offset" would
 * transcribe and send the same file on every restart.
 */
export function recordUpdate(db: DatabaseSync, updateId: number, kind: string): boolean {
  const result = db
    .prepare(
      `INSERT INTO telegram_updates (update_id, received_at, kind)
       VALUES (?, ?, ?)
       ON CONFLICT (update_id) DO NOTHING`,
    )
    .run(updateId, new Date().toISOString(), kind);
  return result.changes > 0;
}

export function markUpdateHandled(db: DatabaseSync, updateId: number): void {
  db.prepare('UPDATE telegram_updates SET handled = 1 WHERE update_id = ?').run(updateId);
}

/**
 * The getUpdates offset is persisted, not held in memory: a restart must not
 * replay an hour of updates, nor skip the ones that arrived while down.
 */
export function readOffset(db: DatabaseSync): number {
  const row = db.prepare('SELECT next_offset FROM telegram_offset WHERE id = 1').get() as
    | { next_offset: number }
    | undefined;
  return row?.next_offset ?? 0;
}

export function writeOffset(db: DatabaseSync, nextOffset: number): void {
  db.prepare('UPDATE telegram_offset SET next_offset = ?, updated_at = ? WHERE id = 1').run(
    nextOffset,
    new Date().toISOString(),
  );
}

/** Highest update_id + 1, which is what Telegram expects as the next offset. */
export function nextOffsetFor(updates: readonly TelegramUpdate[], current: number): number {
  return updates.reduce((max, update) => Math.max(max, update.update_id + 1), current);
}
