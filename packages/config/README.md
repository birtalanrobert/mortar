# @birtalanrobert/config

Environment validation with fail-at-boot semantics.

## Using it in a NestJS application

`ConfigModule.forRoot` — synchronous, and **first in the imports array**.
Nothing else can be configured until the environment has been validated, and
every other module below reads its options from this one.

```ts
import { z } from 'zod';
import { ConfigModule } from '@birtalanrobert/config/nestjs';
import { envString, envInt, envBoolean, envDuration } from '@birtalanrobert/config';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: envString('my-api'),
  PORT: envInt(3000),
  DATABASE_URL: envString(),
  SESSION_TTL: envDuration(30 * 24 * 60 * 60 * 1000), // accepts "30d"
  FEATURE_X: envBoolean(false),
});

export type AppConfig = z.infer<typeof envSchema>;

@Module({
  imports: [
    ConfigModule.forRoot({
      schema: envSchema,
      // Prints the resolved configuration once at boot, secrets redacted.
      logOnBoot: true,
    }),
  ],
})
export class AppModule {}
```

There is no `forRootAsync`, deliberately: an asynchronous factory would need
something to inject, and this is the thing everything else injects.

The module is `@Global()`, so one registration covers the whole application.

## Reading the configuration

Inject the validated object with `ConfigModule.token()`:

```ts
DatabaseModule.forRootAsync({
  inject: [ConfigModule.token()],
  useFactory: (config: AppConfig) => ({ url: config.DATABASE_URL }),
});
```

Or in a provider:

```ts
import { InjectConfig } from '@birtalanrobert/config/nestjs';

@Injectable()
export class Thing {
  constructor(@InjectConfig() private readonly config: AppConfig) {}
}
```

**Never read `process.env` after this point.** A value read straight from the
environment is one that nothing validated, nothing defaulted and no test can
override — and the failure is at the moment it is used rather than at boot.

## Outside NestJS

The root entry has no framework dependency, so a worker, a script or a Next.js
server reads the same schema the same way:

```ts
import { loadConfig } from '@birtalanrobert/config';

const config = loadConfig(envSchema);
```

## Why fail at boot

A missing or malformed variable stops the process with a message naming every
problem at once, rather than the first. The alternative is `undefined` reaching
a database driver at three in the morning, where the error names neither the
variable nor the service.

## The helpers

`envString`, `envInt`, `envBoolean`, `envDuration`, `envList` exist because
everything in an environment is a string. `envDuration` accepts `30d`, `12h`,
`500ms` or a plain number of milliseconds — a TTL written as `2592000000` is a
TTL nobody can check by eye.
