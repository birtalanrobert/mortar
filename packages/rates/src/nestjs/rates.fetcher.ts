import { Injectable } from '@nestjs/common';
import { InjectLogger } from '@birtalanrobert/observability/nestjs';
import type { Logger } from '@birtalanrobert/observability';
import { BNR } from '../sources/bnr';
import { ECB } from '../sources/ecb';
import { MNB } from '../sources/mnb';
import type { RateSource, SourceResult } from '../sources/port';
import { RatesService } from './rates.service';

/**
 * The feeds this package knows how to read.
 *
 * The default for `fetchAll`, and a product wanting fewer passes its own list:
 * a service operating only in Hungary has no reason to ask Bucharest for a rate
 * eight times a day.
 */
export const SOURCES: readonly RateSource[] = [BNR, MNB, ECB];

/** Ten seconds. A bank's website being slow must not hold a worker's queue. */
const TIMEOUT_MS = 10_000;

@Injectable()
export class RatesFetcher {
  constructor(
    private readonly rates: RatesService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /**
   * Reads every feed and stores what came back.
   *
   * **One source failing must not stop the others**, which is why the results
   * are collected rather than awaited together and why a failure is a value
   * rather than a throw. A Romanian landlord's rent does not stop settling
   * because the MNB's web service is down, and a job that failed wholesale on
   * the first bad feed would be a job that retried all three every time one was
   * unwell.
   */
  async fetchAll(sources: readonly RateSource[] = SOURCES): Promise<SourceResult[]> {
    const results: SourceResult[] = [];

    for (const source of sources) {
      results.push(await this.fetchOne(source));
    }

    const failed = results.filter((one) => one.error !== undefined);
    if (failed.length === sources.length && sources.length > 0) {
      /*
       * Every feed failing at once is a different fact from one failing, and
       * almost always ours rather than theirs — no outbound network, a DNS
       * change, a proxy. Worth saying so rather than logging three errors that
       * each look like somebody else's problem.
       */
      this.logger.error('Every exchange rate feed failed. This is usually at our end.', {
        sources: failed.map((one) => one.source),
      });
    }

    return results;
  }

  private async fetchOne(source: RateSource): Promise<SourceResult> {
    try {
      const document = await this.read(source);
      const rates = source.parse(document);

      const stored = await this.rates.record(rates);

      this.logger.info('exchange rates fetched', {
        source: source.name,
        read: rates.length,
        stored,
      });

      return { source: source.name, rates };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn('exchange rate feed failed', { source: source.name, err: message });

      return { source: source.name, rates: [], error: message };
    }
  }

  private async read(source: RateSource): Promise<string> {
    /*
     * An explicit timeout, because `fetch` has none. A hung connection to a
     * bank would otherwise hold this job open until BullMQ's stall detector
     * noticed, which is minutes rather than seconds.
     */
    const abort = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(source.url, { signal: abort });

    if (!response.ok) {
      throw new Error(`${source.name} answered ${response.status}`);
    }

    return response.text();
  }
}
