import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InboundAddressOptions {
  /** The domain that accepts inbound mail — `in.example.com`. */
  domain: string;
  /** Signing secret. Distinct from the link secret; see `mint`. */
  secret: string;
  /** The local part before the subject — `docs` in `docs+…@…`. */
  prefix?: string;
  /** Bytes of tag to keep. Eight is 64 bits, which is plenty here. */
  tagBytes?: number;
}

export interface ParsedAddress {
  subject: string;
  address: string;
}

const DEFAULT_PREFIX = 'docs';
const DEFAULT_TAG_BYTES = 8;

/**
 * A per-request email address a client can forward a document to.
 *
 * The address *is* the credential — anyone who knows it can attach a file to a
 * request — so it is signed rather than guessable. Without a tag, a sequential
 * or predictable local part means a stranger can post documents into a firm's
 * workflow, and the firm cannot tell.
 *
 * A separate secret from the one signing links, deliberately. An address is
 * printed in email clients, forwarded, and quoted in replies for years; a link
 * expires in days. Sharing a secret between something long-lived and public and
 * something short-lived and private means rotating either one breaks the other.
 */
export class InboundAddress {
  private readonly domain: string;
  private readonly secret: string;
  private readonly prefix: string;
  private readonly tagBytes: number;

  constructor(options: InboundAddressOptions) {
    if (options.secret.length < 32) {
      // Short secrets are the reason HMAC gets blamed for things HMAC did not
      // do. Refused at construction, where it is a deployment error, rather
      // than at first use, where it is an incident.
      throw new Error('An inbound address secret must be at least 32 characters.');
    }

    this.domain = options.domain.replace(/^@/, '').toLowerCase();
    this.secret = options.secret;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.tagBytes = options.tagBytes ?? DEFAULT_TAG_BYTES;
  }

  /**
   * The address for one subject — a request, an application, a case.
   *
   * Sub-addressed with `+` rather than given its own local part, so one mailbox
   * receives everything and routing is a string operation rather than a
   * provisioning step per request. Every provider worth using preserves the
   * detail after `+`; the ones that do not cannot deliver this feature at all.
   */
  mint(subject: string): string {
    const normalised = normalise(subject);
    return `${this.prefix}+${normalised}.${this.tag(normalised)}@${this.domain}`;
  }

  /**
   * The subject an address refers to, or nothing if it was not minted here.
   *
   * Returns rather than throws: an inbound webhook receives whatever the
   * internet sends it, and mail to an address nobody issued is a daily
   * occurrence rather than an exceptional one.
   */
  parse(address: string): ParsedAddress | undefined {
    const cleaned = extractAddress(address);
    if (!cleaned) return undefined;

    const [local, domain] = cleaned.split('@');
    if (!local || domain !== this.domain) return undefined;

    const plus = local.indexOf('+');
    if (plus === -1 || local.slice(0, plus) !== this.prefix) return undefined;

    const detail = local.slice(plus + 1);
    const dot = detail.lastIndexOf('.');
    if (dot === -1) return undefined;

    const subject = detail.slice(0, dot);
    const tag = detail.slice(dot + 1);
    if (!subject || !this.matches(subject, tag)) return undefined;

    return { subject, address: cleaned };
  }

  /**
   * Which of a message's recipients is one of ours.
   *
   * A forwarded email carries the original recipients as well, and often
   * several of them: the client forwards to us and copies their accountant. The
   * first address that verifies is the one the message is about.
   */
  find(recipients: readonly string[]): ParsedAddress | undefined {
    for (const recipient of recipients) {
      const parsed = this.parse(recipient);
      if (parsed) return parsed;
    }
    return undefined;
  }

  /**
   * Hex, not base64url — because the address is lowercased on the way in.
   *
   * Local parts are case-sensitive on paper and lowercased by providers in
   * practice, so `parse` normalises the case. A base64url tag would not survive
   * that: `aB` and `ab` are different tags, and every address minted would fail
   * to verify itself. Hex is four bits a character instead of six, which costs
   * a few characters in an address nobody types by hand.
   */
  private tag(subject: string): string {
    return createHmac('sha256', this.secret)
      .update(`${this.prefix}:${this.domain}:${subject}`)
      .digest('hex')
      .slice(0, this.tagBytes * 2);
  }

  /**
   * Constant-time comparison.
   *
   * The tag is a MAC, and comparing MACs with `===` is the textbook way to
   * leak one a byte at a time. That the attack is impractical over the public
   * internet is not a reason to write the version that depends on it.
   */
  private matches(subject: string, tag: string): boolean {
    const expected = Buffer.from(this.tag(subject), 'utf8');
    const actual = Buffer.from(tag, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

/**
 * The subject, in a form that survives an email address.
 *
 * Local parts are case-insensitive in practice — many providers lowercase them
 * in transit — so a subject that differs only by case would arrive as a
 * different subject. Lowercasing here means the address minted and the address
 * received agree.
 */
function normalise(subject: string): string {
  const cleaned = subject.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleaned) throw new Error('A subject must contain letters or digits.');
  return cleaned;
}

/**
 * The address out of a `To:` header, which is rarely just an address.
 *
 * `"Popescu & Asociații" <docs+abc.tag@in.example.com>` is the normal case, and
 * a display name containing an `@` is not unusual.
 */
function extractAddress(value: string): string | undefined {
  const angled = /<([^>]+)>/.exec(value);
  const candidate = (angled?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : undefined;
}
