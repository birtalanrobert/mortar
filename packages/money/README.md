# @mortar/money

Integer minor-unit money. No floats, ever, at any point in the chain.

Eleven of the seventeen project specifications independently state the same
requirement — _"money in integer minor units, never floats"_ — which is why
this package exists and why it has no dependencies.

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
import { money, fromMajor, add, allocate, fromNet, format } from '@mortar/money';

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
discount apportionment and commission calculation in the catalogue. Shares are
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
