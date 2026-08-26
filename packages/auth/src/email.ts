/**
 * Normalises an email address for storage and lookup.
 *
 * Lower-cases the whole address. The local part is technically
 * case-sensitive per RFC 5321, but no mail provider anyone here
 * will encounter actually treats it that way — and honouring the letter of the
 * spec would let `Ana@x.com` and `ana@x.com` register as two accounts, which
 * users experience as a bug and attackers experience as an opportunity.
 *
 * Deliberately does **not** strip dots or `+tags`: those rules are
 * provider-specific, and applying Gmail's to every domain silently merges
 * distinct addresses elsewhere.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A pragmatic email check.
 *
 * Not RFC-complete, and deliberately so: full RFC 5322 accepts addresses no
 * mail server would deliver to, and the only real proof an address works is
 * sending to it — which is what verification is for. This rejects the obvious
 * mistakes and nothing else.
 */
export function isPlausibleEmail(email: string): boolean {
  if (typeof email !== 'string') return false;
  const value = email.trim();
  if (value.length < 3 || value.length > 320) return false;
  if (/\s/.test(value)) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;
  return true;
}
