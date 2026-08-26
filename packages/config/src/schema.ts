import { z } from 'zod';

/**
 * Coercion helpers for environment variables.
 *
 * Everything in `process.env` is a string, including `"false"` — which is
 * truthy, and which is the single most common configuration bug in Node
 * applications. These helpers exist so no project writes that bug again.
 */

/** A boolean from `true/false`, `1/0`, `yes/no`, `on/off`, case-insensitive. */
export const envBoolean = (defaultValue?: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a boolean (true/false, 1/0, yes/no, on/off), received "${value}"`,
      });
      return z.NEVER;
    })
    .pipe(z.boolean())
    .default(defaultValue as boolean);

/** An integer, rejecting the silent NaN that Number("abc") produces. */
export const envInt = (defaultValue?: number) =>
  z
    .union([z.number(), z.string()])
    .transform((value, ctx) => {
      const parsed = typeof value === 'number' ? value : Number(value.trim());
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected an integer, received "${String(value)}"`,
        });
        return z.NEVER;
      }
      return parsed;
    })
    .pipe(z.number().int())
    .default(defaultValue as number);

/** A TCP port. */
export const envPort = (defaultValue?: number) =>
  envInt(defaultValue).pipe(z.number().int().min(1).max(65535));

/** A number, integer or otherwise. */
export const envNumber = (defaultValue?: number) =>
  z
    .union([z.number(), z.string()])
    .transform((value, ctx) => {
      const parsed = typeof value === 'number' ? value : Number(value.trim());
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected a number, received "${String(value)}"`,
        });
        return z.NEVER;
      }
      return parsed;
    })
    .pipe(z.number())
    .default(defaultValue as number);

/** A comma-separated list, trimmed, with empty entries dropped. */
export const envList = (defaultValue: string[] = []) =>
  z
    .union([z.array(z.string()), z.string()])
    .transform((value) =>
      Array.isArray(value)
        ? value
        : value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
    )
    .default(defaultValue);

/**
 * A duration in milliseconds, accepting either a plain number or a suffixed
 * string: `30s`, `15m`, `2h`, `7d`. Configuration is far more readable with
 * units, and this removes the arithmetic from every `.env` file.
 */
export const envDuration = (defaultValue?: number) =>
  z
    .union([z.number(), z.string()])
    .transform((value, ctx) => {
      if (typeof value === 'number') return value;
      const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(value.trim());
      if (!match) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected a duration such as "500ms", "30s", "15m", "2h" or "7d", received "${value}"`,
        });
        return z.NEVER;
      }
      const magnitude = Number(match[1]);
      const multipliers: Record<string, number> = {
        ms: 1,
        s: 1000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
      };
      return magnitude * (multipliers[match[2] ?? 'ms'] ?? 1);
    })
    .pipe(z.number().nonnegative())
    .default(defaultValue as number);

/** A URL, validated so a malformed connection string fails at boot. */
export const envUrl = (defaultValue?: string) =>
  z
    .string()
    .url()
    .default(defaultValue as string);

/** One of a fixed set of values. */
export const envEnum = <T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue?: T[number],
) => z.enum(values).default(defaultValue as T[number]);

/** A required non-empty string. */
export const envString = (defaultValue?: string) =>
  defaultValue === undefined ? z.string().min(1) : z.string().min(1).default(defaultValue);

/**
 * A secret: a required string with a minimum length, because a signing key of
 * eight characters is not a signing key.
 */
export const envSecret = (minLength = 32) =>
  z
    .string()
    .min(minLength, `must be at least ${minLength} characters — short secrets are not secrets`);

/** The variables essentially every service needs. */
export const baseEnvSchema = z.object({
  NODE_ENV: envEnum(['development', 'test', 'production'], 'development'),
  SERVICE_NAME: envString(),
  LOG_LEVEL: envEnum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], 'info'),
});

export { z };
