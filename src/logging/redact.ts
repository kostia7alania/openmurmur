/**
 * Secret redaction for log output.
 *
 * A Telegram bot token in a log file is a full account compromise: anyone with
 * it can read every message the bot ever received. Redaction is applied at the
 * logger boundary so that no call site has to remember to do it, including
 * error messages and stack traces produced by `fetch` (which embed the URL,
 * and Telegram puts the token *in the URL path*).
 */

/**
 * `123456789:AAF-abcDEF...` — Telegram bot token shape.
 *
 * Deliberately *not* anchored with `\b` at the start. A token is very often
 * glued to a preceding word ("bot<token>", "botToken=<token>"), and since `t`
 * and `8` are both word characters there is no boundary between them — a
 * leading `\b` silently fails to match exactly the cases that matter most.
 * Over-matching a few leading digits is harmless; under-matching leaks a token.
 */
const BOT_TOKEN = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;
/** Token embedded in an api.telegram.org URL path. */
const BOT_TOKEN_IN_URL = /(\/bot)\d{6,12}:[A-Za-z0-9_-]{30,}/g;
/** Telegram getFile download path also carries the token. */
const FILE_PATH_TOKEN = /(\/file\/bot)\d{6,12}:[A-Za-z0-9_-]{30,}/g;

export const REDACTED = '[REDACTED]';

export function redact(input: string): string {
  return input
    .replace(BOT_TOKEN_IN_URL, `$1${REDACTED}`)
    .replace(FILE_PATH_TOKEN, `$1${REDACTED}`)
    .replace(BOT_TOKEN, REDACTED);
}

const SENSITIVE_KEY = /token|secret|password|api[_-]?key|authorization/i;

/**
 * Recursively redacts a structured log payload. Keys whose *name* looks
 * sensitive are dropped entirely regardless of value shape, because a token
 * that fails the regex (a future Telegram format, say) would otherwise leak.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      stack: value.stack ? redact(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(inner, depth + 1);
    }
    return out;
  }
  return String(value);
}
