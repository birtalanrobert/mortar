/**
 * What a pass says, before either platform has been asked to render it.
 *
 * Both Apple and Google are given the *same* object. A stamp card and an event
 * ticket differ in what goes in the fields, not in the shape of this type,
 * which is the reason this package exists once rather than twice.
 *
 * Nothing here is platform vocabulary. `primary` is not `primaryFields`, and
 * `balance` is not `loyaltyPoints` — the renderers own those names, because the
 * day one platform renames something is the day exactly one file changes.
 */

/**
 * The pass styles this package renders.
 *
 * Apple's word, because there is no neutral one — Google models the same
 * distinction as separate object *types* rather than as a key. `storeCard` is a
 * loyalty card (project 06) and `eventTicket` is a ticket (project 01); the rest
 * are carried because they cost nothing and their absence would be discovered at
 * the worst moment.
 */
export type PassStyle = 'storeCard' | 'eventTicket' | 'coupon' | 'generic' | 'boardingPass';

/** How a value is presented. Left unset, a value is shown as it is written. */
export interface FieldFormat {
  dateStyle?: 'none' | 'short' | 'medium' | 'long' | 'full';
  timeStyle?: 'none' | 'short' | 'medium' | 'long' | 'full';
  numberStyle?: 'decimal' | 'percent' | 'scientific' | 'spellOut';
  /** ISO 4217. Turns the value into money, formatted for the reader's locale. */
  currencyCode?: string;
  alignment?: 'left' | 'center' | 'right' | 'natural';
}

export interface PassField extends FieldFormat {
  /**
   * Unique within the pass, and **stable across updates**.
   *
   * It is what the device compares to decide that a value changed, so a key
   * generated per render makes every field look new and every update look like
   * a rebuild. Wallet holds passes by serial and diffs by key.
   */
  key: string;
  label?: string;
  value: string | number;
  /**
   * What the lock screen says when this field changes, e.g. `'%@ stamps now'`.
   *
   * The `%@` is not decoration — it is where the new value is substituted, and a
   * message without it is silently never shown. This is also the *only* way a
   * pass speaks to its holder: there is no separate notification channel, which
   * is why a campaign in project 06 is a field change (see the package README).
   */
  changeMessage?: string;
}

/** Somewhere the pass should surface on a lock screen. */
export interface PassLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
  /** Shown on the lock screen when the holder is there. */
  relevantText?: string;
}

export interface PassBarcode {
  format: 'qr' | 'pdf417' | 'aztec' | 'code128';
  /** What a scanner reads. In project 06 this identifies one card, nothing else. */
  message: string;
  /** Printed under the barcode, for a staff member typing it in by hand. */
  altText?: string;
  /**
   * Defaults to `iso-8859-1`, which is what Apple's own examples use and what
   * every scanner in a café can be relied upon to decode. UTF-8 is accepted by
   * the platforms and not by some hardware, so the safe default is the narrow
   * one and the message is kept to ASCII.
   */
  encoding?: string;
}

/**
 * The images a pass carries, as bytes.
 *
 * **Bytes rather than keys or URLs, deliberately.** This package signs a file
 * for somebody else's operating system; making it able to fetch from storage
 * would mean it could not be run from a test or a command line without an S3
 * client, and every asset it hashes would arrive over a network it cannot see.
 * The caller reads them; this reads only what it was handed.
 */
export interface PassAssets {
  /** Required by both platforms. The small square shown in notifications. */
  icon: ImageSet;
  logo?: ImageSet;
  /** The band behind the primary field. What a `storeCard` uses instead of a background. */
  strip?: ImageSet;
  background?: ImageSet;
  thumbnail?: ImageSet;
  footer?: ImageSet;
}

/**
 * One image at the densities it is supplied in.
 *
 * `x1` is the base. `x2` and `x3` must be exactly two and three times its
 * dimensions — not approximately, and the conformance check enforces it, because
 * a mismatched `@2x` renders as a blurred or cropped image on precisely the
 * devices most people hold.
 */
export interface ImageSet {
  x1: Uint8Array;
  x2?: Uint8Array;
  x3?: Uint8Array;
}

/** An RGB colour. Written as a triple rather than as a string so it cannot be malformed. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface PassColours {
  background: Rgb;
  foreground: Rgb;
  /** The small text above each value. Falls back to the foreground colour. */
  label?: Rgb;
  /** Apple only, and only on some styles: the line above the barcode. */
  stripText?: Rgb;
}

/**
 * Where the device asks for an updated copy of this pass.
 *
 * Absent, the pass is a snapshot: it installs, it renders, and it never changes
 * again. Everything project 06 sells depends on this being present.
 */
export interface PassWebService {
  /** Must be HTTPS. Apple's devices refuse anything else. */
  url: string;
  /**
   * A secret for **this pass and no other**, at least sixteen characters.
   *
   * It authorises the four update endpoints, so it is generated with a CSPRNG,
   * compared in constant time, rotated when the pass is re-issued, and never
   * written to a log. A leak reaches exactly one card.
   */
  authenticationToken: string;
}

/**
 * Per-locale text.
 *
 * Keyed by locale, then by the string being replaced — the value of any `label`
 * or `value` in the pass is looked up here before it is shown. Apple resolves
 * this on the device from `pass.strings` files; Google takes translations inline.
 * Both are fed from this one map.
 */
export type PassLocalisations = Record<string, Record<string, string>>;

export interface PassContent {
  style: PassStyle;
  /**
   * Unique for ever within one pass type, and the identity the update web
   * service is addressed by. Never reused, never guessable.
   */
  serialNumber: string;
  /** The business, as the holder knows it. Never us. */
  organizationName: string;
  /** Read aloud by VoiceOver, and the pass's only accessible description. */
  description: string;
  logoText?: string;
  colours: PassColours;
  assets: PassAssets;

  header?: PassField[];
  primary?: PassField[];
  secondary?: PassField[];
  auxiliary?: PassField[];
  /** The back of the pass: terms, expiry disclosure, contact details, unsubscribe. */
  back?: PassField[];

  barcode?: PassBarcode;
  locations?: PassLocation[];
  /** Metres. How near the holder must be for a location to surface the pass. */
  maxDistance?: number;
  relevantDate?: Date;
  expirationDate?: Date;
  /** A redeemed ticket or a wound-down card: shown, struck through, and inert. */
  voided?: boolean;
  /**
   * Whether the holder may pass this on to somebody else.
   *
   * Defaults to *prohibited* for `storeCard` and `coupon`, which is the opposite
   * of the platform default and is deliberate: a shareable stamp card is a
   * screenshot in a group chat, which is the same failure that makes a static
   * counter QR code unusable.
   */
  shareable?: boolean;

  webService?: PassWebService;
  localisations?: PassLocalisations;

  /**
   * Who holds the pass, where the platform has somewhere to put it.
   *
   * Apple has not: a holder's name on an Apple pass is an ordinary field, put
   * there by the caller like any other. Google models it separately —
   * `accountName` and `accountId` on the object — and leaving them empty there
   * produces a card that renders without the one thing that makes it feel like
   * the holder's own.
   *
   * Optional throughout, because a business may run anonymous enrolment, where
   * there is deliberately no name and no contact detail to put here at all.
   */
  holder?: PassHolder;
}

export interface PassHolder {
  name?: string;
  /** The business's own identifier for this person. Never an email or a phone number. */
  accountId?: string;
}
