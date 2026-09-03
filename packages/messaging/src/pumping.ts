/**
 * Number ranges that are never a client's mobile telephone.
 *
 * Satellite and "global" networks, which is what artificial-traffic fraud
 * actually uses: the operator of the range shares the termination fee with
 * whoever generates the traffic, so a message sent there is a payment to the
 * person who caused it. No accountant's client is reachable on `+882`.
 */
const NEVER_A_CLIENT = [
  '+870',
  '+871',
  '+872',
  '+873',
  '+874',
  '+875',
  '+876',
  '+877',
  '+878',
  '+879',
  '+881',
  '+882',
  '+883',
];

export interface SmsRiskInput {
  /** In international form. Anything else cannot be judged and is refused. */
  phone: string;
  /** Segments this firm has already sent in the last hour. */
  sentThisHour: number;
  /** Distinct country codes this firm has sent to in the last day. */
  countriesToday: readonly string[];
  /** What this message would cost, from `countSegments`. */
  segments: number;
  /** Overridable per firm, because a busy month is not fraud. */
  hourlyCap?: number;
  /** Distinct countries in a day before it stops looking like a client list. */
  countryCap?: number;
}

export type SmsRefusal = 'not_international' | 'premium_range' | 'hourly_cap' | 'country_spread';

export interface SmsRisk {
  allowed: boolean;
  refusal?: SmsRefusal;
  /** The country code, for the caller's own records. */
  country: string;
}

/**
 * A firm sending fifty text messages an hour is not chasing clients.
 *
 * Fifty is far above what chasing produces — a firm with two hundred live
 * requests sends a handful of final reminders a day — and far below what makes
 * fraud worth committing.
 */
const DEFAULT_HOURLY_CAP = 50;

/**
 * A firm's clients live in a handful of countries.
 *
 * Three a day is generous for an accountant in Cluj with clients in Italy and
 * the United Kingdom, and implausible for a list of numbers assembled to
 * generate termination fees.
 */
const DEFAULT_COUNTRY_CAP = 3;

/**
 * Whether this text message should be sent at all.
 *
 * Artificial inflation of traffic — "SMS pumping" — is the one fraud this
 * product's shape invites: a chasing feature that sends a message per party is
 * a feature that sends a message per number somebody can type in. The attacker
 * controls a premium range, adds clients whose telephone numbers terminate
 * there, and collects a share of what we are billed.
 *
 * The defence is deliberately not "detect the fraudster". It is three limits
 * that a real firm never approaches and an attacker cannot avoid: volume,
 * spread, and ranges that are never a person's mobile. Each refusal names
 * itself, because the firm on the other end of a false positive has to be told
 * something they can act on.
 */
export function assessSmsRisk(input: SmsRiskInput): SmsRisk {
  const phone = input.phone.replace(/[\s()-]/g, '');
  const country = countryCodeOf(phone);

  /**
   * International form only.
   *
   * A national number cannot be judged — `0722…` is Romanian, Italian or
   * neither depending on who is reading it — and guessing from the firm's own
   * country is how a message goes somewhere nobody intended.
   */
  if (!phone.startsWith('+') || phone.length < 8) {
    return { allowed: false, refusal: 'not_international', country };
  }

  if (NEVER_A_CLIENT.some((range) => phone.startsWith(range))) {
    return { allowed: false, refusal: 'premium_range', country };
  }

  const hourlyCap = input.hourlyCap ?? DEFAULT_HOURLY_CAP;
  if (input.sentThisHour + input.segments > hourlyCap) {
    return { allowed: false, refusal: 'hourly_cap', country };
  }

  const countryCap = input.countryCap ?? DEFAULT_COUNTRY_CAP;
  const countries = new Set(input.countriesToday);
  if (!countries.has(country) && countries.size >= countryCap) {
    return { allowed: false, refusal: 'country_spread', country };
  }

  return { allowed: true, country };
}

/**
 * The country code, as far as it can be known from the number alone.
 *
 * Deliberately crude: a full numbering-plan table would be a dependency that
 * needs updating, and what this is used for is counting *distinct* prefixes
 * rather than naming countries. Two numbers in the same country counted as one
 * prefix is all the accuracy the rule requires.
 */
export function countryCodeOf(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) return 'unknown';

  // The one-digit codes (North America, Russia and Kazakhstan) and then the
  // common two-digit ones; everything else is taken as three.
  if (/^\+(1|7)/.test(digits)) return digits.slice(0, 2);
  // `42` is the one gap in the 4x range — it was Czechoslovakia and is unassigned.
  if (/^\+(2[07]|3[0-469]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/.test(digits)) {
    return digits.slice(0, 3);
  }

  return digits.slice(0, 4);
}
