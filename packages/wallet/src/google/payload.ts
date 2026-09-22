import { ValidationError } from '@birtalanrobert/http';
import type { PassContent, PassField, Rgb } from '../content';

/**
 * Google's half of the same pass.
 *
 * Fed from the identical {@link PassContent}, and the differences are Google's
 * rather than ours. Three of them shape everything here:
 *
 * **Images are URIs, not bytes.** Google fetches them; Apple is handed them in
 * the archive. So this renderer takes the URLs of images the caller has already
 * published, and cannot be given the same `assets` the Apple side uses.
 *
 * **There is a class as well as an object.** The class is the programme — one
 * per loyalty programme — and the object is one person's card. A field put on
 * the wrong one either cannot vary per holder or has to be written two thousand
 * times.
 *
 * **Updates are direct writes.** No registration, no silent push, no device
 * dance. Which makes this side much the simpler of the two, and is worth saying
 * plainly so that nobody goes looking for the missing complexity.
 */

/**
 * `ACTIVE` unless the pass has been voided or has expired.
 *
 * The same four words on a loyalty object and an event ticket object — Google
 * shares the enumeration, and so does this.
 */
export type LoyaltyState = 'ACTIVE' | 'COMPLETED' | 'EXPIRED' | 'INACTIVE';

export interface GoogleIssuer {
  /** The numeric issuer identifier from the Google Wallet console. */
  issuerId: string;
  /** The business, as the holder knows it. */
  issuerName: string;
}

export interface LoyaltyClassInput extends GoogleIssuer {
  /** Unique within the issuer. The class id becomes `{issuerId}.{classSuffix}`. */
  classSuffix: string;
  programName: string;
  /** A published URL. Google fetches it; it is not uploaded through this. */
  programLogoUri?: string;
  heroImageUri?: string;
  /**
   * `UNDER_REVIEW` until Google approves the class, then `APPROVED`.
   *
   * A class left in `DRAFT` issues objects that install and show nothing to
   * anyone but the issuer's own test accounts, which is a confusing way to
   * discover the setting exists.
   */
  reviewStatus?: 'UNDER_REVIEW' | 'APPROVED' | 'DRAFT';
  /** ISO 3166-1 alpha-2, e.g. `RO`. Decides some of Google's own wording. */
  countryCode?: string;
}

export interface LoyaltyObjectInput {
  issuerId: string;
  /** Unique within the issuer; becomes `{issuerId}.{objectSuffix}`. */
  objectSuffix: string;
  classSuffix: string;
  /**
   * The moment the object's state is decided against.
   *
   * Injected rather than read from the clock, as everything else in this
   * programme that depends on time is: an object built for a card that expires
   * this afternoon is `ACTIVE` or `EXPIRED` depending on when the function ran,
   * and a test that cannot say which is a test that passes until it does not.
   */
  now: Date;
}

const ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Google's identifiers are `{issuerId}.{suffix}` and the suffix is constrained.
 *
 * Checked here rather than discovered at the API, because the failure there is a
 * 400 with a body that names the field and not the value, on a code path that
 * runs once per enrolment.
 */
function identifier(issuerId: string, suffix: string, field: string): string {
  if (!ID_SEGMENT.test(suffix)) {
    throw new ValidationError(
      [
        {
          field,
          message: `"${suffix}" cannot be part of a Google Wallet identifier. Letters, digits, full stops, underscores and hyphens only — a UUID qualifies, an email address does not.`,
          code: 'invalid_identifier',
        },
      ],
      'That identifier cannot be used.',
    );
  }
  return `${issuerId}.${suffix}`;
}

