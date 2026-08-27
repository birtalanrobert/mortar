export interface PutOptions {
  contentType?: string;
  /** What a browser should call it on download. Never used as a key. */
  filename?: string;
  /** Copied onto the object, for operators reading a bucket without a database. */
  metadata?: Record<string, string>;
}

export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
  /** The provider's own checksum, for detecting a truncated upload. */
  etag?: string;
}

export interface PresignedUpload {
  url: string;
  /** Headers the browser must send for the signature to match. */
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * Object storage, as the only shape the rest of the system knows.
 *
 * A port rather than an S3 client, for two reasons that both turned up in the
 * specifications rather than in theory: some customers require their documents
 * to stay in a storage account they control, and some verticals want files
 * delivered into a folder the professional already uses. Both are adapters
 * behind this interface; neither is a rewrite of anything above it.
 *
 * Deliberately small. Everything here is something more than one adapter can
 * genuinely do — object lifecycle rules, tagging and server-side transforms are
 * not, and putting them here would make the interface a description of S3 with
 * extra steps.
 */
export interface StoragePort {
  put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<StoredObject | undefined>;
  delete(key: string): Promise<void>;

  /**
   * A URL the browser uploads to directly.
   *
   * The reason the whole port exists in this shape: a phone photographing a
   * four-page bank statement should send those bytes to storage, not through
   * the API. Proxying them costs a request-sized chunk of memory per concurrent
   * upload and puts the API's timeout between a client and finishing.
   */
  presignUpload(
    key: string,
    options: PutOptions & { expiresInSeconds?: number },
  ): Promise<PresignedUpload>;

  /**
   * A URL the browser downloads from directly, expiring shortly.
   *
   * Short-lived because it is a bearer credential for one object: anyone
   * holding it can read that file until it expires, and these files are bank
   * statements and identity documents.
   */
  presignDownload(
    key: string,
    options?: { expiresInSeconds?: number; filename?: string },
  ): Promise<string>;
}
