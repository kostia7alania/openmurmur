import { appendFileSync } from 'node:fs';
import { redact, redactValue } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Append NDJSON here in addition to stderr. */
  readonly file?: string | undefined;
  readonly component?: string | undefined;
  /** Test hook: capture records instead of writing anywhere. */
  readonly sink?: ((record: Record<string, unknown>) => void) | undefined;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(component: string): Logger;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: redact(message),
    };
    if (options.component !== undefined) record['component'] = options.component;
    if (fields !== undefined) Object.assign(record, redactValue(fields) as object);

    if (options.sink) {
      options.sink(record);
      return;
    }
    const line = JSON.stringify(record);
    process.stderr.write(`${line}\n`);
    if (options.file !== undefined) {
      try {
        appendFileSync(options.file, `${line}\n`, { mode: 0o600 });
      } catch {
        // A full or unwritable disk must not take the daemon down; the health
        // check reports disk pressure separately.
      }
    }
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (component) =>
      createLogger({
        ...options,
        component: options.component ? `${options.component}.${component}` : component,
      }),
  };
}

/** Logger that discards everything. Used by tests that assert on behaviour. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
