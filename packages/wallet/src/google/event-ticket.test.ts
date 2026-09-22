import { describe, expect, it } from 'vitest';
import { sampleContent } from '../testing';
import { buildEventTicketClass, buildEventTicketObject } from './payload';

const NOW = new Date('2026-06-01T09:00:00Z');

/** A Romanian theatre, because the zone is half of what this has to get right. */
const CLASS_INPUT = {
  issuerId: '3388000000012345678',
  issuerName: 'Teatrul Național',
  classSuffix: 'hamlet-2027-11-14',
  eventName: 'Hamlet',
  venueName: 'Sala Mare',
  venueAddress: 'Piața Teatrului 1, Cluj-Napoca',
  startsAt: new Date('2027-11-14T17:30:00Z'),
  timezone: 'Europe/Bucharest',
};

const OBJECT_INPUT = {
  issuerId: '3388000000012345678',
  classSuffix: 'hamlet-2027-11-14',
  objectSuffix: '0f9d4b7a-3c21-4f7e-9c2a-8d5e6f1b2c3d',
  now: NOW,
};

describe('the event ticket class', () => {
  it('is the performance, and carries what every holder shares', () => {
    const ticketClass = buildEventTicketClass(sampleContent(), CLASS_INPUT);

    expect(ticketClass.id).toBe('3388000000012345678.hamlet-2027-11-14');
    expect(ticketClass.eventName).toEqual({
      defaultValue: { language: 'en', value: 'Hamlet' },
    });
    expect(ticketClass.venue).toEqual({
      name: { defaultValue: { language: 'en', value: 'Sala Mare' } },
      address: {
        defaultValue: { language: 'en', value: 'Piața Teatrului 1, Cluj-Napoca' },
      },
    });
  });

  /**
   * The whole reason the zone is an argument.
   *
   * `2027-11-14T17:30:00Z` and `2027-11-14T19:30:00+02:00` name the same
   * moment, and only the second is what the ticket says. A holder shown the
   * first arrives after the interval — and it looks perfectly right to whoever
   * wrote the code, because they are in a different timezone.
   */
  it('writes the time with the venue’s own offset', () => {
    const ticketClass = buildEventTicketClass(sampleContent(), CLASS_INPUT);

    expect(ticketClass.dateTime).toEqual({ start: '2027-11-14T19:30:00+02:00' });
  });

  /**
   * And the offset is a property of the date rather than of the venue: a
   * performance on the last Sunday in October is an hour from one the week
   * before, and a fixed offset per venue gets that night wrong every year.
   */
  it('follows the clock change rather than a fixed offset', () => {
    const summer = buildEventTicketClass(sampleContent(), {
      ...CLASS_INPUT,
      startsAt: new Date('2027-07-14T16:30:00Z'),
    });

    expect(summer.dateTime).toEqual({ start: '2027-07-14T19:30:00+03:00' });
  });

  it('falls back to the instant when no zone is given', () => {
    const ticketClass = buildEventTicketClass(sampleContent(), {
      ...CLASS_INPUT,
      timezone: undefined,
    });

    expect(ticketClass.dateTime).toEqual({ start: '2027-11-14T17:30:00.000Z' });
  });

  /**
   * The setting that differs from a loyalty card, and the difference is the
   * point of it: a stamp card that vanished when somebody changed phone looks
   * broken, and a ticket several people can hold at once is the screenshot
   * problem with Google's blessing.
   */
  it('admits one holder rather than several', () => {
    expect(
      buildEventTicketClass(sampleContent(), CLASS_INPUT).multipleDevicesAndHoldersAllowedStatus,
    ).toBe('ONE_USER_ALL_DEVICES');
  });
});

describe('the event ticket object', () => {
  it('names the holder, the reference and the seat', () => {
    const object = buildEventTicketObject(sampleContent(), {
      ...OBJECT_INPUT,
      ticketNumber: 'ABCDE-FGHJK-2MNPQ',
      seat: { section: 'Stalls', row: 'A', seat: '3' },
    });

    expect(object.classId).toBe('3388000000012345678.hamlet-2027-11-14');
    expect(object.ticketNumber).toBe('ABCDE-FGHJK-2MNPQ');
    expect(object.seatInfo).toEqual({
      section: { defaultValue: { language: 'en', value: 'Stalls' } },
      row: { defaultValue: { language: 'en', value: 'A' } },
      seat: { defaultValue: { language: 'en', value: '3' } },
    });
  });

  /**
   * A terrace has no row and no seat. Google renders an empty `seat` as a
   * labelled blank, which reads as information that has gone missing rather
   * than information that never existed.
   */
  it('leaves out a seat a standing ticket does not have', () => {
    const object = buildEventTicketObject(sampleContent(), {
      ...OBJECT_INPUT,
      seat: { section: 'Terrace' },
    });

    expect(object.seatInfo).toEqual({
      section: { defaultValue: { language: 'en', value: 'Terrace' } },
    });
  });

  it('carries no seat at all where there is nothing to say', () => {
    expect(buildEventTicketObject(sampleContent(), OBJECT_INPUT).seatInfo).toBeUndefined();
  });

  /** A revoked ticket still installs and still says it is void: a wallet that
      kept showing the last good copy would be a code somebody presents. */
  it('is inactive once the ticket has been voided', () => {
    const object = buildEventTicketObject({ ...sampleContent(), voided: true }, OBJECT_INPUT);

    expect(object.state).toBe('INACTIVE');
  });
});
