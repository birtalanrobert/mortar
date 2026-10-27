import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import type { Logger } from '../types';
import { MORTAR_LOGGER } from './tokens';

/**
 * What Nest says of its own wiring at every start: a line for each module
 * initialised, each controller and route mapped, each gateway's subscription —
 * some four hundred in a modest API. Detail for finding out why a route is
 * missing, so said at `debug`: at `info` it buried the lines that tell whoever
 * is watching that the application started, and how.
 */
const WIRING_CONTEXTS: ReadonlySet<string> = new Set([
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'WebSocketsController',
]);

/**
 * Adapts a mortar {@link Logger} to Nest's own `LoggerService`, so that
 * framework output — route mapping, dependency errors, shutdown notices —
 * lands in the same structured stream as application output.
 *
 *   const app = await NestFactory.create(AppModule, { bufferLogs: true });
 *   app.useLogger(new NestLoggerAdapter(logger));
 *
 * Without this, a service ends up with two log formats: pino JSON from the
 * application and Nest's coloured text from the framework, which is a
 * genuine nuisance in any aggregator.
 */
@Injectable()
export class NestLoggerAdapter implements LoggerService {
  // Injected by token rather than by type: `Logger` is an interface, and
  // `emitDecoratorMetadata` records `Object` for one — there would be nothing
  // for Nest to resolve.
  constructor(@Inject(MORTAR_LOGGER) private readonly logger: Logger) {}

  log(message: unknown, ...optional: unknown[]): void {
    const fields = this.fields(optional);
    if (typeof fields.context === 'string' && WIRING_CONTEXTS.has(fields.context)) {
      this.logger.debug(String(message), fields);
      return;
    }
    this.logger.info(String(message), fields);
  }

  error(message: unknown, ...optional: unknown[]): void {
    // Nest hands some errors over whole — the one that ends a failed boot,
    // for one — and the error is its stack, its code and the errors it
    // gathers; its string alone is often no more than its name.
    if (message instanceof Error) {
      this.logger.error(headline(message), message, this.fields(optional));
      return;
    }
    // Nest passes the stack as the first optional argument.
    const [first, ...rest] = optional;
    if (typeof first === 'string' && first.includes('\n')) {
      this.logger.error(String(message), { stack: first, ...this.fields(rest) });
      return;
    }
    this.logger.error(String(message), first, this.fields(rest));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn(String(message), this.fields(optional));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug(String(message), this.fields(optional));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.trace(String(message), this.fields(optional));
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    if (message instanceof Error) {
      this.logger.fatal(headline(message), message, this.fields(optional));
      return;
    }
    this.logger.fatal(String(message), this.fields(optional));
  }

  /** Nest's last optional argument is conventionally the emitting context. */
  private fields(optional: unknown[]): Record<string, unknown> {
    const last = optional[optional.length - 1];
    return typeof last === 'string' ? { context: last } : {};
  }
}

/** An error's message, or its name when it has none — an `AggregateError` of refused connections has none. */
function headline(error: Error): string {
  return error.message || error.name;
}
