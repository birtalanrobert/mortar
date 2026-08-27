# @birtalanrobert/context

The ambient request context: who is asking, which tenant, which request.

## What it is

An `AsyncLocalStorage` store carried automatically through every `await` in a
request, so that a service five layers down can know the actor and the tenant
without either being threaded through five signatures that do not otherwise
care about them.

That threading is not merely tedious — it is the thing that gets skipped, and a
tenant id skipped once is a query that reads another customer's rows.

## Using it in a NestJS application

**There is no module to import.** The store is opened by
`@birtalanrobert/http`'s `ContextMiddleware`, which `HttpModule` applies for
you, so an API gets this by importing `HttpModule` and nothing else.

```ts
import { HttpModule } from '@birtalanrobert/http/nestjs';

@Module({ imports: [HttpModule.forRoot({})] })
export class AppModule {}
```

Then, anywhere below it:

```ts
import { getActor, getTenantId, requireTenantId, getRequestId } from '@birtalanrobert/context';

const tenantId = requireTenantId(); // throws if unset, which is the point
const actor = getActor(); // undefined on an unauthenticated route
```

`requireTenantId` throws rather than returning `undefined`, because a query
built with an absent tenant is a query that quietly returns nothing — or, with
row-level security switched off, everything.

## Outside a request

A worker, a scheduled task or a script has no middleware to open a store, so it
opens one itself:

```ts
import { runWithContext } from '@birtalanrobert/context';

await runWithContext({ tenantId, actor: { id: 'worker', type: 'system' } }, async () => {
  // everything in here sees the same ambient context an HTTP request would
});
```

This is how a job that acts on behalf of a tenant gets the same row-level
security behaviour as the request that enqueued it.

## What it does not do

It does not bind the tenant to a database connection. That is
`runInTenantTransaction` in `@birtalanrobert/tenancy`, and the distinction
matters: resolving a tenant into ambient context tells _the application_ who is
asking, while binding tells _Postgres_ — and an unbound read on a table with
row-level security returns nothing at all.

## No dependencies

Nothing here imports a framework or a driver. It is used by the API, the worker
and the shared packages alike, and anything framework-shaped would break at
least one of them.
