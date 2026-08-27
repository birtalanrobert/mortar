import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NotFoundError } from '@birtalanrobert/http';
import { safeFilename } from './keys';
import type { PresignedUpload, PutOptions, StoragePort, StoredObject } from './port';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Set for MinIO or any other S3-compatible endpoint. */
  endpoint?: string;
  /**
   * Required by MinIO and by anything else that is not AWS.
   *
   * Virtual-hosted style needs wildcard DNS for the bucket, which a local
   * container does not have.
   */
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** How long a presigned URL lives. Short on purpose; see the port. */
  defaultExpirySeconds?: number;
}

const DEFAULT_EXPIRY = 300;

/**
 * S3, and anything that speaks its protocol.
 *
 * Written against the protocol rather than against AWS specifically, because
 * the development stack runs MinIO and at least one customer will insist on
 * their own account. The only place that difference appears is the constructor.
 */
export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly expiry: number;

  constructor(options: S3StorageOptions) {
    const config: S3ClientConfig = { region: options.region };
    if (options.endpoint) config.endpoint = options.endpoint;
    if (options.forcePathStyle !== undefined) config.forcePathStyle = options.forcePathStyle;
    if (options.credentials) config.credentials = options.credentials;

    this.client = new S3Client(config);
    this.bucket = options.bucket;
    this.expiry = options.defaultExpirySeconds ?? DEFAULT_EXPIRY;
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<StoredObject> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentDisposition: disposition(options.filename),
        Metadata: options.metadata,
      }),
    );

    return {
      key,
      size: body.length,
      contentType: options.contentType,
      etag: result.ETag?.replaceAll('"', ''),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) throw new NotFoundError('File', key);

      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (isMissing(error)) throw new NotFoundError('File', key);
      throw error;
    }
  }

  /**
   * Whether the object is there, and how large.
   *
   * Returns `undefined` rather than throwing, because its caller is asking a
   * question — "did that upload actually arrive?" — for which absence is a
   * legitimate answer rather than an exception.
   */
  async head(key: string): Promise<StoredObject | undefined> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );

      return {
        key,
        size: result.ContentLength ?? 0,
        contentType: result.ContentType,
        etag: result.ETag?.replaceAll('"', ''),
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 treats deleting a missing object as success, which is what we want:
    // a retried erasure must not fail because the first attempt worked.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignUpload(
    key: string,
    options: PutOptions & { expiresInSeconds?: number } = {},
  ): Promise<PresignedUpload> {
    const expiresIn = options.expiresInSeconds ?? this.expiry;

    /**
     * The content type is part of what is signed.
     *
     * Without it a client who was allowed to upload a PDF can upload anything
     * at all to the same key — the signature does not care — and the type
     * recorded in the database becomes a claim rather than a fact.
     */
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options.contentType,
      ContentDisposition: disposition(options.filename),
      Metadata: options.metadata,
    });

    const url = await getSignedUrl(this.client, command, { expiresIn });

    const headers: Record<string, string> = {};
    if (options.contentType) headers['content-type'] = options.contentType;
    const contentDisposition = disposition(options.filename);
    if (contentDisposition) headers['content-disposition'] = contentDisposition;
    for (const [name, value] of Object.entries(options.metadata ?? {})) {
      headers[`x-amz-meta-${name}`] = value;
    }

    return { url, headers, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async presignDownload(
    key: string,
    options: { expiresInSeconds?: number; filename?: string } = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      // Overridden at read time rather than baked in at write time, so the same
      // stored object can be offered under a name the professional chose.
      ResponseContentDisposition: disposition(options.filename),
    });

    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds ?? this.expiry,
    });
  }
}

/**
 * A `Content-Disposition` for a filename that came from a person.
 *
 * Both forms, as RFC 6266 asks: the plain one for old software, and the
 * `filename*` form for anything that understands UTF-8 — which is what makes
 * `Situație financiară.pdf` arrive with its diacritics rather than as
 * mojibake.
 */
function disposition(filename?: string): string | undefined {
  if (!filename) return undefined;

  const safe = safeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}
