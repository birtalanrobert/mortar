import { createHash, randomInt } from 'node:crypto';

/**
 * Recovery codes: what lets somebody sign in with a second factor once the
 * phone holding it is lost — each good once, shown once, kept only as a hash.
 *
 * Ten characters from an alphabet with nothing that reads as something else —
 * no 0 and o, no 1, l and i, no u and v side by side — written as two groups of
 * five. About 49 bits each: no use guessing within the attempts a lock allows,
 * and short enough to type from a piece of paper.
 */
const ALPHABET = 'abcdefghjkmnpqrstwxyz23456789';
const LENGTH = 10;

/** How many codes an enrolment is given, unless the product says otherwise. */
export const RECOVERY_CODE_COUNT = 10;

/** New codes, written as the person keeps them: `abcde-fghjk`. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let code = '';
    for (let index = 0; index < LENGTH; index += 1) code += ALPHABET[randomInt(ALPHABET.length)];
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** A code as typed, made comparable: case, spaces and the dash forgiven. */
export function normaliseRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, '');
}

/** Whether what was typed could be a recovery code at all, rather than an app's code. */
export function looksLikeRecoveryCode(input: string): boolean {
  const code = normaliseRecoveryCode(input);
  return code.length === LENGTH && [...code].every((char) => ALPHABET.includes(char));
}

/** How a code is kept: its SHA-256. A random code this long needs no slow hash. */
export function hashRecoveryCode(input: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(input)).digest('hex');
}
