import { Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { InjectDataSource, resolveManager } from '@birtalanrobert/database';
import { rate as buildRate, rateToString, type ExchangeRate } from '@birtalanrobert/money/rates';
import { PublishedRate } from './published-rate.entity';

@Injectable()
export class RatesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Stores what a feed published, ignoring what is already there.
   *
   * `DO NOTHING` rather than an upsert, and the difference matters. The feeds
   * are re-read every morning with ten or ninety days of overlap, so almost
   * every row in a fetch is one already held — and a published rate for a past
   * day does not change. If one ever appeared to, overwriting it would silently
   * alter a figure some tenant's balance was settled against; leaving it is
   * both correct and the loud option, because the discrepancy stays visible.
   *
   * Returns how many rows were genuinely new, which is what the job logs: a
   * morning that inserts nothing when the bank has published is a feed that has
   * stopped, and it is the number worth watching.
   */
  async record(rates: readonly ExchangeRate[]): Promise<number> {
    if (rates.length === 0) return 0;

    const inserted = await resolveManager(this.dataSource)
      .createQueryBuilder()
      .insert()
      .into(PublishedRate)
      .values(
        rates.map((one) => ({
          source: one.source ?? 'unknown',
          base: one.base,
          quote: one.quote,
          asOf: one.asOf,
          /*
           * `rateToString` rather than arithmetic. Dividing the scaled integer
           * by 10^10 here would be a float in the one place this whole module
           * exists to keep them out of, and it would be invisible: 4.9772 comes
           * back as 4.9772 and only some rates would drift.
           */
          rate: rateToString(one),
        })),
      )
      .orIgnore()
      .returning('id')
      .execute();

    return Array.isArray(inserted.raw) ? inserted.raw.length : 0;
  }

  /**
   * Every rate for a pair, newest first, back to a day.
   *
   * The shape `settle` wants: it takes a list and does the on-or-before lookup
   * itself, because the engine is pure and the database is not allowed near it.
   * The window is bounded so that a lease settling one charge does not read a
   * decade of publications.
   */
  async since(
    pair: { base: string; quote: string },
    from: string,
    source?: string,
  ): Promise<ExchangeRate[]> {
    const rows = await resolveManager(this.dataSource)
      .getRepository(PublishedRate)
      .createQueryBuilder('rate')
      .where('rate.base = :base AND rate.quote = :quote', pair)
      .andWhere('rate.asOf >= :from', { from })
      .andWhere(source === undefined ? '1 = 1' : 'rate.source = :source', { source })
      .orderBy('rate.asOf', 'DESC')
      .getMany();

    return rows.map(toExchangeRate);
  }

  /** The newest day held for a pair, for the staleness alert in §5.13. */
  async newestDay(pair: { base: string; quote: string }, source: string): Promise<string | null> {
    const row = await resolveManager(this.dataSource)
      .getRepository(PublishedRate)
      .findOne({
        where: { base: pair.base, quote: pair.quote, source },
        order: { asOf: 'DESC' },
      });

    return row?.asOf ?? null;
  }
}

/** A stored row back into the value the engines take. */
export function toExchangeRate(row: PublishedRate): ExchangeRate {
  return buildRate(row.base, row.quote, trimTrailingZeros(row.rate), {
    asOf: row.asOf,
    source: row.source,
  });
}

/**
 * `numeric(20, 10)` comes back as `4.9772000000`, which `rate` would refuse for
 * being more precise than it can hold — it is not, but it does not know that
 * until the zeros are gone.
 */
function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}
