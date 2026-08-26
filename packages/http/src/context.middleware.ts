import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { runWithContext, createContext } from '@birtalanrobert/context';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface ContextMiddlewareOptions {
  /**
   * Trust `X-Forwarded-For` when determining the client address.
   *
   * Only enable behind a proxy that overwrites the header. Trusting it when
   * directly exposed lets any client claim any address, which quietly defeats
   * both rate limiting and the audit trail.
   */
  trustProxy?: boolean;
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

function clientIp(request: RequestLike, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwarded = headerValue(request, 'x-forwarded-for');
    // The left-most entry is the original client; everything after it was
    // appended by successive proxies.
    if (forwarded) return forwarded.split(',')[0]?.trim();
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
export function negotiateLocale(
  header: string | undefined,
  supported: readonly string[],
  fallback: string,
): string {
  if (!header || supported.length === 0) return fallback;

  const accepted = header
    .split(',')
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(';');
      const quality = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)?.[1]).find(Boolean);
      return { tag: (tag ?? '').trim().toLowerCase(), quality: quality ? Number(quality) : 1 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  const supportedLower = supported.map((locale) => locale.toLowerCase());

  for (const { tag } of accepted) {
    if (tag === '*') return fallback;
    const exact = supportedLower.indexOf(tag);
    if (exact !== -1) return supported[exact] as string;

    const language = tag.split('-')[0];
    const byLanguage = supportedLower.findIndex(
      (locale) => locale === language || locale.split('-')[0] === language,
    );
    if (byLanguage !== -1) return supported[byLanguage] as string;
  }

  return fallback;
}
