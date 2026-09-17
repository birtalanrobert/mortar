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

/** `ACTIVE` unless the pass has been voided or has expired. */
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

function stateOf(content: PassContent, now: Date): LoyaltyState {
  if (content.voided) return 'INACTIVE';
  if (content.expirationDate && content.expirationDate.getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}
