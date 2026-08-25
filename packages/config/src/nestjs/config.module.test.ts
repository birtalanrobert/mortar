import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ConfigValidationError } from '../errors';
import { envPort, envString } from '../schema';
import { ConfigModule, MORTAR_CONFIG } from './config.module';

const schema = z.object({
  SERVICE_NAME: envString(),
  PORT: envPort(3000),
  DB_PASSWORD: envString('local'),
});

describe('ConfigModule.forRoot', () => {
  it('provides the validated config under the token', () => {
    const module = ConfigModule.forRoot({
      schema,
      source: { SERVICE_NAME: 'rota', PORT: '3700' },
      logOnBoot: false,
    });

    const provider = module.providers?.[0] as { provide: symbol; useValue: unknown };
    expect(provider.provide).toBe(MORTAR_CONFIG);
    expect(provider.useValue).toMatchObject({ SERVICE_NAME: 'rota', PORT: 3700 });
  });

  it('exports the token so other modules can inject it', () => {
    const module = ConfigModule.forRoot({
      schema,
      source: { SERVICE_NAME: 'rota' },
      logOnBoot: false,
    });
    expect(module.exports).toHaveLength(1);
  });

  it('throws at module construction, before the app can accept traffic', () => {
    expect(() =>
      ConfigModule.forRoot({ schema, source: { PORT: 'not-a-port' }, logOnBoot: false }),
    ).toThrow(ConfigValidationError);
  });

  it('logs a redacted boot banner without leaking secrets', () => {
    const logger = vi.fn();
    ConfigModule.forRoot({
      schema,
      source: { SERVICE_NAME: 'rota', DB_PASSWORD: 'averylongsecretvalue' },
      logger,
    });
    const output = logger.mock.calls[0]?.[0] as string;
    expect(output).toContain('SERVICE_NAME');
    expect(output).not.toContain('averylongsecretvalue');
  });

  it('can be silenced', () => {
    const logger = vi.fn();
    ConfigModule.forRoot({ schema, source: { SERVICE_NAME: 'x' }, logOnBoot: false, logger });
    expect(logger).not.toHaveBeenCalled();
  });
});
