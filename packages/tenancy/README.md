# @mortar/tenancy

Tenant resolution, scoped repositories and row-level security.

The highest-stakes package in Tier 1: a single missed `WHERE tenant_id = …` in
a multi-tenant system is a data breach, not a bug.

## Two layers, deliberately

**`TenantScopedRepository`** stops an unscoped query being *written*. Every read
applies the tenant, every write stamps it, and every returned row is verified
before it is handed back. The verification is not redundant with the filter — it
also catches rows arriving through a relation, a raw query, or a caller passing
an id it should not have.

**Row-level security** stops an unscoped query *returning foreign rows* if one
is written anyway, through raw SQL, a query builder or a third-party library.

The alternative to both — remembering the predicate at several hundred call
sites — fails the first time someone is in a hurry, and fails silently.

## RLS fails silently unless you check

Postgres **superusers bypass every policy**, and `FORCE ROW LEVEL SECURITY`
does not change that. So does any role with `BYPASSRLS`. In either case every
policy is decorative, every query returns every tenant's rows, and nothing
reports a problem.

Development databases are very often created with a superuser, so an
application can pass its entire test suite with RLS doing nothing at all.

```ts
await assertRlsEffective(dataSource); // at boot, in any environment relying on RLS
```

This package's own tests connect through a dedicated non-superuser role for
exactly this reason — running them as the default superuser would prove
nothing while appearing to pass.

## The binding must be inside the transaction

`SET LOCAL` is scoped to the current transaction *and* to the connection
running it. Setting it on a different pooled connection applies to nothing;
setting it without `LOCAL` leaks it to whatever request picks that connection
up next — which in a multi-tenant system means serving one tenant's rows to
another.

`runInTenantTransaction()` binds it on the transaction's own query runner via
the `onBegin` hook, which is the third reason `@mortar/database`'s transactional
context exists.

## Failing closed

- **No tenant bound → the repository throws**, rather than reading everything.
- **No tenant bound → RLS matches no row**, because `current_setting(…, true)`
  is NULL.
- **`TenantGuard` protects a route unless it opts out** with `@AllowNoTenant()`.
  The opposite default would mean a forgotten decorator silently exposes data.
- **Cross-tenant access raises its own error code**, not a 404, so it can be
  alerted on separately — it is either a serious bug or an attack.

## Escaping scope

`unscoped()` exists because platform operators, cross-tenant reports and
migrations are real. It is deliberately verbose, impossible to reach by
accident, and requires a substantive reason so the audit trail can explain why
the boundary was crossed.
