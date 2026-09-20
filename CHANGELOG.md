# Changelog

Each package carries its own version. A release publishes only the packages
whose version is not yet on the registry; `pnpm release` asks npm and skips the
rest.

## observability 1.3.0

### Changed

- **The HTTP status decides the log level, not whether something was thrown.**
  Every refusal reaches the interceptor as an exception — that is how a
  framework says "no" — and all of them were logged at `error` with a full
  stack. A ticketing product's busiest, most correct minute then looks exactly
  like an outage: four hundred `error` lines a second, each carrying a stack,
  for four hundred buyers being told somebody else got the seat. It floods the
  alerting rule that is watching for the thing it can now no longer see, and
  serialising a stack per request is real work on the one event loop that is
  already the bottleneck under load.

  A 4xx is now `warn`, logged as `request refused` with the three fields worth
  grouping on — the error's class, its application code and the sentence the
  caller was given — and without the stack, which describes our frames rather
  than their mistake. A 5xx is unchanged: ours, and keeps everything.

## config 1.2.0

### Added

- **`envText`** — a string that may be empty, which is how a feature is switched
  off. `envString` is "this service does not run without it"; this is "an
  address nobody published means the thing behind it is not there". A live
  channel, an analytics endpoint, a support address: each has a page that must
  render perfectly without one.

### Fixed

- **`envString('')` built a schema that could never pass.** The default was
  substituted and then failed the `min(1)` it had just been given, so a variable
  documented as optional took the whole surface down the first time it was
  actually left unset — every page, at boot, with a validation error naming a
  variable the operator had deliberately omitted. It now throws where the
  mistake is made, naming `envText`.

## realtime 2.0.1

### Fixed

- **The polling fallback could never deliver a first event.** A client that
  falls back to HTTP starts with an empty cursor and asks `since: {}`; `resume`
  reads that as "I am new here" and answers with `latest` and no events, which
  is deliberate — a newcomer does not want the whole backlog. But the polling
  loop advanced its cursor only from events it received, so it never left zero:
  the next poll asked `{}` again, and the one after that, for ever. A page that
  polls perfectly and is never told a thing.

  It now seeds from `latest`, after applying the events and only for a channel
  still standing at zero — the same two conditions the socket path has always
  applied to the `start` frame. Seeding a channel that has just been handed a
  resume would throw that resume away.

  The socket half was never affected, which is why this survived two releases:
  the fallback is what a venue with a hostile network gets, and nobody had
  watched one work.

- **`connecting` was reported for every retry behind a working fallback.** Once
  polling is running the page is connected — over HTTP — and the socket attempt
  behind it is background work. Each attempt moved the state back, so a seat map
  that was updating perfectly said "connecting…" for as long as it was open, and
  `polling` showed only for the instant between a socket dying and the next try.
  On a network that eats WebSockets that is every few seconds. The state a
  product shows is now the state it is in.

## billing 3.1.0

### Added

- **`assign`** — puts a business on a plan without sending anybody to a payment
  page. A chain is sold to rather than checked out, a pilot runs on somebody's
  word, and a business migrating from a competitor is put on the plan it agreed
  to before a card is entered.

  It is also what a deployment with **no provider configured** needs to have a
  subscription at all: every path to a subscription row went through a hosted
  checkout, so until a Stripe account existed there was nothing for a billing
  screen to show and no way to demonstrate the product's own commercial
  behaviour. Project 06's back office is the second consumer of that need; the
  first was project 05's, worked around at the time.

  It refuses to touch a subscription the provider owns — once a card is being
  charged on a schedule, a plan code written beside it makes our screen and
  their invoice disagree, and the customer believes whichever they saw first.
  Changing _how many_ stays `setQuantity`, which tells the provider.

- **`nextPeriodEnd`** — when the period being paid for ends, for a subscription
  this deployment keeps itself. The day of the month is clamped rather than
  rolled over: a month after the thirty-first of January is the twenty-eighth of
  February, because otherwise a business billed on the thirty-first drifts
  forward through the calendar and the two months with the drift in them are
  charged twice.

## links 1.0.0

New package: **signed, expiring links** — how somebody reaches a page without an
account.

It was written inside `stamped-enrol`, with a comment saying it was the
extraction candidate and would move at its second consumer. Phase 4 of project
06 is the API starting to _mint_ them, which is that second consumer — and the
two halves had to move together, because they must agree exactly on the payload
encoding and two implementations that agree today will not agree in a year.

`verifyLink` reports `malformed`, `invalid` or `expired` separately, because
those have three different remedies. The signature is checked before the expiry,
so an expired token nobody signed reads as invalid rather than as merely
expired — which would otherwise invite somebody to keep trying with a fresher
timestamp.

Web Crypto rather than `node:crypto`, so the same code runs in an edge
middleware, a browser and a Nest service. No dependencies.

## wallet 1.2.0

### Added

- **`onRegistered`**, beside the `onDeregistered` that was already there. A
  registration is the only signal either platform gives that a pass was actually
  _installed_: issuing one is a file leaving a server, and nothing else
  distinguishes the two. A product measuring an enrolment funnel, or holding a
  welcome bonus back until there is a phone to show it on, has this and nothing
  else to go on.

  `created` says whether the device already had it, so a retry is not counted as
  an installation. Whether a _re_-installation counts is left to the product,
  because that is where the answer is known.

### Fixed

- **A removal that removed nothing no longer reports a withdrawal of consent.**
  `unregisterDevice` answers 200 whether or not a row went — correctly, because
  a device retrying has not made a mistake — and the Nest layer was reading that
  status as "a holder removed their pass". A device that had nothing registered,
  or somebody with a serial and no pass, would have suppressed a customer's
  messages by asking twice.

  `ProtocolResult` now carries `changed`, which is what the status deliberately
  hides, and both hooks read it.

## files 1.9.0

### Added

- **A fixed frame for a derivative.** `DerivativeSpec` takes an optional
  `height`, with `fit` (`contain` or `cover`) and `background`. Given both
  dimensions the derivative comes out at exactly that size.

  The pipeline was written for photographs, where asking for a width and letting
  the height follow is right. An _asset_ has no shape of its own to keep: a
  square avatar, and a wallet pass's icon, which Apple and Google both reject at
  any size but the one they name. There is no way to produce either by naming a
  width.

  `contain` never enlarges: a small upload is centred and padded rather than
  blown up, because a stretched logo on a customer's card is worse than a small
  one. Padding is transparent unless told otherwise, which is what a logo laid
  over an unknown colour needs; a format without an alpha channel renders that
  as black, so a JPEG derivative of a padded image should name a background.

  `cover` does enlarge, and has to. A frame that is not filled is not a cover,
  and refusing would hand back a derivative the size of the _upload_ rather than
  the size asked for — a 40-pixel strip image where a pass wanted 375 by 123,
  which is a file the device refuses at a counter rather than an error here.

## wallet 1.1.0

### Added

- **Apple's update web service**, as a protocol rather than a controller. The
  five handlers, the registration table and the push live here; the product
  supplies a `PassSource` — three methods that say what a pass _is_ — and writes
  its own controller, because where the routes sit, which guard marks them
  public and what rate limit they carry are the product's decisions. Expressing
  any of them here would mean this package depending on a product's
  authentication.
