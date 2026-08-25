export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

/** Structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

/**
 * The logging surface the rest of the catalogue codes against.
 *
 * Deliberately narrow and framework-free, so the same interface serves a
 * NestJS service, a Next.js route handler, a worker and a test — and so that
 * pino can be replaced without touching a single call site.
 */
export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  /** `error` accepts an Error directly, because that is the common case. */
  error(message: string, errorOrFields?: unknown, fields?: LogFields): void;
  fatal(message: string, errorOrFields?: unknown, fields?: LogFields): void;

  /** A logger with additional fields bound to every line it emits. */
  child(fields: LogFields): Logger;

  /**
   * Times an operation and logs its duration on completion, including on
   * failure. Returns whatever the operation returns.
   */
  time<T>(message: string, operation: () => Promise<T>, fields?: LogFields): Promise<T>;

  readonly level: LogLevel;
  isLevelEnabled(level: LogLevel): boolean;
}
