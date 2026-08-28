import {
  DeleteBucketLifecycleCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
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

export interface LifecycleRule {
  /** Stable, because applying a configuration replaces the whole set by id. */
  id: string;
  /** Limits the rule to one prefix. Omitted means the whole bucket. */
  prefix?: string;
  /**
   * Days after which the provider deletes an object, whatever the application
   * believes.
   *
   * A backstop rather than the policy: the application's own sweep is what
   * honours a firm's retention, and this is what happens if that sweep has been
   * broken for a month and nobody noticed.
   */
  expireAfterDays?: number;
  /**
   * Days after which a multipart upload nobody finished is abandoned.
   *
   * These are invisible — they hold storage, are not listed as objects, and are
   * billed. Every bucket wants this rule and almost none have it.
   */
  abortIncompleteUploadsAfterDays?: number;
}

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

  /**
   * Retention the provider enforces, underneath the application's own.
   *
   * The second of two enforcements, and the point of it is the failure it
   * covers: an application sweep that has been broken for a month leaves a
   * firm's clients' documents sitting in a bucket, and nothing about the
   * application will say so — a lifecycle rule is enforced by the provider
   * whether or not any of our code is running or correct.
   *
   * It is deliberately **not** the policy itself. A per-tenant retention of
   * thirty days cannot be a bucket rule, because the bucket holds every firm
   * and rules are per prefix. Set this generously — several times the longest
   * retention any firm can choose — so it only ever catches what the sweep
   * missed.
   *
   * **Replaces the whole configuration.** That is S3's semantics, not a choice
   * made here: pass every rule the bucket should have, or the ones left out are
   * removed. An empty list removes the configuration altogether.
   *
   * One rule per prefix. Two rules over the same prefix — an expiry in one and
   * an abort in the other — is rejected as overlapping, so a prefix that wants
   * both puts both in the same rule.
   */
  async applyLifecycle(rules: readonly LifecycleRule[]): Promise<void> {
    /**
     * No rules is a deletion, not an empty configuration.
     *
     * S3 refuses a configuration with zero rules — `InvalidArgument`, which
     * reads as a bug in the caller rather than as the "remove the backstop"
     * they meant. There is a separate verb for it, and this is it.
     */
    if (rules.length === 0) {
      await this.client.send(new DeleteBucketLifecycleCommand({ Bucket: this.bucket }));
      return;
    }

    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: rules.map((rule) => ({
            ID: rule.id,
            Status: 'Enabled',
            // An empty prefix filter is how "everything in the bucket" is
            // said; omitting the filter entirely is rejected by newer APIs.
            Filter: { Prefix: rule.prefix ?? '' },
            ...(rule.expireAfterDays === undefined
              ? {}
              : { Expiration: { Days: rule.expireAfterDays } }),
            ...(rule.abortIncompleteUploadsAfterDays === undefined
              ? {}
              : {
                  AbortIncompleteMultipartUpload: {
                    DaysAfterInitiation: rule.abortIncompleteUploadsAfterDays,
                  },
                }),
          })),
        },
      }),
    );
  }

  /**
   * What the bucket is actually configured with.
   *
   * Read back rather than assumed: applying a lifecycle configuration is the
   * kind of deployment step that is done once, by someone who has left, and
   * "we have a backstop" is a claim worth being able to check. An empty list
   * means there is none.
   */
  async describeLifecycle(): Promise<LifecycleRule[]> {
    try {
      const result = await this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
      );

      return (result.Rules ?? []).map((rule) => ({
        id: rule.ID ?? '',
        prefix: rule.Filter?.Prefix ?? rule.Prefix ?? '',
        expireAfterDays: rule.Expiration?.Days,
        abortIncompleteUploadsAfterDays: rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation,
      }));
    } catch (error) {
      // A bucket with no configuration answers with an error rather than an
      // empty list, and "none" is a perfectly good answer to this question.
      if (isMissingLifecycle(error)) return [];
      throw error;
    }
  }
}

function isMissingLifecycle(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'NoSuchLifecycleConfiguration';
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
