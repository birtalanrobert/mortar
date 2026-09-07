# @birtalanrobert/vouchers

Stored value: gift vouchers, prepaid packages and balances.

Money a customer has already handed over and has not yet used. It is the
business's cash and the customer's entitlement at the same time — which is why
this is a **ledger and not a counter**.

Two specifications call for it in the same words: project 02 (gift vouchers and
"ten sessions" packages) and project 06 (gift balances and prepaid top-ups). It
is built for both.

## Why a ledger

A balance stored as a number cannot answer the question that always gets asked:
_where did the other four go?_ And it breaks in the two ordinary cases a ledger
survives — a redemption written twice, and a refund.

So every change is an append-only entry, and the balance is their sum. The
`balance` column exists only as a cache written in the same transaction, with
`CHECK (balance >= 0)` behind it: the constraint is the guarantee, the ledger is
the explanation.

## Counting without a database

```ts
import { balanceOf, canRedeem, applicable, expiryFrom } from '@birtalanrobert/vouchers';

balanceOf([
  { kind: 'issued', amount: 20_000 },
  { kind: 'redeemed', amount: 5_000 },
]); // 15_000

// A voucher for 200 against a bill of 350 pays 200 and the customer pays the rest.
applicable(voucher, 35_000, Date.now()); // 20_000

// Null means never, and that is the default.
expiryFrom(Date.now(), null); // null
```

The root entry point is **framework-free and browser-safe**: a console counts a
balance while somebody types, and a booking page shows what a voucher is worth.
Everything needing TypeORM or Nest is behind `@birtalanrobert/vouchers/nestjs`.

## Issuing and redeeming

```ts
import { VouchersService } from '@birtalanrobert/vouchers/nestjs';

const voucher = await vouchers.issue(tenantId, {
  denomination: 'units',
  amount: 10,
  subject: `service:${massageId}`, // a package is for what it was sold for
  holderId: customer.id,
});

await vouchers.redeem(tenantId, {
  voucherId: voucher.id,
  amount: 1,
  subject: `booking:${booking.id}`,
  serviceSubject: `service:${massageId}`,
});

// An appointment cancelled gives its session back.
await vouchers.release(tenantId, { voucherId: voucher.id, subject: `booking:${booking.id}` });
```

## Two things it deliberately does not do

- **Invent an expiry.** Rules for stored value differ by jurisdiction and
  several treat an unused voucher as the customer's money for years. Null means
  never; a business that knows its own rule sets one.
- **Take a foreign key to your rows.** `subject` is a string in the consuming
  product's own words — `booking:<id>`, `order:<id>` — because a key to one
  product's tables is exactly what would stop this one being shared.

## Codes

Crockford's base32, twelve characters in four groups of three. Its excluded
letters and its substitutions (I and L read as 1, O as 0) are the mistakes
people actually make reading a code aloud. `normaliseCode` applies them, so a
customer reading off a photograph is not told their voucher does not exist
because they typed a letter O.

A voucher is a bearer instrument: whoever holds the card may spend it. What
protects it is the rate limit in front of the lookup, not the entropy — though
32^12 is enough that guessing is not a strategy.