- **`/nestjs`**: `WalletModule`, `WalletWebService`, `WalletRegistrationsService`,
  and the three tables — registrations, push deliveries and the device log.
- **APNs** behind `ApnsPort`, with `RecordingApns` and an HTTP/2 client.
- **Google** behind `GoogleWalletPort`, with `RecordingGoogleWallet` and a real
  client.

### Three decisions worth recording

- **The per-pass authentication token is derived, not stored.** Every pass
  carries a secret the device sends back, and the obvious implementation keeps a
  column of them. `passAuthenticationToken(secret, subject)` computes it from one
  deployment secret instead: nothing secret is in the database, a rebuilt pass
  carries the same token — which a stored hash could not produce — and rotation
  is incrementing a number on the row. The cost is that the secret is the whole
  scheme: change it and every outstanding pass stops being able to update, which
  is right after a leak and a catastrophe by accident.

- **The updated-since tag comes from a monotonic sequence and never a clock.**
  Two updates inside the same tick share a clock value; the device stores it,
  asks again, is told nothing changed, and keeps a pass that has quietly stopped
  matching the database. `webservice.test.ts` asserts both of two updates made in
  the same instant are reported.

- **Pushes are coalesced per device, not per pass.** The push carries nothing —
  no serial, no payload — and the device answers it by asking which of _its_
  passes changed. A holder whose two cards both changed needs one notification;
  sending two makes a phone buzz twice for one question it will ask once. Five
  stamps on five customers is still five pushes.

### Smaller things that are easy to get wrong, and are handled

- `Last-Modified` is compared **loosely**: HTTP dates carry one second, so an
  equal timestamp serves the pass rather than answering 304. At worst one
  redundant fetch, never a missed update.
- Re-registering a device **takes the new push token**. A device that reinstalls
  the pass calls with the same identifiers and a different token, and keeping the
  old one means pushing into the void for ever while recording every one as
  delivered.
- `410 Unregistered` **removes the registration** rather than only being logged.
  It is the only signal there is that somebody deleted their card without the
  deregistration arriving.
- Registration answers **201 the first time and 200 the next**, which Apple
  documents and devices rely on.
- The updated-since query answers **204**, not 200 with an empty array.
- `POST /v1/log` is implemented. It is the only diagnostic Apple sends anywhere,
  and a programme with no device of its own has more use for it than most.
- The three tables **carry no row-level security policy**, deliberately and for
  the same reason `platform_operators` does not: a device sends an opaque
  identifier and a serial and nothing else, so every lookup happens before any
  tenant is known — and a bound read of a `FORCE`-secured table returns nothing
  while reporting success.

## wallet 1.0.0

New package. Apple Wallet and Google Wallet passes — one content model, two
renderers, and a conformance suite.

### Why it is here rather than inside a product

Project 06's specification asks for "a module within the API, isolated behind a
clean interface, so that it can be lifted into project 1 without modification".
The extraction policy says the opposite and is right: two of the seventeen
specifications need wallet passes — loyalty cards and tickets — which is the
threshold, and an interface designed against one of them acquires a
loyalty-shaped assumption in its first week. "Liftable later" is a promise
nobody has ever kept.

So the vocabulary is `PassContent` and `PassField` rather than `stamps` and
`balance`, and both specifications were read before the first type was written.

### What it does

- **`buildPkPass`** — validate, render `pass.json`, hash every file, sign the
  manifest, zip. Deterministic given `builtAt`, because the manifest hashes the
  content and a build that varied would make every rebuild look to a device like
  a change. Refuses rather than signing a pass that breaks a rule.
- **`verifyPkPass`** — the conformance check. Reads the archive back **from its
  bytes** rather than from whatever the builder thought it wrote, re-derives
  every hash in both directions, verifies the detached PKCS#7 against a chain,
  and applies the rules to the `pass.json` actually in the file.
- **`apple/rules.ts`** — every rule in one file with a citation each, plus
  `RULES_REVIEWED`.
- **`readSigningCertificate`** — reads the pass type and team identifiers out of
  the certificate rather than taking them from configuration beside it, because
  a device refuses a pass whose two disagree with its signature and says nothing
  useful about why. Reports `selfSigned`.
- **`buildLoyaltyClass` / `buildLoyaltyObject` / `saveLink`** — Google's half,
  from the same content.
- **`/testing`** — `testSigner`, `sampleContent`, `sampleAssets`, `solidPng`.
  No network, no keychain, no openssl binary.
- **`wallet:verify`**, with a `--live` mode that uses real credentials and names
  what it did not check instead of passing quietly.

### The honest part

There is no device in this programme and there will not be one, so this package
cannot prove that a lock screen renders a pass, that APNs delivers, or that
Apple accepts our certificate. Those are stated in the README as unprovable here
rather than implied by a green run, and `--live` exists now so that one command
answers them the day an Apple account does.

The substitute for a canary is `RULES_REVIEWED` — a date a human moves by
re-reading Apple's published requirements. It is weaker than a canary and is
written down as weaker.

### Decisions worth recording

- **`pkijs` for CMS, `node:crypto` for JWTs.** ASN.1 is a solved problem with
  decades behind it and shelling out to `openssl smime` would make the build
  depend on a binary's version. A JWT with a fixed algorithm is not: everything
  dangerous about JWT is on the verifying side, both tokens here are read by
  somebody else, and `jose` is ESM-only in a CommonJS monorepo. `verifyJwt`
  takes the algorithm as an **argument** rather than reading it from the header,
  which is the decision that makes the difference.
- **Assets are bytes, not keys or URLs.** A package that signs a file for
  somebody else's operating system should not also need an S3 client to be
  tested.
- **`sharingProhibited` defaults on for store cards and coupons**, which is the
  opposite of the platform default. A shareable stamp card is a screenshot in a
  group chat — the same failure that makes a static counter QR code unusable.

### Found while writing it

- **A DER serial number with an unconditional leading zero parsed about half the
  time.** DER permits the padding byte only where the next byte would set the
  sign bit and forbids it otherwise, so `generateDevelopmentCertificate`
  produced a certificate OpenSSL rejected as "illegal padding" whenever the
  first random byte happened to be below 0x80. One run of one certificate would
  have passed three times in five; there is now a test that generates
  twenty-five.
- **`pkijs` cannot emit a distinguished name with separate relative names.** It
  parses them into a flat list and re-encodes them as one multi-valued name, so
  a generated certificate reads as `CN=… + OU=… + O=…` while Apple's reads as
  three lines. The shape used in production is therefore the shape no fixture
  can build — which is why `parseDistinguishedName` is its own module with its
  own tests covering both renderings, rather than a private helper exercised
  only by the fixture.

## files 1.8.0

### Added

