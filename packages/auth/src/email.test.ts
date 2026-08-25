import { describe, expect, it } from 'vitest';
import { isPlausibleEmail, normaliseEmail } from './email';

describe('normaliseEmail', () => {
  it('lower-cases and trims', () => {
    expect(normaliseEmail('  Ana.Pop@Example.COM ')).toBe('ana.pop@example.com');
  });

  it('makes casing variants the same account', () => {
    // Otherwise Ana@x.com and ana@x.com register twice — a bug to users and an
    // opportunity to attackers.
    expect(normaliseEmail('ANA@x.com')).toBe(normaliseEmail('ana@x.com'));
  });

  it('does not strip dots or plus-tags, which are provider-specific', () => {
    // Applying Gmail's rules to every domain silently merges distinct
    // addresses elsewhere.
    expect(normaliseEmail('a.n.a+work@example.com')).toBe('a.n.a+work@example.com');
  });
});

describe('isPlausibleEmail', () => {
  it.each([
    'ana@example.com',
    'a.n.a+tag@sub.example.co.uk',
    'user_name@example-domain.ro',
    'x@y.hu',
  ])('accepts %s', (email) => {
    expect(isPlausibleEmail(email)).toBe(true);
  });

  it.each([
    '',
    'no-at-sign',
    '@example.com',
    'ana@',
    'ana@localhost',
    'ana@exa mple.com',
    'ana example@x.com',
    'ana@.example.com',
    'ana@example.com.',
    'ana@example..com',
  ])('rejects %s', (email) => {
    expect(isPlausibleEmail(email)).toBe(false);
  });

  it('rejects an address beyond the maximum length', () => {
    expect(isPlausibleEmail(`${'a'.repeat(320)}@x.com`)).toBe(false);
  });

  it('handles non-string input', () => {
    expect(isPlausibleEmail(undefined as unknown as string)).toBe(false);
  });
});
