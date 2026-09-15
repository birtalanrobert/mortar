import { describe, expect, it } from 'vitest';
import { LINK_TOKEN_LENGTH, isHandle, mintHandle, signHandle, verifyHandle } from './handle';
import { signLink } from './token';

const SECRET = 'a-signing-secret-of-entirely-sufficient-length';

describe('a link short enough to text', () => {
  /**
   * The measurement this format exists for.
   *
   * A stateless token is over three hundred characters; in an SMS that is two
   * segments spent on the URL before a single word of the message.
   */
  it('is a fraction of the length of a token that carries its claims', async () => {
    const { token: stateless } = await signLink(
      {
        subject: 'order:2f1c0b6e-1b9e-4a1e-9a3a-6f7c5d4e3b2a',
        tenantId: '8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      SECRET,
    );

    const compact = await signHandle(mintHandle(), SECRET);

    expect(compact).toHaveLength(37);
    expect(stateless.length).toBeGreaterThan(300);
  });

  /**
   * The budget, stated as the thing a shop is actually billed for.
   *
   * A GSM segment is 160 characters. A URL is `https://`, a domain, `/s/` and
   * the token — about sixty all told, leaving more than ninety characters to
   * say something in. That is the whole design constraint, and it is asserted
   * here as a number rather than left as a claim in a comment.
   *
   * The product-level proof, that every shipped message template fits one
   * segment with a real link in it, lives with the templates — this package has
   * no business knowing what a message says.
   */
  it('leaves a text message room to say something', () => {
    const url = `https://atelier.example/s/${'a'.repeat(LINK_TOKEN_LENGTH)}`;

    expect(url.length).toBeLessThan(70);
    expect(160 - url.length).toBeGreaterThan(90);
  });

  it('round-trips a handle it minted', async () => {
    const handle = mintHandle();
    const token = await signHandle(handle, SECRET);

    expect(await verifyHandle(token, SECRET)).toEqual({ ok: true, handle });
  });

  it('is unguessable, which is where the security actually lives', () => {
    const handles = new Set(Array.from({ length: 2_000 }, () => mintHandle()));

    /* 128 bits: a collision in two thousand would mean the generator is broken. */
    expect(handles.size).toBe(2_000);
    expect([...handles].every(isHandle)).toBe(true);
  });

  describe('what it refuses', () => {
    it('refuses a token signed with a different secret', async () => {
      const token = await signHandle(mintHandle(), 'a-different-secret-of-sufficient-length');

      expect(await verifyHandle(token, SECRET)).toEqual({ ok: false, reason: 'invalid' });
    });

    /**
     * The attack the tag is actually there to stop being cheap.
     *
     * Somebody walking `/s/<random>` does not get a database query per attempt
     * — they get an HMAC and a refusal.
     */
    it('refuses an invented token', async () => {
      const result = await verifyHandle(`1${'A'.repeat(22)}${'B'.repeat(14)}`, SECRET);

      expect(result).toEqual({ ok: false, reason: 'invalid' });
    });

    it('refuses a token of the wrong length rather than reading past it', async () => {
      const token = await signHandle(mintHandle(), SECRET);

      for (const wrong of [token.slice(0, -1), `${token}x`, '', '1']) {
        expect(await verifyHandle(wrong, SECRET)).toEqual({ ok: false, reason: 'malformed' });
      }
    });

    it('refuses a token from an unknown format version', async () => {
      const token = await signHandle(mintHandle(), SECRET);

      expect(await verifyHandle(`2${token.slice(1)}`, SECRET)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });

    /*
     * A URL is pasted, forwarded and re-typed. Anything outside the alphabet
     * cannot have been minted here, and is refused before it is decoded.
     */
    it('refuses characters it could not have produced', async () => {
      const token = await signHandle(mintHandle(), SECRET);
      const damaged = `1.${token.slice(2)}`;

      expect(await verifyHandle(damaged, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses a handle with a single character changed', async () => {
      const handle = mintHandle();
      const token = await signHandle(handle, SECRET);
      const flipped = handle[0] === 'a' ? 'b' : 'a';

      expect(await verifyHandle(`1${flipped}${handle.slice(1)}${token.slice(23)}`, SECRET)).toEqual(
        { ok: false, reason: 'invalid' },
      );
    });
  });

  describe('isHandle', () => {
    it('accepts what mintHandle produces and nothing shaped differently', () => {
      expect(isHandle(mintHandle())).toBe(true);
      /* A uuid is the shape this format replaced, and is not one. */
      expect(isHandle('2f1c0b6e-1b9e-4a1e-9a3a-6f7c5d4e3b2a')).toBe(false);
      expect(isHandle('')).toBe(false);
      expect(isHandle('A'.repeat(21))).toBe(false);
      expect(isHandle(`A'".repeat`)).toBe(false);
    });
  });
});
