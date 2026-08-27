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
