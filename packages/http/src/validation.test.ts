import { describe, expect, it } from 'vitest';
import type { ValidationError as ClassValidatorError } from 'class-validator';
import { flattenValidationErrors } from './validation';

function error(
  property: string,
  constraints?: Record<string, string>,
  children?: ClassValidatorError[],
): ClassValidatorError {
  return { property, constraints, children } as ClassValidatorError;
}

describe('flattenValidationErrors', () => {
  it('flattens a top-level constraint', () => {
    expect(
      flattenValidationErrors([error('email', { isEmail: 'email must be an email' })]),
    ).toEqual([{ field: 'email', message: 'email must be an email', code: 'is_email' }]);
  });

  it('emits one entry per failed constraint', () => {
    const flattened = flattenValidationErrors([
      error('password', { minLength: 'too short', matches: 'needs a digit' }),
    ]);
    expect(flattened).toHaveLength(2);
    expect(flattened.map((e) => e.code)).toEqual(['min_length', 'matches']);
  });

  it('preserves the dotted path through nested objects', () => {
    const flattened = flattenValidationErrors([
      error('address', undefined, [error('postcode', { isNotEmpty: 'required' })]),
    ]);
    expect(flattened[0]?.field).toBe('address.postcode');
  });

  it('preserves array indices, so a form can highlight the right row', () => {
    const flattened = flattenValidationErrors([
      error('items', undefined, [error('0', undefined, [error('quantity', { min: 'too low' })])]),
    ]);
    expect(flattened[0]?.field).toBe('items.0.quantity');
  });

  it('handles several levels and several siblings', () => {
    const flattened = flattenValidationErrors([
      error('a', { isString: 'a bad' }),
      error('b', undefined, [error('c', { isInt: 'c bad' })]),
    ]);
    expect(flattened.map((e) => e.field)).toEqual(['a', 'b.c']);
  });

  it('returns nothing for an empty list', () => {
    expect(flattenValidationErrors([])).toEqual([]);
  });
});
