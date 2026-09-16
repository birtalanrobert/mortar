import { PublishedRate } from './published-rate.entity';
import { CreatePublishedRates1791000000000 } from '../migrations/1791000000000-CreatePublishedRates';

/** Register alongside the project's own entities, in every service that queries rates. */
export const ratesEntities = [PublishedRate];

/**
 * Register alongside the project's own migrations — **in the service that reads
 * rates**, not necessarily the one that writes them.
 *
 * A worker that fetches and a service that settles both touch this table. The
 * reader should be the one that creates it: a missing write retries harmlessly
 * on the next interval, while a missing read is a customer's figures failing.
 * Register it in both and the second finds it already applied, which is also
 * fine — TypeORM keys the history on the class name.
 */
export const ratesMigrations = [CreatePublishedRates1791000000000];
