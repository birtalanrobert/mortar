import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import type { Logger } from '../types';
import { MORTAR_LOGGER } from './tokens';

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
    this.logger.info(String(message), this.fields(optional));
  }

  error(message: unknown, ...optional: unknown[]): void {
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
    this.logger.fatal(String(message), this.fields(optional));
  }

  /** Nest's last optional argument is conventionally the emitting context. */
  private fields(optional: unknown[]): Record<string, unknown> {
    const last = optional[optional.length - 1];
    return typeof last === 'string' ? { context: last } : {};
  }
}
