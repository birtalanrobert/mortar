import { ValidationPipe, type ValidationPipeOptions } from '@nestjs/common';
import type { ValidationError as ClassValidatorError } from 'class-validator';
import type { FieldError } from './problem';
import { ValidationError } from './errors';

/**
 * Flattens class-validator's nested error tree into dotted field paths.
 *
 * Nest's default pipe discards this structure and hands back an array of
 * sentences, which a form cannot use to highlight the offending input. Keeping
 * the path means `items.0.quantity` reaches the client intact.
 */
export function flattenValidationErrors(
  errors: readonly ClassValidatorError[],
  parentPath = '',
): FieldError[] {
  const flattened: FieldError[] = [];

  for (const error of errors) {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;

    if (error.constraints) {
      for (const [code, message] of Object.entries(error.constraints)) {
        flattened.push({ field: path, message, code: toSnakeCase(code) });
      }
    }

    if (error.children?.length) {
      flattened.push(...flattenValidationErrors(error.children, path));
    }
  }

  return flattened;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * A ValidationPipe with the defaults most services actually want.
 *
 * The defaults matter:
 *
 * - `whitelist` strips properties the DTO does not declare, so a client cannot
 *   set a field the API never intended to expose.
 * - `forbidNonWhitelisted` turns that from a silent strip into an error, which
 *   surfaces a client sending the wrong shape instead of hiding it.
 * - `transform` produces real class instances, so a `@Type(() => Number)` on a
 *   query parameter actually yields a number rather than a numeric string.
 */
export function createValidationPipe(options: ValidationPipeOptions = {}): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    // Throwing a MortarError here rather than Nest's BadRequestException means
    // validation failures arrive at the filter already structured, and come
    // out as 422 with field paths intact.
    exceptionFactory: (errors) =>
      new ValidationError(flattenValidationErrors(errors as ClassValidatorError[])),
    ...options,
  });
}
