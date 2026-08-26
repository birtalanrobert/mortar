# Changelog

All packages share a version and are released together.

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
