import { describe, expect, it, vi } from 'vitest';
import type { ExchangeRate } from '@birtalanrobert/money/rates';
import type { Logger } from '@birtalanrobert/observability';
import { RatesFetcher } from './rates.fetcher';
import type { RateSource } from '../sources/port';
import type { RatesService } from './rates.service';

/**
 * What the fetcher does when a bank is unwell, which is the only behaviour in
 * it worth testing — the parsing is `sources.spec.ts`'s and the storing is the
 * database's.
 */

const spyLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

const makeFetcher = (
  record: (rates: readonly ExchangeRate[]) => Promise<number>,
  log: ReturnType<typeof spyLogger> = spyLogger(),
) => new RatesFetcher({ record } as unknown as RatesService, log as unknown as Logger);

const source = (name: string, parse: RateSource['parse']): RateSource => ({
  name,
  url: `https://example.invalid/${name}`,
  parse,
});

/** Answers every request with the same body, so `fetch` is never real. */
const stubFetch = (body: string | Error) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (body instanceof Error) throw body;
      return { ok: true, text: async () => body } as unknown as Response;
    }),
  );
};

describe('reading the feeds', () => {
  /**
   * The behaviour that matters: a Romanian landlord's rent does not stop
   * settling because the MNB's web service is down.
   */
  it('keeps going when one source fails', async () => {
    stubFetch('<anything/>');
    const record = vi.fn(async () => 1);

    const results = await makeFetcher(record).fetchAll([
      source('GOOD', () => [] as ExchangeRate[]),
      source('BAD', () => {
        throw new Error('shape changed');
      }),
      source('ALSO-GOOD', () => [] as ExchangeRate[]),
    ]);

    expect(results.map((one: { source: string }) => one.source)).toEqual([
      'GOOD',
      'BAD',
      'ALSO-GOOD',
    ]);
    expect(results[1]?.error).toBe('shape changed');
    expect(results[0]?.error).toBeUndefined();
    expect(results[2]?.error).toBeUndefined();
  });

  /**
   * Every feed failing at once is almost always ours rather than theirs — no
   * outbound network, a DNS change, a proxy — and is worth saying so rather
   * than logging three errors that each look like somebody else's problem.
   */
  it('says so loudly when every source fails at once', async () => {
    stubFetch(new Error('getaddrinfo ENOTFOUND'));
    const log = spyLogger();

    await makeFetcher(async () => 0, log).fetchAll([source('A', () => []), source('B', () => [])]);

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('treats a non-200 as a failure rather than parsing the error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => ({ ok: false, status: 503, text: async () => 'nope' }) as unknown as Response,
      ),
    );

    const parse = vi.fn(() => [] as ExchangeRate[]);
    const results = await makeFetcher(async () => 0).fetchAll([source('DOWN', parse)]);

    expect(results[0]?.error).toContain('503');
    /* Never handed an HTML error page to a parser that would have thrown a
     * confusing error about a missing element. */
    expect(parse).not.toHaveBeenCalled();
  });

  it('stores what it read', async () => {
    stubFetch('<anything/>');
    const record = vi.fn(async () => 2);
    const rates = [{ base: 'EUR', quote: 'RON', rate: 1 }] as ExchangeRate[];

    await makeFetcher(record).fetchAll([source('ONE', () => rates)]);

    expect(record).toHaveBeenCalledWith(rates);
  });
});
