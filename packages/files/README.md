# @birtalanrobert/files

Pre-signed direct upload, per-tenant key scoping, virus scanning, envelope
encryption and retention.

## Using it in a NestJS application

```ts
import { FilesModule } from '@birtalanrobert/files/nestjs';
import { S3Storage, ClamAvScanner, EnvelopeCrypto, LocalMasterKey } from '@birtalanrobert/files';

@Module({
  imports: [
    // …config, logger, database…
    FilesModule.forRootAsync({
      inject: [ConfigModule.token()],
      useFactory: (config: AppConfig) => ({
        storage: new S3Storage({
          bucket: config.S3_BUCKET,
          region: config.S3_REGION,
          endpoint: config.S3_ENDPOINT, // MinIO locally
          forcePathStyle: !!config.S3_ENDPOINT,
          credentials: { accessKeyId: config.S3_KEY, secretAccessKey: config.S3_SECRET },
        }),
        scanner: new ClamAvScanner({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT }),
        crypto: new EnvelopeCrypto(new LocalMasterKey(config.MASTER_KEY)),
        maxBytes: config.UPLOAD_MAX_BYTES,
      }),
    }),
  ],
})
export class AppModule {}
```

`@Global()`, and it provides `FilesService`. Register `fileEntities` and
`fileMigrations` with the database module.

**The ports are constructed by the application, not by the module.** Which
bucket, which endpoint, which scanner and whether files are encrypted are
deployment decisions; a module that reached for them itself would be reading
configuration nothing had validated.

Omit `scanner` at your peril — the default is `RefusingScanner`, which refuses
every upload. That is deliberate: see below.

## The shape, and why

A file goes from a client's phone to a professional's folder in three steps: the
API signs a URL, **the browser uploads to storage without touching the API**,
and the API is told afterwards.

The middle step is the reason for everything else. Proxying the bytes through
the API costs a request-sized chunk of memory per concurrent upload and puts the
API's timeout between a client on a train and finishing what they were asked to
do. The price is that the gap between step one and step three is real — rows sit
in `pending`, some of them for ever — which is what `sweepAbandoned` is for.

```ts
const { file, upload } = await files.beginUpload({
  tenantId,
  scope: `request/${requestId}`,
  filename: 'Extras de cont.pdf',
  contentType: 'application/pdf',
});

// …the browser PUTs to upload.url with upload.headers…

await files.confirmUpload(tenantId, file.id, { accepted: ['application/pdf'] });
```

**Send exactly the headers `presignUpload` returns, and no others.** A presigned
PUT is refused if it carries a header the signature did not cover, so that map
is the request rather than advice. Metadata is deliberately absent from it: the
SDK encodes it into the URL, and sending it as `x-amz-meta-*` headers as well is
what makes S3 answer "there were headers present in the request which were not
signed" — on the one request the API is not part of, so the only symptom is a
file that never appears.

## What `confirmUpload` does not trust

Everything after a direct upload is verification, because the client has just
told us something happened somewhere we were not watching.

- **The type is read from the bytes.** A `Content-Type` header and a filename
  extension are both claims made by whoever uploaded the file. Storing either as
  fact is how a document collection product eventually serves a professional an
  executable that a database row insists is a PDF.
- **The size is re-checked.** A presigned `PUT` does not enforce one, so a
  client can send whatever it likes to a URL signed for a small file.
- **Nothing reads the file before the scanner does.** No thumbnail, no assembly,
  no delivery. A professional downloads what their client sent.

## Keys

One bucket, with the tenant's id as the first path segment:

```
tenants/<tenantId>/<scope>/<fileId>.<ext>
```

The tenant comes first so that a bucket policy can name it — a role scoped to
`tenants/<id>/*` cannot reach another tenant's object however it is asked to. A
bucket per tenant gives the same isolation and then meets the account's bucket
limit somewhere in the low hundreds of customers.

Every segment is an id we generated. A filename is data, and data in a path is
how `../` and a null byte become somebody else's object; `safeFilename` exists
for `Content-Disposition` and is never used in a key.

