# @birtalanrobert/comms

Outbound email and SMS behind provider ports, inbound email parsing, and the log
of both.

Deliberately partial. Templates per locale and tone, quiet hours, SMS segment
counting and the metered credit ledger are later work; writing them now would be
guessing at requirements three projects away. What is here is the seam, and the
half of it that had to come first.

## Using it in a NestJS application

```ts
import { CommsModule } from '@birtalanrobert/comms/nestjs';
import { NoopMessagePort } from '@birtalanrobert/comms';

@Module({
  imports: [
    // …config, logger, database…
    CommsModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({
        ports: { email: new NoopMessagePort('email') }, // a real provider from Phase 5
        inbound: { domain: config.INBOUND_DOMAIN, secret: config.INBOUND_SECRET },
      }),
    }),
  ],
})
export class AppModule {}
```

`@Global()`, and it provides `CommsService`. Register `commsEntities` and
`commsMigrations` with the database module.

Both options are optional: a deployment that does not accept inbound mail omits
`inbound` and `inboundAddressFor` returns `undefined`; a channel with no port
records a failed message rather than throwing, so a missing provider shows up in
the log instead of as a 500.

## Inbound addresses

A per-request address a client can forward an existing document to — the feature
that lets someone send a bank statement they already have in their inbox without
opening anything.

```ts
const address = comms.inboundAddressFor(`request-${id}`);
// docs+request-9f2a.4c1de0a83b2f77e1@in.example.com
```

**The address is the credential.** Anyone who knows it can attach a file to a
request, so it carries an HMAC tag: without one, a predictable local part means
a stranger can post documents into a firm's workflow and the firm cannot tell.

Two details that are easy to get wrong:

- **A separate secret from the one signing links.** An address is printed in
  email clients, forwarded, and quoted in replies for years; a link expires in
  days. Sharing a secret between something long-lived and public and something
  short-lived and private means rotating either breaks the other.
- **The tag is hex, not base64url.** Local parts are case-sensitive on paper and
  lowercased by providers in practice, so `parse` normalises case — which a
  base64url tag would not survive, and every address minted would fail to verify
  itself.

`find` picks ours out of a forwarded message's recipients, because a client
forwards to us and copies their accountant.

## Parsing

`parseMime` reads an RFC 5322 message far enough to be useful: headers with
folding, RFC 2047 encoded words, multipart trees, base64 and quoted-printable,
legacy charsets, and attachments with their bytes intact.

Written rather than depended on, for one reason: this runs on every inbound
message, and inbound mail is the most hostile input the system accepts — anyone
can send it, from anywhere, in any shape. Eighty lines that can be read in full
and tested against the cases that actually arrive is a smaller permanent attack
surface than a general-purpose parser that knows every corner of MIME in order
to be asked about six.

What it does not do is left undone rather than half-done. An unrecognised part
becomes an attachment with the bytes intact, which is a failure a person can act
on.

`InboundParser` is the port. Every candidate provider offers either parsed JSON
in its own shape or the raw message, so an adapter is a function into
`InboundMessage` and choosing differently later is a new adapter rather than a
change to anything that consumes mail.

## Receiving a provider's webhook

```ts
const inbound = new ResendInbound({ apiKey, webhookSecret });

const event = inbound.verify(request.rawBody, request.headers);
if (!event) throw new UnauthenticatedError();

const emailId = ResendInbound.emailIdOf(event);
if (emailId) await comms.receive(parseMime(await inbound.rawMime(emailId)));
```

`verify` returns `undefined` for every failure rather than throwing, because the
caller's correct answer is one unauthenticated response whatever went wrong — an
exception carrying the reason tempts a route into reporting which check failed.

**`rawBody` means the bytes that arrived.** A parsed object re-serialised has
different whitespace and key order, and the signature is over bytes, so the
route has to keep the original.

The event carries metadata and **no body**: `rawMime` fetches the original and
returns it for `parseMime` to read. Deliberately raw rather than the provider's
own parsed fields — the parser stays ours, and the day the vendor changes
nothing above it moves.

## The message log

Two jobs, and the second shapes the table.

The first is answering "did my client actually get that reminder?", which a
professional asks whenever a deadline passes quietly. Without a log the honest
answer is "we think so".

The second is **not doing the same thing twice**. Providers redeliver inbound
webhooks — that is how at-least-once delivery works — and without a record of
what has been handled, a client's forwarded bank statement is attached to their
request three times. A partial unique index on the provider's id is what makes
the handler idempotent, and it is a database constraint rather than a check in
code because two redeliveries can arrive at the same moment.

