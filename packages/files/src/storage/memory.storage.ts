import { NotFoundError } from '@birtalanrobert/http';
import type { PresignedUpload, PutOptions, StoragePort, StoredObject } from './port';

/**
 * Object storage in a `Map`, for tests.
 *
 * Exported rather than kept beside the tests because the services that consume
 * `StoragePort` live in other repositories, and every one of them needs a way
 * to test its own upload flow without a bucket. A fake each would be four
 * fakes, each subtly disagreeing with the interface in a different way.
 *
 * The presigned URLs are not real and are marked so. Nothing can upload to
 * them, which is correct: a test that wants to simulate the browser's PUT calls
 * `put` directly, and one that wants to simulate an upload that never arrived
 * simply does not.
 */
export class MemoryStorage implements StoragePort {
  private readonly objects = new Map<string, { body: Buffer; options: PutOptions }>();

  /** Every key currently held, for a test that wants to assert on cleanup. */
  get keys(): string[] {
    return [...this.objects.keys()];
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<StoredObject> {
    this.objects.set(key, { body: Buffer.from(body), options });
    return { key, size: body.length, contentType: options.contentType, etag: `etag-${key}` };
  }

  async get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw new NotFoundError('File', key);
    return object.body;
  }

  async head(key: string): Promise<StoredObject | undefined> {
    const object = this.objects.get(key);
    if (!object) return undefined;
    return {
      key,
      size: object.body.length,
      contentType: object.options.contentType,
      etag: `etag-${key}`,
    };
  }

  async delete(key: string): Promise<void> {
    // Deleting what is not there is success, matching S3 — a retried erasure
    // must not fail because the first attempt worked.
    this.objects.delete(key);
  }

  async presignUpload(
    key: string,
    options: PutOptions & { expiresInSeconds?: number } = {},
  ): Promise<PresignedUpload> {
    const expiresIn = options.expiresInSeconds ?? 300;
    return {
      url: `memory://upload/${encodeURIComponent(key)}`,
      headers: options.contentType ? { 'content-type': options.contentType } : {},
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async presignDownload(key: string): Promise<string> {
    return `memory://download/${encodeURIComponent(key)}`;
  }
}
