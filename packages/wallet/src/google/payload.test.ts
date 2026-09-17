import { describe, expect, it } from 'vitest';
import { sampleContent } from '../testing';
import { buildLoyaltyClass, buildLoyaltyObject } from './payload';

const NOW = new Date('2026-06-01T09:00:00Z');

const CLASS_INPUT = {
  issuerId: '3388000000012345678',
  issuerName: 'Cafeneaua Verde',
  classSuffix: 'cafea-fidelitate',
  programName: 'Cafea de fidelitate',
};

const OBJECT_INPUT = {
  issuerId: '3388000000012345678',
  classSuffix: 'cafea-fidelitate',
  objectSuffix: '0f9d4b7a-3c21-4f7e-9c2a-8d5e6f1b2c3d',
  now: NOW,
};

describe('the loyalty class', () => {
  it('is the programme, and carries what every holder shares', () => {
    const loyaltyClass = buildLoyaltyClass(sampleContent(), CLASS_INPUT);

    expect(loyaltyClass.id).toBe('3388000000012345678.cafea-fidelitate');
    expect(loyaltyClass.issuerName).toBe('Cafeneaua Verde');
    expect(loyaltyClass.hexBackgroundColor).toBe('#183a2c');
    expect(loyaltyClass.locations).toEqual([{ latitude: 46.7712, longitude: 23.6236 }]);
  });

  /**
   * The terms belong to the programme, not to one card.
   *
   * On the object they would be written once per holder, and changing a term
   * would be a two-thousand-row update instead of one.
   */
  it('carries the back of the pass', () => {
    const loyaltyClass = buildLoyaltyClass(sampleContent(), CLASS_INPUT);

    expect(loyaltyClass.textModulesData).toEqual([
      { id: 'terms', header: 'Termeni', body: 'Ștampilele nu expiră.' },
      { id: 'unsubscribe', header: 'Dezabonare', body: 'https://stamped.example/u/abc' },
    ]);
  });

  it('starts under review rather than pretending to be approved', () => {
    expect(buildLoyaltyClass(sampleContent(), CLASS_INPUT).reviewStatus).toBe('UNDER_REVIEW');
  });

  it('lets one person hold the card on more than one device', () => {
    // The restrictive setting is for transferable things like tickets. Here it
    // looks to the holder like their card vanishing when they change phone.
    expect(
      buildLoyaltyClass(sampleContent(), CLASS_INPUT).multipleDevicesAndHoldersAllowedStatus,
    ).toBe('MULTIPLE_HOLDERS');
  });
});

describe('the loyalty object', () => {
  it('is one person’s card', () => {
    const object = buildLoyaltyObject(sampleContent(), OBJECT_INPUT);

    expect(object.id).toBe('3388000000012345678.0f9d4b7a-3c21-4f7e-9c2a-8d5e6f1b2c3d');
    expect(object.classId).toBe('3388000000012345678.cafea-fidelitate');
    expect(object.state).toBe('ACTIVE');
    expect(object.accountName).toBe('Ana Popescu');
    expect(object.barcode).toEqual({
      type: 'QR_CODE',
      value: 'STMP-0F9D4B7A',
      alternateText: 'STMP-0F9D4B7A',
    });
  });

  it('shows a stamp count as written, because "7 / 10" is not a number', () => {
    const object = buildLoyaltyObject(sampleContent(), OBJECT_INPUT);

    expect(object.loyaltyPoints).toEqual({
      label: 'Recompensă',
      balance: { string: 'A 10-a cafea gratuită' },
    });
  });

  it('shows a points balance as an integer, which Google formats for the reader', () => {
    const object = buildLoyaltyObject(
      sampleContent({ primary: [{ key: 'points', label: 'Puncte', value: 1450 }] }),
      OBJECT_INPUT,
    );

    expect(object.loyaltyPoints).toEqual({ label: 'Puncte', balance: { int: 1450 } });
  });

  it('decides its state against a given moment rather than the clock', () => {
    const expiring = sampleContent({ expirationDate: new Date('2026-05-01T00:00:00Z') });

    expect(buildLoyaltyObject(expiring, OBJECT_INPUT).state).toBe('EXPIRED');
    expect(
      buildLoyaltyObject(expiring, { ...OBJECT_INPUT, now: new Date('2026-04-01T00:00:00Z') })
        .state,
    ).toBe('ACTIVE');
  });

  it('is inactive once the card has been voided', () => {
    expect(buildLoyaltyObject(sampleContent({ voided: true }), OBJECT_INPUT).state).toBe(
      'INACTIVE',
    );
  });

  it('has nothing to say about a holder who enrolled anonymously', () => {
    const object = buildLoyaltyObject(sampleContent({ holder: undefined }), OBJECT_INPUT);

    expect(object.accountName).toBeUndefined();
    expect(object.accountId).toBeUndefined();
  });

  it('refuses an identifier Google cannot hold', () => {
    /* The API answers this with a 400 naming the field and not the value. */
    let message = '';
    try {
      buildLoyaltyObject(sampleContent(), { ...OBJECT_INPUT, objectSuffix: 'ana@example.com' });
    } catch (error) {
      message = (error as { errors?: { message: string }[] }).errors?.[0]?.message ?? '';
    }

    expect(message).toMatch(/cannot be part of a Google Wallet identifier/);
    expect(message).toContain('an email address does not');
  });
});
