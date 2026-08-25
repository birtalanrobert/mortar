import { z } from 'zod';
import { ConfigValidationError, type ConfigIssue } from './errors';
import { redactConfig } from './redact';

export interface LoadOptions<T extends z.ZodTypeAny> {
  /** The schema the environment must satisfy. */
  schema: T;
  /** Source of values. Defaults to `process.env`. */
  source?: Record<string, string | undefined>;
  /**
   * Called with a redacted view of the resolved configuration once validation
   * succeeds — the boot banner hook.
   */
  onLoaded?: (redacted: Record<string, unknown>) => void;
}

/**
 * Validates the environment against a schema and returns a typed, frozen
 * configuration object.
 *
 * Throws `ConfigValidationError` listing **every** problem rather than the
 * first, so a misconfigured deployment is fixed in one pass instead of five.
 */
export function loadConfig<T extends z.ZodTypeAny>(options: LoadOptions<T>): Readonly<z.infer<T>> {
  const { schema, source = process.env, onLoaded } = options;

  const result = schema.safeParse(source);

  if (!result.success) {
    const issues: ConfigIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    }));
    throw new ConfigValidationError(issues);
  }

  const config = Object.freeze(result.data as z.infer<T>);
  onLoaded?.(redactConfig(config as Record<string, unknown>));
  return config;
}

/**
 * Validates without throwing, for tooling that needs to report rather than
 * halt — a configuration linter, or a health endpoint's diagnostic mode.
 */
export function validateConfig<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): { ok: true; config: z.infer<T> } | { ok: false; issues: ConfigIssue[] } {
  const result = schema.safeParse(source);
  if (result.success) return { ok: true, config: result.data as z.infer<T> };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  };
}

/**
 * Formats the resolved configuration for the boot log.
 *
 * Printing configuration at boot is genuinely useful — most "it works locally"
 * incidents are visible in this output — and it is only safe because every
 * secret is redacted on the way out.
 */
export function describeConfig(config: Record<string, unknown>): string {
  const redacted = redactConfig(config);
  const width = Math.max(...Object.keys(redacted).map((key) => key.length));
  return Object.entries(redacted)
    .map(([key, value]) => `  ${key.padEnd(width)}  ${formatValue(value)}`)
    .join('\n');
}

function formatValue(value: unknown): string {
  if (value === undefined) return '<unset>';
  if (value === null) return '<null>';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '<empty>';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
