/**
 * Moves a decimal point, exactly.
 *
 * Every published rate arrives per some power of ten — the BNR quotes the
 * forint per hundred, the MNB quotes some currencies per thousand — and
 * normalising to one unit is therefore always a decimal shift rather than a
 * division. Doing it as arithmetic would put `1.26 / 100 = 0.0126000000000001`
 * into the middle of a figure that is meant to be exact, in a product whose
 * whole argument for an integer rate representation is that this must not
 * happen.
 *
 * Positive `places` moves the point left, which is division.
 */
export function shiftDecimal(value: string, places: number): string {
  const trimmed = value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new RangeError(`Not a decimal number: ${value}`);

  const [, sign = '', whole = '', fraction = ''] = match;
  if (whole === '' && fraction === '') throw new RangeError(`Not a decimal number: ${value}`);

  const digits = whole + fraction;
  /* Where the point sits now, counted from the left of `digits`. */
  const point = whole.length - places;

  const padded = point <= 0 ? '0'.repeat(1 - point) + digits : digits;
  const at = point <= 0 ? 1 : point;

  const left = padded.slice(0, at).replace(/^0+(?=\d)/, '');
  const right = padded.slice(at).replace(/0+$/, '');

  return right === '' ? `${sign}${left}` : `${sign}${left}.${right}`;
}

/**
 * A comma decimal separator, as the MNB publishes.
 *
 * Only a comma, and only when there is no full stop: a value carrying both is
 * thousands-separated and belongs to a parser this is not, so it is refused
 * rather than guessed at.
 */
export function fromCommaDecimal(value: string): string {
  const trimmed = value.trim();

  if (trimmed.includes(',') && trimmed.includes('.')) {
    throw new RangeError(`Ambiguous number, both separators present: ${value}`);
  }

  return trimmed.replace(',', '.');
}