- **A `./zip` subpath**, exporting `createZip` and its types on their own.

  The writer was already here and already deterministic, which is what a
  `.pkpass` needs — Apple's archive is checked by hash, so a second build of the
  same content has to produce the same bytes. `@birtalanrobert/wallet` needs
  exactly that and nothing else from this package: it takes pass assets as
  bytes and never touches storage, because a package that signs a file for
  somebody else's operating system should not also need an S3 client to be
  tested.

  Importing the root would have given it one. `index.ts` exports `S3Storage`
  and the `StoredFile` entity, so `import { createZip } from
'@birtalanrobert/files'` loads the AWS SDK and TypeORM to write a zip. The
  subpath is the same code with none of that in its import graph.

## billing 3.0.0

### Fixed

- **`reportUsage` reported nothing, every night, and said so.** It read
  `mortar_usage_records` unbound, with a docblock explaining that a sweep is
  about every tenant and the row itself says whose it is. The table carries
  `FORCE ROW LEVEL SECURITY`, which applies to the table owner too — so the
  `SELECT` returned no rows and reported success, and a night with unreported
  usage was indistinguishable from a night with none.

  Nothing anywhere would have said so. The method returns a count, the count was
  zero, and zero is what a quiet night looks like. Found in project 10 while
  building the metering that calls it.

### Changed

- **`reportUsage(tenants, before?)` now takes the tenants to sweep**, and this is
  a breaking change rather than an optional parameter on purpose: an optional one
  would leave the silent version reachable, and the silent version is the whole
  defect.

  There is no way for this package to enumerate tenants for itself — the only
  table it could read them from is the one behind the policy. Which is the right
  answer anyway: the product owns the register of who exists, and this owns what
  they used. It is the same shape every sweep in this programme has ended up
  with.

- The `UPDATE` marking a row reported is bound too, for the same reason: without
  it, it matches nothing and the same day is reported again on the next sweep.

### Added

- `usage.integration.test.ts`, against a real PostgreSQL with the real
  migration. Every unit test passed throughout the defect's life, because a
  policy needs a database to bite — and `synchronize` does not create one.

## workflow 1.4.0

### Added

- **`PublicLinkService` and a 37-character signed link**, for links that are
  printed, scanned or sent in a text message.

  `signLink` carries its claims inside the token, which is the right trade for
  an email: a forgery is rejected with no database involved. It costs length —
  a subject, a tenant, an expiry and a token id, as JSON, in base64, with a
  SHA-256 signature, comes to **over three hundred characters**. Project 10
  measured what that does to the thing the product is bought for: its "ready for
  collection" SMS came to **seven segments**, of which the URL was five, against
  a specification that says one. As a QR code on a shop window the same token is
  a dense square a phone reads badly across a counter.

  So where a link has to be short, the claims move to a row and the token
  becomes a handle plus a truncated signature: `1` + 22 base64url characters of
  random handle + 14 of tag. The 128-bit handle is what makes it unguessable;
  the tag is what lets a crawler walking `/s/<rubbish>` be refused by an HMAC
  instead of a query. The cost is one indexed lookup, which the page was making
  anyway — it has to read the subject to render it, and revocation is a row
  whichever format is used.

  Neither format supersedes the other. They trade length against a round trip,
  in opposite directions, and both say so in their own docblocks.

- **`mortar_public_link` carries no row-level security policy, deliberately.** A
  handle arrives from a stranger with a URL and nothing else — no session, no
  tenant, nothing a policy could bind to — so the lookup that turns it into a
  tenant cannot itself require one. This is the fourth time in this programme
  that a public handle has had to live in an unpolicied table, after `tenants`
  and project 10's `intake_slug`; the row holds no secrets, and the caller binds
  the tenant it returns before reading anything.

- `mintHandle`, `signHandle`, `verifyHandle`, `isHandle`, `LINK_TOKEN_LENGTH`
  and `LINK_HANDLE_LENGTH` on the pure entry point, so a Next.js server
  component can reject a bad token before opening a connection.

### Changed

- The base64url, HMAC and constant-time comparison helpers moved to
  `links/encoding.ts` and are shared by both token formats. A second
  `toBase64Url` is a second opinion about what bytes a signature covers, and two
  such opinions produce signatures that verify inconsistently — months later,
  for one customer, on one link.

## messaging 1.2.0

### Added

- **`transliterateToGsm`**, the other half of `countSegments`.

  `countSegments` names the characters that forced the expensive encoding.
  Naming them is not much use when they are in the shop's own name: one `ă` in
  `Cofetăria Mierla` moves every message that shop ever sends into UCS-2 and
  cuts capacity from 160 characters to 70, and the shop cannot rename itself.

  Two rules, and both matter. **Marks that are already in the GSM alphabet are
  left alone** — `é`, `ü`, `à`, `ñ` and `Ö` cost one place each, and "strip every
  accent" damages a French or German name to save nothing. **Nothing is ever
  silently dropped**: Greek, Cyrillic and ideographs have no faithful Latin
  equivalent, so they are kept and _reported_, and the product can say "this
  still costs double" rather than claim a saving it did not make.

  It is deliberately not applied on anyone's behalf. A business's name is
  theirs; the product offers the transliteration and shows what it saves.

- `isGsmCharacter`, exported so transliteration asks exactly the question the
  counter asks. Two definitions of the alphabet would mean a firm shown one
  number and billed against another.

## workflow 1.3.1

### Documented

- **`occurred_at` must default to `clock_timestamp()`, not `now()`** — and the
  base entity now says so where somebody writing a `CREATE TABLE` will read it.
  In PostgreSQL `now()` is the _transaction's_ start time, identical for every
  row written inside it, and products record two moves in one transaction on
  ordinary paths: an order taken across a counter is opened and confirmed in one
  breath. Both rows then carry the same microsecond, and `reverse` — which finds
  the last move with `ORDER BY occurred_at DESC, id DESC` — is left choosing
  between two random UUIDs. It undoes one of them, and says nothing.

  Found in project 10, where an order's history displayed out of order one run
  in two. Every product that wrote its own transition table used `now()`;
  `dossier` and `workbench` still do.

- **No guard was added, and that is deliberate.** One was written and removed.
  TypeORM hands `occurredAt` back as a JavaScript `Date`, which is
  millisecond-precision, so comparing two of them reports a tie for rows that
  are genuinely microseconds apart — it refused reversals that were perfectly
  well-defined and broke two of this package's own passing tests. Turning a rare
  silent fault into a frequent loud one is not an improvement. Detecting it
  honestly needs the comparison done in SQL, or an insertion-order column on the
  table, and the second is a schema change for every consumer.

## csv 1.3.0

### Added

- **`readXlsx` and `sheetsIn` on `@birtalanrobert/csv/xlsx`** — the reading half
  of a subpath that could previously only write. Project 04 takes a
  distributor's catalogue in whatever shape their system exports, and a workbook
  is one of the five shapes its format layer has to cover; projects 03, 05, 07,
  08, 09, 10 and 12 all import a spreadsheet the customer already has, because
  re-keying it by hand at signup is where a trial dies.
