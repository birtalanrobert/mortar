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
  private readonly failing = new Set<string>();

  /** Every key currently held, for a test that wants to assert on cleanup. */
  get keys(): string[] {
    return [...this.objects.keys()];
  }

  /** Whether a key is held, without the `NotFoundError` `get` throws. */
  has(key: string): boolean {
    return this.objects.has(key);
  }

  /**
   * Empties the bucket between tests.
   *
   * A suite that shares one instance across a file — which is the normal shape,
   * because the instance is injected into an application built once — otherwise
   * carries every object from every earlier test, and an assertion about what
   * a cleanup removed silently starts passing for the wrong reason.
   */
  clear(): void {
    this.objects.clear();
    this.failing.clear();
  }

  /**
   * Makes one key refuse every operation.
   *
   * Real buckets fail one object at a time — a permissions change, a lifecycle
   * rule, a transient 503 — and the behaviour that matters is what the *caller*
   * does about it: a retention sweep must not abandon thirty-nine other firms
   * because one object would not delete. There is no way to provoke that
   * without a fake that can fail, and every consumer would otherwise write its
   * own.
   */
  failOn(key: string): void {
    this.failing.add(key);
  }

  /** Lets a key work again, for a test asserting that a retry succeeds. */
  stopFailing(key: string): void {
    this.failing.delete(key);
  }

  private assertUsable(key: string): void {
    if (this.failing.has(key)) throw new Error(`Storage refused “${key}”.`);
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<StoredObject> {
    this.assertUsable(key);
    this.objects.set(key, { body: Buffer.from(body), options });
    return { key, size: body.length, contentType: options.contentType, etag: `etag-${key}` };
  }

  async get(key: string): Promise<Buffer> {
    this.assertUsable(key);
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
    this.assertUsable(key);
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
