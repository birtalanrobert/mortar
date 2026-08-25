import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { setAttribute } from '@mortar/context';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Logger } from '../types';
import type { Metrics } from '../metrics';
import { MORTAR_LOGGER, MORTAR_METRICS } from './logger.module';

/**
 * Logs one line per HTTP request, on completion, with its duration and status.
 *
 * One line per request rather than one on entry and one on exit: the entry
 * line carries no outcome, doubles log volume, and in an aggregator simply
 * makes the useful line harder to find.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(MORTAR_LOGGER) private readonly logger: Logger,
    @Inject(MORTAR_METRICS) private readonly metrics: Metrics,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<{ method?: string; url?: string; route?: { path?: string } }>();
    const startedAt = process.hrtime.bigint();

    const method = request?.method ?? 'UNKNOWN';
    // The route pattern, not the concrete URL: `/bookings/:id` keeps metric
    // cardinality bounded, where `/bookings/8f2c...` would not.
    const route = request?.route?.path ?? 'unmatched';
    setAttribute('route', route);

    const finish = (statusCode: number, error?: unknown) => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const fields = {
        method,
        route,
        url: request?.url,
        statusCode,
        durationMs: Math.round(durationMs * 1000) / 1000,
      };

      this.metrics
        .histogram('http_request_duration_ms')
        .observe(durationMs, { method, route, status: String(statusCode) });
      this.metrics
        .counter('http_requests_total')
        .increment(1, { method, route, status: String(statusCode) });

      if (error) this.logger.error('request failed', error, fields);
      else if (statusCode >= 500) this.logger.error('request', fields);
      else if (statusCode >= 400) this.logger.warn('request', fields);
      else this.logger.info('request', fields);
    };

    return next.handle().pipe(
      tap({
        next: () => finish(http.getResponse<{ statusCode?: number }>()?.statusCode ?? 200),
        error: (error: unknown) => {
          const status =
            typeof (error as { status?: unknown })?.status === 'number'
              ? (error as { status: number }).status
              : 500;
          finish(status, error);
        },
      }),
    );
  }
}
