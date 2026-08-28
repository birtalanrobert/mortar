import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from './s3.storage';

/**
 * `S3Storage`, against something that actually speaks S3.
 *
 * MinIO rather than a mocked SDK, because the parts most likely to be wrong are
 * exactly the parts a mock cannot tell you about: whether a presigned URL is
 * accepted, what a missing object answers, and whether a lifecycle
 * configuration is written in a shape the provider accepts. A test that asserts
 * which commands were constructed asserts the code says what it says.
 */
const ENDPOINT = process.env.MORTAR_TEST_S3 ?? 'http://127.0.0.1:3052';
const CREDENTIALS = { accessKeyId: 'mortar', secretAccessKey: 'mortar-local-secret' };
const BUCKET = 'mortar-test';

let storage: S3Storage;

beforeAll(async () => {
  const client = new S3Client({
    region: 'eu-central-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
  });

  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (error) {
    // Already there, from an earlier run against a container someone left up.
    if ((error as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw error;
  }

  storage = new S3Storage({
    bucket: BUCKET,
    region: 'eu-central-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
  });
});

afterAll(async () => {
  await storage.applyLifecycle([]).catch(() => undefined);
});

describe('S3Storage', () => {
  it('stores and reads back exactly what it was given', async () => {
    const key = 'tenant/one/statement.pdf';
    const body = Buffer.from('%PDF-1.7 a statement with ție in it');

    await storage.put(key, body, { contentType: 'application/pdf' });

    expect(await storage.get(key)).toEqual(body);
    expect(await storage.head(key)).toMatchObject({ key, size: body.length });
  });

  it('says nothing is there rather than throwing, for head', async () => {
    expect(await storage.head('tenant/one/never-written.pdf')).toBeUndefined();
  });

  it('treats deleting what is not there as success', async () => {
    // A retried erasure must not fail because the first attempt worked.
    await expect(storage.delete('tenant/one/never-written.pdf')).resolves.toBeUndefined();
  });

  it('presigns an upload a browser can actually use', async () => {
    const key = 'tenant/one/uploaded-by-browser.pdf';
    const upload = await storage.presignUpload(key, { contentType: 'application/pdf' });

    const response = await fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: new Uint8Array(Buffer.from('%PDF-1.7 uploaded directly')),
    });

    // The whole architecture rests on this working: the bytes never touch the
    // API, so a signature the provider rejects is not a detail.
    expect(response.status).toBe(200);
    expect((await storage.get(key)).toString()).toContain('uploaded directly');
  });

  it('presigns a download that carries the filename a person chose', async () => {
    const key = 'tenant/one/situatie.pdf';
    await storage.put(key, Buffer.from('%PDF-1.7'), { contentType: 'application/pdf' });

    const url = await storage.presignDownload(key, { filename: 'Situație financiară.pdf' });
    const response = await fetch(url);

    // Both forms, as RFC 6266 asks — the plain one for old software and the
    // UTF-8 one so the diacritics survive.
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain("filename*=UTF-8''Situa%C8%9Bie");
  });

  it('configures the provider’s own expiry, and reads it back', async () => {
    await storage.applyLifecycle([
      { id: 'backstop', expireAfterDays: 400, abortIncompleteUploadsAfterDays: 7 },
    ]);

    const rules = await storage.describeLifecycle();

    /*
     * The expiry only.
     *
     * MinIO accepts `AbortIncompleteMultipartUpload` and does not report it
     * back; AWS does both. Asserting the abort here would be asserting a
     * property of the development container rather than of this code — and
     * would fail against the provider that actually implements it, which is
     * the wrong way round for a test to fail.
     */
    expect(rules).toEqual([expect.objectContaining({ id: 'backstop', expireAfterDays: 400 })]);
  });

  it('replaces the whole configuration, as S3 does', async () => {
    await storage.applyLifecycle([{ id: 'first', expireAfterDays: 100 }]);
    await storage.applyLifecycle([{ id: 'second', expireAfterDays: 200 }]);

    // Not a choice made here — pass every rule the bucket should have, or the
    // ones left out are removed. Worth a test because the opposite is the
    // natural assumption.
    expect((await storage.describeLifecycle()).map((rule) => rule.id)).toEqual(['second']);
  });

  it('answers “none” for a bucket with no configuration at all', async () => {
    await storage.applyLifecycle([{ id: 'temporary', expireAfterDays: 30 }]);

    await storage.applyLifecycle([]);

    /*
     * Two things at once, both worth having.
     *
     * An empty list has to *remove* the configuration — S3 refuses a
     * configuration with zero rules, and passing one through would surface as
     * `InvalidArgument` where the caller meant "take the backstop off". And
     * reading a bucket that has none must answer "none": the provider raises
     * an error rather than returning an empty list, which is a fact about the
     * protocol and not about this bucket.
     */
    expect(await storage.describeLifecycle()).toEqual([]);
  });
});
