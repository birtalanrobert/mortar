# Changelog

Each package carries its own version. A release publishes only the packages
whose version is not yet on the registry; `pnpm release` asks npm and skips the
rest.

## messaging 1.0.0

Extracted from project 13 at its second consumer (project 12), which is the
rule: written once, moved when a second product needs it.

### Added

- **`countSegments`** — what a message actually costs, counted the way a
  provider counts rather than the way a person counts characters. A single
  character outside GSM 03.38 changes the encoding for the whole message and
  cuts capacity from 160 to 70, so `offenders` names the characters responsible:
  "your ș and ț are doubling the cost" is something a person can act on.
- **Quiet hours** — `isQuiet`, `nextAllowed`, `localTime`, in the _business's_
  zone rather than the recipient's. A phone number says nothing about where
  somebody is sitting.
- **`assessSmsRisk`** — pumping detection. Fraud that costs money rather than
  data, and visible only in the shape of recent traffic rather than in any one
  message.
- **`MessageCreditsService`** and `mortar_message_credits` (`/nestjs`) — credit
  as a ledger, append-only, with the balance summed from the entries rather than
  kept in a column that can disagree with them. No foreign key to whatever the
  segments were spent on, which is what lets two products share it.

The root entry point is pure — no database, no framework, no Node built-ins —
because a console counts segments on every keystroke and that has to run in a
browser. Everything needing TypeORM is behind `/nestjs`.

## redis 1.0.1

### Fixed

- **A queue connection no longer carries a command timeout.** `createQueueConnection`
  already cleared `maxRetriesPerRequest` for BullMQ, but left the five-second
  `commandTimeout` in place — and a queue consumer waits for work with blocking
  reads that are _designed_ to sit there for longer than any sensible deadline.
  The result was an idle worker logging `Command timed out` every few seconds,
  on every queue, for ever. Jobs still ran, which is what made it easy to read
  as a sick Redis rather than a misconfigured client. `commandTimeoutMs` now
  accepts `null` to mean "no deadline", and queue connections pass it.

## comms 1.2.0

The vendors, behind the ports that were waiting for them (dossier D-10).

### Added

- **`ResendMessagePort`** — email, on Resend's own SDK. A message may carry its
  own `from` and `replyTo`, which is how it is branded as a customer without
  their domain being one the provider can sign for: their name in the display
  part, their address to reply to, so a client who replies reaches their
  accountant rather than a mailbox nobody reads.
- **`TwilioMessagePort`** — SMS, on Twilio's SDK, preferring a messaging service
  over a single number. The sender identity is a per-market question — an
  alphanumeric sender ID is permitted in some countries, requires registration
  in others, and cannot be replied to anywhere — and a messaging service is what
  lets it change without a deployment. It refuses to be constructed with no
  sender at all, because the alternative is finding out twelve days into a
  reminder cadence.
- **The segment count comes back from the provider**, not from our estimate.
  `countSegments` decides whether a message is worth sending; the ledger is
  debited by what was actually charged, and the two differing is the case a
  ledger exists to catch — one accented character downgrades a message to UCS-2
  and doubles its cost without changing a word.
- **`ResendInbound`** — verifying the provider's webhook and fetching the
  message it names. The webhook carries metadata and no body, so the original is
  fetched and returned as **raw MIME** for `parseMime` to read: the parser stays
  ours, and the day the provider changes nothing above it moves. Verification is
  the vendor's own (Standard Webhooks) and takes the **raw** request body — a
  parsed object re-serialised has different bytes and fails.

### Notes

- **The vendors' SDKs rather than their REST APIs**, which is the arrangement
  `files` already has with `@aws-sdk/client-s3`. Both were first written against
  the published REST documentation, and the SDK types caught a field this got
  wrong — a received message's download URL. Fewer lines, and the shapes are
  right by construction.
- Both ports **throw** on refusal rather than returning a failure, carrying the
  provider's own sentence. `CommsService` records it in the message log, which
  is what support reads — a port that swallowed the reason would leave "it did
  not send" and nothing else.
- `ResendMessagePort` imposes its own **timeout**: the SDK sets none, and
  something is usually waiting on a message — a professional who has just
  pressed send should not hold a response open until a socket gives up.
- Every port takes an optional `client`, so a deployment can share one and a
  test can fake the vendor at its own surface rather than stubbing `fetch`.

## context 1.1.0

An actor can be an operator.

### Added

