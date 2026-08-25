import { describe, expect, it } from 'vitest';
import { getContext } from '@mortar/context';
import { ContextMiddleware, negotiateLocale } from './context.middleware';

function run(
  request: Record<string, unknown>,
  options = {},
): { context: ReturnType<typeof getContext>; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const response = { setHeader: (name: string, value: string) => void (headers[name] = value) };
  let captured: ReturnType<typeof getContext>;
  new ContextMiddleware(options).use(request, response, () => {
    captured = getContext();
  });
  return { context: captured, headers };
}

describe('ContextMiddleware', () => {
  it('opens a context for the request', () => {
    const { context } = run({ headers: {} });
    expect(context?.source).toBe('http');
    expect(context?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours an inbound request id so traces span services', () => {
    const { context } = run({ headers: { 'x-request-id': 'upstream-1' } });
    expect(context?.requestId).toBe('upstream-1');
  });

  it('defaults correlation id to the request id', () => {
    const { context } = run({ headers: { 'x-request-id': 'r1' } });
    expect(context?.correlationId).toBe('r1');
  });

  it('keeps an inbound correlation id distinct from the request id', () => {
    const { context } = run({
      headers: { 'x-request-id': 'r1', 'x-correlation-id': 'trace-9' },
    });
    expect(context?.requestId).toBe('r1');
    expect(context?.correlationId).toBe('trace-9');
  });

  it('echoes both ids back so a user can quote one to support', () => {
    const { headers } = run({ headers: { 'x-request-id': 'r1' } });
    expect(headers['x-request-id']).toBe('r1');
    expect(headers['x-correlation-id']).toBe('r1');
  });

  it('captures the user agent', () => {
    const { context } = run({ headers: { 'user-agent': 'Mozilla/5.0' } });
    expect(context?.userAgent).toBe('Mozilla/5.0');
  });
});

describe('client address', () => {
  it('uses the socket address when not behind a proxy', () => {
    const { context } = run({ headers: { 'x-forwarded-for': '9.9.9.9' }, ip: '10.0.0.1' });
    // Deliberately ignores the header: trusting it while directly exposed
    // lets any client claim any address.
    expect(context?.ip).toBe('10.0.0.1');
  });

  it('takes the left-most forwarded address when proxied', () => {
    const { context } = run(
      { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.5' }, ip: '10.0.0.1' },
      { trustProxy: true },
    );
    expect(context?.ip).toBe('203.0.113.7');
  });

  it('falls back to the socket when the header is absent', () => {
    const { context } = run({ headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    expect(context?.ip).toBe('127.0.0.1');
  });
});

describe('negotiateLocale', () => {
  const supported = ['ro', 'hu', 'en'];

  it('matches an exact tag', () => {
    expect(negotiateLocale('hu', supported, 'en')).toBe('hu');
  });

  it('matches on the language subtag, so ro-MD gets Romanian', () => {
    expect(negotiateLocale('ro-MD', supported, 'en')).toBe('ro');
  });

  it('respects quality ordering rather than document order', () => {
    expect(negotiateLocale('en;q=0.5, hu;q=0.9', supported, 'en')).toBe('hu');
  });

  it('skips unsupported languages to reach a supported one', () => {
    expect(negotiateLocale('de, fr, hu', supported, 'en')).toBe('hu');
  });

  it('ignores entries with q=0', () => {
    expect(negotiateLocale('hu;q=0, ro', supported, 'en')).toBe('ro');
  });

  it('falls back when nothing matches', () => {
    expect(negotiateLocale('de, fr', supported, 'en')).toBe('en');
    expect(negotiateLocale(undefined, supported, 'en')).toBe('en');
    expect(negotiateLocale('*', supported, 'en')).toBe('en');
  });

  it('preserves the configured casing of the matched locale', () => {
    expect(negotiateLocale('RO-ro', ['ro-RO', 'en'], 'en')).toBe('ro-RO');
  });
});
