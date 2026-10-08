import { createHash } from 'node:crypto';
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

  it('fingerprints a raw body by its bytes, alone or beside the route’s parameters', () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(fingerprint(image)).toBe(fingerprint(Buffer.from(image)));
    expect(fingerprint(image)).not.toBe(
      fingerprint(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 4])),
    );
    // The same bytes in any view of them are the same body.
    expect(fingerprint(new Uint8Array(image))).toBe(fingerprint(image));
    expect(fingerprint({ params: { id: '1' }, body: image })).not.toBe(
      fingerprint({ params: { id: '2' }, body: image }),
    );
  });

  it('never fingerprints a JSON body as a binary one', () => {
    // An object keyed as a Buffer's bytes are, which walking the Buffer used to produce.
    expect(fingerprint({ 0: 97, 1: 32 })).not.toBe(fingerprint(Buffer.from('a ')));
    // The bytes' digest itself, sent as a JSON string.
    const image = Buffer.from('a picture');
    const digest = createHash('sha256').update(image).digest('hex');
    expect(fingerprint(`bytes:${digest}`)).not.toBe(fingerprint(image));
  });

  it('fingerprints megabytes as quickly as they can be hashed', () => {
    // Four megabytes walked byte by byte as an object took longer than the test allows.
    const upload = Buffer.alloc(4 * 1024 * 1024, 7);
    const started = Date.now();
    expect(fingerprint(upload)).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('produces a sha256 hex digest', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
