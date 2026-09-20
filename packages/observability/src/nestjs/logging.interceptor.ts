import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { setAttribute } from '@birtalanrobert/context';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Logger } from '../types';
import type { Metrics } from '../metrics';
import { safeUrl } from '../redaction';
import { MORTAR_LOGGER, MORTAR_METRICS } from './tokens';

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
        // The credentials stripped out of it. A signed link's token in a log
        // line is a credential anybody with log access can use.
        url: safeUrl(request?.url),
        statusCode,
        durationMs: Math.round(durationMs * 1000) / 1000,
      };

      this.metrics
        .histogram('http_request_duration_ms')
        .observe(durationMs, { method, route, status: String(statusCode) });
      this.metrics
        .counter('http_requests_total')
        .increment(1, { method, route, status: String(statusCode) });

      /*
       * **The status decides the level, not whether something was thrown.**
       *
       * Every refusal reaches here as an exception — that is how a framework
       * says "no" — and logging all of them at `error` with a stack made a
       * ticketing product's busiest, most correct minute look like an outage:
       * four hundred `error` lines a second, each a full stack, for four
       * hundred buyers being told somebody else got the seat. It floods an
       * alerting rule that is watching for exactly the thing it now cannot
       * see, and serialising a stack per request is real work on the one loop
       * that is already the bottleneck.
       *
       * A 4xx is an outcome the caller asked for and is told about. It is
       * logged at `warn` with what was refused and why — the type, the code and
       * the message — and without the stack, which describes our frames rather
       * than their mistake. A 5xx is ours, and keeps everything.
       */
      if (statusCode >= 500) this.logger.error('request failed', error ?? fields, fields);
      else if (error) this.logger.warn('request refused', { ...fields, ...refusal(error) });
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

/**
 * What a refusal was, in three fields and no stack.
 *
 * Enough to find it in an aggregator and group it — the class, the application
 * code where there is one, and the sentence the caller was given.
 */
function refusal(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { refusal: String(error) };

  const code = (error as { code?: unknown }).code;

  return {
    refusal: error.name,
    ...(typeof code === 'string' ? { code } : {}),
    reason: error.message,
  };
}
