# @birtalanrobert/rates

Published exchange rates, from the central banks that publish them.

The other half of `@birtalanrobert/money/rates`, and the line between them is
deliberate: that package is **arithmetic** — a rate's representation, its
direction, conversion, the on-or-before lookup — and this one is
**acquisition**. Keeping them apart is what stops a console that shows a
converted price from installing an XML parser and an ORM to do it.

## The root is three parsers and nothing else

Framework-free and database-free. Each is a pure function from a published
document to `ExchangeRate` values, because parsing is where every mistake in
this package will be and it is only testable against recorded payloads if the
network is somewhere else.

```ts
import { BNR, ECB, MNB } from '@birtalanrobert/rates';

BNR.parse(xml); // ExchangeRate[]
```

**Three feeds, three directions, and they disagree on purpose.**

|         | Quotes                                     | So a rate is                |
| ------- | ------------------------------------------ | --------------------------- |
| **BNR** | lei per one unit of the foreign currency   | `base: 'EUR', quote: 'RON'` |
| **MNB** | forints per `unit` of the foreign currency | `base: 'EUR', quote: 'HUF'` |
| **ECB** | foreign currency per one euro              | `base: 'EUR', quote: 'RON'` |

Nothing is inverted on the way in. Inverting is lossy, and a contract naming one
bank must settle at that bank's figure — which is why the publisher is on every
row and why a reader filters by it before looking anything up.

**Two attributes shift a rate by two orders of magnitude.** The BNR publishes
the forint per hundred (`multiplier="100"`) and the MNB publishes the yen per
hundred (`unit="100"`). A parser ignoring either produces a figure that is not
obviously absurd to anybody who does not already know the rate. The MNB also
uses a comma decimal separator, where `Number('392,10')` is `NaN` but stripping
the comma reads thirty-nine thousand.

Every normalisation is a decimal-point move rather than a division, because
`1.26 / 100` in floating point is `0.012600000000000002` — and an exact integer
rate representation is the whole reason `money/rates` exists.

## The Nest side stores them

```ts
import { RatesModule, ratesEntities, ratesMigrations } from '@birtalanrobert/rates/nestjs';

RatesModule.forRoot(); // reads only — for anything that settles a charge
RatesModule.forFetching(); // reads and fetches — for the one worker that talks to the banks
```

`forRoot` cannot write, deliberately: a rate a request could invent is a charge
a customer could dispute.

**Register `ratesMigrations` in the service that _reads_ rates**, not
necessarily the one that writes them. A missing write retries harmlessly on the
next interval; a missing read is a customer's figures failing. Registering it in
both is also fine — TypeORM keys its history on the class name, so the second
finds it already applied.

`mortar_published_rates` carries **no row-level security**, and a test asserts
it. A rate belongs to nobody: the BNR's figure for the 15th is the same fact for
every account, and a policy on it would mean every charge silently reporting
"no rate yet".

## Fetch on an interval, not at a time of day

The BNR publishes around 13:00 in Bucharest, the MNB around 11:00 in Budapest,
the ECB around 16:00 CET — three moments in two timezones, both of which change
twice a year. A job firing at a chosen hour either runs before one of them or
needs a timezone table nobody maintains.

Every few hours instead. The fetch is cheap and idempotent: the feeds carry ten
and ninety days of overlap and `record` ignores what is already held, so
re-reading an unchanged document costs one request and no writes — and a worker
that was down over a weekend catches up on its own.

One source failing must not stop the others, and `fetchAll` returns a result per
source rather than throwing. Only every feed failing at once is worth retrying,
and it is almost always a problem at your end rather than at three banks'.
