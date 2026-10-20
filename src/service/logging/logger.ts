import { redactString, redactValue } from '../../shared/redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

/**
 * Structured JSON-lines logger. Every message and field is passed through the
 * redaction helpers so tokens, passwords and email addresses never reach logs.
 */
export function createLogger(
  options: { level?: LogLevel; sink?: LogSink; bindings?: Record<string, unknown> } = {},
): Logger {
  const minLevel = LEVELS[options.level ?? 'info'];
  const sink: LogSink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < minLevel) {
      return;
    }
    const record = {
      time: new Date().toISOString(),
      level,
      msg: redactString(msg),
      ...(redactValue({ ...bindings, ...fields }) as Record<string, unknown>),
    };
    sink(JSON.stringify(record));
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger({ level: options.level, sink, bindings: { ...bindings, ...extra } }),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