- **Every cell comes back a string, and that is the contract.** A workbook
  stores a guess about what each cell _is_, made by whichever program wrote it
  under whichever locale — so a price arriving as the number `1234.56` has
  already been read under a convention nobody declared, and a reference of
  `0042` has already become forty-two. Handing over what is written lets that
  decision be made once, explicitly, by a mapping that can be previewed. The one
  exception is a date cell, which holds a serial number and has no text to hand
  over; it comes back as `YYYY-MM-DD`, the format no locale reinterprets.
- `read-excel-file`, by the same author as the writer, both MIT and five MIT
  packages between them. The note in this file's own source about ExcelJS still
  stands: its reading path reaches `unzipper` → `binary` → `buffers`, which
  declares no licence at all.

## quantity 1.0.0

### Added

- **`@birtalanrobert/quantity` — a decimal quantity with a unit, and an explicit
  factor table.** The extraction project 03's deferred register has been holding
  for project 04, and designed from both rather than from the one in hand. 03
  converts _between_ dimensions using per-ingredient physics — a litre of oil is
  not a kilogram of oil, and one onion is 150 grams because somebody typed that
  in. 04 needs a factor chain _within_ one dimension: a case is four trays and a
  tray is six bottles. Read side by side the shared part is small and exact — a
  quantity that carries its unit, a factor table, conversion to and from a base,
  and a refusal that is a sentence rather than a stack trace.
- **The table resolves at definition time**, which is the design rather than an
  optimisation: every factor is absolute before anybody can read one, so a cycle
  is impossible by construction and a pallet converts to a bottle in one
  multiplication rather than by walking the chain and rounding at each step. A
  cycle is refused where it is defined, naming the loop —
  `"case" is defined in terms of itself: case → tray → case.`
- **A unit worth nothing is refused**, because dividing by it surfaces as
  `Infinity` inside a total rather than as an error anybody can trace back.
- **The decimal configuration every consumer shares** — 34 significant digits,
  half-up, no exponential notation — with `decimal.js` as a _peer_ dependency,
  because the configuration is global to the module instance a bundler resolved
  and a second copy silently gets its own defaults. That is the trap that once
  registered the forint in the wrong copy and rendered every HUF price a
  hundredth of its value.
- `isMoreThanZero`, because **`Decimal.isPositive()` is true for zero** and
  every caller in this programme that wrote it meant "is there any of it".

**Deliberately not in it:** densities and piece weights (03's, and meaningless
to a wholesaler), minimum order quantities and increments (04's, and meaningless
to a kitchen), and anything that knows what a product is.

## csv 1.2.0

### Added

- **`@birtalanrobert/csv/mapping` — turning the columns somebody else's system
  wrote into the fields a product understands.** Four specifications ask for the
  same thing in four different words: a price-list wizard (03), a payroll export
  profile saved per bookkeeper (07), a spreadsheet import of years of candidates
  (08), and an ERP feed whose layout is configured rather than coded (04). The
  first consumer was not a specification but 764 lines of working code in
  project 03, which is the strongest position this library has extracted from.
- **A field specification that explains itself**, because the sentence beside a
  dropdown is shown to a support person who has never seen this file before —
  and the same sentence is quoted back by a refusal:
  `Say which column holds the price per pack.`
- **Conventions are configuration and never guessed.** `1.234,56` and
  `1,234.56` are the same number under two conventions, both arrive from the
  same country, and read under the wrong one a price is wrong by a factor of a
  thousand **while passing every validation a sensible person writes**. The
  thousands separator is stripped before the decimal one, which is the order
  that does not turn `1.234,56` into `1.234.56`.
- **A decimal comes back as a string**, never a number. A float here is the bug
  the module exists to avoid.
- **A problem carries the line it was on**, counting the header as line 1, so a
  report says "row 1 842" and somebody can go and look at row 1 842. Products
  add their own through `row.reject`, so "no product has that code" and "that is
  not a number" arrive in one list.
- Booleans in the conventions these markets actually write — `da/nu`,
  `igen/nem`, `Y/N`, `1/0` — and per-file overrides where a system has its own.
  Dates in ISO, `DD.MM.YYYY`, `DD/MM/YYYY`, `MM/DD/YYYY` and `YYYYMMDD`, each
  round-tripped so that `31.02.2026` is refused rather than accepted for
  matching the shape.
- A trailing minus and a parenthesised negative, both unambiguous, both written
  by older systems, and both otherwise rejected as "not a number".

## files 1.5.0

### Added

- **`@birtalanrobert/files/print` — print-ready cards with a QR code on each.**
  The artefact that makes a product exist in a shop: a venue that has signed up
  and not printed its table tents has not started, and "design twenty cards with
  a different code on each" is the step where they stop. Three of the seventeen
  specifications ask for exactly this — project 11's table tents and counter
  posters, project 06's enrolment posters in A4, A5 and tent, project 01's
  ticket with a code on it — so it is designed from all three rather than from
  the one in hand: a code, a heading, a caption and a footnote laid out on paper
  that folds and cuts where the marks say. **What any of them say is the
  product's**, on the same line the conventions already draw around notification
  templates: the machinery is shared, the content is not.

  Three things in it are decisions rather than details:

  - **The code is drawn as vectors, not as an image.** Merged into horizontal
    runs it is a couple of hundred rectangles rather than a thousand, and it
    stays sharp at whatever resolution the printer has. A rasterised code scaled
    to a 60 mm square on a 1200 dpi printer is a blurred one, and a blurred code
    at the third attempt is a guest who gives up and asks for a menu.
  - **A tent is one sheet with the card on it twice, the upper half turned
    through half a turn.** Folded, the two faces read from both sides of the
    table. Printed the obvious way one of them is upside down, and the venue
    finds out after printing twenty.
  - **The typeface is a required argument.** PDF's built-in fonts are
    WinAnsi-encoded, which has no `ș`, no `ț` and no `ő` — a default would work
    in development and throw on the first Romanian venue name.

  The font is embedded **whole**: `@pdf-lib/fontkit`'s subsetter drops glyphs
  from ordinary static TrueType fonts, so `Masa 12` prints as `M   2` while the
  text layer still reads `Masa 12` — it copies, searches and extracts correctly
  and is wrong only on paper. Nothing that counts pages sees it. The cost is the
  typeface once per document rather than once per card.

  Adds `qrcode` and `@pdf-lib/fontkit`, both behind the `./print` subpath so a
  consumer that only uploads files never loads either.

## realtime 2.0.0

### Changed

- **`RealtimeSocketServer` moved to `@birtalanrobert/realtime/nestjs/socket`.**
  It is the only thing in the package that needs `ws`, and importing a barrel
  loads everything in it — so a process that publishes and holds no sockets was
  made to install a WebSocket library to reach a Redis backlog, which is exactly
  what declaring `ws` an optional peer was meant to avoid. Found the moment a
  second publisher appeared: project 11's worker releases a held course when its
  timer runs out, publishes it into the same backlog the API serves, and could
  not boot.

  One import to change per gateway process; nothing else moves.

### Fixed

