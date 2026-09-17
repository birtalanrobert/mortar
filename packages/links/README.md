# @birtalanrobert/links

Signed, expiring links: how somebody reaches a page without an account.

A booking confirmation, an upload request, an RSVP, a loyalty card's web
fallback. One side mints a token, the other verifies it, and a shared secret is
what makes it unforgeable.

```ts
import { expiresIn, signLink, verifyLink } from '@birtalanrobert/links';

const token = await signLink(
  { subject: 'card:9f2a', tenantId, expiresAt: expiresIn(60 * 60 * 24 * 30) },
  process.env.LINK_SECRET!,
);

const result = await verifyLink(token, process.env.LINK_SECRET!);
if (result.ok) {
  // result.payload.subject
}
```

## Why both halves are here

They must agree exactly on the payload encoding — the bytes the HMAC is
computed over, the base64 alphabet, the padding — and two implementations that
agree today will not agree in a year.

## What it refuses, and why it says which

`verifyLink` reports `malformed`, `invalid` or `expired`, because those have
three different remedies: "check you copied all of it", "somebody is guessing",
and "ask for another". A product where the difference would tell a stranger
whether something exists should send all three to one page — but it can only
decide that if it is told which happened.

The signature is checked **before** the expiry, so an expired token nobody
signed is reported as invalid rather than as merely expired.

## Runtime

Web Crypto rather than `node:crypto`, so the same code runs in an edge
middleware, in a browser and in a Nest service. No dependencies.