A message that cannot be routed is logged as `discarded` rather than dropped.
Someone will eventually ask why a forwarded document never appeared, and "it
went to an address nobody issued" is an answer only a log can give.

**The body is never stored.** A reminder is innocuous; inbound mail here is bank
statements, and a log table is the last place they should be sitting when
someone asks for an erasure.

## Sending

`MessagePort` per channel. What it exposes is fixed by behaviour rather than by
any one vendor's API: the sender identity, because alphanumeric sender IDs are
permitted in some markets and not others and that decides whether a client can
reply; and the segment count, because that is what a credit ledger is debited
by.

`send` records `accepted`, not `delivered` — the provider has taken it, and
whether it reached a person is a later webhook's news, recorded by `settle`. A
receipt for a message this system has no record of is ignored rather than
inserted: it belongs to another environment sharing the provider account.

`NoopMessagePort` accepts everything and sends nothing. Unlike the file
scanner's default, permissive is right here: not sending an email is a visible
nuisance, while not scanning a file is invisible and dangerous.

### The three shipped transports

```ts
const email = new ResendMessagePort({ apiKey, from: 'no-reply@mail.example.com' });
const sms = new TwilioMessagePort({ accountSid, authToken, messagingServiceSid });
const smtp = new SmtpMessagePort({ url: 'smtp://localhost:3014', from: 'no-reply@example.com' });
```

Each is built on the vendor's own client — the same arrangement `files` has with
`@aws-sdk/client-s3`, and for SMTP the protocol's long-standing implementation
rather than a socket and a state machine written here. Fewer lines, and request
and response shapes that are right by construction rather than transcribed from
documentation.

All three **throw** on refusal, carrying the server's own sentence —
`CommsService` catches it and records that sentence in the message log, which is
what support reads. A port that swallowed the reason would leave "it did not
send" and nothing else.

Each takes an optional client or transport, so a deployment can share one and a
test can work at that surface rather than stubbing `fetch`.

`SmtpMessagePort` is the one every local stack already has somewhere to point
at: each project's Compose file runs Mailpit, and until this existed nothing
could reach it — so an invitation, a receipt or a password reset could not be
followed end to end on a developer's machine without a vendor account. It is
not only a development seam: a customer with their own mail server, a provider
offering a relay rather than an API, and a deployment where mail may not leave
the building are all this class with a different URL.

Two things about it are worth knowing. A server can accept the conversation and
refuse the address — `sendMail` resolves in that case, with the address under
`rejected`, and treating that as success writes "delivered" against a message
the server explicitly refused; this port throws instead. And certificates are
verified: `allowSelfSignedCertificate` exists for a mail catcher or a private
relay and must stay off against anything public, because a certificate nobody
checks makes STARTTLS an encrypted conversation with whoever answered. Its tests
run a real SMTP server in-process rather than mocking the client, which is the
only way either of those behaviours can be asserted.

A message may name its own `from` and `replyTo`, which is how it is branded as a
customer without their domain being one the provider can sign for: their name in
the display part, their address to reply to.

`TwilioMessagePort` prefers a messaging service to a single number, because the
sender identity is a per-market question — an alphanumeric sender ID is
permitted in some countries, needs registration in others, and can never be
replied to — and a messaging service is what lets it change without a
deployment. It refuses to be constructed with no sender at all: the alternative
is finding out twelve days into a reminder cadence.

The segment count in `SendResult` is the provider's, not an estimate. A ledger
debited by an estimate drifts from the invoice within a month — one accented
character downgrades a message to UCS-2 and doubles its cost without changing a
word.

### Attachments

```ts
await comms.send({
  channel: 'email',
  to: 'firm@example.com',
  subject: 'Documents from Ion Popescu',
  text: 'Everything they sent is attached.',
  attachments: [{ filename: 'Ion_Popescu.zip', content: archive, contentType: 'application/zip' }],
});
```

Bounded by `MAX_ATTACHMENT_BYTES` (10 MB) and **refused before the port sees
it**. Providers differ — many refuse at 10 MB, most at 25 — and base64 inflates
an attachment by a third, so the useful limit sits under the smallest of them.
Refusing here turns a silent late bounce into a log entry with a sentence in it.

The log records how many files and how many bytes, never their names: it is read
by support, and a client's filenames are not theirs to read.
