import { describe, expect, it } from 'vitest';
import { snakeCase } from './case';

describe('snakeCase', () => {
  it.each([
    ['createdAt', 'created_at'],
    ['id', 'id'],
    ['AuditLog', 'audit_log'],
    ['tenantId', 'tenant_id'],
    ['a', 'a'],
    ['already_snake', 'already_snake'],
    ['kebab-case', 'kebab_case'],
    ['with space', 'with_space'],
  ])('converts %s to %s', (input, expected) => {
    expect(snakeCase(input)).toBe(expected);
  });

  it('keeps acronyms together, which the naive regex mangles', () => {
    expect(snakeCase('imageURL')).toBe('image_url');
    expect(snakeCase('customerVATNumber')).toBe('customer_vat_number');
    expect(snakeCase('parseHTTPResponse')).toBe('parse_http_response');
    expect(snakeCase('IBAN')).toBe('iban');
  });

  it('handles digits', () => {
    expect(snakeCase('address2Line')).toBe('address2_line');
    expect(snakeCase('oauth2Token')).toBe('oauth2_token');
  });
});