`assertTenantOwns` is called before an object is read, deleted or signed for.
Row-level security governs the database; nothing governs the bucket except the
key handed to it, so the equivalent check is made explicitly and at the point of
use.

## Encryption

Optional, and the reason it exists is **erasure rather than confidentiality** —
the storage provider already encrypts at rest.

Each tenant has one data key. Files are encrypted with it; the key is stored
only wrapped by a master key. Erasing a tenant is then destroying one wrapped
key rather than finding and overwriting every object they ever uploaded, which
is the difference between an erasure request that can be honoured in seconds and
one that cannot honestly be honoured at all, because backups exist.

- AES-256-GCM, fresh IV per file. Reusing an IV under one key in GCM leaks the
  key stream and, with two messages, the authentication key itself.
- The object key is bound in as additional authenticated data, so a ciphertext
  copied under another tenant's prefix fails to open rather than opening into
  the wrong hands.
- `MasterKeyPort` is a port: `LocalMasterKey` for development, a KMS in a
  regulated deployment. Nothing above that line changes.

An encrypted file cannot be served by a presigned URL — the browser has no key —
so `downloadUrl` refuses and the application serves it through `read`. That is
slower, and it is the price of being able to destroy it.

## Archives

`createZip(entries, options)` writes a ZIP in memory. Folders come from the
entry paths — there are no directory records, because every extractor creates
the parents and writing them too would be two sources of truth about one tree.

```ts
const archive = createZip(
  [
    { path: 'Popescu_Ion/01_Bank_statement.pdf', content: statement },
    { path: 'Popescu_Ion/02_Signed_contract.pdf', content: contract },
  ],
  { modified: request.completedAt },
);
```

Written by hand rather than taken from a dependency: the essential format is two
hundred lines and has not changed since 1993, while every library that writes it
brings a stream stack and a supply chain. `node:zlib` supplies the only hard
part.

What it takes responsibility for:

- **Determinism.** Pass `modified` and the same input produces the same bytes,
  so a delivery retry hands the destination the file it already has rather than
  a second copy. Without it every entry is stamped with the start of 1980, which
  is the earliest MS-DOS dates reach.
- **Zip slip.** Leading slashes and `..` segments are stripped, so no
  extractor's carefulness is being relied upon.
- **UTF-8 names.** Flag bit 11 is set, without which `Ștefănescu` arrives as
  mojibake on a machine in another code page.
- **Compression that helps.** Entries are deflated, and stored instead whenever
  deflate produces something larger — which it does for every photograph and
  most PDFs.

Everything is held in memory, which suits a completed request and does not suit
a whole firm's history: past 4 GB it refuses rather than silently writing an
archive no tool can read, because the answer to that is ZIP64 and this is not
it.

## Lifecycle rules

`applyLifecycle` and `describeLifecycle` configure the provider's own expiry.

```ts
await storage.applyLifecycle([
  { id: 'backstop', expireAfterDays: 400, abortIncompleteUploadsAfterDays: 7 },
]);
```

This is a **backstop, not the policy**. Per-tenant retention is enforced by the
application, because a bucket holds every tenant and its rules are per prefix.
The rule matters for the failure the application cannot cover: a sweep that has
been broken for a month leaves documents in the bucket and nothing in the
application will say so. Set it to several times the longest retention any
tenant can choose.

`abortIncompleteUploadsAfterDays` is worth setting in every bucket. An
unfinished multipart upload holds storage, is not listed as an object, and is
billed — and a client closing a page mid-upload creates them.

Applying **replaces the whole configuration**, which is S3's semantics rather
than a choice made here: pass every rule the bucket should have. An empty list
removes it altogether — S3 refuses a configuration with zero rules, so that case
becomes a delete rather than an `InvalidArgument` where the caller meant "take
the backstop off".

One rule per prefix: two rules over the same prefix are rejected as
overlapping, so a prefix that wants both an expiry and an abort puts both in one
rule. MinIO accepts the abort setting and does not report it back; AWS does
both.