- **A process no longer receives its own broadcast.** Redis pub/sub delivers to
  every subscriber on the channel, the sender included, so a gateway that both
  sends and listens — which is every replica — handed each of its own events to
  its sockets twice: once locally, once on the way back. Clients survived it,
  because a repeated sequence number is `skip`; what nobody would have noticed
  is that every screen in the building was being sent twice what it needed, over
  venue wifi, on a tablet. Each message now carries the id of the process that
  sent it and is dropped on arrival at that same process.

  The id is generated rather than configured, deliberately: it exists only to
  recognise a message coming back, and a value an operator could set is a value
  two replicas can be given identically — which would make each drop the other's
  events, the one failure the fan-out exists to prevent.

## printing 1.0.1

### Fixed

- **A queued job's callback now belongs to that job.** `enqueue`'s `onDone` was
  held by the drain loop rather than by the job, so anything queued while the
  printer was busy had its outcome handed to the _previous_ job's caller. One
  routed order is three tickets queued in a row, which made this the normal case
  rather than a race: a product recording "printed" then recorded it against the
  wrong ticket, and the one that actually failed was marked as fine — worse than
  recording nothing, because the whole point of the callback is knowing which
  ticket has no paper.

- **One caller's callback throwing no longer stops the queue.** The remaining
  tickets sat in a queue that had quietly stopped draining, which is the harder
  failure to notice: nothing errored, and a kitchen simply received less than it
  was sent.

- **`wrap` no longer eats a leading indent.** Splitting on spaces turned
  `'   Extra sauce'` into three empty words that were discarded, so an indented
  block printed flush left. That indent is not decoration: it is what separates
  a modifier from the _next_ dish's name on a kitchen ticket, and without it a
  cook reads "no onions" as belonging to the wrong plate. The indent is now kept
  and re-applied to continuation lines, so a modifier long enough to wrap stays
  under its dish instead of sliding back to the margin.

## printing 1.0.0

### Added

- **`@birtalanrobert/printing`** — ESC/POS rendering, a raw port 9100 transport,
  a retrying queue that escalates, and a printer that keeps what it was sent.
  Three products need paper: project 11, where it is a **v1 requirement**
  because a meaningful share of prospects will not buy without it; project 12's
  intake receipt; and project 01's box-office stock. The layout stays in each
  product — a kitchen ticket and a repair receipt share nothing but the wire.

  `Ticket` makes four mistakes impossible, each of which has printed wrong in
  somebody's kitchen. **The printer is initialised first**, because it holds
  whatever the last ticket left it in — the classic symptom being every ticket
  after a heading printing double height until somebody power-cycles it.
  **Styles are turned off again.** **`cut()` feeds the paper past the blade
  first**, since the blade sits above the print head and a cut without a feed
  takes the last three items with it. And **accented text is encoded for the
  printer's own character table**, defaulting to Windows-1250: the American
  table most printers boot into turns "Ciorbă de burtă" into something a cook
  misreads at a glance. Text wraps rather than truncating, because the end of a
  line on a kitchen ticket is where the modifiers are.

  `send` resolving means the bytes left this machine and nothing more — raw port
  9100 has no acknowledgement, and a product reading "printed" as "on paper" is
  reading something the protocol never says.

  `PrintQueue` retries three times, prints serially (two jobs at once interleave
  into one ticket with half of each on it), and **escalates**: `onFailure` is
  not decoration, because a queue that swallows a failure is a kitchen with no
  ticket that never learns it has none. A printer that does not exist fails
  immediately — a configuration mistake answers the same way every time.

  Deliberately **not** BullMQ. A print job is worthless a minute after it was
  created, so it lives in memory beside the process that made it; after a
  restart what a kitchen needs is the _current_ tickets, which the display and
  the database already have.

## realtime 1.1.0

### Added

- **`@birtalanrobert/realtime/nestjs`** — the server half: a WebSocket server, a
  Redis-backed backlog, a Redis fan-out between gateway processes, a polling
  handler and a Nest module.

  `RedisBacklog` assigns the sequence number and stores the event **in one Lua
  script**, because two round trips can come apart: a process that dies between
  `INCR` and `ZADD` has handed out 413 and stored nothing, and no later care can
  fill that hole — every client that reaches it is told the backlog starts at
  414 and reloads, for ever, for an event that never existed.

  `RedisBroadcast` is fire-and-forget, and that is acceptable _here and nowhere
  else_: pub/sub does not deliver to a process that is not connected, but the
  event is already durable, so a process that missed the broadcast serves it
  from the resume the moment any client asks. The socket is the fast path; the
  backlog is the truth.

  `RealtimeSocketServer` sends a client's **replay before its welcome**. The
  welcome says where a channel stands; sending it first would let a client with
  no position adopt the latest sequence and then reject the replay it is about
  to receive as already seen.

  Authorisation is the product's, and returns a _subset_ rather than a boolean —
  a display asking for two stations it may see and one it may not gets the two,
  rather than a connection that fails for a reason nobody can see.

  Nine integration tests against a real socket and a real Redis, including
  twenty concurrent publishes asserting the numbers are 1 to 20 with nothing
  repeated and nothing skipped.

## redis 1.0.2

### Fixed

- **`flushTestRedis` deleted nothing.** `SCAN` returns keys with the client's
  prefix already on them, and every write through that client _adds_ the prefix
  — so passing the scanned keys straight to `DEL` removed `prefix:prefix:key`,
  which exists nowhere. The prefix is now stripped before deleting.

  Nothing failed, which is the point: suites using it shared state between
  tests and passed anyway, until one counted something and found five events
  where it had published four. There is now a test that sets a key, flushes, and
  asserts it is gone.

## realtime 1.0.0

### Added

- **`@birtalanrobert/realtime`** — channels with sequence numbers, gap
  detection, resume, bidirectional heartbeats and a polling fallback that is
  built and tested rather than described. Five specifications call for a live
  connection — project 11's kitchen displays and staff app, and the four game
  clients in 14 to 17 — so it is designed from those five rather than from the
  one in hand.

  **What makes it a package is gap detection, not socket handling.** A client
  that can say "I last saw 412" and be told what it missed is the difference
  between _probably fine_ and _provably complete_; a display quietly one ticket
  behind looks exactly like a kitchen with no orders.

  Three decisions carry the guarantees. **Sequence numbers are per channel**: a
  global counter would make every subscriber's gap detection depend on traffic
  it cannot see, so a kitchen display would think it had missed the messages a
  guest's phone received. **Publishing is append then fan out**, in that order —
  a subscriber told before the event was durable learns about something a
  reconnecting client could not be given. And **the backlog is bounded**, so it
  can fail to answer: a client that was away too long is sent a `gap` frame and
  reloads, rather than a partial replay that looks complete.

  The **polling fallback starts immediately** when a socket will not open, with
  the socket retried behind it — a venue whose network eats WebSockets gets a
  working display rather than a spinner and an exponential backoff. It speaks
  the same protocol and is answered by the same `resume`, which is what keeps it
  a fallback rather than a second implementation that differs on the day it is
  needed.

  The root entry is pure — wire format, gap logic, client — because four browser
  bundles import it.

  Authorisation, acknowledgement, presence and moderation are deliberately
  absent: who may subscribe to a channel is the product's decision, and whether
  a ticket was _acted on_ is a row in its database rather than a frame on a
  socket.

