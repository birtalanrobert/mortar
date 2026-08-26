import { Global, Inject, Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { z } from 'zod';
import { loadConfig } from '../load';

/** Injection token for the validated, frozen configuration object. */
export const MORTAR_CONFIG = Symbol('MORTAR_CONFIG');

/**
 * Injects the validated configuration.
 *
 *   constructor(@InjectConfig() private readonly config: AppConfig) {}
 *
 * The injected value is the schema's inferred type, so `config.PORT` is a
 * number and a typo is a compile error rather than an undefined at runtime.
 */
export const InjectConfig = () => Inject(MORTAR_CONFIG);

export interface ConfigModuleOptions<T extends z.ZodTypeAny> {
  /** The schema the environment must satisfy. */
  schema: T;
  /** Source of values. Defaults to `process.env`. */
  source?: Record<string, string | undefined>;
  /**
   * Log the resolved configuration (redacted) at boot. Defaults to true —
   * most "it works on my machine" incidents are visible in this output, and it
   * is only safe because every secret is redacted on the way out.
   */
  logOnBoot?: boolean;
  /** Where the boot banner goes. Defaults to `console.log`. */
  logger?: (message: string) => void;
}

/**
 * Validates the environment **at module construction**, which is before the
 * application starts listening.
 *
 * A misconfigured deployment therefore fails immediately and loudly, rather
 * than at first use — halfway through a payment, or in a worker at three in
 * the morning.
 */
@Global()
@Module({})
export class ConfigModule {
  /**
   * The injection token, for `inject:` arrays.
   *
   * `ConfigModule.token()` reads better at a wiring site than importing
   * `MORTAR_CONFIG` separately, and it keeps the token's identity in one place
   * should it ever need to change.
   */
  static token(): symbol {
    return MORTAR_CONFIG;
  }

  static forRoot<T extends z.ZodTypeAny>(options: ConfigModuleOptions<T>): DynamicModule {
    const { schema, source, logOnBoot = true, logger = console.log } = options;

    // Deliberately eager: this throws during module construction, not on first
    // injection, so the process exits before it can accept traffic.
    const config = loadConfig({
      schema,
      source,
      onLoaded: logOnBoot
        ? (redacted) => {
            const width = Math.max(...Object.keys(redacted).map((k) => k.length));
            const lines = Object.entries(redacted)
              .map(([key, value]) => `  ${key.padEnd(width)}  ${format(value)}`)
              .join('\n');
            logger(`Configuration:\n${lines}`);
          }
        : undefined,
    });

    const provider: Provider = { provide: MORTAR_CONFIG, useValue: config };

    return {
      module: ConfigModule,
      providers: [provider],
      exports: [provider],
    };
  }
}

function format(value: unknown): string {
  if (value === undefined) return '<unset>';
  if (value === null) return '<null>';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '<empty>';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
