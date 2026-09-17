import type { PassContent, PassField, Rgb } from '../content';
import { BARCODE_FORMATS, DEFAULT_BARCODE_ENCODING } from './rules';

/**
 * The identity of the certificate a pass is signed with.
 *
 * Both values live in the Pass Type ID certificate and both must appear in
 * `pass.json` — a pass whose `teamIdentifier` disagrees with its signature is
 * refused by the device with no explanation. They are read from the certificate
 * rather than configured separately, so the two cannot drift apart.
 */
export interface PassIdentity {
  passTypeIdentifier: string;
  teamIdentifier: string;
}

/** The shape written to `pass.json`. Loose on purpose: it is a serialisation, not an API. */
export type PassJson = Record<string, unknown>;

const rgb = (colour: Rgb): string => `rgb(${colour.r}, ${colour.g}, ${colour.b})`;

/**
 * Apple's date format is ISO 8601 with an offset.
 *
 * `toISOString` gives `Z`, which is a valid offset and is what we want: a pass
 * carries an instant, and rendering it in the reader's zone is the device's job.
 */
const instant = (date: Date): string => date.toISOString();

function field(source: PassField): Record<string, unknown> {
  const out: Record<string, unknown> = { key: source.key, value: source.value };

  if (source.label !== undefined) out.label = source.label;
  if (source.changeMessage !== undefined) out.changeMessage = source.changeMessage;
  if (source.dateStyle) out.dateStyle = `PKDateStyle${capitalise(source.dateStyle)}`;
  if (source.timeStyle) out.timeStyle = `PKDateStyle${capitalise(source.timeStyle)}`;
  if (source.numberStyle) out.numberStyle = `PKNumberStyle${capitalise(source.numberStyle)}`;
  if (source.currencyCode) out.currencyCode = source.currencyCode;
  if (source.alignment) out.textAlignment = `PKTextAlignment${capitalise(source.alignment)}`;

  return out;
}

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * `PassContent` rendered as the `pass.json` Apple reads.
 *
 * Deterministic: the same content and the same identity produce byte-identical
 * output, with no clock and no random in it. That is not tidiness — the manifest
 * hashes this file, so a second build of unchanged content has to produce the
 * same bytes or every rebuild looks to the device like a change.
 */
export function buildPassJson(content: PassContent, identity: PassIdentity): PassJson {
  const pass: PassJson = {
    formatVersion: 1,
    passTypeIdentifier: identity.passTypeIdentifier,
    teamIdentifier: identity.teamIdentifier,
    serialNumber: content.serialNumber,
    organizationName: content.organizationName,
    description: content.description,
    backgroundColor: rgb(content.colours.background),
    foregroundColor: rgb(content.colours.foreground),
  };

  if (content.colours.label) pass.labelColor = rgb(content.colours.label);
  if (content.colours.stripText) pass.stripColor = rgb(content.colours.stripText);
  if (content.logoText !== undefined) pass.logoText = content.logoText;

  const style: Record<string, unknown> = {};
  if (content.header?.length) style.headerFields = content.header.map(field);
  if (content.primary?.length) style.primaryFields = content.primary.map(field);
  if (content.secondary?.length) style.secondaryFields = content.secondary.map(field);
  if (content.auxiliary?.length) style.auxiliaryFields = content.auxiliary.map(field);
  if (content.back?.length) style.backFields = content.back.map(field);
  pass[content.style] = style;

  if (content.barcode) {
    /*
     * The plural key only. The singular `barcode` was how iOS 8 and earlier read
     * this, and writing both is the standard way to carry a pass back nine major
     * versions — which is not a compatibility this product buys, and a
     * superseded key written on purpose is still a superseded key.
     */
    pass.barcodes = [
      {
        format: BARCODE_FORMATS[content.barcode.format],
        message: content.barcode.message,
        messageEncoding: content.barcode.encoding ?? DEFAULT_BARCODE_ENCODING,
        ...(content.barcode.altText !== undefined ? { altText: content.barcode.altText } : {}),
      },
    ];
  }

  if (content.locations?.length) {
    pass.locations = content.locations.map((place) => ({
      latitude: place.latitude,
      longitude: place.longitude,
      ...(place.altitude !== undefined ? { altitude: place.altitude } : {}),
      ...(place.relevantText !== undefined ? { relevantText: place.relevantText } : {}),
    }));
  }

  if (content.maxDistance !== undefined) pass.maxDistance = content.maxDistance;
  if (content.relevantDate) pass.relevantDate = instant(content.relevantDate);
  if (content.expirationDate) pass.expirationDate = instant(content.expirationDate);
  if (content.voided) pass.voided = true;

  /*
   * Defaults to prohibited for the two styles that are worth copying. A stamp
   * card that can be handed to a friend is a screenshot in a group chat, which
   * is the same reason the scanner reads the customer's code rather than the
   * customer reading a code on the counter.
   */
  const shareable =
    content.shareable ?? !(content.style === 'storeCard' || content.style === 'coupon');
  if (!shareable) pass.sharingProhibited = true;

  if (content.webService) {
    pass.webServiceURL = content.webService.url;
    pass.authenticationToken = content.webService.authenticationToken;
  }

  return pass;
}

/**
 * `pass.strings` for one locale.
 *
 * The format is a sequence of `"key" = "value";` lines, and the escaping is the
 * part worth having in one place: an unescaped quotation mark in a business name
 * — `Joe's "Best" Coffee` — ends the string early and takes the rest of the file
 * with it.
 */
export function buildPassStrings(entries: Record<string, string>): string {
  return (
    Object.entries(entries)
      /* Sorted, because a JSON object's order is not something to hash. */
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `"${escapeStrings(key)}" = "${escapeStrings(value)}";`)
      .join('\n') + '\n'
  );
}

const escapeStrings = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
