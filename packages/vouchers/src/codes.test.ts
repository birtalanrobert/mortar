import { describe, expect, it } from 'vitest';

import { CODE_GROUPS, CODE_GROUP_LENGTH, looksLikeCode, normaliseCode } from './codes';

describe('a voucher code', () => {
  it('reads back what somebody typed, however they typed it', () => {
    expect(normaliseCode('abc def ghj kmn')).toBe('ABC-DEF-GHJ-KMN');
    expect(normaliseCode('ABC-DEF-GHJ-KMN')).toBe('ABC-DEF-GHJ-KMN');
    expect(normaliseCode('  abc.def/ghj kmn  ')).toBe('ABC-DEF-GHJ-KMN');
  });

  it('forgives the three letters everybody gets wrong', () => {
    /*
     * I, L and O are not in the alphabet precisely so that somebody reading a
     * code off a photograph has somewhere unambiguous to put them. Telling a
     * customer their voucher does not exist because they typed a letter O is
     * the failure this prevents.
     */
    expect(normaliseCode('O12-I34-L56-789')).toBe('012-134-156-789');
  });

  it('recognises one of ours, and only one of ours', () => {
    expect(looksLikeCode('ABC-DEF-GHJ-KMN')).toBe(true);
    expect(looksLikeCode('ABCDEFGHJKMN')).toBe(true);

    // Too short, and containing letters the alphabet deliberately excludes.
    expect(looksLikeCode('ABC-DEF')).toBe(false);
    expect(looksLikeCode('ABC-DEF-GHI-KMN')).toBe(false);
    expect(looksLikeCode('ABC-DEF-GHU-KMN')).toBe(false);
  });

  it('is twelve characters, which is enough that guessing is not a strategy', () => {
    expect(CODE_GROUPS * CODE_GROUP_LENGTH).toBe(12);
  });
});
