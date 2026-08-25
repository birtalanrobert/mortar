import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  permissionsForRoles,
} from './rbac';

const mapping = {
  owner: [ALL_PERMISSIONS],
  manager: ['booking:*', 'staff:read'],
  staff: ['booking:read'],
};

describe('permissionsForRoles', () => {
  it('expands a role', () => {
    expect([...permissionsForRoles(['staff'], mapping)]).toEqual(['booking:read']);
  });

  it('unions several roles', () => {
    expect([...permissionsForRoles(['staff', 'manager'], mapping)].sort()).toEqual([
      'booking:*',
      'booking:read',
      'staff:read',
    ]);
  });

  it('ignores an unknown role rather than throwing', () => {
    // Roles are data supplied by a project; a stale one in a membership must
    // not break the request.
    expect([...permissionsForRoles(['nonexistent'], mapping)]).toEqual([]);
  });

  it('handles no roles', () => {
    expect(permissionsForRoles([], mapping).size).toBe(0);
  });
});

describe('hasPermission', () => {
  it('matches exactly', () => {
    expect(hasPermission(new Set(['booking:read']), 'booking:read')).toBe(true);
  });

  it('refuses a permission that was not granted', () => {
    expect(hasPermission(new Set(['booking:read']), 'booking:write')).toBe(false);
  });

  it('honours a resource wildcard', () => {
    expect(hasPermission(new Set(['booking:*']), 'booking:write')).toBe(true);
  });

  it('does not let one resource wildcard leak into another', () => {
    expect(hasPermission(new Set(['booking:*']), 'invoice:write')).toBe(false);
  });

  it('honours the global wildcard', () => {
    expect(hasPermission(new Set([ALL_PERMISSIONS]), 'anything:at:all')).toBe(true);
  });

  it('refuses everything when nothing is granted', () => {
    expect(hasPermission(new Set(), 'booking:read')).toBe(false);
  });

  it('does not treat a prefix as a wildcard', () => {
    // 'booking' must not grant 'booking:write' — only 'booking:*' does.
    expect(hasPermission(new Set(['booking']), 'booking:write')).toBe(false);
  });
});

describe('hasAllPermissions / hasAnyPermission', () => {
  const granted = new Set(['booking:read', 'staff:*']);

  it('requires every permission for "all"', () => {
    expect(hasAllPermissions(granted, ['booking:read', 'staff:write'])).toBe(true);
    expect(hasAllPermissions(granted, ['booking:read', 'invoice:write'])).toBe(false);
  });

  it('requires only one for "any"', () => {
    expect(hasAnyPermission(granted, ['invoice:write', 'booking:read'])).toBe(true);
    expect(hasAnyPermission(granted, ['invoice:write'])).toBe(false);
  });

  it('treats an empty requirement as satisfied for "all"', () => {
    expect(hasAllPermissions(granted, [])).toBe(true);
  });

  it('treats an empty requirement as unsatisfied for "any"', () => {
    expect(hasAnyPermission(granted, [])).toBe(false);
  });
});
