import { Catch, Inject, Optional, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { getRequestId } from '@birtalanrobert/context';
import { MORTAR_LOGGER, type Logger } from './logger-token';
import { MortarError } from './errors';
import { PROBLEM_CONTENT_TYPE } from './problem';
import { toProblemDetails } from './serialize';

export interface ExceptionFilterOptions {
  baseUri?: string;
  /** Never enable in production. See `SerializeOptions.exposeInternals`. */
  exposeInternals?: boolean;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader?(name: string, value: string): void;
  header?(name: string, value: string): ResponseLike;
  json(body: unknown): unknown;
}

interface RequestLike {
  url?: string;
  originalUrl?: string;
  method?: string;
}

/**
 * Turns every thrown value into a Problem Details response.
 *
 * Registered globally, this is the last thing between an exception and the
 * client. Two rules it must never break: the response is always a valid
 * problem document, and a 5xx never carries internal detail.
 */
@Catch()
export class MortarExceptionFilter implements ExceptionFilter {
  constructor(
    @Optional() @Inject(MORTAR_LOGGER) private readonly logger?: Logger,
    private readonly options: ExceptionFilterOptions = {},
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const requestId = getRequestId();

    const problem = toProblemDetails(exception, {
      instance: request?.originalUrl ?? request?.url,
      requestId,
      baseUri: this.options.baseUri,
      exposeInternals: this.options.exposeInternals,
    });

    this.log(exception, problem.status, request);

    if (problem.retryAfter !== undefined) {
      setHeader(response, 'Retry-After', String(problem.retryAfter));
    }
    setHeader(response, 'Content-Type', PROBLEM_CONTENT_TYPE);

    response.status(problem.status).json(problem);
  }

  private log(exception: unknown, status: number, request: RequestLike | undefined): void {
    if (!this.logger) return;

    const fields = { method: request?.method, path: request?.originalUrl ?? request?.url, status };

    // 5xx is ours and always warrants a stack. 4xx is the client's and is
    // logged at debug — a wall of 404 warnings trains everyone to ignore
    // warnings, which is how a real one gets missed.
    if (status >= 500) {
      this.logger.error('unhandled request failure', exception, fields);
      return;
    }

    if (exception instanceof MortarError && exception.code === 'cross_tenant_access') {
      // Either a serious bug or an attack. Either way, somebody should find
      // out today rather than at the next audit.
      this.logger.warn('cross-tenant access blocked', fields);
      return;
    }

    this.logger.debug('request rejected', {
      ...fields,
      code: exception instanceof MortarError ? exception.code : undefined,
    });
  }
}

function setHeader(response: ResponseLike, name: string, value: string): void {
  // Express exposes setHeader; Fastify exposes header. Support both rather
  // than forcing a platform choice on seventeen projects.
  if (typeof response.setHeader === 'function') response.setHeader(name, value);
  else if (typeof response.header === 'function') response.header(name, value);
}
