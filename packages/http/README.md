# @mortar/http

Error taxonomy, RFC 9457 Problem Details, request context and health checks.

## The error taxonomy is framework-free

`MortarError` and its subclasses import nothing from NestJS. Domain modules,
workers, CLI tools and tests all throw them; only the HTTP layer knows how to
turn one into a response. A domain module that had to import `@nestjs/common`
to say "not found" would be coupled to a web framework for no reason.

```ts
import { NotFoundError, ConflictError } from '@mortar/http';

throw new NotFoundError('Booking', bookingId);
throw new ConflictError('That seat has already been sold.');
```

## One response shape for every failure

Every error — thrown by application code, by the framework, or by accident —
comes out as the same problem document:

```json
{
  "type": "https://problems.mortar.dev/conflict",
  "title": "Conflict",
  "status": 409,
  "code": "conflict",
  "detail": "That seat has already been sold.",
  "instance": "/events/42/seats",
  "requestId": "b1f0…"
}
```

Clients branch on **`code`**, not on `title` (prose, may be reworded or
translated) and not on `status` (too coarse to distinguish "seat already sold"
from "booking window closed").

## Two guarantees the filter never breaks

1. **The response is always a valid problem document** — whatever was thrown.
   An error handler that can itself fail is not an error handler.
2. **A 5xx never carries internal detail.** An unexpected error's message
   routinely contains a SQL fragment, a file path or a connection string. In
   production the client gets a generic message and a `requestId`; the detail
   lives in the logs.

## Logging levels are deliberate

- **5xx** → `error`, with the exception attached. It is ours.
- **`cross_tenant_access`** → `warn`. In a multi-tenant system this is either a
  serious bug or an attack, and somebody should find out today.
- **Other 4xx** → `debug`. A wall of 404 warnings trains everyone to ignore
  warnings, which is how a real one gets missed.

## Liveness and readiness are not the same endpoint

`/health/live` answers *is this process running* and touches nothing. A
liveness probe that checks the database restarts the service every time the
database hiccups — turning a brief blip into a restart loop across every
replica at once.

`/health/ready` answers *can this process serve traffic* and does check
dependencies. Non-critical indicators report `degraded` rather than `down`, so
an unreachable metrics sink does not remove the instance from rotation.

Per-indicator timeouts are enforced by the registry, not trusted to the
indicator: the failure this endpoint most needs to survive is a dependency that
hangs, not one that errors.

## Usage

```ts
HttpModule.forRoot({
  context: { trustProxy: true, supportedLocales: ['ro', 'hu', 'en'] },
  errors: { baseUri: 'https://errors.acme.com' },
  health: { indicators: [databaseIndicator], detailed: false },
});

app.useGlobalPipes(createValidationPipe());
```
