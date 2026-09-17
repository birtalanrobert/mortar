/**
 * Everything Apple requires of a pass, in one file, with a citation per rule.
 *
 * This is the substitute for a device. Nothing here can be proved by installing
 * a pass on a phone we do not have, so the rules the phone would apply are
 * written down and applied first — which catches the same failures earlier and
 * for every pass rather than for one.
 *
 * **Two obligations come with that.**
 *
 * The first is the citation. Every rule names the published requirement it
 * encodes, so a reader can check it rather than trust it, and a rule nobody can
 * source is a rule somebody invented.
 *
 * The second is {@link RULES_REVIEWED}. Apple and Google change wallet
 * requirements without much notice, and the usual defence is a canary that
 * installs a real pass daily and fails when they do. There is no canary here, so
 * the defence is weaker and is written down as weaker: a human reads the current
 * requirements on a schedule and this file changes when they have. It is the
 * plan's own weakest mitigation, and it is listed as such there too.
 */

/**
 * When the rules below were last read against Apple's published documentation.
 *
 * Bumped **only** by somebody who has actually re-read them. The renewal
 * runbook carries the obligation and the calendar carries the date, because
 * software that reminds itself is software that stops reminding itself the day
 * it breaks.
 */
export const RULES_REVIEWED = '2026-09-17';

/** Where a rule comes from. */
export interface Citation {
  /** The document, named as a reader would search for it. */
  source: string;
  /** Anything a reader needs that the source does not say plainly. */
  note?: string;
}

export interface Rule {
  id: string;
  citation: Citation;
}

const APPLE_PASS = 'Apple Developer — Wallet Passes: Pass (pass.json top-level keys)';
const APPLE_FIELDS = 'Apple Developer — Wallet Passes: PassFieldContent';
const APPLE_BARCODES = 'Apple Developer — Wallet Passes: Pass.Barcodes';
const APPLE_LOCATIONS = 'Apple Developer — Wallet Passes: Pass.Locations';
const APPLE_WEBSERVICE = 'Apple Developer — Wallet Passes: Adding a Web Service to Update Passes';
const APPLE_ASSETS = 'Apple Developer — Wallet Passes: Pass Design and Creation (image sizes)';
const APPLE_PACKAGE = 'Apple Developer — Wallet Passes: Building a Pass (manifest and signature)';

/** The rules, as data, so a README and a test can both enumerate them. */
export const RULES = {
  formatVersion: {
    id: 'format-version',
    citation: { source: APPLE_PASS, note: 'formatVersion is 1 and there has never been another.' },
  },
  requiredKeys: {
    id: 'required-keys',
    citation: {
      source: APPLE_PASS,
      note: 'description, formatVersion, organizationName, passTypeIdentifier, serialNumber and teamIdentifier are all required.',
    },
  },
  singleStyle: {
    id: 'single-style',
    citation: {
      source: APPLE_PASS,
      note: 'Exactly one of boardingPass, coupon, eventTicket, generic or storeCard.',
    },
  },
  colourSyntax: {
    id: 'colour-syntax',
    citation: {
      source: APPLE_PASS,
      note: 'Colours are a CSS-style RGB triple, e.g. rgb(23, 187, 82). Written from a typed triple here so the string cannot be malformed; the check guards a hand-edited pass.json.',
    },
  },
  fieldKeysUnique: {
    id: 'field-keys-unique',
    citation: {
      source: APPLE_FIELDS,
      note: 'A field key must be unique within the pass. Duplicates make the device diff the wrong field on update.',
    },
  },
  changeMessagePlaceholder: {
    id: 'change-message-placeholder',
    citation: {
      source: APPLE_FIELDS,
      note: 'changeMessage must contain %@, where the new value is substituted. Without it the message is never shown — silently.',
    },
  },
  fieldCounts: {
    id: 'field-counts',
    citation: {
      source: 'Apple Developer — Wallet Passes: Pass Design and Creation (layout per style)',
      note: 'Apple truncates rather than refuses, so this is our rule enforced against their layout: a field that is silently dropped is worse than a build that fails.',
    },
  },
  barcodeFormat: {
    id: 'barcode-format',
    citation: {
      source: APPLE_BARCODES,
      note: 'PKBarcodeFormatQR, PKBarcodeFormatPDF417, PKBarcodeFormatAztec or PKBarcodeFormatCode128. Only the plural `barcodes` key is written: the singular `barcode` has been superseded since iOS 9.',
    },
  },
  barcodeEncodable: {
    id: 'barcode-encodable',
    citation: {
      source: APPLE_BARCODES,
      note: 'The message must be representable in messageEncoding. Defaulting to iso-8859-1 and then putting a non-Latin-1 character in it produces a barcode no scanner reads.',
    },
  },
  locationCount: {
    id: 'location-count',
    citation: { source: APPLE_LOCATIONS, note: 'At most ten locations per pass.' },
  },
  locationRange: {
    id: 'location-range',
    citation: {
      source: APPLE_LOCATIONS,
      note: 'Latitude -90..90, longitude -180..180. A transposed pair is a valid-looking pass that surfaces in the sea.',
    },
  },
  webServiceHttps: {
    id: 'web-service-https',
    citation: {
      source: APPLE_WEBSERVICE,
      note: 'webServiceURL must be HTTPS, and is required whenever authenticationToken is present. Neither is useful alone.',
    },
  },
  authenticationTokenLength: {
    id: 'authentication-token-length',
    citation: {
      source: APPLE_WEBSERVICE,
      note: 'At least sixteen characters. It is a per-pass secret, so the floor is a minimum rather than a target.',
    },
  },
  iconRequired: {
    id: 'icon-required',
    citation: {
      source: APPLE_ASSETS,
      note: 'icon.png is required. A pass without one installs and then shows nothing in notifications.',
    },
  },
  styleAssets: {
    id: 'style-assets',
    citation: {
      source: APPLE_ASSETS,
      note: 'A storeCard and a coupon draw their band from strip.png; an eventTicket uses a background or a thumbnail. Our rule: a style is given the image its layout is built around.',
    },
  },
  densityMultiples: {
    id: 'density-multiples',
    citation: {
      source: APPLE_ASSETS,
      note: '@2x and @3x are exactly two and three times the base in both dimensions. Apple scales what it is given, so a mismatch is a blurred image rather than an error.',
    },
  },
  pngOnly: {
    id: 'png-only',
    citation: { source: APPLE_ASSETS, note: 'Pass images are PNG.' },
  },
  manifestCoversArchive: {
    id: 'manifest-covers-archive',
    citation: {
      source: APPLE_PACKAGE,
      note: 'manifest.json holds the SHA-1 of every file in the archive. Checked in both directions here: a file present and unhashed fails on the device with no useful message.',
    },
  },
  signatureVerifies: {
    id: 'signature-verifies',
    citation: {
      source: APPLE_PACKAGE,
      note: 'signature is a detached PKCS#7 over the bytes of manifest.json, signed with the Pass Type ID certificate and chaining to Apple’s root through the WWDR intermediate.',
    },
  },
} as const satisfies Record<string, Rule>;

