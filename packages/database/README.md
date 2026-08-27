# @birtalanrobert/database

The TypeORM data source, transactions with savepoints, and migrations that are
safe to run from several replicas at once.

## Using it in a NestJS application

```ts
import { DatabaseModule } from '@birtalanrobert/database';
import { entities, migrations } from './database/entities';

@Module({
  imports: [
    ConfigModule.forRoot({ schema: envSchema }),
    LoggerModule.forRootAsync({/* … */}),

    DatabaseModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({
        url: config.DATABASE_URL,
        entities,
        migrations,
        poolSize: config.DATABASE_POOL_SIZE,
        statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT,
        ssl: config.DATABASE_SSL,
        applicationName: config.SERVICE_NAME,
        migrationsRun: true,
        assertMigrations: true,
      }),
    }),
  ],
})
export class AppModule {}
```

Register it **after** the logger and **before** anything that queries. The
module is `@Global()`; there is no `forFeature`, because entities are declared
once in the options rather than per feature module.

### `entities` and `migrations`

Assemble both in one file that the application and the migration CLI both
import, so the two cannot disagree:

```ts
export const entities = [...authEntities, ...auditEntities, Tenant, Request];
export const migrations = [...authMigrations, ...auditMigrations, CreateFoundations1787757482317];
```

### `migrationsRun` and `assertMigrations`

`migrationsRun: true` applies pending migrations at boot, guarded by a Postgres
advisory lock inside the package — several replicas starting together are safe:
one applies, the rest wait and then find nothing pending.

`assertMigrations: true` refuses to serve traffic if anything is still pending
afterwards. It only ever fires when a run silently applied nothing, which is
exactly the failure that is otherwise invisible.

If a migration is slow enough that it holds up a rollout, turn `migrationsRun`
off and run it as a release step instead.

## Injecting the data source

```ts
import { InjectDataSource } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';

@Injectable()
export class Thing {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}
}
```

## Transactions

```ts
import { runInTransaction, resolveManager } from '@birtalanrobert/database';

await runInTransaction(dataSource, async (manager) => {
  await manager.save(thing);
  await other.doWork(manager); // same transaction, passed explicitly
});
```

Nesting uses **savepoints** rather than a second transaction, so an inner
failure rolls back only the inner work and the outer transaction decides what
to do about it.

`resolveManager(dataSource)` returns the ambient transaction's manager if one is
open and the plain manager otherwise — which is how a service method works both
standalone and as part of a larger transaction without two code paths.

`independent: true` forces a separate transaction, for work that must survive
the outer one rolling back — recording that an external call was attempted, for
instance.

**In a multi-tenant application use `runInTenantTransaction` from
`@birtalanrobert/tenancy` instead.** It does everything this does and binds the
tenant for row-level security; an unbound read on a protected table returns
nothing at all.

## Testing

`createTestDataSource(entities, { migrations })` builds a data source against
the Docker Postgres, applying the real migrations rather than `synchronize` —
indexes, partial indexes and check constraints are usually the part worth
testing, and `synchronize` skips half of them.

## Base entity and column helpers

`BaseEntity` gives `id`, `createdAt` and `updatedAt`. `JSON_COLUMN` and
`TIMESTAMP_COLUMN` are spread into `@Column({ ... })` so that a `jsonb` column
or a `timestamptz` is declared the same way everywhere.
