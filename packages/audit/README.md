# @mortar/audit

An append-only audit trail that **joins the caller's transaction**.

## Why this package exists in this form

`record()` writes through the active `EntityManager` when one is open. That
single property is the reason mortar adopted TypeORM at all: a package holding
its own connection pool cannot join the caller's transaction, so a rollback
would leave behind an audit row for a change that never happened — a confident
record of a lie, which is worse than no record.

```ts
await runInTransaction(dataSource, async () => {
  await bookingRepo.save(booking);
  await audit.record({
    action: 'booking.cancelled',
    entityType: 'booking',
    entityId: booking.id,
    before,
    after,
  });
});
// Both commit, or neither does.
```

## Append-only is enforced by the database

The service exposes no update or delete for individual rows, **and** the
migration installs a trigger that raises on `UPDATE`. A trail that merely
happens not to be edited is worth less than one that cannot be — and these
projects use it to settle disputes about money, hours worked and who saw whose
data.

Bulk time-based purging (`purgeOlderThan`) still works, because retention is a
policy rather than a way to remove one inconvenient row.

## Context is captured automatically

Tenant, actor, actor name, impersonator, request id, correlation id, address
and user agent all come from the ambient request context. A caller writes one
line and the entry is complete.

**Impersonation records both parties** — the operator and the account they
acted as — because "who did this" has two answers when support is involved.

**The actor's name is denormalised** on purpose: a user who is later renamed or
deleted must still be identifiable, and a join to a mutable table would quietly
rewrite history.

## Only changes are stored, and secrets never are

`computeChanges()` records just the fields that differ, with password, token,
key, PIN, card and IBAN-shaped fields replaced by `[redacted]` — the fact of
the change is recorded, the value is not.

Dates compare by instant rather than identity, so a record re-read from the
database does not register as changed.
