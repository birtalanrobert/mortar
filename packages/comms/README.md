# @birtalanrobert/comms

Outbound email and SMS behind provider ports, inbound email parsing, and the log
of both.

Deliberately partial. Templates per locale and tone, quiet hours, SMS segment
counting and the metered credit ledger are later work; writing them now would be
guessing at requirements three projects away. What is here is the seam, and the
half of it that had to come first.

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
