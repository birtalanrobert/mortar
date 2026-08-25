import { describe, expect, it } from 'vitest';
import { fingerprint } from './service';

describe('fingerprint', () => {
  it('is stable for identical payloads', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ a: 1, b: 2 }));
  });

  it('ignores key ordering, which JSON.stringify does not', () => {
    // A client serialising the same object twice can emit keys in a different
    // order; treating that as a different request would defeat the whole point.
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('is stable through nesting', () => {
    expect(fingerprint({ o: { x: 1, y: 2 }, l: [1, 2] })).toBe(
      fingerprint({ l: [1, 2], o: { y: 2, x: 1 } }),
    );
  });

  it('differs when a value changes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it('respects array order, which is meaningful', () => {
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });

  it('ignores undefined properties, matching JSON transport', () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
  });

  it('distinguishes null from absent', () => {
    expect(fingerprint({ a: null })).not.toBe(fingerprint({}));
  });

  it('handles scalars and empty bodies', () => {
    expect(fingerprint(undefined)).toBe(fingerprint(undefined));
    expect(fingerprint(null)).not.toBe(fingerprint(0));
    expect(fingerprint('')).not.toBe(fingerprint(null));
  });

  it('produces a sha256 hex digest', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