## files 1.4.0

### Added

- **`PutOptions.cacheControl`**, honoured by `S3Storage` on both `put` and
  `presignUpload` and recorded by `MemoryStorage` (readable through a new
  `optionsFor(key)`, so a test can assert what an object will be served under).

  The header belongs on the object because the thing that serves it is a CDN the
  application never speaks to. A rendered derivative's key names its content, so
  it is immutable and deserves `public, max-age=31536000, immutable` — and
  without it a guest's phone re-downloads every photograph on a menu on their
  second visit, which is the whole budget the image pipeline was added to
  protect. On a presigned upload it is signed in, so it appears in `headers` and
  a browser that omits it gets a signature mismatch rather than an object
  quietly missing the header.

  Never set it on an original somebody uploaded: that key can be reused.

### Fixed

- **A presigned upload carrying metadata was refused by S3.** `presignUpload`
  returned the metadata as `x-amz-meta-*` headers _as well as_ letting the SDK
  encode it into the query string, and a presigned PUT is rejected outright if
  it carries an `x-amz-*` header the signature does not cover: "there were
  headers present in the request which were not signed". Every product's direct
  upload sets metadata — the tenant and the scope, so an operator can read a
  bucket during an incident without a database — so every one of them was
  broken. The returned headers are now exactly the ones the browser must send:
  `content-type`, `cache-control` (both applied only when sent) and
  `content-disposition` (signed as a header, so omitting it breaks the
  signature). The metadata still arrives; it is in the URL.

  The failure had no witness. It happens on the one request the API is not part
  of, so the only symptom is a file that never appears.

- **The SDK signed a checksum of a body it had not seen.** Since v3.729 the AWS
  SDK computes a CRC32 for every upload by default, including one it is only
  presigning — so `x-amz-checksum-crc32` for an _empty_ body went into the URL
  and S3 rejected the browser's bytes for not hashing to it. `S3Storage` now
  sets `requestChecksumCalculation: 'WHEN_REQUIRED'`. MinIO ignores the
  mismatch, which is the worst version of this: the development stack works and
  the deployment does not.

## files 1.3.0

### Added

- **`@birtalanrobert/files/images`** — the image pipeline eight of the seventeen
  specifications call for, behind a subpath with `sharp` as an _optional_ peer
  dependency. A repair shop, a wedding microsite, a menu and a made-to-order
  workshop all receive photographs from people who are not thinking about the
  web, and none of them will ever be asked to resize anything.

  `renderImage(bytes, { sizes, formats, placeholder })` returns a responsive set
  in modern formats, the displayed dimensions, a dominant colour and optionally
  a blurred `data:` URI. Sizes are named in the product's own vocabulary —
  `thumb`, `card`, `full` — because a stored key of `card` survives the day
  somebody decides cards are 720 wide and a key of `640` does not.

  Four corrections are the reason this is one function rather than four calls at
  each consumer. **Orientation is applied and the returned dimensions are the
  turned ones**: a phone stores a portrait photograph as a landscape one plus an
  EXIF flag, and a page that reserves the stored shape produces exactly the
  layout shift the placeholder was added to prevent. **Metadata is dropped**,
  and the customer's front-door coordinates with it — sharp's default rather
  than a call, which is why there is a test asserting it. **Nothing is
  enlarged.** **A colour is measured** so the box is filled rather than white.

  Input is identified by its bytes; anything that is not a raster photograph
  raises `UnsupportedImageError`. The refusal that matters is the SVG, which
  libvips will rasterise happily and which is a document format with a script
  engine in it. `maxPixels` guards decompression, because the failure mode of a
  bomb is a worker killed by the kernel rather than an error anybody sees.

  Encoding is sequential on purpose: sharp threads each operation already, so
  six at once finishes no sooner while holding six decoded images in memory.

## workflow 1.3.0

### Added

- **`appendOnlySql(table, { redactable })`** — columns a retention sweep may set
  to `NULL`, and nothing else. Append-only and a published retention schedule
  pull against each other: the row is evidence of when somebody clocked in and
  must never be rewritten, while one column of it — a location trace, a
  photograph, an IP address — is personal data with an expiry date printed in a
  document a regulator can read.

  Without this the only way to keep that promise is to drop the trigger, sweep,
  and put it back: an operation performed under time pressure, on production,
  and sometimes forgotten halfway. So the erasure is narrowed instead of the
  protection being removed. An update passes only when every named column ends
  up `NULL` and every other column is exactly what it was; nulling an
  already-null column is fine, because an hourly sweep re-reaches rows it has
  already cleared and an error there is a worker restarting rather than a
  promise being kept.

  Tables that name no redactable column keep the function they had, character
  for character.

  **The order of the two checks inside the trigger is the error message rather
  than the outcome.** Checked the other way round, an ordinary rewrite of an
  unrelated column is still refused — but refused for leaving the _location_
  untouched, which sends whoever reads the log looking at the wrong column
  entirely. The rest of the row is compared first.

## context 1.2.0

### Added

- **`device` as an actor type.** Hardware that acts on its own credential —
  a kitchen display acknowledging a ticket, a tablet by a door recording a
  clock-in — was previously recorded as `client`, alongside the guest whose
  phone is in the same room. That is the one distinction the audit trail cannot
  afford to lose: "which display acknowledged this order?" is the first question
  asked when a table waits forty minutes, and an answer of "a client" does not
  separate the screen at the pass from the guest's own handset.

  Additive: `client` still means what it meant, and nothing has to move.

## comms 1.9.1

### Changed

- **`WebPushMessagePort` now takes a `DataSource` rather than a `keysFor`
  callback.** The callback had to be `CommsService.pushKeysFor`, and that cannot
  be built at the moment the module which _provides_ `CommsService` is being
  configured — every consumer would hit the same circle, and Nest's message for
  it names neither the port nor the reason.

  `mortar_push_subscription` is this package's own table, so the port reading it
  is not a layer being crossed. It still learns nothing about _who_ is
  subscribed: an endpoint and the two keys for it is all a transport should
  know, and all it gets.

## comms 1.9.0

### Added

- **Web push**, as a channel and the subscriptions it needs. Three of the
  seventeen specifications send to a PWA (02, 04, 07), and every one of them
  would otherwise reimplement the same thing: registering an endpoint,
  de-duplicating it, and — the part that goes wrong — **deleting it on 410
  Gone**. A browser that has revoked permission answers that for ever, and a
  product still trying has delivery figures that are quietly meaningless.

  `WebPushMessagePort` is a transport and knows nothing about who is subscribed:
  `CommsService` owns `mortar_push_subscription` and hands the port a resolver.
  `subject` names the relationship rather than one product's noun — an employee
  here, a customer there — because a foreign key to either is exactly what would
  stop the table being shared.

  `PushSubscriptionGone` is raised for 404 and 410 and for an endpoint with no
  keys, so a caller has one behaviour to reason about rather than three. A 503
  is an ordinary failure and does **not** delete anything: a push service having
  a bad minute is not a person revoking permission.

  `OutboundMessage.url` carries where a tap should land. In the encrypted
  payload rather than a header, because it is the service worker that decides
  what a notification does and it reads the payload.

