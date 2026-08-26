# mortar

Backend plumbing for NestJS services, as twelve small packages.

Multi-tenant SaaS backends need the same things every time: money that does not
drift, a request context that reaches the logger, an audit trail that cannot lie,
tenant isolation that fails closed, background work that survives the world
changing underneath it. Mortar is those things, written once and tested
properly, so they are not rewritten badly on each new service.

**Plumbing only.** There is no domain model here, no opinion about what a
customer or an order is, and nothing that expects your application to be shaped
a particular way.

## Packages

Every package is versioned and installed independently. Take one or take all
twelve.

| Package                                                   | What it does                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`@birtalanrobert/money`](packages/money)                 | Integer minor-unit money, allocation that never loses a cent, net/gross tax, locale parsing and formatting |
| [`@birtalanrobert/context`](packages/context)             | `AsyncLocalStorage` request context: request id, correlation id, tenant, actor, locale                     |
| [`@birtalanrobert/config`](packages/config)               | Environment validation that fails at boot and reports every problem at once, with secret redaction         |
| [`@birtalanrobert/observability`](packages/observability) | Structured logging bound to the request context, metrics, correlation                                      |
| [`@birtalanrobert/http`](packages/http)                   | Error taxonomy, RFC 9457 problem details, exception filter, health checks, locale negotiation              |
| [`@birtalanrobert/database`](packages/database)           | TypeORM `DataSource` conventions and a **transactional context** every other package writes through        |
| [`@birtalanrobert/redis`](packages/redis)                 | Connections, distributed locks, tagged cache, sliding-window rate limiting                                 |
| [`@birtalanrobert/tenancy`](packages/tenancy)             | Tenant resolution, scoped repositories, PostgreSQL row-level security                                      |
| [`@birtalanrobert/auth`](packages/auth)                   | Identity, scrypt passwords, opaque sessions, single-use tokens, roles and permissions                      |
| [`@birtalanrobert/audit`](packages/audit)                 | Append-only audit log, enforced by a database trigger                                                      |
| [`@birtalanrobert/idempotency`](packages/idempotency)     | Idempotency keys for mutating endpoints                                                                    |
| [`@birtalanrobert/jobs`](packages/jobs)                   | BullMQ conventions, context propagation, and a forward-window scanner                                      |

```bash
npm install @birtalanrobert/money @birtalanrobert/http
```

Each package's README explains **why** it is built the way it is; the API is
discoverable from the types.

## The idea worth understanding first

`@birtalanrobert/database` carries the active TypeORM `EntityManager` in the
request context. Every other package resolves through it, so an audit record, an
idempotency key or a row-level-security binding **joins the transaction the
caller already has open**.

```ts
await runInTransaction(dataSource, async () => {
  await orders.save(order);
  await audit.record({ action: 'order.cancelled', before, after });
});
// Both commit, or neither does.
```

Without that, a package holding its own connection pool would write an audit row
for a change that then rolled back — a confident record of something that never
happened. It is the reason the packages compose rather than merely coexist.

## Some things that are deliberate

- **Money is never a float.** Not at any point, in any package.
- **Tenant scoping fails closed.** An unscoped query throws rather than quietly
  returning every tenant's rows, and row-level security is the second line
  behind it. `assertRlsEffective()` exists because RLS is silently inert when
  the connecting role is a superuser.
- **The audit log is append-only in the database**, not merely by convention. A
  trail that can be edited is worth less than one that cannot.
- **Sessions are opaque, not JWTs**, because revoking access immediately matters
  more than avoiding a lookup.
- **Background work scans a forward window** rather than scheduling one job per
  item. A per-item job still fires for something cancelled or rescheduled after
  it was scheduled; a scan reads current state and simply does not find it.
- **Every package has a framework-free core** and, where useful, a thin NestJS
  layer over it. The service is a wrapper, never a reimplementation, so the same
  logic runs in workers, CLI tools and tests.

## Development

Requires Node 20+, pnpm and Docker.

```bash
pnpm install
pnpm db:up              # PostgreSQL and Redis, for integration tests
pnpm test               # unit only — fast, runs anywhere
pnpm test:integration   # needs the Docker stack
pnpm typecheck && pnpm lint && pnpm build
```

Integration tests run against a real PostgreSQL and a real Redis, never mocks,
and they execute the real migrations rather than `synchronize` — which silently
skips triggers, constraints and grants.

## Licence

**AGPL-3.0-only.** Read it, learn from it, use it. If you build a hosted service
on it, that service's source must be released under the AGPL too.

The AGPL is a grant from the copyright holder to everyone else; the copyright
holder is not a licensee of their own work. See [`NOTICE`](NOTICE).

Commercial licences are available for anyone who cannot comply with the AGPL.

**Contributions are not accepted.** A contributor keeps copyright in their
contribution unless they assign it, and a project no longer wholly owned by one
copyright holder cannot be relicensed by that holder. Should that change, a CLA
would be a prerequisite rather than a formality.
