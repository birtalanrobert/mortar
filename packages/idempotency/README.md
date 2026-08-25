# @birtalanrobert/idempotency

Idempotency keys for mutating endpoints.

Every project in the catalogue needs this because clients double-submit: a
guest double-taps and the order becomes real food, a retried attack command is
unrecoverable, a doubled payment is a refund and an apology.

## The commit boundaries are the design, and they are not symmetrical

**The claim commits immediately, in its own transaction.** A concurrent
duplicate must be able to _see_ the claim — which it cannot do if the claim is
sitting uncommitted inside the first request's transaction. Two simultaneous
requests would then both proceed.

**The completion commits with the work.** If `complete()` ran in a separate
transaction, a crash between the two would leave the work done and the key
unfinished, and the retry would do the work twice — the exact failure this
package exists to prevent.

```ts
const claim = await idempotency.begin(key, 'POST /orders', body);
if (claim.outcome === 'replay') return claim.body;

await runInTransaction(dataSource, async () => {
  const order = await createOrder(body);
  await idempotency.complete(claim.record, 201, order); // joins this transaction
});
```

## Key reuse with a different payload is rejected

Replaying the first response would answer a question the client did not ask,
and hide a bug in their code. They get a 422 naming the header and a
`idempotency_key_reused` code.

## Abandoned claims expire

A process that dies mid-request leaves an `in_progress` claim. Without a lock
timeout that key is poisoned forever and the client can never retry. Default:
five minutes, comfortably longer than any request should take.

## Notes

- **Scope is part of the identity.** Without it, a client reusing one key
  across two endpoints would get the first endpoint's response from the second.
- **The unique index uses `COALESCE(tenant_id, …)`** because Postgres treats
  NULLs as distinct — a plain `UNIQUE(tenant_id, scope, key)` would let two
  platform-level requests claim the same key simultaneously.
- **The response is stored as `text`, not `jsonb`.** It is an opaque blob to be
  replayed verbatim, never queried into, and `text` keeps SQL NULL
  unambiguously meaning "no response recorded".
