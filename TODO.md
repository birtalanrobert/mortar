# Mortar — Tier 1 Implementation Plan

Tier 1 is the set of packages every one of the seventeen projects installs.
See `../specs/00-shared-foundations.md` for the full context.

## Decisions taken

| Decision        | Choice                                                                             | Reasoning                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager | pnpm workspaces (via corepack)                                                     | Strict node_modules, fast, good monorepo story                                                                                                                                                                              |
| Language target | TypeScript → **CommonJS**, ES2023                                                  | NestJS decorators + `emitDecoratorMetadata` assume CJS; the whole Nest ecosystem is CJS                                                                                                                                     |
| Build           | plain `tsc` per package                                                            | Libraries need clean `.d.ts`, not bundles. No bundler complexity                                                                                                                                                            |
| Tests           | vitest                                                                             | Fast, native TS, no transform config                                                                                                                                                                                        |
| Validation      | zod                                                                                | The de-facto standard; used by `@mortar/config`                                                                                                                                                                             |
| Persistence     | **`pg` directly, no ORM**                                                          | Mortar owns only infrastructural tables (sessions, audit, idempotency). Forcing TypeORM/Prisma/Drizzle on 17 projects is exactly the bottleneck §8 of the spec warns against. Projects pick their own ORM for domain models |
| Migrations      | Plain SQL files shipped per package                                                | Applied by the consuming project's own migration runner                                                                                                                                                                     |
| NestJS coupling | `@nestjs/common` as a **peer** dependency, only in packages that genuinely need it | `money`, `context`, `config`, `observability` stay framework-free                                                                                                                                                           |

## Build order (dependency-driven)

```
money ─────────────────────────┐  (pure, zero deps)
context ───────────┐           │
config ────────────┤           │
                   ▼           │
              observability    │
                   │           │
                   ▼           │
                 http ◄────────┘
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

### Phase B — Framework-free packages

- [x] B1. `@mortar/money` — minor units, arithmetic, allocation, rounding, multi-currency, parse/format
- [x] B2. `@mortar/context` — AsyncLocalStorage request context
- [x] B3. `@mortar/config` — zod env schema, fail-at-boot, typed access, redaction
- [ ] B4. `@mortar/observability` — structured logging bound to context, metrics, correlation

### Phase C — HTTP layer

- [ ] C1. `@mortar/http` — error taxonomy + problem-details
- [ ] C2. `@mortar/http` — exception filter, validation pipe, OpenAPI conventions
- [ ] C3. `@mortar/http` — health checks (db, redis, storage)
- [ ] C4. `@mortar/http` — context middleware wiring

### Phase D — Data-touching packages

- [ ] D1. `@mortar/audit` — append-only log, actor/action/entity/before-after, query helpers, retention
- [ ] D2. `@mortar/idempotency` — key decorator, store, replay semantics, conflict detection
- [ ] D3. `@mortar/tenancy` — resolution strategies, scoped repository, RLS helpers, cross-tenant guard
- [ ] D4. `@mortar/auth` — identity, password hashing, sessions, verification, reset, invitations, RBAC

### Phase E — Background work

- [ ] E1. `@mortar/jobs` — BullMQ conventions, typed jobs, idempotent handler wrapper
- [ ] E2. `@mortar/jobs` — retry/backoff, dead-letter, scheduled-job distributed lock
- [ ] E3. `@mortar/jobs` — **forward-window scanner base** (the pattern 10 of 17 projects need)

### Phase F — Release

- [ ] F1. Changesets or version policy, private registry publish config
- [ ] F2. Root README documenting install + usage per package