- **`Actor.type` accepts `'operator'`** — one of _us_, working inside a
  customer's account with their consent. Separate from `user` because the audit
  trail has to be able to say which it was: support access recorded as the
  customer's own action is worse than no record, being a confident answer to
  "who opened this?" that names the wrong person. Thirteen of the seventeen
  specifications describe back-office impersonation, so the type belongs here
  rather than in each of them.
- `impersonatedBy` is now documented as the _other_ shape — an operator acting
  as a named user — with a note that acting as oneself inside the customer's
  account is the safer one, because nothing is disguised.

## comms 1.1.0

Attachments, so a completed set of documents can be delivered by email (dossier
F-174).

### Added

- **`OutboundMessage.attachments`**, and `MAX_ATTACHMENT_BYTES` at 10 MB.
  Providers differ — many refuse at 10, most at 25 — and base64 inflates an
  attachment by a third, so the useful limit sits well under the smallest of
  them.
- **Refused before the provider sees it.** A receiving server bounces an
  oversized attachment silently and late, which becomes "they never got it and
  nobody knows why". The log records a failure with a sentence instead, and
  nothing is handed to the port.
- The message log records **how many files and how many bytes**, never their
  names: the log is read by support, and a client's filenames are not theirs to
  read.

### Fixed

- **`NoopMessagePort` ids are now unique across processes.** They counted from
  one, and the message log has a unique index on
  `(direction, provider_message_id)` — so the second test run against the same
  database collided, and `CommsService` reported it as a message the provider
  refused. The failure surfaced in whatever was being tested rather than in the
  double, and only on the second run.

## files 1.2.0

ZIP archives and provider-enforced retention (dossier F-170, F-178): a completed
request leaves as one file whose folders and names the receiving firm can file
without opening it. A ZIP of `IMG_4471.jpg` is worthless; one of
`Ion_Popescu/03_Bank_statement.pdf` is already filed.

### Added

- **`createZip`.** Hand-written over `node:zlib` rather than taken from a
  dependency — the essential format is two hundred lines and has not changed
  since 1993, and every library that writes it brings a stream stack and a
  supply chain with it.
- Deterministic when given a `modified` date, so a delivery retry produces the
  file the destination already has rather than a second copy.
- Zip-slip paths (`/etc/passwd`, `../../secrets`) are stripped rather than
  trusted to the extractor; duplicate paths are refused rather than left for the
  extractor to resolve; names are flagged UTF-8 so a Romanian filename survives.
- Entries are deflated, and stored instead when deflate would make them bigger —
  which is every photograph and most PDFs.
- Verified against `unzip` in the tests, not only against its own reader: an
  archive only this package can read is not an archive.
- **`S3Storage.applyLifecycle` / `describeLifecycle`.** Provider-enforced expiry
  as a backstop under the application's own retention. The failure it covers is
  the one the application cannot: a sweep broken for a month leaves documents in
  a bucket and nothing in the application says so. An empty rule list removes
  the configuration, because S3 refuses one with zero rules.
- **`S3Storage` now has integration tests**, against MinIO rather than a mocked
  SDK — whether a presigned URL is actually accepted, what a missing object
  answers, and whether a lifecycle configuration is written in a shape a
  provider takes are all things a mock cannot speak to. Mortar's development
  stack gained a MinIO service on 3052/3053 for it.
- **`MemoryStorage` gained `has`, `clear`, `failOn` and `stopFailing`.** A suite
  shares one instance across a file, so without `clear` every object from every
  earlier test is still there and an assertion about what a cleanup removed
  silently starts passing for the wrong reason. `failOn` exists because real
  buckets fail one object at a time, and what matters is what the caller does
  about it: a retention sweep must not abandon thirty-nine other firms because
  one object would not delete.

## files 1.1.0

Single-PDF assembly (dossier F-090): several photographed pages become one
document, which is what a professional actually wants — three separate JPEGs of
a statement means three files to open in an order only knowable from filenames
the client did not choose.

### Added

- **`assemblePdf`.** JPEG and PNG are embedded natively, `DCTDecode` and
  `FlateDecode`, so a photograph reaches the professional as the bytes the
  camera produced rather than a generational copy. Pages are sized to their
  image rather than floated on a fixed A4, scaled down but never up.
- HEIC is refused. A phone produces it, no PDF reader opens it, and converting
  it needs a decoder this package is not going to carry.
- No producer or creation date is written: these are a client's bank statements,
  and the defaults name the software that touched them. It also makes the output
  deterministic, which a test asserts.

### A dependency, and why this one

