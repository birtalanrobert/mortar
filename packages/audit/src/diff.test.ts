import { describe, expect, it } from 'vitest';
import { REDACTED, computeChanges, redactMetadata } from './diff';

describe('computeChanges', () => {
  it('records only what changed', () => {
    const changes = computeChanges(
      { name: 'Ana', email: 'a@x.com', role: 'staff' },
      { name: 'Ana Maria', email: 'a@x.com', role: 'staff' },
    );
    expect(changes).toEqual({ name: { from: 'Ana', to: 'Ana Maria' } });
  });

  it('returns null when nothing changed, so no empty row is written', () => {
    expect(computeChanges({ a: 1 }, { a: 1 })).toBeNull();
  });

  it('records added and removed fields', () => {
    expect(computeChanges({ a: 1 }, { b: 2 })).toEqual({
      a: { from: 1, to: undefined },
      b: { from: undefined, to: 2 },
    });
  });

  it('handles creation and deletion', () => {
    expect(computeChanges(null, { a: 1 })).toEqual({ a: { from: undefined, to: 1 } });
    expect(computeChanges({ a: 1 }, null)).toEqual({ a: { from: 1, to: undefined } });
    expect(computeChanges(null, null)).toBeNull();
  });

  it('compares dates by instant, not identity', () => {
    // A record re-read from the database yields a different Date object for
    // the same moment; treating that as a change would fill the log with
    // entries where nothing happened.
    const a = new Date('2026-03-01T10:00:00Z');
    const b = new Date('2026-03-01T10:00:00Z');
    expect(computeChanges({ at: a }, { at: b })).toBeNull();
    expect(computeChanges({ at: a }, { at: new Date('2026-03-02T10:00:00Z') })).not.toBeNull();
  });

  it('compares objects and arrays structurally', () => {
    expect(computeChanges({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toBeNull();
    expect(computeChanges({ tags: ['a'] }, { tags: ['a', 'b'] })).not.toBeNull();
    expect(computeChanges({ o: { x: 1 } }, { o: { x: 1 } })).toBeNull();
  });

  it('distinguishes null from undefined', () => {
    expect(computeChanges({ a: null }, { a: undefined })).not.toBeNull();
  });

  it('redacts sensitive fields but still records that they changed', () => {
    const changes = computeChanges(
      { passwordHash: 'old-hash', name: 'Ana' },
      { passwordHash: 'new-hash', name: 'Ana' },
    );
    expect(changes).toEqual({ passwordHash: { from: REDACTED, to: REDACTED } });
  });

  it('matches redacted names regardless of casing or separators', () => {
    for (const field of ['api_key', 'apiKey', 'API-KEY', 'cardNumber']) {
      const changes = computeChanges({ [field]: 'a' }, { [field]: 'b' });
      expect(changes?.[field]?.to).toBe(REDACTED);
    }
  });

  it('accepts additional fields to redact', () => {
    const changes = computeChanges({ salary: 100 }, { salary: 200 }, { redact: ['salary'] });
    expect(changes?.salary).toEqual({ from: REDACTED, to: REDACTED });
  });

  it('ignores fields that are noise, such as updatedAt', () => {
    const changes = computeChanges(
      { name: 'a', updatedAt: new Date(1) },
      { name: 'a', updatedAt: new Date(2) },
      { ignore: ['updatedAt'] },
    );
    expect(changes).toBeNull();
  });
});

describe('redactMetadata', () => {
  it('redacts at the top level', () => {
    expect(redactMetadata({ reason: 'ok', token: 'abc' })).toEqual({
      reason: 'ok',
      token: REDACTED,
    });
  });

  it('redacts inside nested objects and arrays', () => {
    const out = redactMetadata({ user: { name: 'Ana', password: 'p' }, list: [{ secret: 's' }] });
    expect(JSON.stringify(out)).not.toContain('"p"');
    expect(JSON.stringify(out)).not.toContain('"s"');
    expect(JSON.stringify(out)).toContain('Ana');
  });

  it('does not recurse without bound', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 50; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => redactMetadata(deep)).not.toThrow();
  });
});
