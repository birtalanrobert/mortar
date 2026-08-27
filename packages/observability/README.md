# @birtalanrobert/observability

Structured logging and metrics.

## Using it in a NestJS application

`LoggerModule.forRootAsync`, registered **second** — after `ConfigModule`, so
its options are validated, and before everything else, so anything that logs
during its own construction has somewhere to log to.

```ts
import { LoggerModule } from '@birtalanrobert/observability/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot({ schema: envSchema }),

    LoggerModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({
        serviceName: config.SERVICE_NAME,
        level: config.LOG_LEVEL,
        // Human-readable locally; one JSON object per line everywhere else,
        // because that is what a log shipper can parse.
        pretty: config.NODE_ENV === 'development',
        // With a fleet, "which of these eight replicas is stuck" is the first
        // question, and without this the logs cannot answer it.
        base: config.INSTANCE_ID ? { instance: config.INSTANCE_ID } : undefined,
      }),
    }),
  ],
})
export class AppModule {}
```

The module is `@Global()`, so one registration covers the application.

## Injecting a logger

```ts
import { InjectLogger } from '@birtalanrobert/observability/nestjs';
import type { Logger } from '@birtalanrobert/observability';

@Injectable()
export class Thing {
  constructor(@InjectLogger() private readonly logger: Logger) {}

  work() {
    // Fields, not interpolation: a message you can search by field survives
    // being read by a machine.
    this.logger.info('Sent request', { requestId, parties: 3 });
  }
}
```

`InjectMetrics()` and `Metrics` work the same way.

## Replacing Nest's own logger

`NestLoggerAdapter` makes the framework's boot output go through the same
pipeline, so a deployment produces one log format rather than two:

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(app.get(NestLoggerAdapter));
```

`bufferLogs` matters — without it, everything Nest prints before the adapter is
resolved escapes in the default format.

## Request logging

`LoggingInterceptor` records method, route, status and duration for every
request. Register it once, globally:

```ts
providers: [{ provide: APP_INTERCEPTOR, useClass: LoggingInterceptor }];
```

## Outside NestJS

The root entry is framework-free, so a worker or a script builds a logger
directly:

```ts
import { createLogger } from '@birtalanrobert/observability';

const logger = createLogger({ serviceName: 'importer', level: 'info' });
```

## Metrics

An in-process registry with counters, gauges and histograms, exposed in
Prometheus text format:

```ts
metrics.increment('jobs_total', { status: 'failed' });
metrics.observe('job_duration_ms', elapsed, { queue: 'notifications' });

// GET /metrics
return metrics.toPrometheus();
```

Labels are stored beside the observation rather than parsed back out of a key,
because parsing a key back into labels breaks the first time a label value
contains the separator.