`pdf-lib` is a real dependency in a package that has argued against them —
`@birtalanrobert/comms` writes its own MIME parser, and the ClamAV adapter
speaks the protocol directly. The distinction is where a failure shows up. A
MIME parser that gets something wrong loses an attachment, visibly, immediately.
**A malformed PDF is invisible until a professional cannot open it**, days
later, with a client who has already put the paper away — and PDF is a format
with enough subtlety that hand-rolling a writer is a wager on being right about
all of it.

### A bug found while writing the tests

`pdf-lib` reads an image's **whole backing `ArrayBuffer` and ignores the view's
`byteOffset`**. Node allocates every Buffer under 4 KB from a shared 8 KB pool,
so a small page — a compressed scan, or anything fetched from storage — arrives
at a non-zero offset, and the embedder parses whatever sits at the pool's start.

It is a nasty shape of bug: whether it fires depends on what else the process
has allocated, so the first several runs passed by reading a stale copy of the
same image left at position 0. An offset-aware view does not fix it, because it
shares the ArrayBuffer. `assemblePdf` copies the bytes, and a test builds a
pooled buffer deliberately.

## http 2.0.0 — and a minor for everything that depends on it

`@birtalanrobert/http` root entry point is now framework-free.

### Why a major

The root exported the exception filter, the context middleware, the validation
pipe, the health controller, `HttpModule` and `@PublicRoute()` — so importing
`NotFoundError` imported NestJS. Every package that raises a mortar error
inherited that, which is a framework in an edge bundle for the sake of a type
guard.

Those six now live at `@birtalanrobert/http/nestjs`. **The error classes,
problem serialisation, header names, locale negotiation and the health registry
have not moved**, so most files need no change; an application module and a
bootstrap file need one line each.

### Also changed

- **`toProblemDetails` recognises a Nest `HttpException` by shape rather than
  by `instanceof`.** That removes the last runtime import, and it is the more
  correct check: two copies of `@nestjs/common` in one install — routine in a
  monorepo — make `instanceof` false for the framework's own exceptions, so its
  validation errors would silently fall through to the generic 500 branch. The
  function is documented as total; recognising the contract is what makes that
  true.
- **`REQUEST_ID_HEADER`, `CORRELATION_ID_HEADER` and `negotiateLocale` moved to
  their own module** so a Next.js middleware can read the same header names
  without the middleware class that uses them.

### auth 1.1.0, idempotency 1.1.0, tenancy 1.1.0, workflow 1.1.0

No API change. Each depends on `http`, and each is republished so its dependency
range moves to `^2.0.0` — otherwise an application installing `http@2` would end
up with a second copy at `1.x` underneath these, and `isMortarError` is an
`instanceof` check that two copies quietly break.

`workflow` also gains the `mortar.entries` field it was missing, so its
`nestjs/` subpath stub is regenerated by the build instead of surviving only
because nothing had deleted it.

### Every package README now documents its wiring

What to import, whether it is `forRoot` or `forRootAsync`, where it goes in the
imports array and what breaks if it goes elsewhere, which entities and
migrations to register, and what needs no module at all — `context`, `money` and
the root half of `http` are imported directly.

Two scripts check the result rather than trusting it: one resolves every
documented import against the built `.d.ts` files, the other checks every
`Module.forRoot…()` shown actually exists. Both found real errors — a
`RedisService.remember` that does not exist (it is `redis.cache.getOrSet`), a
`workers.handle` that is `workers.register`, an `envBool` that is `envBoolean`,
and column helpers documented in the wrong package.

## files 1.0.0, comms 1.0.0

The two Tier 2 packages dossier's Phase 2 needs: somewhere for an uploaded
document to go, and a way for a client to forward one they already have.

Built now rather than up front because this is the phase that first needs them —
and built partially, on purpose. `files` has no PDF assembly, thumbnailing or
ZIP packaging; `comms` has no templates, quiet hours or credit ledger. Those
belong to the phases that need them, and writing them now would be guessing at
requirements three projects away.

### `files`

- **Pre-signed direct upload.** The browser uploads to storage without touching
  the API. Proxying the bytes costs a request-sized chunk of memory per
  concurrent upload and puts the API's timeout between a client on a train and
  finishing. The cost is real rows in `pending`, which `sweepAbandoned` clears.
- **The type is read from the bytes, never from the header.** A `Content-Type`
  and a filename extension are claims made by whoever uploaded the file.