### Changed

- **`MessageLog.channel` and `Suppression.channel` now import `Channel`** rather
  than spelling the union out. It was written in three places that had to move
  together with no compiler check that they did — and adding a member is already
  a schema change in disguise without also being a search.

## csv 1.1.1

### Changed

- **`toXlsx` now writes with `write-excel-file` rather than ExcelJS**, and the
  reason is a licence rather than a feature. ExcelJS reaches an _unlicensed_
  transitive dependency through its **reading** path — `unzipper` → `binary` →
  `buffers`, and `buffers@0.1.1` declares no licence anywhere, which under
  copyright means no rights granted. A product that ships cannot rely on code
  nobody has granted rights to, and `pnpm licenses:check` in project 07 refused
  it on exactly those grounds.

  Writing is all this subpath does. The replacement writes and does not read,
  and its whole dependency tree is one MIT package — so the reading half was
  buying a licence problem for a capability with no consumer.

  The interface is unchanged: same `toXlsx(rows, options)`, same contract that
  strings stay strings and numbers stay numbers.

## csv 1.1.0

### Added

- **`@birtalanrobert/csv/xlsx`** — writing the `.xlsx` a bookkeeper opens. Four
  of the seventeen specifications ask for Excel _beside_ CSV (03, 04, 05, 07)
  and the reason is always the same: a CSV opened in Excel is reinterpreted on
  the way in. An employee reference of `0042` becomes the number 42, and `7,50`
  becomes either seven and a half or the text "7,50" depending on a setting
  nobody in the business can find. An `.xlsx` says what each cell is.

  **Behind a subpath, deliberately.** The CSV side of this package is
  browser-safe and small; a spreadsheet writer is neither, and a console
  counting segments on every keystroke must not be shipping a zip library to do
  it. Only what needs Excel pays for Excel.

  Strings stay strings and numbers stay numbers, which is the whole contract:
  the caller decides, because a reference is text and a column somebody wants to
  sum is not.

### Changed

- The package description now says _tabular files_ rather than _CSV files_. The
  name stays `csv`, because renaming a published package costs every consumer a
  change for no gain.

## auth 1.2.0

### Added

- **`Pbkdf2Hasher`**, for a secret a **browser** must also verify. `ScryptHasher`
  remains the default and should stay it — scrypt is memory-hard and PBKDF2 is
  not — but the Web Crypto API implements PBKDF2 and does not implement scrypt.
  A surface that has to authenticate with no network therefore either verifies a
  PBKDF2 hash with the platform's own primitive, ships a JavaScript scrypt into
  every bundle, or holds a _second_ hash of the same secret in a second format.
  The third is the worst of the three: two representations of one secret is two
  things to keep in step, and the day they disagree is the day somebody cannot
  clock in.

  Encoded as `pbkdf2$sha256$iterations$salt$hash`, so the parameters travel with
  the hash. Defaults to OWASP's current floor of 600,000 iterations, and refuses
  a truncated digest for the same reason scrypt's parser does — PBKDF2 is
  prefix-stable, so verifying at the stored length would let a one-byte digest
  match roughly one attempt in 256.

  Use it only where offline verification is the requirement, and only for
  secrets whose real protection is something else: a rate limit, a locked
  cabinet, a short lifetime. For an account password, use scrypt.

## comms 1.8.0

### Added

- **`CommsService.serves(channel)`** — whether anything is configured that could
  carry a channel. For callers holding a genuine choice: somebody with both a
  mobile number and an email address, on a deployment that has SMTP and no text
  provider, should receive an email rather than a recorded failure, and the
  caller cannot know which without asking. The ports are the deployment's
  business rather than the product's, and until now they were private.

  It is deliberately not a promise of delivery and not a way around `send`'s
  honesty: a caller with only one address still sends on it and still gets the
  failure recorded, because "we tried and there was no way to reach them" is a
  fact a business needs.

## clock 1.0.0

### Added

- **Wall-clock and interval arithmetic across time zones**, extracted from
  project 02's slot engine at its second consumer — project 07's rota. Two
  sentences account for most scheduling bugs in this catalogue and both are in
  here: **a date is not an instant** — "Tuesday the fourteenth" is a different
  span of real time in Bucharest and Budapest — and **a duration is not a
  difference of wall clocks**, because a 22:00–06:00 shift is seven hours on the
  spring-forward night and nine on the autumn one.
- Extracted rather than copied because six of the seventeen specifications
  schedule against somebody's local wall clock, and a second copy of DST
  arithmetic is one that goes subtly wrong in a single place. What stays in each
  project is the engine built _on_ it — the slot engine, the scheduling rules
  engine, the costing engine — which share this substrate and no logic.
- `offsetMinutesAt` reads `Intl` rather than a table, so the tz database is the
  runtime's. `toInstant` reports `gap` and `ambiguous` rather than hiding them.
  `MinuteOfDay` may exceed 1440, which is what makes an overnight span one
  interval. Project 02's 102 tests came with it.

## comms 1.7.0

### Added

- **WhatsApp**, as a transport beside SMS and SMTP — four of the seventeen
  specifications want it and none of them wants a second implementation.
  `WhatsAppMessagePort` sends through Twilio, which the products that want this
  already hold credentials for and which already models the two things that
  make WhatsApp _not_ a third kind of text message: outside twenty-four hours
  of the customer's own last message only a **template Meta approved in
  advance** may be sent, and it is billed per conversation rather than per
  segment.
- `OutboundMessage.template` carries that approved template and its variables.
  `text` is still required and still logged: what a business needs to read back
  months later is the words that went out, not a pointer to a template that has
  since been edited.
- `FallbackMessagePort` tries one channel and then another, on the **two**
  refusals that mean "this channel will never work for this person" — a number
  that is not on WhatsApp, and a closed window with no template. Everything else
  is raised, because silently sending every message by SMS when a token expired
  is a bill nobody expected and a fault nobody saw.
- `AllowWhatsApp` widens the channel constraints on the message log **and the
  suppression list**. The type and the constraint move together: adding a member
  to a union lets the code compile and leaves the database refusing the row —
  the mistake that cost a release in `commerce` and is not repeated here.
- `whatsAppEnvSchema` — the sender and the approved templates, read from the
  environment. Shared because more than one service reads them and they have to
  agree: the worker builds the port, and whatever surface a business configures
  its messages on has to know whether the channel exists before offering it.
- `SendResult.channel` names what actually carried a message, and
  `MessagePort.fallbackChannel` declares where a port may divert to. The log
  records the first, so "sent on WhatsApp" is never the answer for something
  that went by SMS — a business reads that row when it asks why it was charged
  for texts.

### Changed

- A suppression is honoured on the channel a port **may divert to** as well as
  the one addressed. Somebody who replied STOP to a text message has their
  refusal recorded against `sms`; addressing the same number on WhatsApp must
  not be a way round it, because nothing can promise which channel will carry
  it.

## calendars 1.0.0

### Added

