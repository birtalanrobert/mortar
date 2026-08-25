---
name: mortar-development
description: How to work on the mortar library itself — package structure, migrations, testing discipline against real Postgres and Redis, and the decisions that must not be quietly reversed. Use when adding or changing anything inside the mortar repo.
---

# Developing mortar

## Commands

```bash
pnpm db:up              # Postgres 3050, Redis 3051 — required for integration tests
pnpm test               # unit only; fast, runs anywhere
pnpm test:integration   # needs the Docker stack
pnpm typecheck          # builds first: NodeNext resolves workspace deps via dist
pnpm lint && pnpm format

pnpm new:package <name> "<description>"
pnpm new:migration <package> <MigrationName>
```

## Settled decisions — do not reverse without a reason

| Decision | Why |
|---|---|
| **TypeORM, PostgreSQL enforced** | All seventeen specs mandate Postgres, so there is no ORM independence left to protect — and a package with its own pool cannot join the caller's transaction, which breaks audit, idempotency and RLS silently |
| **CommonJS, NodeNext resolution** | NestJS decorators need `emitDecoratorMetadata`; `node10` is deprecated in TS 5.9 and removed in TS 7 |
| **`tsc` per package, no bundler** | Libraries need clean `.d.ts`, not bundles |
| **NestJS is a peer dependency** | `money`, `context`, `config`, `observability` stay framework-free |
| **Pure core + thin NestJS layer** | The service is a wrapper, never a reimplementation — all logic stays in the core so Next.js, workers, CLI and tests can use it |

## Package structure

`pnpm new:package` produces the right shape. Every package has
`tsconfig.json` (IDE, includes tests) and `tsconfig.build.json` (emit, excludes
them) — a single config that excludes tests leaves the language server treating
them as orphaned files.

Packages serving both server and frontend (`config`, `observability`) expose a
`./nestjs` subpath. Subpaths ship a **stub folder** as well as an `exports`
map, because consuming NestJS projects typically use `moduleResolution: "node"`,
which predates and ignores `exports`.

## Migrations

**Always `pnpm new:migration`** — it stamps `Date.now()`. TypeORM orders by the
number in the class name, so hand-picked incrementing values collide the moment
two packages or two developers pick the same next number, and the order is then
decided by whoever guessed higher rather than by when the change was written.

**Unreleased migrations are amended in place**, not stacked. Once published,
never.

## Testing discipline

**Integration tests must run the real migration**, not `synchronize`:

```ts
createTestDataSource(entities, { migrations: authMigrations })
```

`synchronize` builds the schema from decorators and **silently skips everything
a migration does beyond columns and indexes** — triggers, constraints,
functions, grants. This is not hypothetical: it is how the audit log's
append-only trigger went untested until a test caught it.

Other rules learned the hard way:

- **Test what the package prevents, not just what it does.** The valuable tests
  assert the negative: an audit row that does *not* survive a rollback, a
  reminder that is *not* sent for a cancelled booking, a tenant filter that
  cannot be widened by passing `tenantId`.
- **Security tests must exercise the real conditions.** RLS tests connect
  through a dedicated **non-superuser** role, because superusers bypass every
  policy — running them as the default superuser proves nothing while appearing
  to pass.
- **Integration files run sequentially and share one database.** A suite that
  drops the schema needs its own file, or it wipes a sibling's tables.
- **A queue is a concurrency pool.** Two worker instances on one queue compete;
  give a test its own queue name.
- Weak KDF parameters in tests (`new ScryptHasher({ cost: 1024 })`). Production
  strength makes the suite unbearable and proves nothing extra.

## Adding a package

Only when a **second** consumer needs it — one consumer is guessing at an
interface. Tier 1 and `@mortar/billing` are the exceptions, because all
seventeen consumers are known.

Then: `pnpm new:package`, peer-depend on NestJS rather than depending on it,
ship migrations as an exported array (`authMigrations`), export entities as an
array too (`authEntities`), and write the README to explain *why*, not *what* —
the API is discoverable from types, the reasoning is not.
