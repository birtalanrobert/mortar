# @birtalanrobert/wallet

Apple Wallet and Google Wallet passes: one content model, two renderers, and a
conformance suite that checks the result against the rules a device would apply.

Designed against two of the seventeen specifications rather than one — a loyalty
stamp card (project 06) and an event ticket (project 01). A stamp added and a
ticket admitted are the same four operations over different content, which is
why the vocabulary here is `PassContent` and `PassField` rather than `stamps`
and `balance`.

**This package is server-side.** It reads certificates, signs archives and
hashes files; nothing in a browser bundle should import it.

## What it can prove, and what it cannot

There is no iPhone and no Android handset in this programme, and there will not
be one. The usual way to know a pass works is to install it; that is not
available, so the rules a device applies are written down and applied first.

**Proved here, on every run:**

- the archive contains what Apple looks for, and nothing it does not;
- every entry in `manifest.json` is the SHA-1 of the file it names — **and every
  file in the archive appears in the manifest**, which is the direction that gets
  forgotten;
- the `signature` is a detached PKCS#7 over the exact bytes of `manifest.json`,
  verifying against the signing certificate and chaining to a trust anchor;
- `pass.json` satisfies every rule in `apple/rules.ts`, each carrying a citation
  to the published requirement it encodes;
- images are PNGs, within the sizes the layout allows, with `@2x` and `@3x`
  exactly two and three times the base;
- Google's class and object payloads have the shape the API documents, and the
  save link's JWT verifies against the service account's public key.

**Not proved here, and not implied by a green run:**

- that a lock screen renders the pass as intended;
- that APNs or Google actually deliver;
- that Apple's servers accept _our_ certificate.

Those need credentials and a device. `pnpm --filter @birtalanrobert/wallet verify
--live` answers the first and third the day an account exists; the report names
what it did not check rather than passing silently.

The weakest part of this arrangement is honest about being weak: a canary that
installs a real pass daily would notice a platform change by failing, and there
is none. Instead `apple/rules.ts` carries `RULES_REVIEWED`, a date somebody has
to move by actually re-reading the requirements.

## Building a pass

```ts
import { buildPkPass, verifyPkPass, type PassContent } from '@birtalanrobert/wallet';

const content: PassContent = {
  style: 'storeCard',
  serialNumber: card.id,
  organizationName: business.name,
  description: `Loyalty card — ${business.name}`,
  colours: { background: { r: 24, g: 58, b: 44 }, foreground: { r: 255, g: 255, b: 255 } },
  assets: { icon: { x1: iconBytes, x2: icon2xBytes }, strip: { x1: stripBytes } },
  primary: [{ key: 'balance', label: 'Stamps', value: '7 / 10', changeMessage: 'You now have %@' }],
  barcode: { format: 'qr', message: card.code },
  webService: { url: 'https://api.example.com/wallet', authenticationToken: card.token },
};

const pass = await buildPkPass(content, {
  certificate: process.env.APPLE_PASS_CERTIFICATE!,
  privateKey: process.env.APPLE_PASS_KEY!,
  intermediates: [process.env.APPLE_WWDR!],
});

/* Not optional in a test. This is the only thing standing in for a device. */
const verdict = await verifyPkPass(pass.bytes, { trustedRoots: [process.env.APPLE_ROOT!] });
```

`buildPkPass` refuses rather than signing a pass that breaks a rule. The archive
is **deterministic** given `builtAt`: the manifest hashes the content, so a build
that varied would make every rebuild look to a device like a change.

## Google

```ts
import { buildLoyaltyClass, buildLoyaltyObject, saveLink } from '@birtalanrobert/wallet';

const loyaltyClass = buildLoyaltyClass(content, {
  issuerId,
  issuerName: business.name,
  classSuffix: program.id,
  programName: program.name,
  programLogoUri: logoUrl,
});

const link = saveLink({
  serviceAccountEmail,
  privateKey,
  origins: ['https://enrol.example.com'],
  loyaltyObject: buildLoyaltyObject(content, {
    issuerId,
    classSuffix: program.id,
    objectSuffix: card.id,
    now,
  }),
  now,
});
```

Three differences from Apple, all Google's: images are URIs rather than bytes,
there is a class as well as an object, and updates are direct writes with no
device registration.