export type RuleName = keyof typeof RULES;

/** One thing wrong with a pass, said in the words somebody can act on. */
export interface PassProblem {
  rule: RuleName;
  /** Where in the pass, e.g. `primaryFields[0].changeMessage` or `strip@2x`. */
  path: string;
  message: string;
}

/**
 * How many fields of each kind a style's layout holds.
 *
 * `back` is absent because it scrolls and has no limit. `primary` differs by
 * style, which is the one that bites: two primary fields on a `storeCard` shows
 * one of them, and which one is not documented.
 */
export const FIELD_LIMITS: Record<
  import('../content').PassStyle,
  { header: number; primary: number; secondary: number; auxiliary: number }
> = {
  storeCard: { header: 3, primary: 1, secondary: 4, auxiliary: 4 },
  coupon: { header: 3, primary: 1, secondary: 4, auxiliary: 4 },
  eventTicket: { header: 3, primary: 1, secondary: 4, auxiliary: 4 },
  generic: { header: 3, primary: 1, secondary: 4, auxiliary: 4 },
  boardingPass: { header: 3, primary: 2, secondary: 4, auxiliary: 4 },
};

/**
 * The image each style's layout is built around, beyond the required icon.
 *
 * Empty for `generic` and `boardingPass`, which lay out from their fields alone.
 */
export const STYLE_ASSETS: Record<
  import('../content').PassStyle,
  readonly ('strip' | 'background' | 'thumbnail')[]
> = {
  storeCard: ['strip'],
  coupon: ['strip'],
  eventTicket: [],
  generic: [],
  boardingPass: [],
};

/** Pixel dimensions of each image at 1x, as Apple publishes them. */
export const ASSET_SIZES: Record<string, { width: number; height: number }> = {
  icon: { width: 29, height: 29 },
  logo: { width: 160, height: 50 },
  strip: { width: 375, height: 123 },
  background: { width: 180, height: 220 },
  thumbnail: { width: 90, height: 90 },
  footer: { width: 286, height: 15 },
};

export const MAX_LOCATIONS = 10;
export const MIN_AUTHENTICATION_TOKEN = 16;

export const BARCODE_FORMATS = {
  qr: 'PKBarcodeFormatQR',
  pdf417: 'PKBarcodeFormatPDF417',
  aztec: 'PKBarcodeFormatAztec',
  code128: 'PKBarcodeFormatCode128',
} as const;

export const DEFAULT_BARCODE_ENCODING = 'iso-8859-1';
