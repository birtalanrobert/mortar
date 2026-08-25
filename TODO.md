# Mortar — Tier 1 Implementation Plan

Tier 1 is the set of packages every one of the seventeen projects installs.
See `../specs/00-shared-foundations.md` for the full context.

## Decisions taken

| Decision        | Choice                                          | Reasoning                                                 |
| --------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Package manager | pnpm workspaces (via corepack)                  | Strict node_modules, fast, good monorepo story            |
| Language target | TypeScript → **CommonJS**, ES2023               | NestJS decorators + `emitDecoratorMetadata` assume CJS    |
| Build           | plain `tsc` per package                         | Libraries need clean `.d.ts`, not bundles                 |
| Tests           | vitest                                          | Fast, native TS, no transform config                      |
| Validation      | zod                                             | The de-facto standard; used by `@mortar/config`           |
| Database        | **PostgreSQL, enforced**                        | All seventeen specifications mandate it                   |
| ORM             | **TypeORM**                                     | See below                                                 |
| Migrations      | TypeORM migration classes, exported per package | Projects register mortar's migrations alongside their own |
| Package shape   | **Pure core + thin NestJS layer**               | See below                                                 |

### On the ORM — a reversal, and why

The original plan avoided an ORM to prevent lock-in. That was wrong: all
seventeen projects mandate PostgreSQL, so the lock-in is already accepted, and
avoiding TypeORM buys nothing while costing correctness.

The decisive argument is **transaction composition**. A package that owns its
own connection pool cannot join the caller's transaction. That means:

- an **audit record** could be written for a change that then rolls back;
- an **idempotency key** could be committed for work that never happened;
- **RLS session variables** (`SET LOCAL app.tenant_id`) set by one pool would not
  apply to queries issued on another.

All three are silent correctness failures. TypeORM it is, with
`@mortar/database` owning the `DataSource` and a **transactional context** so
every mortar write participates in whatever transaction is already open.

### On package shape — functions _and_ services

Every package has two layers:

- **A framework-free core.** Pure functions, no decorators, no DI. Usable from
  NestJS, Next.js route handlers, React, workers, CLI tools and tests.
- **A thin NestJS integration layer.** An injectable service, a module, guards
  and interceptors — wiring the core into DI, validated config, the TypeORM
  connection and the request context. It is a **wrapper, never a
  reimplementation**; all logic stays in the core.

Packaging follows the audience:

| Package                                                               | Entry points                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `money`, `context`                                                    | Single pure entry. Frontend-safe, no NestJS anywhere                                                         |
| `config`, `observability`                                             | `.` pure core, `./nestjs` module + service. A Next.js app importing `@mortar/config` must not pull in NestJS |
| `database`, `http`, `audit`, `idempotency`, `tenancy`, `auth`, `jobs` | Server-only by nature; modules, services and the underlying functions all from the main entry                |

Subpath entries ship a **stub folder** (`nestjs/package.json` pointing at
`../dist/nestjs`) as well as an `exports` map, because consuming NestJS projects
typically use `moduleResolution: "node"`, which does not read `exports`.

NestJS and TypeORM are **peer dependencies**, never hard ones.

## Build order (dependency-driven)

```
money ─────────────────────────────┐  (pure, zero deps)
context ───────────┬───────────────┤
config ────────────┤               │
                   ▼               │
              observability        │
                   │               │
                   ▼               │
               database            │
                   │               │
                   ▼               │
                 http ◄────────────┘
                   │
     ┌─────────────┼─────────────┬──────────┐
     ▼             ▼             ▼          ▼
   audit     idempotency     tenancy      auth
                                  │
                                  ▼
                                jobs
```

## Tasks

### Phase A — Workspace foundation

- [x] A1. Enable pnpm, init workspace, root `package.json`, `pnpm-workspace.yaml`
- [x] A2. Base `tsconfig.json`, shared build config, `.gitignore`, `.npmrc`
- [x] A3. Vitest workspace config
- [x] A4. ESLint + Prettier
- [x] A5. Package scaffolding script + README
- [x] A6. CI workflow (lint, typecheck, test, build)
- [x] A7. Subpath-entry build support (stub folder generation + exports map)
- [x] A8. Shared test harness: throwaway Postgres via testcontainers or a CI service

### Phase B — Framework-free packages

- [x] B1. `@mortar/money` — minor units, arithmetic, allocation, rounding, multi-currency, parse/format
- [x] B2. `@mortar/context` — AsyncLocalStorage request context
- [x] B3. `@mortar/config` — zod env schema, fail-at-boot, typed access, redaction
- [x] B4. `@mortar/config` — `./nestjs` ConfigModule + typed ConfigService
- [x] B5. `@mortar/observability` — core logger (pino), context binding, redaction, metrics
- [x] B6. `@mortar/observability` — `./nestjs` LoggerModule, Nest LoggerService adapter, HTTP logging interceptor

### Phase C — Database foundation

- [x] C1. `@mortar/database` — `DataSource` factory from validated config, naming strategy, base entity conventions
- [x] C2. `@mortar/database` — **transactional context**: active `EntityManager` in the request context, `@Transactional()` decorator, `runInTransaction()` function
- [x] C3. `@mortar/database` — `DatabaseModule`, repository helpers, migration discovery, health check
- [x] C4. `@mortar/database` — integration tests against a real Postgres

### Phase D — HTTP layer

- [x] D1. `@mortar/http` — error taxonomy + problem-details mapping
- [x] D2. `@mortar/http` — exception filter, validation pipe, serialization conventions
- [x] D3. `@mortar/http` — context middleware (request id, correlation, locale, ip) and the Nest module
- [x] D4. `@mortar/http` — health checks (db, redis, storage) with a pluggable indicator registry
- [ ] D5. `@mortar/http` — OpenAPI conventions and shared decorators
      _Deferred to the second consumer: the useful set of shared response
      decorators is not knowable until two real APIs have been built against
      this package. Extracting it now would be guessing at an interface._

### Phase E — Data-touching packages

- [x] E1. `@mortar/audit` — entity + migration, `AuditService`, transaction-joined writes, query helpers, retention
- [x] E2. `@mortar/idempotency` — entity + migration, `IdempotencyService`, interceptor/decorator, replay and conflict semantics
- [x] E3. `@mortar/tenancy` — resolution strategies, `TenantService`, scoped repository, **RLS session-variable binding inside the transaction**, cross-tenant guard
- [x] E4. `@mortar/auth` — entities + migrations, password hashing, `SessionService`, verification and reset flows, invitations, RBAC guards and decorators

### Phase F — Background work

- [x] F1. `@mortar/jobs` — BullMQ module, typed job definitions, idempotent handler wrapper
- [x] F2. `@mortar/jobs` — retry/backoff, dead-letter, scheduled-job distributed lock
- [x] F3. `@mortar/jobs` — **forward-window scanner base** (the pattern 10 of 17 projects need)
- [x] F4. `@mortar/jobs` — context propagation from request into job execution

### Phase G — Release

- [ ] G1. Version policy and private registry publish config
- [ ] G2. Root README documenting install + usage per package
- [ ] G3. A worked example wiring a minimal NestJS app against the full Tier 1 set
