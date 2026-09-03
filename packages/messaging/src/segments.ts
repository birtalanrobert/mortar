/**
 * The GSM 03.38 alphabet, which is what fits 160 characters into a message.
 *
 * Anything outside it forces the whole message into UCS-2 and cuts capacity to
 * 70 — so one `ș` in a Romanian sentence more than doubles what it costs to
 * send. That is the entire reason this function exists.
 */
const GSM = new Set(
  [
    '@£$¥èéùìòÇ\nØø\rÅå',
    'Δ_ΦΓΛΩΠΨΣΘΞ',
    'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§',
    '¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ]
    .join('')
    .split(''),
);

/**
 * Characters that fit, but cost two.
 *
 * The extension table: each is sent as an escape plus the character, so a
 * message full of curly brackets holds eighty of them rather than a hundred and
 * sixty.
 */
const GSM_EXTENDED = new Set('^{}\\[~]|€'.split(''));

export interface SegmentCount {
  characters: number;
  /** What a provider actually charges for. */
  segments: number;
  /** `gsm` is 160 to a segment; `unicode` is 70. */
  encoding: 'gsm' | 'unicode';
  /** How many more characters fit before another segment is charged. */
  remaining: number;
  /**
   * The characters that forced the expensive encoding.
   *
   * Named rather than counted, because the useful warning is "your ș and ț are
   * doubling the cost" — which a person can act on — rather than "this message
   * is unicode", which they cannot.
   */
  offenders: string[];
}

/**
 * What one SMS actually costs to send.
 *
 * Counted the way a provider counts it, which is not the way a person counts
 * characters: a single diacritic changes the alphabet for the *whole* message
 * and more than halves its capacity, and messages over one segment lose a few
 * characters each to the header that joins them.
 *
 * Pure and dependency-free so that the console can run it on every keystroke
 * while a firm edits their message, and the worker can charge the ledger by the
 * same arithmetic. Two implementations of this would mean a firm shown one
 * number and billed another.
 */
export function countSegments(text: string): SegmentCount {
  // Surrogate pairs count as one character to a person and to the provider.
  const characters = [...text];

  const offenders = new Set<string>();
  let units = 0;

  for (const character of characters) {
    if (GSM.has(character)) {
      units += 1;
    } else if (GSM_EXTENDED.has(character)) {
      // An escape plus the character: two of the segment's places.
      units += 2;
    } else {
      offenders.add(character);
      units += 1;
    }
  }

  const encoding = offenders.size > 0 ? 'unicode' : 'gsm';
  const single = encoding === 'gsm' ? 160 : 70;
  // Concatenated messages give up six bytes per part to the header that says
  // which part they are.
  const concatenated = encoding === 'gsm' ? 153 : 67;

  if (characters.length === 0) {
    return { characters: 0, segments: 0, encoding, remaining: single, offenders: [] };
  }

  const length = encoding === 'unicode' ? characters.length : units;
  const segments = length <= single ? 1 : Math.ceil(length / concatenated);
  const capacity = segments === 1 ? single : segments * concatenated;

  return {
    characters: characters.length,
    segments,
    encoding,
    remaining: capacity - length,
    offenders: [...offenders],
  };
}
