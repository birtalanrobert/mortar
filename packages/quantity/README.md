# @birtalanrobert/quantity

A decimal quantity with a unit, and an explicit factor table.

Pure and deliberately small: no framework, no database, no Node built-ins. A
browser converting a case to bottles while somebody types has to run this, and
so does a worker importing forty thousand products.

## What it is for

Two products in this catalogue need "units" and mean different things by it.
Project 03 converts **between** dimensions using per-ingredient physics — a
litre of oil is not a kilogram of oil. Project 04 needs a factor chain **within**
one dimension — a case is four trays, a tray is six bottles. Designed from both,
the genuinely shared part is exactly this package, and it is small:

- a decimal quantity that carries its unit, never a bare number;
- a factor table resolved **at definition time**, so a cycle is impossible by
  construction rather than caught at use;
- conversion to and from a base unit, with the arithmetic done once;
- a structured refusal when a conversion is not defined — a sentence naming what
  is missing, not an exception with a stack trace.

Deliberately **not** here: densities and piece weights (project 03's, and
meaningless to a wholesaler), minimum order quantities and increments (project
04's, and meaningless to a kitchen), and anything that knows what a product is.

## Using it

**There is no module to import.** Pure functions and value types, imported
directly wherever they are needed — a service, a domain package, a React
component, a worker.

```ts
import { unitTable, quantity, convert, toBase } from '@birtalanrobert/quantity';

const beer = unitTable(
  [
    { code: 'tray', of: 'bottle', times: 6 },
    { code: 'case', of: 'tray', times: 4 },
    { code: 'pallet', of: 'case', times: 40 },
  ],
  { base: 'bottle' },
);

beer.factor('pallet'); // 960 — resolved once, at definition
toBase(quantity(2, 'case'), beer); // { ok: true, value: 48 bottle }
convert(quantity(1, 'pallet'), 'tray', beer); // { ok: true, value: 160 tray }
```

The base unit is implied and its factor is exactly 1. Declaring it as anything
else is refused, because that is the only thing "base" can mean.

Where every factor is absolute against one base — which is how a mass table
reads — say so directly:

```ts
const mass = unitTable(
  [
    { code: 'kg', toBase: 1000 },
    { code: 'dag', toBase: 10 },
  ],
  { base: 'g' },
);
```

## Refusals are values, not exceptions

A conversion returns a discriminated union, because both consumers do something
specific with a refusal — one turns it into a prompt naming what is missing, the
other into a row problem with a line number in an import report — and neither
can do that with a value that is simply absent.

```ts
const result = convert(quantity(1, 'barrel'), 'bottle', beer);

if (!result.ok) {
  result.problem.reason; // 'unknown-unit'
  result.problem.says;
  // '"barrel" is not one of the units this is counted in (bottle, tray, case, pallet).'
}
```

A **table** that cannot be built throws `UnitTableError` instead, because a
broken table is a broken definition rather than a failed operation. The error
carries the same structured `problem`, so an importer can catch it and report
the row.

```ts
unitTable(
  [
    { code: 'case', of: 'tray', times: 4 },
    { code: 'tray', of: 'case', times: 0.25 },
  ],
  { base: 'bottle' },
);
// UnitTableError: "case" is defined in terms of itself: case → tray → case.
```

## The decimal rules

`decimal.js` at 34 significant digits, half-up rounding, and no exponential
notation — configured once, here, so that every consumer shares it. Rounding
happens at the boundary and never between steps.

`decimal.js` is a **peer** dependency on purpose. The configuration is global to
the module instance a bundler resolved, and a consumer that ends up with its own
copy gets that copy's defaults — the same trap that once registered a currency
in the wrong module instance and rendered every forint a hundred times too
small.

Two helpers travel with it because both were written wrong at least once:

```ts
import { isMoreThanZero, isUsableQuantity } from '@birtalanrobert/quantity';

isUsableQuantity(decimal(0)); // true — nought of something is a real answer
isMoreThanZero(decimal(0)); // false — and `Decimal.isPositive()` says true
```

`Decimal.isPositive()` being true for zero is defensible arithmetic and is not
what any caller here has ever meant. Every use of it in this programme meant "is
there any of it", and the bug was silent in both directions: an order line for
nought packs, a movement of nothing, a price recorded against no quantity.
