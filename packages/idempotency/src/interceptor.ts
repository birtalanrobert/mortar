import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BadRequestError } from '@birtalanrobert/http';
import { Observable, from, of, switchMap } from 'rxjs';
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
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Applies idempotency to handlers marked with `@Idempotent()`.
 *
 * Replays the stored response on a repeat, and completes the claim inside the
 * handler's own transaction so work and completion commit together.
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

    return from(this.service.begin(key, scope, request.body)).pipe(
      switchMap((result) => {
        if (result.outcome === 'replay') return of(result.body);

        return next.handle().pipe(
          switchMap((body: unknown) =>
            from(
              // Runs inside the handler's transaction when one is open, so the
              // completion is durable exactly when the work is.
              this.service.complete(result.record, statusOf(context), body).then(() => body),
            ),
          ),
        );
      }),
    );
  }
}

function headerValue(request: RequestLike, name: string): string | undefined {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function statusOf(context: ExecutionContext): number {
  const response = context.switchToHttp().getResponse<{ statusCode?: number }>();
  return response?.statusCode ?? 200;
}
