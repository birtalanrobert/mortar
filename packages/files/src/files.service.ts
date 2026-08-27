import { createHash, randomUUID } from 'node:crypto';
import { BadRequestError, NotFoundError, ValidationError } from '@birtalanrobert/http';
import { resolveManager } from '@birtalanrobert/database';
import type { DataSource, EntityManager } from 'typeorm';
import { detectType } from './detect';
import { EnvelopeCrypto, type Envelope } from './crypto/envelope';
import type { ScannerPort } from './scanning/port';
import { assertTenantOwns, objectKey, safeFilename } from './storage/keys';
import type { PresignedUpload, StoragePort } from './storage/port';
import { StoredFile } from './stored-file.entity';

export interface BeginUploadInput {
  tenantId: string;
  /** What the file belongs to, as `type/id`. */
  scope: string;
  filename: string;
  /** The client's claim, used only to sign the URL. Never stored as fact. */
  contentType?: string;
  uploadedBy?: string;
  retainUntil?: Date;
  metadata?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface FilesServiceOptions {
  storage: StoragePort;
  scanner: ScannerPort;
  /** Absent means files are stored as they arrive. See `encrypted` on the row. */
  crypto?: EnvelopeCrypto;
  /** Refused above this, before a URL is signed. */
  maxBytes?: number;
}

/** How the tenant's data key is fetched. Supplied by the owning service. */
export type DataKeyResolver = (tenantId: string) => Promise<Envelope | undefined>;

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The path a file takes from a client's device to somewhere a professional can
 * open it.
 *
 * Three steps, and the shape is forced by the middle one: the API signs a URL,
 * the browser uploads to storage without touching the API, and the API is told
 * afterwards. Proxying the bytes instead would cost a request-sized chunk of
 * memory per concurrent upload and put the API's timeout between a client on a
 * train and finishing what they were asked to do.
 *
 * The price is that the gap between step one and step three is real: rows sit
 * in `pending`, some of them for ever. That is what the abandoned sweep is for.
 */
export class FilesService {
  private readonly storage: StoragePort;
  private readonly scanner: ScannerPort;
  private readonly crypto?: EnvelopeCrypto;
  private readonly maxBytes: number;