- **One bucket, tenant id as the first path segment**, so a bucket policy can
  name it. `assertTenantOwns` before every read, delete and signature: nothing
  governs a bucket except the key handed to it.
- **Envelope encryption for erasure, not confidentiality.** The provider already
  encrypts at rest. Destroying one wrapped key is the difference between an
  erasure request honoured in seconds and one that cannot honestly be honoured,
  because backups exist. The object key is bound in as AAD, so a ciphertext
  moved under another tenant's prefix fails to open.
- **`RefusingScanner` is the default.** A misconfiguration that silently
  disables virus scanning is indistinguishable from working software until it
  matters; one that refuses uploads is noticed in minutes.
- **`MemoryStorage` is exported.** Every service consuming `StoragePort` lives
  in another repository and needs to test its upload flow without a bucket.

### `comms`

- **Signed per-request inbound addresses.** The address is the credential, so it
  carries an HMAC tag; without one a predictable local part lets a stranger post
  documents into a firm's workflow. Its own secret, because an address lives for
  years in sent folders while a link expires in days.
- **A MIME parser rather than a dependency.** Inbound mail is the most hostile
  input the system accepts. Eighty readable lines tested against what actually
  arrives is a smaller permanent surface than a parser that knows every corner
  of MIME in order to be asked about six.
- **A partial unique index on the provider's message id.** Providers redeliver;
  without it a forwarded bank statement is attached three times. A constraint
  rather than a check, because two redeliveries can arrive at once.
- **The message body is never logged.** A reminder is innocuous; inbound mail
  here is bank statements.
- **Ports only for sending.** Providers are Phase 5; the seam exists now so the
  one thing that needs sending sooner has somewhere to go.

### A defect in the scaffolding, found by the editor

`scripts/new-package.mjs` generated a single `tsconfig.json` that both emitted
to `dist` and excluded `*.test.ts` — so a new package's tests belonged to no
project and were type-checked by nothing. The build passed while the editor
showed errors, which is how three genuine type errors in `envelope.test.ts`
survived a green run.

`files`, `comms` and `workflow` now carry the standard pair the other twelve
packages already had, and the scaffold writes both. Nothing published changes:
`dist` never contained tests either way.

### A bug this found

The inbound tag was base64url at first, and every address failed to verify
itself. `parse` lowercases the address on the way in — correctly, because
providers lowercase local parts — which destroys a case-sensitive tag. Hex
costs a few characters in an address nobody types by hand.

## observability 1.0.1

Never published. An interrupted publish left `1.0.0` partially staged and npm
rejected a retry, so the version was stepped over — and then the staged upload
finalised on npm's side after all. `1.0.0` is the real release; `1.0.1` does
not exist.

## observability 1.1.0, jobs 1.1.0

Everything a worker needs to be observable. Found by building `starter-worker`,
whose specification asks for queue depth, job duration, failure rate and
scanner lag — none of which anything recorded.

### Added

- **`JobWorkers` records `job_duration_ms`, `jobs_total` (labelled by outcome)
  and `jobs_dead_lettered_total`.** In the runner rather than in each handler:
  how many ran, how many failed and how long they took are properties of the
  runner and identical in every service. One counter with a `status` label
  rather than two counters, because failure rate is a ratio and both halves
  must share their labels. Defaults to a no-op registry.

- **`WindowScanner` records `scanner_scan_duration_ms`, `scanner_items_total`
  and `scanner_last_success_timestamp_ms`.** The last is the one worth alerting
  on: a scanner that has stopped logs nothing and errors nothing, it simply
  stops finding work, and the first anyone hears is a customer asking why they
  were never reminded. A timestamp rather than an age, because a gauge written
  only on success cannot grow while the scanner is dead.

- **`JobQueues` rejects a job id containing `:`**, naming the job and the id.
  BullMQ uses the colon as a key separator and refuses such an id with an error
  that mentions neither — and `` `reminder:${id}` `` is the natural thing to
  write, so that error is reached often and explains nothing.

- **`JobsModule` passes the container's metrics registry** to the worker
  registry, so this costs a consumer nothing to switch on.

- **`InMemoryMetrics.snapshot()`**, returning every series held. A `/metrics`
  endpoint has to enumerate what exists, and `value()` could only answer about
  a name the caller already knew. Histograms report count, sum, min and max;
  bucketing is a presentation decision belonging to whatever scrapes it.

### Fixed

- **Histogram labels are stored beside their observations** rather than
  recovered by parsing the storage key. A label value containing `=` or `,`
  would not have survived the round trip.