const hex = (colour: Rgb): string =>
  `#${[colour.r, colour.g, colour.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

const localized = (value: string, language = 'en') => ({
  defaultValue: { language, value },
});

/** The programme, written once. */
export function buildLoyaltyClass(
  content: PassContent,
  input: LoyaltyClassInput,
): Record<string, unknown> {
  const loyaltyClass: Record<string, unknown> = {
    id: identifier(input.issuerId, input.classSuffix, 'classSuffix'),
    issuerName: input.issuerName,
    programName: input.programName,
    reviewStatus: input.reviewStatus ?? 'UNDER_REVIEW',
    hexBackgroundColor: hex(content.colours.background),
    /*
     * One holder, several devices — a phone and a watch, or a replaced handset.
     * The restrictive setting exists for transferable things like event tickets
     * and is wrong for a loyalty card, where it looks to the holder like the
     * card vanishing when they change phone.
     */
    multipleDevicesAndHoldersAllowedStatus: 'MULTIPLE_HOLDERS',
  };

  if (input.countryCode) loyaltyClass.countryCode = input.countryCode;

  if (input.programLogoUri) {
    loyaltyClass.programLogo = {
      sourceUri: { uri: input.programLogoUri },
      contentDescription: localized(`${input.programName} logo`),
    };
  }

  if (input.heroImageUri) {
    loyaltyClass.heroImage = {
      sourceUri: { uri: input.heroImageUri },
      contentDescription: localized(input.programName),
    };
  }

  if (content.locations?.length) {
    loyaltyClass.locations = content.locations.map((place) => ({
      latitude: place.latitude,
      longitude: place.longitude,
    }));
  }

  /*
   * The back of the pass — terms, the expiry disclosure, contact details — is a
   * property of the programme rather than of one card, so it belongs on the
   * class. Putting it on the object writes the same paragraph once per holder
   * and makes changing a term a two-thousand-row update.
   */
  const modules = content.back?.map(textModule).filter(Boolean);
  if (modules?.length) loyaltyClass.textModulesData = modules;

  return loyaltyClass;
}

/** One person's card. */
export function buildLoyaltyObject(
  content: PassContent,
  input: LoyaltyObjectInput,
): Record<string, unknown> {
  const object: Record<string, unknown> = {
    id: identifier(input.issuerId, input.objectSuffix, 'objectSuffix'),
    classId: identifier(input.issuerId, input.classSuffix, 'classSuffix'),
    state: stateOf(content, input.now),
  };

  if (content.holder?.name) object.accountName = content.holder.name;
  if (content.holder?.accountId) object.accountId = content.holder.accountId;

  const primary = content.primary?.[0];
  if (primary) object.loyaltyPoints = points(primary);

  const secondary = content.secondary?.[0];
  if (secondary) object.secondaryLoyaltyPoints = points(secondary);

  if (content.barcode) {
    object.barcode = {
      type: BARCODE_TYPES[content.barcode.format],
      value: content.barcode.message,
      ...(content.barcode.altText !== undefined ? { alternateText: content.barcode.altText } : {}),
    };
  }

  if (content.locations?.length) {
    object.locations = content.locations.map((place) => ({
      latitude: place.latitude,
      longitude: place.longitude,
    }));
  }

  if (content.expirationDate) {
    object.validTimeInterval = { end: { date: content.expirationDate.toISOString() } };
  }

  return object;
}

export interface EventTicketClassInput extends GoogleIssuer {
  /** Unique within the issuer. The class id becomes `{issuerId}.{classSuffix}`. */
  classSuffix: string;
  /** The event, as it is advertised. One class per performance, not per run. */
  eventName: string;
  /** Where it is. Google renders the name; the address is what maps open. */
  venueName?: string;
  venueAddress?: string;
  /** When it starts, and when it is over. Both in the venue's own zone. */
  startsAt?: Date;
  endsAt?: Date;
  /** The venue's clock, as an IANA zone. Without it Google reads the times as UTC. */
  timezone?: string;
  logoUri?: string;
  heroImageUri?: string;
  reviewStatus?: 'UNDER_REVIEW' | 'APPROVED' | 'DRAFT';
  countryCode?: string;
}

export interface EventTicketObjectInput {
  issuerId: string;
  objectSuffix: string;
  classSuffix: string;
  /** What a door reads out when the barcode will not scan. */
  ticketNumber?: string;
  /** Where the holder sits. Any of them may be absent — a terrace has none. */
  seat?: { section?: string; row?: string; seat?: string; gate?: string };
  /** See {@link LoyaltyObjectInput.now}: injected rather than read from a clock. */
  now: Date;
}

/**
 * The performance, written once.
 *
 * **A class per event rather than per production**, because Google puts the
 * date, the venue and the name on the class and an object cannot override them:
 * a season of *Hamlet* sharing one class would show every holder the first
 * night's date.
 *
 * The second consumer of this package is what produced it. A loyalty programme
 * and an event are both "the thing a pass belongs to", and everything about how
 * they are built, signed and saved is shared — but Google models them as
 * different classes with different fields, and a ticket rendered as a loyalty
 * card shows a balance where its seat should be.
 */
export function buildEventTicketClass(
  content: PassContent,
  input: EventTicketClassInput,
): Record<string, unknown> {
  const ticketClass: Record<string, unknown> = {
    id: identifier(input.issuerId, input.classSuffix, 'classSuffix'),
    issuerName: input.issuerName,
    eventName: localized(input.eventName),
    reviewStatus: input.reviewStatus ?? 'UNDER_REVIEW',
    hexBackgroundColor: hex(content.colours.background),
    /*
     * `ONE_USER_ALL_DEVICES`, and the difference from a loyalty card is the
     * point of the setting.
     *
     * A stamp card is `MULTIPLE_HOLDERS`, because a card that vanished when
     * somebody changed phone looks broken. A ticket admits one person once, and
     * a pass that could be held by several people at once is the screenshot
     * problem with Google's blessing. Passing one on is `transfer.service.ts`'s
     * job, where the old code is revoked as the new one is issued.
     */
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
  };

  if (input.countryCode) ticketClass.countryCode = input.countryCode;

  if (input.venueName) {
    ticketClass.venue = {
      name: localized(input.venueName),
      ...(input.venueAddress ? { address: localized(input.venueAddress) } : {}),
    };
  }

  /*
   * Written with the venue's own offset, not as UTC.
   *
   * Google renders these as the times printed on the ticket, and an instant
   * ending in `Z` is shown to a holder in Bucharest two hours early — the kind
   * of mistake that looks perfectly right to whoever is in the timezone the
   * code was written in, and sends somebody to a theatre after the interval.
   */
  if (input.startsAt || input.endsAt) {
    ticketClass.dateTime = {
      ...(input.startsAt ? { start: withOffset(input.startsAt, input.timezone) } : {}),
      ...(input.endsAt ? { end: withOffset(input.endsAt, input.timezone) } : {}),
    };
  }

  if (input.logoUri) {
    ticketClass.logo = {
      sourceUri: { uri: input.logoUri },
      contentDescription: localized(`${input.issuerName} logo`),
    };
  }

  if (input.heroImageUri) {
    ticketClass.heroImage = {
      sourceUri: { uri: input.heroImageUri },
      contentDescription: localized(input.eventName),
    };
  }

  if (content.locations?.length) {
    ticketClass.locations = content.locations.map((place) => ({
      latitude: place.latitude,
      longitude: place.longitude,
    }));
  }

  /* The back of the pass — terms, contact details — belongs to the event rather
     than to one holder, for the same reason it belongs to a programme. */
  const modules = content.back?.map(textModule).filter(Boolean);
  if (modules?.length) ticketClass.textModulesData = modules;

  return ticketClass;
}

/** One person's ticket. */
export function buildEventTicketObject(
  content: PassContent,
  input: EventTicketObjectInput,
): Record<string, unknown> {
  const object: Record<string, unknown> = {
    id: identifier(input.issuerId, input.objectSuffix, 'objectSuffix'),
    classId: identifier(input.issuerId, input.classSuffix, 'classSuffix'),
    state: stateOf(content, input.now),
  };

  if (content.holder?.name) object.ticketHolderName = content.holder.name;
  if (input.ticketNumber) object.ticketNumber = input.ticketNumber;

  /*
   * Only what there is.
   *
   * A terrace has no row and no seat, and Google renders an empty `seat` as a
   * labelled blank — which on a standing ticket reads as information that has
   * gone missing rather than information that never existed.
   */
  const seat = Object.entries(input.seat ?? {}).filter(([, value]) => Boolean(value));
  if (seat.length > 0) {
    object.seatInfo = Object.fromEntries(
      seat.map(([key, value]) => [key, localized(String(value))]),
    );
  }

  if (content.barcode) {
    object.barcode = {
      type: BARCODE_TYPES[content.barcode.format],
      value: content.barcode.message,
      ...(content.barcode.altText !== undefined ? { alternateText: content.barcode.altText } : {}),
    };
  }

  if (content.locations?.length) {
    object.locations = content.locations.map((place) => ({
      latitude: place.latitude,
      longitude: place.longitude,
    }));
  }

  if (content.expirationDate) {
    object.validTimeInterval = { end: { date: content.expirationDate.toISOString() } };
  }

  return object;
}

const BARCODE_TYPES = {
  qr: 'QR_CODE',
  pdf417: 'PDF_417',
  aztec: 'AZTEC',
  code128: 'CODE_128',
} as const;

/**
 * A balance, in Google's shape.
 *
 * `balance.string` rather than `balance.int` even for a number of stamps: the
 * label and the value are shown together and "7 of 10" is a string, while `int`
 * renders a bare 7 with no way to say what it is out of. `int` is right for a
 * points programme, which is why the caller decides by what it puts in the
 * field rather than by a flag here.
 */
function points(field: PassField): Record<string, unknown> {
  const balance =
    typeof field.value === 'number' && Number.isInteger(field.value)
      ? { int: field.value }
      : { string: String(field.value) };

  return {
    ...(field.label !== undefined ? { label: field.label } : {}),
    balance,
  };
}

function textModule(field: PassField): Record<string, unknown> | null {
  if (field.value === undefined || field.value === null) return null;
  return {
    id: field.key,
    ...(field.label !== undefined ? { header: field.label } : {}),
    body: String(field.value),
  };
}

/**
 * An instant as wall-clock time in a zone, with the offset written out.
 *
 * `2027-11-14T19:30:00+02:00` rather than `2027-11-14T17:30:00Z`. Both name the
 * same moment and only one of them is what a ticket says, which is what Google
 * shows the holder.
 *
 * Built from `Intl` rather than from a table: the offset on a given date is a
 * property of that date — a performance on the last Sunday in October is an
 * hour away from one the week before, and a fixed offset per venue gets that
 * night wrong every year.
 */
function withOffset(at: Date, timezone: string | undefined): string {
  if (!timezone) return at.toISOString();

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(at);

  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  /* `GMT+02:00`, or bare `GMT` at zero — where ISO 8601 wants `+00:00`. */
  const zone = read('timeZoneName').replace('GMT', '') || '+00:00';
  /* Midnight comes back as `24` in some runtimes, which is a valid hour in the
     Intl sense and not one ISO 8601 accepts. */
  const hour = read('hour') === '24' ? '00' : read('hour');

  return `${read('year')}-${read('month')}-${read('day')}T${hour}:${read('minute')}:${read('second')}${zone}`;
}

function stateOf(content: PassContent, now: Date): LoyaltyState {
  if (content.voided) return 'INACTIVE';
  if (content.expirationDate && content.expirationDate.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}
