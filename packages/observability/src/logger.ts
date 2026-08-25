import { contextSnapshot } from '@mortar/context';
import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { buildRedactionPaths, REDACTED } from './redaction';
import type { LogFields, LogLevel, Logger } from './types';

export interface CreateLoggerOptions {
  /** Appears as `service` on every line. */
  serviceName: string;
  level?: LogLevel;
  /**
   * Pretty-print for a human reading a terminal. Defaults to true outside
   * production; JSON everywhere else, because log aggregators parse JSON and
   * humans do not read production logs line by line.
   */
  pretty?: boolean;
  /** Additional field names to redact, beyond the defaults. */
  redact?: readonly string[];
  /** Fields bound to every line, e.g. release version or region. */
  base?: LogFields;
  /** Write target. Defaults to stdout. */
  destination?: NodeJS.WritableStream;
}

/**
 * Adapts pino to the framework-free {@link Logger} interface, merging the
 * ambient request context into every line.
 *
 * That merge is the entire point of this package: a log line written deep
 * inside a service carries the request id, correlation id, tenant and actor
 * without any of the intervening functions having been told about them.
 */
class PinoAdapter implements Logger {
  constructor(private readonly pino: PinoLogger) {}

  get level(): LogLevel {
    return this.pino.level as LogLevel;
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.pino.isLevelEnabled(level);
  }

  trace(message: string, fields?: LogFields): void {
    this.pino.trace(this.merge(fields), message);
  }

  debug(message: string, fields?: LogFields): void {
    this.pino.debug(this.merge(fields), message);
  }

  info(message: string, fields?: LogFields): void {
    this.pino.info(this.merge(fields), message);
  }

  warn(message: string, fields?: LogFields): void {
    this.pino.warn(this.merge(fields), message);
  }

  error(message: string, errorOrFields?: unknown, fields?: LogFields): void {
    this.pino.error(this.mergeError(errorOrFields, fields), message);
  }

  fatal(message: string, errorOrFields?: unknown, fields?: LogFields): void {
    this.pino.fatal(this.mergeError(errorOrFields, fields), message);
  }

  child(fields: LogFields): Logger {
    return new PinoAdapter(this.pino.child(fields));
  }

  async time<T>(message: string, operation: () => Promise<T>, fields?: LogFields): Promise<T> {
    const startedAt = process.hrtime.bigint();
    const durationMs = () => Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    try {
      const result = await operation();
      this.info(message, { ...fields, durationMs: round(durationMs()), outcome: 'ok' });
      return result;
    } catch (error) {
      // Logged on the failure path too — an operation that failed slowly is
      // usually more interesting than one that succeeded slowly.
      this.error(message, error, {
        ...fields,
        durationMs: round(durationMs()),
        outcome: 'error',
      });
      throw error;
    }
  }

  private merge(fields?: LogFields): LogFields {
    const context = contextSnapshot();
    return fields ? { ...context, ...fields } : context;
  }

  private mergeError(errorOrFields?: unknown, fields?: LogFields): LogFields {
    if (errorOrFields instanceof Error) {
      return { ...this.merge(fields), err: errorOrFields };
    }
    if (errorOrFields && typeof errorOrFields === 'object') {
      return { ...this.merge(fields), ...(errorOrFields as LogFields) };
    }
    return this.merge(fields);
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Creates a configured logger. */
export function createLogger(options: CreateLoggerOptions): Logger {
  const {
    serviceName,
    level = 'info',
    pretty = process.env.NODE_ENV !== 'production',
    redact = [],
    base = {},
    destination,
  } = options;

  const pinoOptions: LoggerOptions = {
    level,
    base: { service: serviceName, ...base },
    redact: { paths: buildRedactionPaths(redact), censor: REDACTED },
    // ISO timestamps: log aggregators and humans both read them, unlike epoch
    // milliseconds, which only machines do.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // `level: "info"` rather than `level: 30`, for the same reason.
      level: (label) => ({ level: label }),
    },
  };

  if (pretty && !destination) {
    return new PinoAdapter(
      pino({
        ...pinoOptions,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }),
    );
  }

  return new PinoAdapter(destination ? pino(pinoOptions, destination) : pino(pinoOptions));
}

/**
 * A logger that discards everything, for tests and for code paths that must
 * not depend on a logger having been configured.
 */
export function createNoopLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    level: 'fatal',
    isLevelEnabled: () => false,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
    time: async (_message, operation) => operation(),
  };
  return logger;
}
