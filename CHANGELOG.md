# Changelog

Each package carries its own version. A release publishes only the packages
whose version is not yet on the registry; `pnpm release` asks npm and skips the
rest.

## observability 1.0.1

Never published. An interrupted publish left `1.0.0` partially staged and npm
rejected a retry, so the version was stepped over — and then the staged upload
finalised on npm's side after all. `1.0.0` is the real release; `1.0.1` does
not exist.

## observability 1.1.0, jobs 1.1.0

Everything a worker needs to be observable. Found by building `starter-worker`,
whose specification asks for queue depth, job duration, failure rate and
scanner lag — none of which anything recorded.

### Added

- **`JobWorkers` records `job_duration_ms`, `jobs_total` (labelled by outcome)
  and `jobs_dead_lettered_total`.** In the runner rather than in each handler:
  how many ran, how many failed and how long they took are properties of the
  runner and identical in every service. One counter with a `status` label
  rather than two counters, because failure rate is a ratio and both halves
  must share their labels. Defaults to a no-op registry.

- **`WindowScanner` records `scanner_scan_duration_ms`, `scanner_items_total`
  and `scanner_last_success_timestamp_ms`.** The last is the one worth alerting
  on: a scanner that has stopped logs nothing and errors nothing, it simply
  stops finding work, and the first anyone hears is a customer asking why they
  were never reminded. A timestamp rather than an age, because a gauge written
  only on success cannot grow while the scanner is dead.

- **`JobQueues` rejects a job id containing `:`**, naming the job and the id.
  BullMQ uses the colon as a key separator and refuses such an id with an error
  that mentions neither — and `` `reminder:${id}` `` is the natural thing to
  write, so that error is reached often and explains nothing.

- **`JobsModule` passes the container's metrics registry** to the worker
  registry, so this costs a consumer nothing to switch on.

- **`InMemoryMetrics.snapshot()`**, returning every series held. A `/metrics`
  endpoint has to enumerate what exists, and `value()` could only answer about
  a name the caller already knew. Histograms report count, sum, min and max;
  bucketing is a presentation decision belonging to whatever scrapes it.

### Fixed

- **Histogram labels are stored beside their observations** rather than
  recovered by parsing the storage key. A label value containing `=` or `,`
  would not have survived the round trip.

## 1.0.0

The version numbers become meaningful.

Until now every package shared one version and all twelve were republished
together. That does not survive contact with per-package releases while the
major is `0`: under semver a `^0.2.0` range excludes `0.3.0`, so changing one
package and releasing only it leaves every dependent pinned to the old copy —
and npm resolves that by installing both. Two copies of `observability` means
two distinct `MORTAR_LOGGER` symbols, and dependency injection stops working
with an error that names neither.

At `1.x` a caret range accepts later minors, so a package can be released on
its own and its dependents pick it up on their next install. From here:

- **patch** — a fix that changes no signature
- **minor** — anything added
- **major** — anything removed or changed in shape

### Added

- **`DatabaseModule` can run migrations at boot** — `migrationsRun: true`.

  Guarded by a Postgres advisory lock, so several replicas starting at once are
  safe: one applies while the others wait, then find nothing pending. TypeORM
  takes no lock of its own, and without one the second replica to reach a
  `CREATE TABLE` fails and that container crash-loops. Also exported directly
  as `runMigrationsWithLock` for release-step scripts.

- **`LoggerModule` provides `NestLoggerAdapter` and `LoggingInterceptor`.**
  Both were exported but never registered, so `app.get(NestLoggerAdapter)` and
  `{ provide: APP_INTERCEPTOR, useExisting: LoggingInterceptor }` — the two
  documented ways to use them — both failed. Constructing them by hand still
  works.

- **`PUBLIC_ROUTE_KEY` and `PublicRoute()` in `@birtalanrobert/http`**, and the
  health controller now carries them. `@birtalanrobert/auth` re-exports the key
  as `PUBLIC_KEY`, unchanged, so `PermissionsGuard` and `@Public()` behave
  exactly as before — but a globally registered guard no longer 401s the
  readiness probe, which previously left pods that never joined the load
  balancer.

- **`auditEntities` and `idempotencyEntities`**, so every package that ships
  entities exports them as an array the same way it exports its migrations.

### Fixed

- **A circular import between `logger.module.ts` and the two classes it now
  provides** left `MORTAR_LOGGER` `undefined` at decorator evaluation time, so
  `@Inject(MORTAR_LOGGER)` silently degraded to reflected-type injection and
  Nest reported that it could not resolve `Function`. The tokens moved to a
  leaf module. Under CommonJS this class of bug fails at wiring time, never at
  build time.

### Testing

`@nestjs/testing` and `unplugin-swc` are now dev dependencies, and the Nest
modules are exercised by building a real container rather than by inspecting
the `DynamicModule` object. Every defect above was invisible to a test that
asserts on `module.providers` and obvious to one that calls `moduleRef.get()`.

## 0.2.0

Composing the packages into a real application surfaced three problems that
package-level tests could not.

### Added

- **`forRootAsync` on every configurable module** — `LoggerModule`,
  `DatabaseModule`, `RedisModule`, `HttpModule`, `TenancyModule`, `AuthModule`,
  `IdempotencyModule` and `JobsModule`.

  Previously each module took its options synchronously, which meant a consumer
  had to read `process.env` at import time — before anything had validated it —
  to configure a database URL or a Redis connection. That defeats having a
  configuration layer at all. Options can now come from any provider, including
  the validated config.

- **`ConfigModule.token()`**, so a wiring site can write
  `inject: [ConfigModule.token()]` rather than importing the raw symbol.

- **`AsyncModuleOptions<T>`** in `@birtalanrobert/context`: the shared shape for
  the above.

### Fixed

- **`HttpModule` and `TenancyModule` no longer hold module options in static
  fields.** Both middlewares now receive their options through dependency
  injection. The previous arrangement meant a second `forRoot()` call silently
  overwrote the first — which is exactly what happens when a test suite builds
  more than one application in a process.

- **`@birtalanrobert/http` accepts `class-validator` 0.15**, which is current.
  The peer range previously stopped at 0.14 and produced an unmet-peer warning
  on every install.

- **Internal dependencies publish as `^x.y.z` rather than an exact pin.** Exact
  pins across a family released together make npm install several copies of the
  same package as soon as two versions coexist in one tree.

### Note on compatibility

`HttpModule.contextOptions` and `TenancyModule.resolvers` are no longer present
as static properties. They were declared `private` and were never part of the
documented surface — TypeScript consumers could not reach them — but a
JavaScript consumer reading them would break. Nothing else changed shape.

## 0.1.0

First release.
