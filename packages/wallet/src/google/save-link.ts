import { ValidationError } from '@birtalanrobert/http';
import { signJwt } from '../jwt';

/**
 * "Add to Google Wallet" — a link, and the token inside it.
 *
 * The whole of Google's install flow: a JWT signed by the service account,
 * carrying the object to be saved, appended to a Google URL. The holder opens
 * it, Google reads the token, and the card is theirs. There is no upload and no
 * file.
 *
 * Which means the token **is** the credential. Anyone holding the link can save
 * the card, so it is generated per enrolment, never logged, and never put
 * anywhere it can be seen by somebody other than the person enrolling.
 */

/** Where a save link points. Google's, and not configurable. */
export const SAVE_URL = 'https://pay.google.com/gp/v/save/';

export interface SaveLinkInput {
  /** The service account's email address, which is the token's issuer. */
  serviceAccountEmail: string;
  /** Its private key, PEM. */
  privateKey: Buffer | string;
  /**
   * The sites allowed to open this link.
   *
   * Google checks the referrer against these, so a token issued for the wrong
   * origin fails at Google with an error the person enrolling cannot act on.
   * Required in practice even though the API treats it as optional.
   */
  origins: readonly string[];
  /** The object as {@link buildLoyaltyObject} produced it. */
  loyaltyObject?: Record<string, unknown>;
  /** The class, when it is created by the same token rather than beforehand. */
  loyaltyClass?: Record<string, unknown>;
  /**
   * The ticket, as {@link buildEventTicketObject} produced it.
   *
   * Google keys the token's payload by what kind of pass it holds, so a ticket
   * sent as `loyaltyObjects` installs as a loyalty card with a balance where
   * its seat should be. One of this and `loyaltyObject` is required; both
   * together is a token that saves two passes and is almost certainly a
   * mistake, so it is refused.
   */
  eventTicketObject?: Record<string, unknown>;
  eventTicketClass?: Record<string, unknown>;
  /** The moment the token says it was issued. */
  now: Date;
}

/** The signed token. {@link saveLink} is usually what a caller wants instead. */
export function buildSaveToken(input: SaveLinkInput): string {
  if (input.origins.length === 0) {
    throw new ValidationError(
      [
        {
          field: 'origins',
          message:
            'A save link needs the origins it may be opened from. Without them Google refuses the token at the moment the customer taps it.',
          code: 'origins_required',
        },
      ],
      'A save link needs its origins.',
    );
  }

  if (Boolean(input.loyaltyObject) === Boolean(input.eventTicketObject)) {
    throw new ValidationError(
      [
        {
          field: 'loyaltyObject',
          message:
            'A save link carries exactly one pass: a loyalty object or an event ticket object. ' +
            'Google keys the payload by kind, and a ticket sent as a loyalty card installs with a ' +
            'balance where its seat should be.',
          code: 'one_object_required',
        },
      ],
      'A save link carries exactly one pass.',
    );
  }

  const payload: Record<string, unknown> = {};

  if (input.loyaltyObject) payload.loyaltyObjects = [input.loyaltyObject];
  if (input.loyaltyClass) payload.loyaltyClasses = [input.loyaltyClass];
  if (input.eventTicketObject) payload.eventTicketObjects = [input.eventTicketObject];
  if (input.eventTicketClass) payload.eventTicketClasses = [input.eventTicketClass];

  return signJwt(
    {
      iss: input.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(input.now.getTime() / 1000),
      origins: [...input.origins],
      payload,
    },
    input.privateKey,
    { algorithm: 'RS256' },
  );
}

/**
 * The URL to put behind "Add to Google Wallet".
 *
 * Long — the object travels inside it — and that is Google's design rather than
 * a mistake. It is well inside what browsers and Android accept, but it is not
 * something to put in an SMS, which is why the desktop fallback in project 06
 * sends a short link to a page that renders this button rather than the link
 * itself.
 */
export const saveLink = (input: SaveLinkInput): string => `${SAVE_URL}${buildSaveToken(input)}`;
