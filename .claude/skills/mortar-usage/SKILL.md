---
name: mortar-usage
description: How to consume the @birtalanrobert/* packages — wiring order, the transactional context, tenant scoping, extending mortar's entities, and the job scanner. Use when building a service on top of mortar.
---

# Using mortar

Mortar is backend plumbing for NestJS services. Install only what is needed;
each package is versioned independently.

## Wiring order

`ConfigModule` → `DatabaseModule` → `RedisModule` → `HttpModule` →
`TenancyModule` → `AuthModule` → the rest. Config validates the environment at
module construction, so a misconfigured deployment fails **before** it can
accept traffic.

## The transactional context — the thing to understand first

`@birtalanrobert/database` carries the active `EntityManager` in the request context.
Every mortar write resolves through it, so **audit rows, idempotency keys and
RLS bindings all join the caller's transaction**.

```ts
await runInTransaction(dataSource, async () => {
  await bookingRepo.save(booking);
  await audit.record({ action: 'booking.cancelled', before, after });
});
// Both commit, or neither does.
```

This is not a convenience. Without it an audit row can be written for a change
that then rolls back — a confident record of something that never happened.

- **Nesting uses savepoints**, so an inner failure rolls back only the inner
  work and the outer transaction stays usable.
- **`afterCommit()`** is where side effects belong — an email, an enqueued job,
  a cache invalidation. It runs only after the outermost commit, so nothing
  fires for work that rolled back. Outside a transaction it runs immediately,
  so callers never branch.

## Tenant scoping — two layers, both required

`TenantScopedRepository` stops an unscoped query being **written**. RLS stops
one returning foreign rows if it is written anyway, through raw SQL or a
third-party library.

**RLS fails silently when the connecting role is a superuser or has
`BYPASSRLS`** — every policy becomes decorative and nothing reports it.
Development databases are routinely created with a superuser, so:

```ts
await assertRlsEffective(dataSource); // at boot, wherever RLS is relied on
```

`unscoped()` exists for platform metering and cross-tenant reports. It requires
a substantive reason string, deliberately, so the audit trail can explain why
the boundary was crossed.

## Extending mortar's entities

Every mortar entity ships as an **abstract base plus a concrete default**.

```ts
@Entity({ name: 'mortar_user' })
export class User extends BaseUser {
  @Column({ nullable: true }) phoneNumber!: string | null;
  @OneToMany(() => Shift, (s) => s.user) shifts?: Shift[];
}

AuthModule.forRoot({ entities: { user: User } });
```

Three rules, all enforced at boot by `assertAuthEntitiesValid()`:

1. **Register your subclass, not mortar's default.** Two entities on one table
   makes every query a coin toss.
2. **Keep the class name.** Mortar's entities reference each other by name, so
   `AppUser` leaves `Membership.user` unresolvable.
3. **Add your columns in your own migration.** Mortar's creates the base table.

A profile table (one-to-one) and a unidirectional `@ManyToOne` remain available
where they suit better. **`tenantId` is never a relation** — mortar owns no
tenant table, because each project defines its own.

## Background work

**Use the window scanner, never one scheduled job per item:**

```ts
new WindowScanner(
  {
    name: 'booking-reminders',
    intervalMs: 60_000,
    windowMs: 15 * 60_000, // must exceed the interval
    find: (from, to) => repo.dueBetween(from, to),
    keyFor: (b) => `${b.id}:24h`, // include *which* reminder, not just the item
    dispatch: (b) => queues.enqueue(sendReminder, { bookingId: b.id }),
  },
  redis.locks,
).start();
```

A per-item job still fires for a booking that was cancelled or rescheduled, and
cancelling it means finding a job that may already be in flight. Scanning reads
current state each pass, so cancelled work is simply not found — nothing needs
un-scheduling because nothing was scheduled.

Other essentials:

- **`defineJob({ idFor })`** makes enqueueing idempotent — a webhook delivered
  twice runs once.
- **Context propagates into jobs**, so a job's logs carry the correlation id of
  the request that caused it.
- **`onDeadLetter`** is where alerting belongs. BullMQ keeps a failed job;
  keeping it is not the same as anybody knowing.
- **Never share the app's Redis client with BullMQ** — use
  `createQueueConnection()`. BullMQ's blocking commands would stall everything
  else on that connection.

## Money

Integer minor units, always. `allocate()` for any split — it never loses or
invents a unit, which the naive multiply-and-round does. `fromGross()` derives
net from gross so `net + tax === gross` exactly, because the gross is what the
customer actually paid and must not move.

**ISO 4217 gives HUF exponent 2** even though Hungarian practice uses whole
forints. Override explicitly at boot if that matters.

## Errors

Throw `@birtalanrobert/http` errors from anywhere — they are framework-free, so domain
code and workers use them too. Clients branch on **`code`**, not on `title`
(prose, translatable) or `status` (too coarse). A 5xx never carries internal
detail to the client.
