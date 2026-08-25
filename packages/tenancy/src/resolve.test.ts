import { describe, expect, it, vi } from 'vitest';
import {
  headerResolver,
  pathResolver,
  resolveTenant,
  sessionResolver,
  subdomainResolver,
} from './resolve';

const lookup = (slug: string) => (slug === 'clubname' ? 'tenant-1' : undefined);

describe('subdomainResolver', () => {
  const resolver = subdomainResolver({ baseDomain: 'seatscope.app', lookup });

  it('resolves a tenant subdomain', async () => {
    expect(await resolver.resolve({ hostname: 'clubname.seatscope.app' })).toBe('tenant-1');
  });

  it('reads the host header when hostname is absent', async () => {
    expect(await resolver.resolve({ headers: { host: 'clubname.seatscope.app:3100' } })).toBe(
      'tenant-1',
    );
  });

  it('is case-insensitive', async () => {
    expect(await resolver.resolve({ hostname: 'ClubName.SeatScope.App' })).toBe('tenant-1');
  });

  it('ignores the apex domain', async () => {
    expect(await resolver.resolve({ hostname: 'seatscope.app' })).toBeUndefined();
  });

  it('ignores reserved subdomains rather than treating them as slugs', async () => {
    for (const host of ['www', 'app', 'api', 'admin']) {
      expect(await resolver.resolve({ hostname: `${host}.seatscope.app` })).toBeUndefined();
    }
  });

  it('ignores a different base domain', async () => {
    expect(await resolver.resolve({ hostname: 'clubname.evil.com' })).toBeUndefined();
  });

  it('does not match a nested subdomain that merely ends with the base domain', async () => {
    // `evil.clubname.seatscope.app` must not resolve to `clubname`.
    expect(await resolver.resolve({ hostname: 'evil.clubname.seatscope.app' })).toBeUndefined();
  });

  it('returns undefined for an unknown slug', async () => {
    expect(await resolver.resolve({ hostname: 'nosuch.seatscope.app' })).toBeUndefined();
  });
});

describe('sessionResolver', () => {
  it('reads from user or session', () => {
    const resolver = sessionResolver();
    expect(resolver.resolve({ user: { tenantId: 't1' } })).toBe('t1');
    expect(resolver.resolve({ session: { tenantId: 't2' } })).toBe('t2');
    expect(resolver.resolve({})).toBeUndefined();
  });
});

describe('headerResolver', () => {
  it('requires verification to succeed', async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const resolver = headerResolver({ verify });
    expect(await resolver.resolve({ headers: { 'x-tenant-id': 't1' } })).toBe('t1');
    expect(verify).toHaveBeenCalledWith('t1', expect.any(Object));
  });

  it('refuses an unverified header, which would be privilege escalation', async () => {
    // Accepting a tenant id straight from a browser request lets any client
    // read any tenant. Verification is mandatory, not optional.
    const resolver = headerResolver({ verify: () => false });
    expect(await resolver.resolve({ headers: { 'x-tenant-id': 'someone-elses' } })).toBeUndefined();
  });
});

describe('pathResolver', () => {
  it('verifies the parameter before trusting it', async () => {
    expect(await pathResolver({ verify: () => true }).resolve({ params: { tenantId: 't1' } })).toBe(
      't1',
    );
    expect(
      await pathResolver({ verify: () => false }).resolve({ params: { tenantId: 't1' } }),
    ).toBeUndefined();
  });
});

describe('resolveTenant', () => {
  it('returns the first match and names its source', async () => {
    const result = await resolveTenant(
      [subdomainResolver({ baseDomain: 'seatscope.app', lookup }), sessionResolver()],
      { hostname: 'clubname.seatscope.app', user: { tenantId: 'other' } },
    );
    expect(result).toEqual({ tenantId: 'tenant-1', source: 'subdomain' });
  });

  it('falls through to a later resolver', async () => {
    const result = await resolveTenant(
      [subdomainResolver({ baseDomain: 'seatscope.app', lookup }), sessionResolver()],
      { hostname: 'seatscope.app', user: { tenantId: 'from-session' } },
    );
    expect(result).toEqual({ tenantId: 'from-session', source: 'session' });
  });

  it('returns undefined when nothing matches', async () => {
    expect(await resolveTenant([sessionResolver()], {})).toBeUndefined();
  });
});
