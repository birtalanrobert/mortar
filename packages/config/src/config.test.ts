import { describe, expect, it, vi } from 'vitest';
import {
  ConfigValidationError,
  baseEnvSchema,
  describeConfig,
  envBoolean,
  envDuration,
  envEnum,
  envInt,
  envList,
  envPort,
  envSecret,
  envString,
  envUrl,
  isSecretKey,
  loadConfig,
  redactConfig,
  redactUrl,
  validateConfig,
  z,
} from './index';

describe('envBoolean', () => {
  const schema = z.object({ FLAG: envBoolean(false) });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['', false],
  ])('reads %s as %s', (input, expected) => {
    expect(loadConfig({ schema, source: { FLAG: input } }).FLAG).toBe(expected);
  });

  it('does not treat the string "false" as truthy — the classic Node config bug', () => {
    expect(loadConfig({ schema, source: { FLAG: 'false' } }).FLAG).toBe(false);
  });

  it('rejects a value that is not a boolean at all', () => {
    expect(() => loadConfig({ schema, source: { FLAG: 'maybe' } })).toThrow(ConfigValidationError);
  });

  it('applies the default when unset', () => {
    expect(loadConfig({ schema, source: {} }).FLAG).toBe(false);
  });
});

describe('envInt and envPort', () => {
  it('parses integers', () => {
    const schema = z.object({ N: envInt() });
    expect(loadConfig({ schema, source: { N: '42' } }).N).toBe(42);
  });

  it('rejects a non-numeric string rather than yielding NaN', () => {
    const schema = z.object({ N: envInt() });
    expect(() => loadConfig({ schema, source: { N: 'abc' } })).toThrow(ConfigValidationError);
  });

  it('rejects a float where an integer is required', () => {
    const schema = z.object({ N: envInt() });
    expect(() => loadConfig({ schema, source: { N: '1.5' } })).toThrow(ConfigValidationError);
  });

  it('bounds a port to the valid range', () => {
    const schema = z.object({ PORT: envPort(3000) });
    expect(loadConfig({ schema, source: { PORT: '3700' } }).PORT).toBe(3700);
    expect(() => loadConfig({ schema, source: { PORT: '70000' } })).toThrow();
    expect(() => loadConfig({ schema, source: { PORT: '0' } })).toThrow();
  });
});

describe('envDuration', () => {
  const schema = z.object({ TTL: envDuration(0) });

  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
    ['1000', 1000],
  ])('reads %s as %dms', (input, expected) => {
    expect(loadConfig({ schema, source: { TTL: input } }).TTL).toBe(expected);
  });

  it('rejects an unknown unit', () => {
    expect(() => loadConfig({ schema, source: { TTL: '5 weeks' } })).toThrow();
  });
});

describe('envList', () => {
  it('splits, trims and drops empties', () => {
    const schema = z.object({ ORIGINS: envList() });
    expect(loadConfig({ schema, source: { ORIGINS: 'a.com, b.com ,,c.com' } }).ORIGINS).toEqual([
      'a.com',
      'b.com',
      'c.com',
    ]);
  });
});

describe('envSecret', () => {
  it('rejects a short secret, because a short secret is not a secret', () => {
    const schema = z.object({ KEY: envSecret(32) });
    expect(() => loadConfig({ schema, source: { KEY: 'tooshort' } })).toThrow(
      ConfigValidationError,
    );
    expect(loadConfig({ schema, source: { KEY: 'x'.repeat(32) } }).KEY).toHaveLength(32);
  });
});

describe('loadConfig', () => {
  const schema = z.object({
    SERVICE_NAME: envString(),
    PORT: envPort(3000),
    DATABASE_URL: envUrl(),
    MODE: envEnum(['a', 'b'], 'a'),
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadConfig({ schema, source: { PORT: 'nope', DATABASE_URL: 'not-a-url' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigValidationError;
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect(err.issues.length).toBe(3);
      expect(err.issues.map((i) => i.path).sort()).toEqual([
        'DATABASE_URL',
        'PORT',
        'SERVICE_NAME',
      ]);
    }
  });

  it('names the offending variable in the message', () => {
    expect(() => loadConfig({ schema, source: {} })).toThrow(/SERVICE_NAME/);
  });

  it('returns a frozen object so configuration cannot drift at runtime', () => {
    const config = loadConfig({
      schema,
      source: { SERVICE_NAME: 'rota', DATABASE_URL: 'postgres://localhost:3710/rota' },
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('calls onLoaded with a redacted view', () => {
    const onLoaded = vi.fn();
    loadConfig({
      schema: z.object({ SERVICE_NAME: envString(), DB_PASSWORD: envString() }),
      source: { SERVICE_NAME: 'rota', DB_PASSWORD: 'supersecretvalue' },
      onLoaded,
    });
    expect(onLoaded).toHaveBeenCalledOnce();
    expect(onLoaded.mock.calls[0]?.[0]).toMatchObject({ SERVICE_NAME: 'rota' });
    expect(JSON.stringify(onLoaded.mock.calls[0]?.[0])).not.toContain('supersecretvalue');
  });
});

describe('validateConfig', () => {
  it('reports without throwing', () => {
    const result = validateConfig(z.object({ A: envString() }), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('A');
  });
});

describe('baseEnvSchema', () => {
  it('supplies sensible defaults', () => {
    const config = loadConfig({ schema: baseEnvSchema, source: { SERVICE_NAME: 'api' } });
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
  });
});

describe('redaction', () => {
  it('recognises secret-shaped key names', () => {
    for (const key of ['DB_PASSWORD', 'apiKey', 'JWT_SECRET', 'private_key', 'AUTH_TOKEN']) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ['PORT', 'SERVICE_NAME', 'LOG_LEVEL']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it('keeps a short prefix so two secrets are distinguishable in a log', () => {
    const out = redactConfig({ API_SECRET: 'abcdefghijklmnop' });
    expect(out.API_SECRET).toBe('abcd***op (16 chars)');
  });

  it('fully masks a short secret', () => {
    expect(redactConfig({ TOKEN: 'abc' }).TOKEN).toBe('***');
  });

  it('walks nested objects', () => {
    const out = redactConfig({ db: { host: 'localhost', password: 'longsecretvalue' } });
    expect(out.db).toMatchObject({ host: 'localhost' });
    expect(JSON.stringify(out)).not.toContain('longsecretvalue');
  });

  it('strips the password from a connection string', () => {
    expect(redactUrl('postgres://user:hunter2@localhost:3710/db')).toContain('***');
    expect(redactUrl('postgres://user:hunter2@localhost:3710/db')).not.toContain('hunter2');
  });

  it('does not leak a malformed URL', () => {
    expect(redactUrl('::::')).toBe('<invalid url>');
  });
});

describe('describeConfig', () => {
  it('renders an aligned, redacted boot banner', () => {
    const out = describeConfig({
      SERVICE_NAME: 'rota',
      PORT: 3700,
      DB_PASSWORD: 'longsecretvalue',
    });
    expect(out).toContain('SERVICE_NAME');
    expect(out).toContain('3700');
    expect(out).not.toContain('longsecretvalue');
  });
});
