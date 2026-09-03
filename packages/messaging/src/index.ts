/**
 * What a text message costs, when it may be sent, and whether it should be.
 *
 * Three things every product that sends SMS gets wrong in the same order: it
 * prices a message the way a person counts characters rather than the way a
 * provider counts segments; it sends at three in the morning; and it pays for
 * traffic somebody manufactured. None of that is specific to a domain, which is
 * why it lives here rather than being written a second time.
 *
 * **This entry point is pure.** No database, no framework, no Node built-ins —
 * a console counts segments on every keystroke, and that has to work in a
 * browser. The credit ledger, which needs both, is behind `/nestjs`.
 */
export { countSegments, type SegmentCount } from './segments';

export { DEFAULT_QUIET_HOURS, isQuiet, localTime, nextAllowed, type QuietHours } from './quiet';

export {
  assessSmsRisk,
  countryCodeOf,
  type SmsRefusal,
  type SmsRisk,
  type SmsRiskInput,
} from './pumping';
