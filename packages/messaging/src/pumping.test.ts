import { describe, expect, it } from 'vitest';
import { assessSmsRisk, countryCodeOf } from './pumping';

const base = {
  phone: '+40722123456',
  sentThisHour: 0,
  countriesToday: ['+40'],
  segments: 2,
};

describe('assessSmsRisk', () => {
  it('lets a firm chase their own clients', () => {
    expect(assessSmsRisk(base)).toEqual({ allowed: true, country: '+40' });
  });

  it('refuses a range that is never a person’s mobile', () => {
    /*
     * The fraud this product's shape invites.
     *
     * The operator of a satellite or "global" range shares the termination fee
     * with whoever generates the traffic, so a message sent there is a payment
     * to the person who caused it. No accountant's client is on `+882`.
     */
    expect(assessSmsRisk({ ...base, phone: '+882345678901' })).toMatchObject({
      allowed: false,
      refusal: 'premium_range',
    });
    expect(assessSmsRisk({ ...base, phone: '+870123456789' }).allowed).toBe(false);
  });

  it('refuses a number nobody can place', () => {
    // `0722…` is Romanian, Italian or neither depending on who reads it, and
    // guessing from the firm's own country is how a message goes somewhere
    // nobody intended.
    expect(assessSmsRisk({ ...base, phone: '0722123456' })).toMatchObject({
      allowed: false,
      refusal: 'not_international',
    });
  });

  it('stops a firm sending fifty text messages an hour', () => {
    // Far above what chasing produces, and far below what makes fraud worth
    // committing.
    expect(assessSmsRisk({ ...base, sentThisHour: 49, segments: 2 })).toMatchObject({
      allowed: false,
      refusal: 'hourly_cap',
    });
    expect(assessSmsRisk({ ...base, sentThisHour: 40, segments: 2 }).allowed).toBe(true);
  });

  it('counts segments rather than messages against the cap', () => {
    // A Romanian reminder with its diacritics is two segments and costs twice
    // as much to send, so it should count twice towards a spending limit.
    expect(assessSmsRisk({ ...base, sentThisHour: 49, segments: 1 }).allowed).toBe(true);
  });

  it('lets a firm keep sending to countries it already writes to', () => {
    const risk = assessSmsRisk({
      ...base,
      phone: '+39331234567',
      countriesToday: ['+40', '+39', '+44'],
    });

    // An accountant in Cluj with clients in Italy and the United Kingdom is
    // ordinary, and hitting the cap on a country they already use would be a
    // false positive on the third reminder of a normal week.
    expect(risk.allowed).toBe(true);
  });

  it('stops a list assembled to spread across countries', () => {
    const risk = assessSmsRisk({
      ...base,
      phone: '+2348012345678',
      countriesToday: ['+40', '+39', '+44'],
    });

    // Three countries in a day is generous for a firm's client list and
    // implausible for numbers gathered to generate termination fees.
    expect(risk).toMatchObject({ allowed: false, refusal: 'country_spread' });
  });

  it('can be loosened for a firm that genuinely works everywhere', () => {
    // An immigration adviser is exactly that firm, and a rule with no way to
    // raise it becomes a support ticket rather than a control.
    expect(
      assessSmsRisk({
        ...base,
        phone: '+2348012345678',
        countriesToday: ['+40', '+39', '+44'],
        countryCap: 20,
      }).allowed,
    ).toBe(true);
  });
});

describe('countryCodeOf', () => {
  it('reads the codes it needs to tell apart', () => {
    expect(countryCodeOf('+40722123456')).toBe('+40');
    expect(countryCodeOf('+36301234567')).toBe('+36');
    expect(countryCodeOf('+447700900123')).toBe('+44');
    expect(countryCodeOf('+12025550123')).toBe('+1');
    expect(countryCodeOf('+882345678901')).toBe('+882');
  });

  it('says so when it cannot tell', () => {
    // Used for counting distinct prefixes rather than naming countries, so
    // "unknown" is an answer rather than a failure.
    expect(countryCodeOf('0722123456')).toBe('unknown');
  });
});
