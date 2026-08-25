import { afterEach, describe, expect, it } from 'vitest';
import { buildDataSourceOptions } from './data-source';
import { SnakeCaseNamingStrategy } from './naming';

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('buildDataSourceOptions', () => {
  const url = 'postgres://user:pass@localhost:3710/app';

  it('targets postgres with the snake_case naming strategy', () => {
    const options = buildDataSourceOptions({ url });
    expect(options.type).toBe('postgres');
    expect(options.namingStrategy).toBeInstanceOf(SnakeCaseNamingStrategy);
  });

  it('never runs migrations on boot', () => {
    // A deploy that half-migrates across replicas is far worse than one that
    // fails visibly at the migrate step.
    expect(buildDataSourceOptions({ url }).migrationsRun).toBe(false);
  });

  it('defaults synchronize off', () => {
    expect(buildDataSourceOptions({ url }).synchronize).toBe(false);
  });

  it('refuses synchronize in production, because it drops columns', () => {
    process.env.NODE_ENV = 'production';
    expect(() => buildDataSourceOptions({ url, synchronize: true })).toThrow(
      /never be enabled in production/,
    );
  });

  it('permits synchronize outside production', () => {
    process.env.NODE_ENV = 'test';
    expect(buildDataSourceOptions({ url, synchronize: true }).synchronize).toBe(true);
  });

  it('sets a statement timeout so one query cannot hold the pool', () => {
    const options = buildDataSourceOptions({ url, statementTimeoutMs: 5000 });
    expect((options.extra as Record<string, unknown>).statement_timeout).toBe(5000);
  });

  it('sets application_name, which is how you find the culprit in pg_stat_activity', () => {
    const options = buildDataSourceOptions({ url, applicationName: 'rota-api' });
    expect((options.extra as Record<string, unknown>).application_name).toBe('rota-api');
  });

  it('passes through pool size and schema', () => {
    const options = buildDataSourceOptions({ url, poolSize: 25, schema: 'app' });
    expect((options as { poolSize?: number }).poolSize).toBe(25);
    expect((options as { schema?: string }).schema).toBe('app');
  });
});

describe('SnakeCaseNamingStrategy', () => {
  const strategy = new SnakeCaseNamingStrategy();

  it('derives a table name from the class name', () => {
    expect(strategy.tableName('AuditLog', undefined)).toBe('audit_log');
  });

  it('honours an explicit table name', () => {
    expect(strategy.tableName('AuditLog', 'mortar_audit_log')).toBe('mortar_audit_log');
  });

  it('snake-cases columns', () => {
    expect(strategy.columnName('createdAt', '', [])).toBe('created_at');
  });

  it('honours an explicit column name', () => {
    expect(strategy.columnName('createdAt', 'inserted_at', [])).toBe('inserted_at');
  });

  it('prefixes embedded columns', () => {
    expect(strategy.columnName('amount', '', ['price'])).toBe('price_amount');
  });

  it('builds join column names', () => {
    expect(strategy.joinColumnName('tenant', 'id')).toBe('tenant_id');
  });
});
