import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { joinCommits } from '@birtalanrobert/database';
import { BadRequestError } from '@birtalanrobert/http';
import { Observable, catchError, from, of, switchMap, throwError } from 'rxjs';
import { ClaimInFlight } from './claim-in-flight';
import { IdempotencyService } from './service';

export const IDEMPOTENT_KEY = 'mortar:idempotent';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export interface IdempotentOptions {
  /**
   * Operation identifier. Defaults to `METHOD path`.
   *
   * Without a scope a client reusing one key across endpoints would receive
   * the first endpoint's response from the second.
   */
  scope?: string;
  /** Reject the request when the header is absent. Defaults to false. */
  required?: boolean;
}

/**
 * Marks a handler idempotent.
 *
 *   @Post()
 *   @Idempotent({ required: true })
 *   create(@Body() dto: CreateOrderDto) { ... }
 */
export const Idempotent = (options: IdempotentOptions = {}) => SetMetadata(IDEMPOTENT_KEY, options);

interface RequestLike {
  method?: string;
  route?: { path?: string };
  url?: string;
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Applies idempotency to handlers marked with `@Idempotent()`.
 *
 * Replays the stored response on a repeat. Otherwise the claim joins every
 * transaction the handler commits, and is marked done inside the first that
 * writes, so the work and the key commit together wherever in the handler
 * that transaction was opened (`ClaimInFlight`). A handler that fails before
 * committing anything releases the key for the caller's retry.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly service: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!options) return next.handle();

    const request = context.switchToHttp().getRequest<RequestLike>();
    const key = headerValue(request, IDEMPOTENCY_HEADER);

    if (!key) {
      if (options.required) {
        throw new BadRequestError('An Idempotency-Key header is required for this operation.');
      }
      return next.handle();
    }

    const scope =
      options.scope ?? `${request.method ?? 'POST'} ${request.route?.path ?? request.url ?? ''}`;

    return from(this.service.begin(key, scope, payloadOf(request))).pipe(
      switchMap((result) => {
        if (result.outcome === 'replay') return of(result.body);

        const claim = new ClaimInFlight(
          this.service,
          result.record,
          this.declaredStatus(context, request),
        );
        // Subscribed inside `joinCommits`, so every continuation of the
        // handler — and each transaction it opens — carries the claim.
        return new Observable<unknown>((subscriber) =>
          joinCommits(claim.participant, () => next.handle().subscribe(subscriber)),
        ).pipe(
          catchError((error: unknown) =>
            from(claim.failed()).pipe(switchMap(() => throwError(() => error))),
          ),
          switchMap((body: unknown) => from(claim.succeeded(body).then(() => body))),
        );
      }),
    );
  }

  /**
   * The status the handler answers with: its `@HttpCode`, or Nest's default
   * for the method. Read from the route rather than the response, which Nest
   * sets only after every interceptor has finished.
   */
  private declaredStatus(context: ExecutionContext, request: RequestLike): number {
    return (
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (request.method === 'POST' ? 201 : 200)
    );
  }
}

function headerValue(request: RequestLike, name: string): string | undefined {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * What a key must repeat to be the same request: its body, and the route's
 * parameters — the scope is the route's pattern, so without them one key sent
 * to two queue items, or two villages, would have the second answered with
 * the first's response. A route with no parameters is identified by its body
 * alone, as before, so keys claimed before this version still match their
 * retries.
 */
function payloadOf(request: RequestLike): unknown {
  const params = request.params ?? {};
  return Object.keys(params).length === 0 ? request.body : { params, body: request.body };
}
