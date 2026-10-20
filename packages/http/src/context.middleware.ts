import { randomUUID } from 'node:crypto';
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER, negotiateLocale } from './headers';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { runWithContext, createContext } from '@birtalanrobert/context';

export interface ContextMiddlewareOptions {
  /**
   * Trust `X-Forwarded-For` when determining the client address: `true` for
   * one proxy in front of the application, or how many there are.
   *
   * Each proxy appends the address it was connected from, so the client is
   * the entry that many from the **right** — the left-most entry is whatever
   * the client chose to send, and taking it lets anybody claim any address.
   * Only enable behind proxies that are really there: trusting the header
   * when directly exposed lets any client claim any address, which quietly
   * defeats both rate limiting and the audit trail.
   */
  trustProxy?: boolean | number;
  /** Locales this application serves, best first. */
  supportedLocales?: readonly string[];
  /** Locale used when negotiation finds no match. */
  defaultLocale?: string;
  /** Echo the request id back to the client. Defaults to true. */
  echoRequestId?: boolean;
}

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface ResponseLike {
  setHeader?(name: string, value: string): void;
  header?(name: string, value: string): unknown;
}

/**
 * Opens the request context for the lifetime of the request.
 *
 * Everything downstream — logging, auditing, tenant scoping, error reporting —
 * reads from it, so this must be registered before anything else that matters.
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  constructor(private readonly options: ContextMiddlewareOptions = {}) {}

  use(request: RequestLike, response: ResponseLike, next: () => void): void {
    const {
      trustProxy = false,
      supportedLocales = ['en'],
      defaultLocale = supportedLocales[0] ?? 'en',
      echoRequestId = true,
    } = this.options;

    const requestId = headerValue(request, REQUEST_ID_HEADER) ?? randomUUID();
    const correlationId = headerValue(request, CORRELATION_ID_HEADER) ?? requestId;

    if (echoRequestId) {
      setHeader(response, REQUEST_ID_HEADER, requestId);
      setHeader(response, CORRELATION_ID_HEADER, correlationId);
    }

    const context = createContext({
      requestId,
      correlationId,
      source: 'http',
      ip: clientIp(request, trustProxy),
      userAgent: headerValue(request, 'user-agent'),
      locale: negotiateLocale(
        headerValue(request, 'accept-language'),
        supportedLocales,
        defaultLocale,
      ),
    });

    runWithContext(context, next);
  }
}

function headerValue(request: RequestLike, name: string): string | undefined {
  const value = request.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function setHeader(response: ResponseLike, name: string, value: string): void {
  if (typeof response.setHeader === 'function') response.setHeader(name, value);
  else if (typeof response.header === 'function') response.header(name, value);
}

function clientIp(request: RequestLike, trustProxy: boolean | number): string | undefined {
  const hops = trustProxy === true ? 1 : trustProxy === false ? 0 : Math.max(0, trustProxy);
  const forwarded = hops > 0 ? headerValue(request, 'x-forwarded-for') : undefined;
  if (forwarded) {
    const entries = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    // Counted from the right: each trusted proxy appended the address it was
    // connected from, so the last `hops` entries are theirs to vouch for, and
    // anything further left is the client's own word.
    const client = entries[Math.max(0, entries.length - hops)];
    if (client) return client;
  }
  return request.ip ?? request.socket?.remoteAddress;
}

/**
 * Negotiates a locale from `Accept-Language`.
 *
 * Matches the exact tag first, then the language subtag — so a browser asking
 * for `ro-MD` is served `ro` rather than falling through to English, which
 * matters wherever an audience's regional tags vary.
 */
