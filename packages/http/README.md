# @birtalanrobert/http

Error taxonomy, RFC 9457 Problem Details, request context and health checks.

## Two entry points

**`@birtalanrobert/http`** is framework-free. Error classes, problem
serialisation, header names, locale negotiation and the health registry —
nothing here imports `@nestjs/common`, so a Next.js route handler, an edge
function or a job runner raises the same errors and produces the same problem
documents as the API without installing a framework to do it.

**`@birtalanrobert/http/nestjs`** is the wiring: the module, the exception
filter, the context middleware, the validation pipe, the health controller and
`@PublicRoute()`.

> **Moved in 2.0.0.** These were previously exported from the root, which meant
> importing `NotFoundError` pulled NestJS into an edge bundle. Anything in the
> second list now comes from `@birtalanrobert/http/nestjs` instead of
> `@birtalanrobert/http`; the error classes stay exactly where they were, so
> most files need no change at all.

## The error taxonomy is framework-free

`MortarError` and its subclasses import nothing from NestJS. Domain modules,
workers, CLI tools and tests all throw them; only the HTTP layer knows how to
turn one into a response. A domain module that had to import `@nestjs/common`
to say "not found" would be coupled to a web framework for no reason.

```ts
import { NotFoundError, ConflictError } from '@birtalanrobert/http';

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

`/health/live` answers _is this process running_ and touches nothing. A
liveness probe that checks the database restarts the service every time the
database hiccups — turning a brief blip into a restart loop across every
replica at once.

`/health/ready` answers _can this process serve traffic_ and does check
dependencies. Non-critical indicators report `degraded` rather than `down`, so
an unreachable metrics sink does not remove the instance from rotation.

Per-indicator timeouts are enforced by the registry, not trusted to the
indicator: the failure this endpoint most needs to survive is a dependency that
hangs, not one that errors.

## Using it in a NestJS application

```ts
import { HttpModule, createValidationPipe } from '@birtalanrobert/http/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot({ schema: envSchema }),
    LoggerModule.forRootAsync({/* … */}),
    DatabaseModule.forRootAsync({/* … */}),

    HttpModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({
        context: {
          // Only behind a proxy that overwrites the header. Trusting it while
          // directly exposed lets any client claim any address, which defeats
          // both rate limiting and the audit trail.
          trustProxy: config.NODE_ENV === 'production',
          supportedLocales: ['ro', 'hu', 'en'],
        },
        errors: { baseUri: config.PROBLEM_BASE_URI },
        health: { detailed: config.HEALTH_DETAILED },
      }),
    }),
  ],
})
export class AppModule {}
```

`@Global()`. Register it **early** — before anything that raises an error worth
serialising, and before any module whose middleware expects a request context to
already be open. It applies `ContextMiddleware` and registers
`MortarExceptionFilter` itself; neither needs adding to `APP_FILTER` by hand.

In `bootstrap.ts`:

```ts
app.useGlobalPipes(createValidationPipe());
```

The pipe turns class-validator failures into the same problem document as
everything else — without it, a validation failure from the framework looks
completely different from one raised by application code, and every client needs
two error handlers.

### Health indicators

```ts
import { HEALTH_REGISTRY } from '@birtalanrobert/http/nestjs';
import { HealthRegistry, createIndicator } from '@birtalanrobert/http';

constructor(@Inject(HEALTH_REGISTRY) registry: HealthRegistry) {
  registry.add(createIndicator('database', () => dataSource.query('SELECT 1')));
}
```

`/health/live` says the process is up; `/health/ready` says it can serve. They
are different endpoints because a failing readiness check should stop traffic,
while a failing liveness check restarts the pod — and answering one with the
other produces a restart loop under load.

## Using it outside NestJS

```ts
import { NotFoundError, toProblemDetails, negotiateLocale } from '@birtalanrobert/http';

try {
  // …
} catch (error) {
  const problem = toProblemDetails(error, { baseUri, requestId });
  return Response.json(problem, { status: problem.status });
}
```

`toProblemDetails` is total: a `MortarError`, a Nest `HttpException`, a plain
`Error` or a thrown string all become the same document.