- Two-way calendar sync for projects 02 and 08. **The rules come first**,
  because a one-way feed cannot corrupt the diary it exports and a sync can: the
  diary owns appointments and the external calendar holds a copy, the external
  calendar owns everything else and we never touch it, and disconnecting leaves
  every appointment exactly where it was. "Last write wins" is what this refuses
  to be.
- `driftOf` recognises a copy somebody moved, renamed or deleted, and the next
  sync puts it back. `busyFrom` merges their events into the stretches of
  unavailable time a diary should hold — skipping our own copies, anything
  marked free, and cancelled events providers keep returning.
- Adapters for Google Calendar and Microsoft Graph through the vendors' own
  clients, behind `/google` and `/microsoft` so a product using one does not
  install the other's SDK. Refresh tokens are sealed with AES-256-GCM.
- Their events are never stored: read in a window, turned into busy periods,
  forgotten. And `pull` _returns_ those periods rather than writing into a
  product's own diary — a shared package with a foreign key into a product's
  tables is not a shared package.

## database 1.1.0

### Added

- `sealSecret` / `openSecret`: AES-256-GCM for a credential that has to live in
  a column — a third-party refresh token, a provider key. Authenticated, so a
  tampered value fails to open rather than decrypting to rubbish some code path
  then uses as a credential; versioned, so the algorithm can change without
  making old rows unreadable; and `sealingKey` refuses a key of the wrong length
  loudly, because a silently padded one works until the day it does not.
- `secretsMatch`, for comparing a presented secret against a stored one in
  constant time.

## vouchers 1.0.0

### Added

- Stored value for projects 02 and 06: gift vouchers, prepaid packages and
  balances, as an **append-only ledger** rather than a counter. The balance is
  the sum of the entries; the `balance` column is a cache written in the same
  transaction with `CHECK (balance >= 0)` behind it, so overspending is
  impossible even when the application is wrong and the history still explains
  the number.
- `money` and `units` are separate denominations on purpose — ten sessions and
  a thousand lei must never be added — and a package carries the `subject` it
  was sold for, so a course of physiotherapy cannot be spent on haircuts.
- Expiry is **null by default**, because rules for stored value differ by
  jurisdiction and several treat an unused voucher as the customer's money for
  years. `expiryFrom` clamps a month's arithmetic to the end of a shorter month
  rather than rolling into the next one.
- Codes in Crockford's base32, with its substitutions applied on the way in: a
  customer reading a code off a photograph is not told their voucher does not
  exist because they typed a letter O.
- The root entry point is framework-free and browser-safe; entities, migration
  and `VouchersService` live behind `/nestjs`.

## commerce 4.1.0

### Added

- `voucher` as a payment kind: money taken for stored value, a gift card sold
  or a package bought. A _redemption_ is deliberately not a payment — selling a
  voucher brings money in and spending it later brings none, and counting both
  would tell a business it earned the same two hundred twice. Redemptions are
  entries in `@birtalanrobert/vouchers`' ledger instead.

## commerce 1.0.0

### Added

- Taking money on a business's behalf, for projects 01, 02 and 11: payout
  onboarding with a hard gate, card payments through Stripe Connect as
  destination charges, holds that are captured only by a human decision,
  manually recorded cash, terminal, voucher and transfer takings, partial
  refunds with a required reason, and webhook verification.
- `depositFor` and `canTakeMoney` at the pure root entry point, because a
  console shows both while somebody drags a slider.
- **We never hold anybody's funds** — the customer pays the business directly
  and our cut is an application fee. Everything in the package follows from it.

## phone 1.0.0

### Added

- Telephone numbers as the durable identity of a customer: `normalisePhone`,
  `formatPhone`, `dialable`, `isSearchablePhone`, for Romania and Hungary.
  Extracted from project 12 when project 02 needed the same matching, which is
  the second consumer the policy asks for.
- **Three forms, and they are not interchangeable**: as typed, normalised (a
  search key) and dialable (E.164). Project 12 shipped a pumping check that
  refused a perfectly good normalised number for having no plus, which is what
  the distinction exists to prevent.
- No dependencies and nothing framework-shaped, so a browser bundle can decide
  whether a lookup is worth making before the keystroke lands.

## comms 1.3.0

### Added

- `SmtpMessagePort`: email over SMTP, built on nodemailer. Every project's
  Compose file runs Mailpit and nothing could reach it, so an invitation, a
  receipt or a password reset could not be followed end to end on a developer's
  machine without a vendor account. It is a production transport too — a
  customer's own mail server, a relay offered instead of an API, a deployment
  where mail may not leave the building.
- A recipient the server refuses after accepting the conversation is a failure
  rather than a success. `sendMail` resolves in that case, and recording it as
  sent writes "delivered" against a message the server explicitly refused.
- Certificates are verified by default. `allowSelfSignedCertificate` is for a
  local catcher or a private relay, and named so nobody enables it casually.
- Its tests run a real SMTP server in-process rather than mocking the client:
  neither the refused recipient nor the untrusted certificate can be asserted
  against a mock.

## messaging 1.0.1

### Fixed

- **The entity pointed at the wrong table.** `MessageCreditEntry` was mapped to
  `message_credits` while the migration creates `mortar_message_credits`, so
  every read through the service failed with `relation "public.message_credits"
does not exist`. The migration and the raw SQL in the README were right; only
  the decorator was wrong, which is why the package's own build and typecheck
  had nothing to say about it.

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

## csv 1.0.0

Extracted at the second consumer: project 12 reads a shop's shelf out of a
spreadsheet, project 13 writes an access log a regulator will open. Both had
hand-written code, and both had a bug the other did not.

### Added

- **`parseCsv`** — delimiter detected from the file. Every locale that uses a
  comma as the decimal separator gets semicolon-separated files out of Excel,
  still called CSV, and the obvious shortcut of honouring both at once splits a
  field reading `screen cracked; battery dead` in two and shifts every column
  after it, silently. Blank lines dropped; the mark Excel writes stripped, since
  left in place it hides in the first header.
- **`toCsv` and `toCsvFrom`** — quoting that is not optional, empty cells rather
  than the strings `null` and `undefined`, and a byte-order mark by default,
  because Excel guesses a file's encoding by looking at it and reads an unmarked
  UTF-8 file as the system code page — so `Ioană` opens as `IoanÄƒ` for exactly
  the people whose names have diacritics. `toCsvFrom` takes the column order
  rather than reading it off the first object's keys.

Pure: no database, no framework, no Node built-ins, so a console can preview an
upload before it happens. Deliberately not part of `files`, which carries S3,
virus scanning and PDF assembly.

## jobs 1.1.1

### Fixed

- **`JobsModule` now closes the Redis connection it opened.** It creates a
  dedicated connection and hands it to BullMQ, and BullMQ closes connections it
  created while leaving alone the ones it was given — correctly, since it does
  not own them. Nothing closed this one. An application that finished its work
  and called `app.close()` sat there with an open socket for ever: a seed script
  that never returned, and a deployment step that hung waiting for it. The
  connection is now provided under `MORTAR_QUEUE_CONNECTION` and closed in
  `onApplicationShutdown`, after the workers and queues that use it.

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
