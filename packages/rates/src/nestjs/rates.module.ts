import { Global, Module, type DynamicModule } from '@nestjs/common';
import { RatesFetcher } from './rates.fetcher';
import { RatesService } from './rates.service';

/**
 * Reading and filling the published rate table.
 *
 * Two shapes, because the two sides of this have genuinely different needs.
 * `forRoot()` provides only `RatesService`, which reads — that is what an API
 * settling a charge needs, and it must not be able to write a rate a request
 * could have invented. `forFetching()` adds `RatesFetcher`, and belongs in the
 * one worker that talks to the banks.
 *
 * Global, because settlement happens wherever a charge is raised, and threading
 * a module import through every feature that eventually raises one is friction
 * with no benefit.
 *
 * **No schedule here.** How often to ask, and from which of the feeds, is the
 * product's decision — it depends on which markets it serves and on what its
 * job runner looks like. See the README for the interval this package
 * recommends and why it is an interval rather than a time of day.
 */
@Global()
@Module({})
export class RatesModule {
  /** Read-only. The right one for anything that settles rather than fetches. */
  static forRoot(): DynamicModule {
    return {
      module: RatesModule,
      providers: [RatesService],
      exports: [RatesService],
    };
  }

  /** Read and fetch. For the single worker that talks to the banks. */
  static forFetching(): DynamicModule {
    return {
      module: RatesModule,
      providers: [RatesService, RatesFetcher],
      exports: [RatesService, RatesFetcher],
    };
  }
}