## Scanning

`ScannerPort`, with `ClamAvScanner` speaking `clamd`'s INSTREAM protocol
directly. The protocol is about eighty lines; a dependency for that is a
supply-chain surface for no benefit.

The default when nothing is configured is `RefusingScanner`, which refuses
everything. A misconfiguration that silently disables virus scanning is
indistinguishable from working software right up until it matters; one that
refuses uploads is noticed within minutes of a deployment.

## Testing

`MemoryStorage` implements the whole port in a `Map`. It is exported rather than
kept beside the tests because every service that consumes `StoragePort` lives in
another repository and needs a way to test its upload flow without a bucket —
otherwise each writes a fake that disagrees with the interface in its own way.

Its presigned URLs are not real and nothing can upload to them, which is
correct: a test that simulates the browser's PUT calls `put`, and one that
simulates an upload that never arrived simply does not.

Four methods exist only for tests, and each earns its place:

|                                   |                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keys`, `has(key)`                | Assert on what a cleanup removed, without `get`'s `NotFoundError`                                                                                       |
| `clear()`                         | Empty it between tests — one instance is normally shared across a file, and objects otherwise accumulate until an assertion passes for the wrong reason |
| `failOn(key)`, `stopFailing(key)` | Make one object refuse every operation. Real buckets fail one object at a time, and the behaviour worth testing is what the caller does about it        |

## Cache headers

`put` and `presignUpload` take a `cacheControl`, and it goes on the object
rather than on a response, because what serves these files is a CDN this
application never speaks to. A rendered derivative is immutable — its key names
its content — so `public, max-age=31536000, immutable` is the honest header for
one. Do not set it on an original somebody uploaded: that key can be reused.

## The image pipeline

`@birtalanrobert/files/images` — a subpath, because it needs `sharp` and most
consumers of this package do not. `sharp` is an **optional peer dependency**:
install it in the service that renders images, and nothing else pays for a
hundred megabytes of native binaries.

```ts
import { renderImage } from '@birtalanrobert/files/images';

const rendered = await renderImage(uploaded, {
  sizes: [
    { name: 'thumb', width: 160 },
    { name: 'card', width: 640 },
    { name: 'full', width: 1600 },
  ],
  formats: ['avif', 'webp', 'jpeg'],
  placeholder: 'blur',
});
```

Sizes are named rather than numbered, and the names are the product's. A stored
key of `card` survives the day somebody decides cards are 720 wide; a key of
`640` does not.

Four things happen, and each is a defect somewhere that skipped it:

- **Orientation is applied**, and the returned `width` and `height` are the
  _displayed_ ones. A phone stores a portrait photograph as a landscape one plus
  an EXIF flag; reserving the stored shape produces exactly the layout shift the
  placeholder was added to prevent.
- **Metadata is dropped**, and the customer's coordinates with it. This is
  sharp's default rather than a call made here — and there is a test asserting
  it, because the day somebody adds `withMetadata()` to keep a colour profile,
  the coordinates come back too.
- **Nothing is enlarged.** A 400-pixel photograph asked for a 1600-pixel
  derivative stays 400 wide.
- **A dominant colour is measured** — `#rrggbb`, always — so the box is filled
  before the picture lands. `placeholder: 'blur'` adds a `data:` URI of a few
  hundred bytes as well.

Input is identified by its bytes, not its name or its `Content-Type`, and
anything that is not a raster photograph raises `UnsupportedImageError`. The
refusal that matters is not a text file called `photo.jpg`: it is an SVG, which
libvips will rasterise happily and which is a document format with a script
engine and a URL loader in it.

`maxPixels` guards decompression: a hundred-kilobyte PNG of one flat colour
decodes to gigabytes, and a worker that meets one is killed by the kernel rather
than raising anything anybody sees.

Encoding runs one derivative at a time. sharp already threads each operation,
so encoding six AVIFs at once finishes no sooner and holds six decoded images in
memory while it does.
