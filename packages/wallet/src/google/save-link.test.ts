import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyJwt } from '../jwt';
import { sampleContent } from '../testing';
import { buildLoyaltyClass, buildLoyaltyObject } from './payload';
import { buildSaveToken, SAVE_URL, saveLink } from './save-link';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = new Date('2026-06-01T09:00:00Z');

const input = (overrides: Record<string, unknown> = {}) => ({
  serviceAccountEmail: 'passes@stamped.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  origins: ['https://enrol.stamped.example'],
  loyaltyObject: buildLoyaltyObject(sampleContent(), {
    issuerId: '3388000000012345678',
    classSuffix: 'cafea',
    objectSuffix: 'card-1',
    now: NOW,
  }),
  now: NOW,
  ...overrides,
});

describe('the save link', () => {
  it('is a Google URL with a token on the end', () => {
    const link = saveLink(input());

    expect(link.startsWith(SAVE_URL)).toBe(true);
    expect(link.slice(SAVE_URL.length).split('.')).toHaveLength(3);
  });

  /**
   * Verified with the service account's *public* key, which is the whole point:
   * it is the same check Google performs, done with a key pair this test
   * generated rather than with a credential anybody has to hold.
   */
  it('verifies against the service account’s public key', () => {
    const verified = verifyJwt(buildSaveToken(input()), publicKey, 'RS256');

    expect(verified).not.toBeNull();
    expect(verified!.claims).toMatchObject({
      iss: 'passes@stamped.iam.gserviceaccount.com',
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(NOW.getTime() / 1000),
      origins: ['https://enrol.stamped.example'],
    });
  });

  it('carries the card inside the token', () => {
    const verified = verifyJwt(buildSaveToken(input()), publicKey, 'RS256');
    const payload = verified!.claims.payload as { loyaltyObjects: { id: string }[] };

    expect(payload.loyaltyObjects[0]!.id).toBe('3388000000012345678.card-1');
  });

  it('can carry the programme as well, for the first card of a new one', () => {
    const loyaltyClass = buildLoyaltyClass(sampleContent(), {
      issuerId: '3388000000012345678',
      issuerName: 'Cafeneaua Verde',
      classSuffix: 'cafea',
      programName: 'Cafea',
    });

    const verified = verifyJwt(buildSaveToken(input({ loyaltyClass })), publicKey, 'RS256');
    const payload = verified!.claims.payload as { loyaltyClasses?: unknown[] };

    expect(payload.loyaltyClasses).toHaveLength(1);
  });

  it('refuses to issue a token with no origins', () => {
    // Google rejects it at the moment the customer taps the button, with an
    // error the customer can do nothing about. Better here.
    expect(() => buildSaveToken(input({ origins: [] }))).toThrow(/origins/);
  });
});

/**
 * Google keys the token's payload by what kind of pass it holds.
 *
 * A ticket sent as `loyaltyObjects` installs as a loyalty card with a balance
 * where its seat should be — which is a pass that looks wrong to the holder and
 * entirely fine to every assertion about the JWT itself.
 */
describe('an event ticket save link', () => {
  it('carries the ticket under Google’s own key', () => {
    const token = buildSaveToken({
      ...input({ loyaltyObject: undefined }),
      eventTicketObject: { id: '3388.one' },
      eventTicketClass: { id: '3388.hamlet' },
    });

    const verified = verifyJwt(token, publicKey, 'RS256');

    expect((verified!.claims as { payload: Record<string, unknown> }).payload).toEqual({
      eventTicketObjects: [{ id: '3388.one' }],
      eventTicketClasses: [{ id: '3388.hamlet' }],
    });
  });

  it('refuses a token carrying neither', () => {
    expect(() => buildSaveToken(input({ loyaltyObject: undefined }))).toThrow(/exactly one pass/);
  });

  it('refuses a token carrying both', () => {
    expect(() => buildSaveToken(input({ eventTicketObject: { id: '3388.one' } }))).toThrow(
      /exactly one pass/,
    );
  });
});
