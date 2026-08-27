# @birtalanrobert/audit

The append-only record of what was done, by whom, to what.

## Using it in a NestJS application

```ts
import { AuditModule, AuditService } from '@birtalanrobert/audit';

@Module({
  imports: [
    // …config, logger, database…
    AuditModule.forRoot(),
  ],
})
export class AppModule {}
```

`forRoot()` takes no required options and there is no `forRootAsync`, because
there is nothing to configure that depends on anything else — the module needs
the data source, which it injects. `@Global()`.

Register `auditEntities` and `auditMigrations` with the database module:

```ts
export const entities = [...auditEntities /* … */];
export const migrations = [...auditMigrations /* … */];
```

## Recording

```ts
constructor(private readonly audit: AuditService) {}

await this.audit.record(
  {
    action: 'request.created',
    entityType: 'request',
    entityId: request.id,
    tenantId,
    before: previous,   // omit on creation
    after: current,     // omit on deletion
  },
  manager,              // the surrounding transaction, if there is one
);
```

**Pass the manager.** An audit entry written outside the transaction it
describes survives a rollback, which produces a trail asserting something that
never happened — worse than no trail, because it will be believed.

`before`/`after` are diffed into a `changes` column. For a fact that is not a
state change — "a link was re-issued to this address" — use `metadata` instead:
an `after` with no `before` is recorded as a diff from nothing, which reads as
though those fields had just been set.

The actor and tenant come from the ambient context when not given explicitly.

## Reading

```ts
// The whole trail for one entity, newest first:
const history = await audit.forEntity('request', requestId);

// Or a broader query:
const recent = await audit.query({ tenantId, action: 'request.created', limit: 100 });
```

## Why it is append-only

There is no update and no delete. A trail that can be edited is a trail that
answers "what happened" with "whatever somebody last wanted it to say", and the
questions it exists to answer — a disputed deletion, a regulator's request, an
incident — are exactly the ones where an editable record is worthless.

Retention is handled by deleting whole partitions of old entries as a policy,
not by amending individual rows.

## `seq`

A monotonic sequence beside the timestamp. Two entries written in the same
millisecond are still ordered, and a clock that steps backwards does not
reorder history.
