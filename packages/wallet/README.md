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