## 1.0.0

The version numbers become meaningful.

Until now every package shared one version and all twelve were republished
together. That does not survive contact with per-package releases while the
major is `0`: under semver a `^0.2.0` range excludes `0.3.0`, so changing one
package and releasing only it leaves every dependent pinned to the old copy —
and npm resolves that by installing both. Two copies of `observability` means
two distinct `MORTAR_LOGGER` symbols, and dependency injection stops working
with an error that names neither.

At `1.x` a caret range accepts later minors, so a package can be released on
its own and its dependents pick it up on their next install. From here:

- **patch** — a fix that changes no signature
- **minor** — anything added
- **major** — anything removed or changed in shape

### Added

- **`DatabaseModule` can run migrations at boot** — `migrationsRun: true`.

  Guarded by a Postgres advisory lock, so several replicas starting at once are
  safe: one applies while the others wait, then find nothing pending. TypeORM
  takes no lock of its own, and without one the second replica to reach a
  `CREATE TABLE` fails and that container crash-loops. Also exported directly
  as `runMigrationsWithLock` for release-step scripts.

- **`LoggerModule` provides `NestLoggerAdapter` and `LoggingInterceptor`.**
  Both were exported but never registered, so `app.get(NestLoggerAdapter)` and
  `{ provide: APP_INTERCEPTOR, useExisting: LoggingInterceptor }` — the two
  documented ways to use them — both failed. Constructing them by hand still
  works.

- **`PUBLIC_ROUTE_KEY` and `PublicRoute()` in `@birtalanrobert/http`**, and the
  health controller now carries them. `@birtalanrobert/auth` re-exports the key
  as `PUBLIC_KEY`, unchanged, so `PermissionsGuard` and `@Public()` behave
  exactly as before — but a globally registered guard no longer 401s the
  readiness probe, which previously left pods that never joined the load
  balancer.

- **`auditEntities` and `idempotencyEntities`**, so every package that ships
  entities exports them as an array the same way it exports its migrations.

### Fixed

- **A circular import between `logger.module.ts` and the two classes it now
  provides** left `MORTAR_LOGGER` `undefined` at decorator evaluation time, so
  `@Inject(MORTAR_LOGGER)` silently degraded to reflected-type injection and
  Nest reported that it could not resolve `Function`. The tokens moved to a
  leaf module. Under CommonJS this class of bug fails at wiring time, never at
  build time.

### Testing

`@nestjs/testing` and `unplugin-swc` are now dev dependencies, and the Nest
modules are exercised by building a real container rather than by inspecting
the `DynamicModule` object. Every defect above was invisible to a test that
asserts on `module.providers` and obvious to one that calls `moduleRef.get()`.

## 0.2.0

Composing the packages into a real application surfaced three problems that
package-level tests could not.

### Added

- **`forRootAsync` on every configurable module** — `LoggerModule`,
  `DatabaseModule`, `RedisModule`, `HttpModule`, `TenancyModule`, `AuthModule`,
  `IdempotencyModule` and `JobsModule`.

  Previously each module took its options synchronously, which meant a consumer
  had to read `process.env` at import time — before anything had validated it —
  to configure a database URL or a Redis connection. That defeats having a
  configuration layer at all. Options can now come from any provider, including
  the validated config.

- **`ConfigModule.token()`**, so a wiring site can write
  `inject: [ConfigModule.token()]` rather than importing the raw symbol.

- **`AsyncModuleOptions<T>`** in `@birtalanrobert/context`: the shared shape for
  the above.

### Fixed

- **`HttpModule` and `TenancyModule` no longer hold module options in static
  fields.** Both middlewares now receive their options through dependency
  injection. The previous arrangement meant a second `forRoot()` call silently
  overwrote the first — which is exactly what happens when a test suite builds
  more than one application in a process.

- **`@birtalanrobert/http` accepts `class-validator` 0.15**, which is current.
  The peer range previously stopped at 0.14 and produced an unmet-peer warning
  on every install.

- **Internal dependencies publish as `^x.y.z` rather than an exact pin.** Exact
  pins across a family released together make npm install several copies of the
  same package as soon as two versions coexist in one tree.

### Note on compatibility

`HttpModule.contextOptions` and `TenancyModule.resolvers` are no longer present
as static properties. They were declared `private` and were never part of the
documented surface — TypeScript consumers could not reach them — but a
JavaScript consumer reading them would break. Nothing else changed shape.

## 0.1.0

First release.
