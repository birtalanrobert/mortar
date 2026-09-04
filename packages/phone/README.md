# @birtalanrobert/phone

Telephone numbers as the durable identity of a customer, for the markets these
products are sold in.

```ts
import { normalisePhone, formatPhone, dialable } from '@birtalanrobert/phone';

normalisePhone('0722 123 456', 'RO'); // '40722123456'
normalisePhone('+40722123456', 'RO'); // '40722123456'  — the same customer
formatPhone('40722123456', 'RO'); // '0722 123 456'
dialable('40722123456'); // '+40722123456'
```

## Three forms, and they are not interchangeable

- **As typed.** Stored beside the normalised form and shown back, because a
  customer recognises their own number in the shape they write it.
- **Normalised** — `normalisePhone`. Digits only, country code first. This is
  what is unique, what is indexed and what is matched on. **It is a search key,
  not an address.**
- **Dialable** — `dialable`. E.164, with the plus. What a provider is handed.

The distinction is not academic: a project shipped a pumping check that refused
anything without a country code, which refused a perfectly good normalised
`40722123456` and recorded it as "not international". A search key is not
something you can send to.

## What it will not do

**It does not refuse a number.** Anything that cannot be read as a number in the
given market is returned digits-only rather than rejected — a business taking a
call from abroad must not be blocked, and a number that only ever matches itself
is a better outcome than a booking that could not be taken.

`isSearchablePhone` is the softer question the console actually asks: is this
worth looking up? Offering to search for `07` wastes a second of a
thirty-second intake.

## Markets

Romania and Hungary. Each carries how the country _writes_ a number down, which
is not decoration — a customer checking a number on a receipt pattern-matches
against the shape they know, and `0722123456` reads as a different number from
`0722 123 456` to the person who owns it. Romania joins the trunk prefix to the
first group; Hungary separates it.

Adding a market is one entry in `DIALLING` and its tests.
