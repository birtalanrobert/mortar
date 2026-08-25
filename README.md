# mortar

The common library behind the seventeen projects in `../specs`. Mortar is what
binds the bricks: plumbing that every project needs, written once, so that no
project spends its first fortnight rebuilding tenancy scoping, money arithmetic
or SMS segment counting.

## What belongs here, and what does not

Mortar owns **plumbing**. It does not own domain logic.

The governing rule from the foundations specification: _extract only what is
genuinely identical across several projects, stable enough not to churn, and
expensive enough to rewrite that sharing pays._ A shared library that tries to
own domain logic becomes a bottleneck every project has to fight.

The corollary rule, which keeps this honest: **extract at the second consumer,
not the first.** Writing a shared package for a single consumer is guessing at
an interface. The only exceptions are the Tier 1 packages and `@mortar/billing`,
where all seventeen consumers are known in advance.

## Packages

### Tier 1 — every project

| Package                 | Status | Purpose                                               |
| ----------------------- | ------ | ----------------------------------------------------- |
| `@mortar/money`         | ✅     | Integer minor-unit money, allocation, tax, formatting |
| `@mortar/context`       | ✅     | AsyncLocalStorage request context                     |
| `@mortar/config`        | ✅     | Environment schema with fail-at-boot semantics        |
| `@mortar/observability` | ⬜     | Structured logging, metrics, correlation              |
| `@mortar/http`          | ⬜     | Error taxonomy, problem-details, filters, health      |
| `@mortar/audit`         | ⬜     | Append-only audit log                                 |
| `@mortar/idempotency`   | ⬜     | Idempotency keys for mutating endpoints               |
| `@mortar/tenancy`       | ⬜     | Tenant resolution, scoped repositories, RLS helpers   |
| `@mortar/auth`          | ⬜     | Identity, sessions, verification, invitations, RBAC   |
| `@mortar/jobs`          | ⬜     | BullMQ conventions, forward-window scanner            |

Tiers 2–4 are listed in `../specs/00-shared-foundations.md` and are extracted
incrementally, at the second consumer.

## Extending mortar's entities from a project

Every mortar entity ships as an **abstract base plus a concrete default**. A
project needing extra columns or relations declares its own class extending the
base, mapping the same table, and registers it:

```ts
@Entity({ name: 'mortar_user' })
export class User extends BaseUser {
  @Column({ nullable: true }) phoneNumber!: string | null;
  @OneToMany(() => Shift, (s) => s.user) shifts?: Shift[];
}

AuthModule.forRoot({ entities: { user: User } });
```

Mortar's services then operate on the project's class. A profile table and a
unidirectional `@ManyToOne` remain available for cases that suit them better.

Two mistakes are caught at boot rather than surfacing later: registering both
your subclass and mortar's default (two entities, one table), and renaming the
subclass (mortar's entities reference each other by class name).

See `packages/auth/README.md`.

## Conventions

- **TypeScript → CommonJS.** The NestJS ecosystem is CJS and decorators depend
  on `emitDecoratorMetadata`.
- **`tsc` per package**, not a bundler. Libraries need clean `.d.ts` output.
- **No ORM.** Mortar owns only infrastructural tables (sessions, audit,
  idempotency) and reaches them through `pg` directly. Forcing TypeORM, Prisma
  or Drizzle on seventeen projects is exactly the bottleneck to avoid. Projects
  choose their own ORM for domain models; mortar ships SQL migrations for its
  own tables.
- **NestJS is a peer dependency**, and only in the packages that genuinely need
  it. `money`, `context`, `config` and `observability` stay framework-free.

## Working on it

```bash
pnpm install
pnpm test          # vitest, all packages
pnpm typecheck
pnpm lint
pnpm build

node scripts/new-package.mjs <name> "<description>"
```

See `TODO.md` for the implementation plan and current state.
