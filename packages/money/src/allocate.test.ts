import { describe, expect, it } from 'vitest';
import { allocate, allocateByAmounts, money, split, sum } from './index';

/**
 * The invariant that matters: an allocation never loses or invents a minor
 * unit. Every test here asserts the parts sum exactly back to the whole.
 */
describe('allocate', () => {
  it('distributes the remainder rather than losing it', () => {
    const parts = allocate(money(1000, 'EUR'), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([334, 333, 333]);
    expect(sum(parts).amount).toBe(1000);
  });

  it('respects weighting', () => {
    const parts = allocate(money(10000, 'EUR'), [70, 30]);
    expect(parts.map((p) => p.amount)).toEqual([7000, 3000]);
  });

  it('handles the classic uneven case exactly', () => {
    const parts = allocate(money(5, 'EUR'), [3, 7]);
    expect(sum(parts).amount).toBe(5);
  });

  it('never loses a unit across many random splits', () => {
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(Math.random() * 1_000_000);
      const count = 1 + Math.floor(Math.random() * 12);
      const ratios = Array.from({ length: count }, () => Math.random() * 100);
      const parts = allocate(money(total, 'EUR'), ratios);
      expect(sum(parts, 'EUR').amount).toBe(total);
    }
  });

  it('handles negative amounts symmetrically', () => {
    const parts = allocate(money(-1000, 'EUR'), [1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([-334, -333, -333]);
    expect(sum(parts).amount).toBe(-1000);
  });

  it('handles a zero-weight share', () => {
    const parts = allocate(money(1000, 'EUR'), [1, 0, 1]);
    expect(parts[1]?.amount).toBe(0);
    expect(sum(parts).amount).toBe(1000);
  });

  it('is deterministic for identical input', () => {
    const a = allocate(money(1000, 'EUR'), [1, 1, 1]);
    const b = allocate(money(1000, 'EUR'), [1, 1, 1]);
    expect(a).toEqual(b);
  });

  it('rejects nonsense input', () => {
    expect(() => allocate(money(100, 'EUR'), [])).toThrow();
    expect(() => allocate(money(100, 'EUR'), [0, 0])).toThrow();
    expect(() => allocate(money(100, 'EUR'), [-1, 2])).toThrow();
  });
});

describe('split', () => {
  it('splits a bill evenly with the remainder at the front', () => {
    expect(split(money(1000, 'EUR'), 3).map((p) => p.amount)).toEqual([334, 333, 333]);
  });

  it('handles a single part', () => {
    expect(split(money(999, 'EUR'), 1).map((p) => p.amount)).toEqual([999]);
  });

  it('rejects a non-positive part count', () => {
    expect(() => split(money(100, 'EUR'), 0)).toThrow();
    expect(() => split(money(100, 'EUR'), 1.5)).toThrow();
  });
});

describe('allocateByAmounts', () => {
  it('apportions a discount across line items', () => {
    const lines = [money(3000, 'EUR'), money(5000, 'EUR'), money(2000, 'EUR')];
    const discount = allocateByAmounts(money(1000, 'EUR'), lines);
    expect(discount.map((d) => d.amount)).toEqual([300, 500, 200]);
    expect(sum(discount).amount).toBe(1000);
  });
});
