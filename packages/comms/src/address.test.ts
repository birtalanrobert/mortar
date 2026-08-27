import { describe, expect, it } from 'vitest';
import { InboundAddress } from './address';

const addresses = new InboundAddress({
  domain: 'in.example.com',
  secret: 'a-secret-that-is-at-least-thirty-two-characters',
});

describe('mint', () => {
  it('produces a sub-addressed address on the inbound domain', () => {
    const address = addresses.mint('req-123');

    expect(address).toMatch(/^docs\+req-123\.[0-9a-f]{16}@in\.example\.com$/);
  });

  it('is stable for the same subject', () => {
    // A client keeps the address in their sent folder and forwards to it again
    // next month. An address that changed would silently stop working.
    expect(addresses.mint('req-123')).toBe(addresses.mint('req-123'));
  });

  it('differs per subject', () => {
    expect(addresses.mint('req-123')).not.toBe(addresses.mint('req-124'));
  });

  it('refuses a subject with nothing usable in it', () => {
    expect(() => addresses.mint('///')).toThrow();
  });
});

describe('parse', () => {
  it('recovers the subject from an address it minted', () => {
    const address = addresses.mint('req-123');

    expect(addresses.parse(address)).toEqual({ subject: 'req-123', address });
  });

  it('reads an address out of a display-name header', () => {
    const address = addresses.mint('req-123');

    expect(addresses.parse(`"Popescu & Asociații" <${address}>`)?.subject).toBe('req-123');
  });

  it('is case-insensitive, because providers lowercase local parts', () => {
    const address = addresses.mint('req-123');

    expect(addresses.parse(address.toUpperCase())?.subject).toBe('req-123');
  });

  it('refuses an address with a forged tag', () => {
    // The address is the credential. Without the tag, anyone who guesses a
    // request id can post documents into a firm's workflow.
    expect(addresses.parse('docs+req-123.0000000000000000@in.example.com')).toBeUndefined();
  });

  it('refuses an address with no tag at all', () => {
    expect(addresses.parse('docs+req-123@in.example.com')).toBeUndefined();
  });

  it('refuses another subject’s tag', () => {
    const other = addresses.mint('req-124');
    const tag = other.split('.')[1]?.split('@')[0];

    expect(addresses.parse(`docs+req-123.${tag}@in.example.com`)).toBeUndefined();
  });

  it('refuses a tag minted with a different secret', () => {
    const stranger = new InboundAddress({
      domain: 'in.example.com',
      secret: 'a-different-secret-of-at-least-thirty-two-chars',
    });

    expect(addresses.parse(stranger.mint('req-123'))).toBeUndefined();
  });

  it('refuses another domain', () => {
    const address = addresses.mint('req-123');

    // Otherwise a lookalike domain someone else controls routes into our
    // workflow.
    expect(addresses.parse(address.replace('in.example.com', 'in.example.org'))).toBeUndefined();
  });

  it('refuses another prefix', () => {
    expect(addresses.parse('other+req-123.0000000000000000@in.example.com')).toBeUndefined();
  });

  it.each(['', 'not an address', '@', 'docs+@in.example.com', 'plain@in.example.com'])(
    'returns nothing for %j rather than throwing',
    (value) => {
      // An inbound webhook receives whatever the internet sends it; mail to an
      // address nobody issued is a daily event, not an exception.
      expect(addresses.parse(value)).toBeUndefined();
    },
  );
});

describe('find', () => {
  it('picks ours out of a forwarded message’s recipients', () => {
    const address = addresses.mint('req-123');

    const found = addresses.find([
      'contabil@example.com',
      `"Documents" <${address}>`,
      'sotia@example.com',
    ]);

    expect(found?.subject).toBe('req-123');
  });

  it('returns nothing when none of them are', () => {
    expect(addresses.find(['a@example.com', 'b@example.com'])).toBeUndefined();
  });

  it('returns nothing for an empty list', () => {
    expect(addresses.find([])).toBeUndefined();
  });
});

describe('construction', () => {
  it('refuses a secret short enough to be brute-forced', () => {
    expect(() => new InboundAddress({ domain: 'in.example.com', secret: 'short' })).toThrow();
  });

  it('accepts a domain written with a leading @', () => {
    const forgiving = new InboundAddress({
      domain: '@in.example.com',
      secret: 'a-secret-that-is-at-least-thirty-two-characters',
    });

    expect(forgiving.mint('req-1')).toContain('@in.example.com');
  });
});
