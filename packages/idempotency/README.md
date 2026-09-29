# @birtalanrobert/idempotency

Idempotency keys for mutating endpoints.

This is needed wherever clients double-submit: a
guest double-taps and the order becomes real food, a retried attack command is
unrecoverable, a doubled payment is a refund and an apology.

## Using it in a NestJS application

```ts
import { IdempotencyModule } from '@birtalanrobert/idempotency';

@Module({
  imports: [
    // …config, logger, database…
    IdempotencyModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({ ttlMs: config.IDEMPOTENCY_TTL }),
    }),
  ],
})
export class AppModule {}
```

`@Global()`, and it provides `IdempotencyInterceptor`, which the application
registers globally so every `@Idempotent()` route is covered:

```ts
providers: [{ provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor }];
```

Register `idempotencyEntities` and `idempotencyMigrations` with the database
module.

## Marking a route

```ts
@Post()
@Idempotent()
async create(@Body() body: CreateThingDto) { /* … */ }
```

The client sends `Idempotency-Key`. A repeat with the same key **and the same
request** — the same body, and the same route parameters — replays the first
response; the same key with a _different_ request is refused rather than
replayed, because silently answering a question the caller did not ask hides
their bug.

Put it on anything a client will retry and that has an effect outside the
database — sending an email, charging a card, issuing a link. A create that
times out in the network leaves the caller unable to tell whether it happened,
and without a key the safe behaviour is also the one that does it twice.

## The commit boundaries are the design, and they are not symmetrical

**The claim commits immediately, in its own transaction.** A concurrent
duplicate must be able to _see_ the claim — which it cannot do if the claim is
sitting uncommitted inside the first request's transaction. Two simultaneous
requests would then both proceed.

**The key is marked done in the transaction that does the work.** If it were
marked in a transaction of its own, a crash between the two would leave the
work done and the key unfinished, and the retry would do the work twice — the
exact failure this package exists to prevent.

The interceptor cannot open that transaction: a service opens it, deep inside
the handler, and commits it there. So while the handler runs, the claim joins
every transaction that commits (`joinCommits` from `@birtalanrobert/database`),
and the **first one to commit a write** marks the key done as its last
statement. A transaction that wrote nothing — a read, however wrapped — does not
count: Postgres gives a transaction an id only once it writes, or locks a row
to write it. The response is stored once the handler answers; a repeat in the
moment between, or after a crash that never stored it, is answered with the
route's status and no body, rather than with the work done twice.

**A handler that fails before committing a write frees the key**, so the
caller's retry runs — a refusal, a validation error, a transaction that rolled
back. **One that fails after a write committed does not**: the work is done,
so a retry is answered with no body rather than repeated — for instance when
a callback run after the commit fails.

Without the interceptor, the same holds by hand:

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
  The scope is the route's pattern, so the route's parameters are fingerprinted
  with the body: one key sent to two queue items is refused, not answered with
  the first's response. A route with no parameters is fingerprinted by its body
  alone, as before 1.2.0.
- **Needs Postgres 13 or later**, for `pg_current_xact_id_if_assigned()`.
- **The unique index uses `COALESCE(tenant_id, …)`** because Postgres treats
  NULLs as distinct — a plain `UNIQUE(tenant_id, scope, key)` would let two
  platform-level requests claim the same key simultaneously.
- **The response is stored as `text`, not `jsonb`.** It is an opaque blob to be
  replayed verbatim, never queried into, and `text` keeps SQL NULL
  unambiguously meaning "no response recorded".