## Keeping a pass up to date

Apple's update web service is five endpoints a device calls. This package
carries the protocol, the registration table and the push; the product supplies
a `PassSource` — three methods that say what a pass _is_ — and writes the
controller, because where the routes live and which guard marks them public are
its decisions.

```ts
import { WalletModule, WALLET_PASS_SOURCE } from '@birtalanrobert/wallet/nestjs';

WalletModule.forRootAsync(
  {
    inject: [ConfigModule.token()],
    useFactory: (config) => ({ tokenSecret: config.WALLET_PASS_TOKEN_SECRET }),
  },
  { provide: WALLET_PASS_SOURCE, useClass: CardPassSource },
);
```

**The authentication token is derived, not stored.** Every pass carries a secret
the device sends back, and the obvious implementation keeps a column of them.
`passAuthenticationToken(secret, { passTypeIdentifier, serialNumber, version })`
computes it instead: nothing secret is in the database, a rebuilt pass carries
the same token, and rotation is incrementing `version`. The cost is that the
deployment secret is the whole scheme — change it and every outstanding pass
stops being able to update.

**The updated-since tag must not come from a clock.** Two updates inside the
same tick share a value, the device stores it, asks again, is told nothing
changed, and keeps a pass that has silently stopped matching the database. A
monotonic sequence assigned per update is the fix, and `PassSource.updatedSince`
is where it lives.

**`If-Modified-Since` is compared loosely**, for the same reason: HTTP dates
carry one second, so an _equal_ timestamp serves the pass rather than answering 304. At worst one redundant fetch; never a missed update.

## Push

```ts
import { RecordingApns, Http2Apns, coalesce } from '@birtalanrobert/wallet';
```

The push carries nothing — no serial, no payload — and the device answers it by
asking which of _its_ passes changed. So pushes are **coalesced per device**: a
holder whose two cards both changed gets one notification, and five stamps on
five customers is five pushes.

`RecordingApns` records instead of sending and can be made to answer
`410 Unregistered`, which is the only signal there is that somebody deleted
their card without the deregistration arriving. `WalletRegistrationsService`
removes the registration when it sees one, and writes every outcome to
`mortar_wallet_push_delivery` — which, with no device in this programme, is the
only evidence an update reached anybody.

`POST /v1/log` is implemented too. It is the only diagnostic Apple sends
anywhere, and a product testing without a phone has more use for it than one
that can look at a screen.

## Google, in one call

`GoogleWalletApi` exchanges a signed assertion for an access token — a save link
is a JWT the _holder's browser_ hands to Google, and a write is not — and
upserts by trying `PUT` and falling back to `POST`, because Google has no upsert
and a record of what we have already created will eventually be wrong.
`RecordingGoogleWallet` is its counterpart fake.

## The certificate

```ts
import { daysUntilExpiry, readSigningCertificate, EXPIRY_WARNINGS } from '@birtalanrobert/wallet';

const certificate = readSigningCertificate(pem);
certificate.passTypeIdentifier; // read from the certificate, never configured beside it
certificate.selfSigned; // true for a development certificate — say so in words
daysUntilExpiry(certificate, new Date());
```

An expired certificate does not degrade anything: every pass update for every
tenant stops, silently. `EXPIRY_WARNINGS` is `[60, 30, 7]` days, which is what
renewal actually takes.

## Testing against real passes

```ts
import { sampleAssets, sampleContent, solidPng, testSigner } from '@birtalanrobert/wallet/testing';

const signer = await testSigner();
const pass = await buildPkPass(sampleContent(), signer.material);
const verdict = await verifyPkPass(pass.bytes, { trustedRoots: signer.trustedRoots });
```

`testSigner` builds a two-certificate chain rather than one self-signed
certificate, because a self-signed one verifies against itself and makes every
chain assertion in a suite pass for the wrong reason. `solidPng(width, height)`
generates real PNGs of exact dimensions, which is what the density rules need.

Nothing in `/testing` touches a network, a keychain or a binary.

## Development certificates

`generateDevelopmentCertificate` produces a Pass Type ID certificate with the
right shape and the wrong provenance. Passes signed with it satisfy every rule
here and **no device will install one**. `readSigningCertificate` reports
`selfSigned` so a surface can say that in words instead of showing a green tick.