  constructor(
    private readonly dataSource: DataSource,
    options: FilesServiceOptions,
  ) {
    this.storage = options.storage;
    this.scanner = options.scanner;
    this.crypto = options.crypto;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get limitBytes(): number {
    return this.maxBytes;
  }

  /**
   * An explicit manager wins; otherwise the ambient transaction, if any.
   *
   * The explicit form matters here because a caller often needs the file row
   * written in the same transaction as whatever it belongs to — a request item
   * and its upload must appear together or not at all.
   */
  private manager(manager?: EntityManager): EntityManager {
    return manager ?? resolveManager(this.dataSource);
  }

  /**
   * Records the intent and returns a URL the browser can upload to.
   *
   * The row is written first and deliberately: a signed URL that nothing knows
   * about produces an object in the bucket that no query will ever find, and
   * the retention sweep works from rows.
   */
  async beginUpload(
    input: BeginUploadInput,
    manager?: EntityManager,
  ): Promise<{ file: StoredFile; upload: PresignedUpload }> {
    const repository = this.manager(manager).getRepository(StoredFile);

    const fileId = randomUUID();
    /**
     * The extension comes from the *claimed* type, and only to make the key
     * readable to an operator looking at a bucket. It is corrected on confirm,
     * once the bytes have been read and the type is a fact rather than a claim.
     */
    const key = objectKey({
      tenantId: input.tenantId,
      scope: input.scope,
      fileId,
      extension: extensionFor(input.contentType),
    });

    const file = await repository.save(
      repository.create({
        id: fileId,
        tenantId: input.tenantId,
        scope: input.scope,
        objectKey: key,
        filename: safeFilename(input.filename),
        state: 'pending',
        retainUntil: input.retainUntil ?? null,
        uploadedBy: input.uploadedBy ?? null,
        metadata: input.metadata ?? {},
      }),
    );

    const upload = await this.storage.presignUpload(key, {
      contentType: input.contentType,
      expiresInSeconds: input.expiresInSeconds,
      // Readable in the bucket without a database, which is what an operator
      // has during an incident.
      metadata: { tenant: input.tenantId, scope: input.scope },
    });

    return { file, upload };
  }

  /**
   * Called once the browser says the upload finished.
   *
   * Everything here is verification. The client has just told us something
   * happened somewhere we were not watching, and the only trustworthy account
   * of what arrived is the object itself.
   */
  async confirmUpload(
    tenantId: string,
    fileId: string,
    options: { accepted?: readonly string[]; dataKey?: () => Promise<Buffer> } = {},
    manager?: EntityManager,
  ): Promise<StoredFile> {
    const repository = this.manager(manager).getRepository(StoredFile);

    const file = await repository.findOne({ where: { id: fileId, tenantId } });
    if (!file) throw new NotFoundError('File', fileId);
    // Already confirmed: a retried confirmation is normal and must not scan and
    // re-encrypt a file that is already finished.
    if (file.state !== 'pending') return file;

    assertTenantOwns(tenantId, file.objectKey);

    const head = await this.storage.head(file.objectKey);
    if (!head) {
      throw new BadRequestError('That upload did not arrive. Please try sending it again.');
    }
    if (head.size === 0) {
      return this.refuse(repository, file, 'The file was empty.');
    }
    if (head.size > this.maxBytes) {
      // Checked here as well as before signing, because a presigned PUT does
      // not enforce a size and a client can send whatever it likes to it.
      await this.storage.delete(file.objectKey);
      return this.refuse(
        repository,
        file,
        `That file is larger than ${Math.floor(this.maxBytes / 1024 / 1024)} MB.`,
      );
    }

    await repository.update({ id: file.id }, { state: 'scanning' });

    const content = await this.storage.get(file.objectKey);

    /**
     * The type is read from the bytes, never taken from the upload's header.
     *
     * A `Content-Type` is a claim by whoever uploaded the file. Storing it as
     * fact is how a document collection product eventually serves a
     * professional an executable that a database row insists is a PDF.
     */
    const detected = detectType(content);
    if (options.accepted && (!detected || !options.accepted.includes(detected.contentType))) {
      await this.storage.delete(file.objectKey);
      return this.refuse(repository, file, 'That kind of file is not accepted here.');
    }

    /**
     * Scanned before anything else reads it, and before it is encrypted.
     *
     * A professional downloads what their client sent. A document collection
     * product that hands a bookkeeper malware has done the one thing it must
     * never do, so nothing — no thumbnail, no assembly, no delivery — happens
     * before this returns clean.
     */
    const verdict = await this.scanner.scan(content);
    if (!verdict.clean) {
      // The bytes go; the row stays. "What happened to the file I was told
      // about" deserves an answer.
      await this.storage.delete(file.objectKey);
      await repository.update(
        { id: file.id },
        {
          state: 'infected',
          reason: verdict.threat,
          scannedAt: new Date(),
          size: head.size,
          contentType: detected?.contentType ?? null,
        },
      );
      return repository.findOneOrFail({ where: { id: file.id } });
    }

    const checksum = createHash('sha256').update(content).digest('hex');

    let encrypted = false;
    let keyId: string | null = null;

    if (this.crypto && options.dataKey) {
      const dataKey = await options.dataKey();
      const sealed = this.crypto.encrypt(dataKey, content, file.objectKey);
      await this.storage.put(file.objectKey, sealed, {
        // Deliberately not the detected type: what is stored is ciphertext, and
        // labelling it `application/pdf` invites something to try to render it.
        contentType: 'application/octet-stream',
        metadata: { tenant: tenantId, encrypted: 'true' },
      });
      encrypted = true;
      keyId = 'wrapped';
    }

    await repository.update(
      { id: file.id },
      {
        state: 'ready',
        size: content.length,
        contentType: detected?.contentType ?? null,
        checksum,
        encrypted,
        keyId,
        scannedAt: new Date(),
        reason: null,
      },
    );

    return repository.findOneOrFail({ where: { id: file.id } });
  }

  /** The file's contents, decrypted if they were encrypted. */
  async read(
    tenantId: string,
    fileId: string,
    options: { dataKey?: () => Promise<Buffer> } = {},
    manager?: EntityManager,
  ): Promise<Buffer> {
    const file = await this.require(tenantId, fileId, manager);
    if (file.state !== 'ready') {
      throw new BadRequestError('That file is not available.');
    }

    const stored = await this.storage.get(file.objectKey);
    if (!file.encrypted) return stored;

    if (!this.crypto || !options.dataKey) {
      throw new ValidationError([
        {
          field: 'dataKey',
          message: 'That file is encrypted and no key was supplied.',
          code: 'missing_data_key',
        },
      ]);
    }

    return this.crypto.decrypt(await options.dataKey(), stored, file.objectKey);
  }

  /**
   * A short-lived URL the browser can download from.
   *
   * Refused for an encrypted file, and that is the honest answer rather than a
   * limitation to work around: the browser has no key, so a presigned URL would
   * hand it ciphertext. Encrypted files are read through `read` and served by
   * the application, which is slower and is the price of being able to destroy
   * them.
   */
  async downloadUrl(
    tenantId: string,
    fileId: string,
    options: { expiresInSeconds?: number } = {},
    manager?: EntityManager,
  ): Promise<string> {
    const file = await this.require(tenantId, fileId, manager);
    if (file.state !== 'ready') throw new BadRequestError('That file is not available.');
    if (file.encrypted) {
      throw new BadRequestError('That file is encrypted and must be downloaded through the API.');
    }

    return this.storage.presignDownload(file.objectKey, {
      expiresInSeconds: options.expiresInSeconds,
      filename: file.filename,
    });
  }

  /**
   * Deletes the bytes and marks the row.
   *
   * The row survives deletion on purpose: an audit that says a document existed
   * and was destroyed on a date is worth more than one with a gap where it used
   * to be.
   */
  async erase(tenantId: string, fileId: string, manager?: EntityManager): Promise<void> {
    const repository = this.manager(manager).getRepository(StoredFile);
    const file = await this.require(tenantId, fileId, manager);
    if (file.deletedAt) return;

    await this.storage.delete(file.objectKey);
    await repository.update({ id: file.id }, { deletedAt: new Date() });
  }

  /**
   * Deletes files whose retention has run out.
   *
   * Returns what it did rather than logging it, so the caller can record the
   * count in its own audit trail — a sweep that deletes client documents and
   * leaves no trace of having run is not one anybody should have to trust.
   */
  async sweepExpired(now = new Date(), limit = 500, manager?: EntityManager): Promise<number> {
    const repository = this.manager(manager).getRepository(StoredFile);

    const due = await repository
      .createQueryBuilder('file')
      .where('file.retainUntil IS NOT NULL')
      .andWhere('file.retainUntil <= :now', { now })
      .andWhere('file.deletedAt IS NULL')
      .limit(limit)
      .getMany();

    for (const file of due) {
      await this.storage.delete(file.objectKey);
      await repository.update({ id: file.id }, { deletedAt: new Date() });
    }

    return due.length;
  }

  /**
   * Clears away uploads that were started and never finished.
   *
   * A client on a train who closes the page leaves a `pending` row and, often,
   * an object nobody will ever ask for. Both are removed; neither is an error.
   */
  async sweepAbandoned(olderThan: Date, limit = 500, manager?: EntityManager): Promise<number> {
    const repository = this.manager(manager).getRepository(StoredFile);

    const stale = await repository
      .createQueryBuilder('file')
      .where('file.state = :state', { state: 'pending' })
      .andWhere('file.createdAt <= :olderThan', { olderThan })
      .limit(limit)
      .getMany();

    for (const file of stale) {
      await this.storage.delete(file.objectKey);
      await repository.delete({ id: file.id });
    }

    return stale.length;
  }

  private async require(
    tenantId: string,
    fileId: string,
    manager?: EntityManager,
  ): Promise<StoredFile> {
    const file = await this.manager(manager)
      .getRepository(StoredFile)
      .findOne({ where: { id: fileId, tenantId } });

    if (!file) throw new NotFoundError('File', fileId);
    // Belt to the database's braces: the key is a location, and a location is
    // only as trustworthy as everything that has ever written to that row.
    assertTenantOwns(tenantId, file.objectKey);
    return file;
  }

  private async refuse(
    repository: { update: (criteria: object, values: object) => Promise<unknown> },
    file: StoredFile,
    reason: string,
  ): Promise<StoredFile> {
    await repository.update({ id: file.id }, { state: 'rejected', reason });
    return { ...file, state: 'rejected', reason } as StoredFile;
  }
}

/** Only for making a key legible in a bucket listing. Never trusted. */
function extensionFor(contentType?: string): string | undefined {
  const known: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/heic': 'heic',
    'image/webp': 'webp',
    'image/tiff': 'tif',
  };
  return contentType ? known[contentType] : undefined;
}
