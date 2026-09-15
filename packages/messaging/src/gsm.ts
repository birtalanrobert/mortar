import { isGsmCharacter } from './segments';

/**
 * Saying the same thing in the alphabet a provider charges least for.
 *
 * `countSegments` names the characters that forced the expensive encoding. This
 * is the other half: what to send instead. One `ă` in a shop's own name doubles
 * every message that shop ever sends, and the shop cannot rename itself — so
 * the only remaining lever is to transliterate, and to be honest about it.
 *
 * **Best effort, and it says so.** Latin letters with marks have faithful
 * equivalents and are converted; Greek, Cyrillic and anything ideographic do
 * not, and are left exactly as they were and *reported*. A function that
 * silently dropped them would turn a Bulgarian shop's name into empty space,
 * which is worse than an expensive message.
 *
 * **Never applied without somebody choosing it.** A business's name is theirs.
 * The right shape in a product is to offer the transliteration, show what it
 * saves, and let them accept or refuse — which is why this reports what it
 * changed rather than quietly returning a string.
 */

/**
 * The characters a canonical decomposition does not separate.
 *
 * Everything with a combining mark — `ă`, `ș`, `ő`, `č` — is handled by NFD and
 * needs no table. What is left is the letters whose marks are *part of the
 * glyph* (`ø`, `đ`, `ł`), the ligatures, and the Turkish dotless i, where the
 * faithful answer is a judgement rather than a rule.
 *
 * Nothing already in the GSM alphabet appears here: `ø`, `æ`, `ß` and `É` cost
 * one place each and are left alone by the check above this table.
 */
const IRREDUCIBLE = new Map(
  Object.entries({
    đ: 'd',
    Đ: 'D',
    ð: 'd',
    Ð: 'D',
    þ: 'th',
    Þ: 'Th',
    ł: 'l',
    Ł: 'L',
    ħ: 'h',
    Ħ: 'H',
    ı: 'i',
    İ: 'I',
    œ: 'oe',
    Œ: 'OE',
    /* Typography, which arrives by way of a word processor rather than a name. */
    '‘': "'",
    '’': "'",
    '‚': "'",
    '“': '"',
    '”': '"',
    '„': '"',
    '–': '-',
    '—': '-',
    '…': '...',
    ' ': ' ',
    ' ': ' ',
    '•': '*',
    '«': '"',
    '»': '"',
  }),
);

export interface GsmTransliteration {
  /** The text as it would be sent. */
  readonly text: string;
  /** Whether anything was changed at all. */
  readonly changed: boolean;
  /**
   * Characters with no faithful Latin equivalent, left exactly as they were.
   *
   * Non-empty means the result is still UCS-2 and still costs double — the
   * product should say so rather than claim a saving it did not make.
   */
  readonly untranslatable: readonly string[];
}

/**
 * Rewrites text into the GSM alphabet wherever that can be done faithfully.
 *
 * Characters already in the alphabet are left alone even when they carry a mark
 * — `é`, `ü` and `à` are free, and "remove every accent" would damage a French
 * or German name to save nothing at all.
 */
export function transliterateToGsm(text: string): GsmTransliteration {
  let result = '';
  const untranslatable = new Set<string>();

  for (const character of text) {
    /* Already cheap. Includes the marked letters GSM happens to carry. */
    if (isGsmCharacter(character)) {
      result += character;
      continue;
    }

    const mapped = IRREDUCIBLE.get(character);
    if (mapped !== undefined) {
      result += mapped;
      continue;
    }

    /*
     * Decompose, then drop the combining marks. `ă` is `a` followed by U+0306
     * and `ș` is `s` followed by U+0326, so one rule covers every Romanian,
     * Hungarian, Polish, Czech and Vietnamese letter without a table for each.
     */
    const stripped = character.normalize('NFD').replace(/\p{M}+/gu, '');

    if (stripped.length > 0 && [...stripped].every(isGsmCharacter)) {
      result += stripped;
      continue;
    }

    /* Greek, Cyrillic, Han, emoji: kept as they are, and reported. */
    result += character;
    untranslatable.add(character);
  }

  return {
    text: result,
    changed: result !== text,
    untranslatable: [...untranslatable],
  };
}
