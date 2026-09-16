# @birtalanrobert/money

Integer minor-unit money. No floats, ever, at any point in the chain.

This requirement comes up in every financial system — _"money in integer minor units, never floats"_ — which is why
this package exists and why it has no dependencies.

## Using it in a NestJS application

**There is no module to import.** This package is pure functions and a value
type with no dependencies, so it is imported directly wherever it is needed —
in a service, in a domain module, in a React component, in a worker.

```ts
import { money, add, format } from '@birtalanrobert/money';

const price = money(1999, 'RON'); // 19.99 RON
const total = add(price, money(500, 'RON'));
```

Persisting it is two columns, never a float. The column helpers live in
`@birtalanrobert/database`, so that this package stays dependency-free:

```ts
import { MONEY_AMOUNT_COLUMN, CURRENCY_COLUMN } from '@birtalanrobert/database';

@Column(MONEY_AMOUNT_COLUMN) amount!: number;
@Column(CURRENCY_COLUMN) currency!: string;
```

Being dependency-free is the point: a Next.js bundle can format a price without
installing an ORM, and a worker can total an invoice without a framework.

## Core ideas

- **`Money` is `{ amount, currency }`**, where `amount` is a safe integer count
  of minor units (cents, bani, fillér). It is frozen on construction.
- **Currency is never implicit.** Mixing currencies throws rather than coercing;
  quietly coercing is how money goes missing.
- **Floats enter in exactly one place** — `fromMajor()` — because user input and
  third-party payloads arrive that way. They never leave except through
  `toMajor()` for display.

## Usage

```ts
import { money, fromMajor, add, allocate, fromNet, format } from '@birtalanrobert/money';

const price = fromMajor(12.34, 'EUR'); // 1234 minor units
const total = add(price, money(500, 'EUR')); // 1734

// VAT, with net and gross always distinguishable
const line = fromNet(total, 19);
line.net.amount; // 1734
line.tax.amount; // 329
line.gross.amount; // 2063

// Splitting without losing a cent
allocate(money(1000, 'EUR'), [1, 1, 1]); // 334, 333, 333 — sums to exactly 1000

format(price, { locale: 'ro-RO' });
```

## Currencies

EUR, RON, HUF and the surrounding regional currencies are registered by default
with their ISO 4217 exponents. **Note that ISO gives HUF an exponent of 2** even
though Hungarian everyday practice uses whole forints. If a project wants
integer forints it must say so explicitly at boot, rather than relying on a
surprising default:

```ts
registerCurrency({ code: 'HUF', exponent: 0, name: 'Hungarian forint' });
```

## Rounding

`RoundingMode.HalfUp` is the default, deliberately: these are commercial
applications issuing invoices, and HalfUp is what the surrounding paperwork and
the customer's own arithmetic use. `HalfEven` is available for statistical work.

## Allocation

`allocate()` is the algorithm behind every bill split, fee distribution,
discount apportionment and commission calculation. Shares are
handed out by integer division and the remaining units distributed to the
largest fractional remainders — so the parts **always** sum exactly back to the
whole, for any input, including negatives.

The naive alternative (multiply by ratio, round each) either loses money or
invents it, and the discrepancy surfaces later as an unexplainable one-cent
difference on a reconciliation report.

## Tax

`fromGross()` derives the net from the gross rather than recomputing it, so
`net + tax === gross` exactly. The gross is what the customer actually paid and
it must not move. Verified across every rate in use in both target markets.

## Exchange rates

Behind a subpath, because most consumers of this package format prices and never
convert between currencies — and a barrel that re-exported the rate arithmetic
would put it in every one of their bundles.

```ts
import { convert, invert, rate, rateOn, rateToString } from '@birtalanrobert/money/rates';

const bnr = rate('EUR', 'RON', '4.9772', { asOf: '2026-09-15', source: 'BNR' });

convert(fromMajor(450, 'EUR'), bnr); // { amount: 223_974, currency: 'RON' }
```

Four decisions, each of which is a bug this prevents:

- **Direction is part of the value.** `base` is what one unit of is priced,
  `quote` is what it is priced in. `convert` throws `RateDirectionError` rather
  than inverting silently — applying a EUR/RON rate to lei gives an answer wrong
  by a factor of twenty-five that looks entirely plausible on a screen.
- **A rate is never a float.** It is an integer scaled by `10 ** RATE_SCALE`
  (ten decimal places, the same precision as a `numeric(20, 10)` column), parsed
  from the decimal string a central bank publishes. `Number('1.005')` is
  `1.00499999999999989`, and that is a rate one unit short of the real one.
- **Conversion goes through major units.** Minor-unit counts differ — EUR has
  two, JPY has none — so `minor × rate` is right only by coincidence. The whole
  calculation is `bigint` and rounds once at the end, because a million euros
  times a scaled rate is two hundred times past the largest exact integer a
  JavaScript number holds.
- **`rateOn` takes the latest published on or before a day, never after.**
  Central banks do not publish at weekends and rent falls due on the first. A
  lookup that reached forward would give a different answer depending on when
  the report was run.

`conversionFactor` returns the same arithmetic as an exact rational, for callers
carrying a value `Money` cannot hold — a price _per gram_, a fractional count of
minor units. Multiply first, divide second.

`invert` exists and is lossy by nature: 4.9772 inverts to 0.2009161778 and back
to 4.9771999993. Store the published direction and convert once.
