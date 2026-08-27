import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDataSource } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { EnvelopeCrypto, LocalMasterKey, generateMasterKey } from './crypto/envelope';
import { FilesService } from './files.service';
import { CreateStoredFile1787813455183 } from './migrations/1787813455183-CreateStoredFile';
import { PermissiveTestScanner, RefusingScanner, type ScannerPort } from './scanning/port';
import { MemoryStorage } from './storage/memory.storage';
import { StoredFile } from './stored-file.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PDF = Buffer.from('%PDF-1.7 a small but genuine-looking document');

let dataSource: DataSource;
let storage: MemoryStorage;

beforeEach(async () => {
  dataSource ??= await createTestDataSource([StoredFile], {
    migrations: [CreateStoredFile1787813455183],
  });
  await dataSource.getRepository(StoredFile).clear();
  storage = new MemoryStorage();
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

function service(
  options: { scanner?: ScannerPort; crypto?: EnvelopeCrypto; maxBytes?: number } = {},
) {
  return new FilesService(dataSource, {
    storage,
    scanner: options.scanner ?? new PermissiveTestScanner(),
    crypto: options.crypto,
    maxBytes: options.maxBytes,
  });
}

/** Stands in for the browser's PUT to the presigned URL. */
async function browserUploads(key: string, content: Buffer): Promise<void> {
  await storage.put(key, content);
}

describe('beginUpload', () => {
  it('records the intent before handing out a URL', async () => {
    const files = service();

    const { file, upload } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'Extras de cont.pdf',
      contentType: 'application/pdf',
    });

    // A signed URL nothing knows about produces an object no query will ever
    // find, and the retention sweep works from rows.
    expect(file.state).toBe('pending');
    expect(file.objectKey).toContain(`tenants/${TENANT}/request/abc/`);
    expect(upload.url).toBeTruthy();
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps the client’s filename for display, not for the key', async () => {
    const files = service();

    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: '../../etc/passwd',
    });

    expect(file.filename).not.toContain('/');
    expect(file.objectKey).not.toContain('passwd');
  });
});

describe('confirmUpload', () => {
  it('reads the type from the bytes and marks the file ready', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'statement.pdf',
      // A deliberate lie, which is the point: the header is a claim.
      contentType: 'image/png',
    });
    await browserUploads(file.objectKey, PDF);

    const confirmed = await files.confirmUpload(TENANT, file.id);

    expect(confirmed.state).toBe('ready');
    expect(confirmed.contentType).toBe('application/pdf');
    expect(confirmed.size).toBe(PDF.length);
    expect(confirmed.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses when the bytes never arrived', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'nothing.pdf',
    });

    // The client closed the page mid-upload. Common, and not an error the
    // client can do anything about except try again.
    await expect(files.confirmUpload(TENANT, file.id)).rejects.toThrow(/did not arrive/i);
  });

  it('rejects an empty file', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'empty.pdf',
    });
    await browserUploads(file.objectKey, Buffer.alloc(0));

    expect((await files.confirmUpload(TENANT, file.id)).state).toBe('rejected');
  });

  it('rejects a file larger than the limit, whatever was signed for', async () => {
    const files = service({ maxBytes: 1024 });
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'big.pdf',
    });
    await browserUploads(file.objectKey, Buffer.alloc(4096, 0x41));

    // A presigned PUT does not enforce a size; the client can send whatever it
    // likes to it.
    const confirmed = await files.confirmUpload(TENANT, file.id);
    expect(confirmed.state).toBe('rejected');
    expect(storage.keys).not.toContain(file.objectKey);
  });

  it('rejects a type that is not accepted here', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'photo.png',
    });
    await browserUploads(
      file.objectKey,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(8),
      ]),
    );

    const confirmed = await files.confirmUpload(TENANT, file.id, {
      accepted: ['application/pdf'],
    });

    expect(confirmed.state).toBe('rejected');
    expect(storage.keys).not.toContain(file.objectKey);
  });

  it('quarantines an infected file: bytes gone, row kept', async () => {
    const scanner: ScannerPort = {
      scan: async () => ({ clean: false, threat: 'Eicar-Test-Signature' }),
      available: async () => true,
    };
    const files = service({ scanner });
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'invoice.pdf',
    });
    await browserUploads(file.objectKey, PDF);

    const confirmed = await files.confirmUpload(TENANT, file.id);

    expect(confirmed.state).toBe('infected');
    expect(confirmed.reason).toBe('Eicar-Test-Signature');
    // The bytes go; the row stays. "What happened to the file I was told
    // about" deserves an answer.
    expect(storage.keys).not.toContain(file.objectKey);
  });

  it('refuses everything when no scanner is configured', async () => {
    const files = service({ scanner: new RefusingScanner() });
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'a.pdf',
    });
    await browserUploads(file.objectKey, PDF);

    // A misconfiguration that silently disables scanning is invisible until it
    // matters; one that refuses uploads is noticed in minutes.
    expect((await files.confirmUpload(TENANT, file.id)).state).toBe('infected');
  });

  it('is idempotent, because a confirmation gets retried', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'a.pdf',
    });
    await browserUploads(file.objectKey, PDF);

    const first = await files.confirmUpload(TENANT, file.id);
    const second = await files.confirmUpload(TENANT, file.id);

    expect(second.state).toBe('ready');
    expect(second.checksum).toBe(first.checksum);
  });

  it('will not confirm another tenant’s file', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'a.pdf',
    });
    await browserUploads(file.objectKey, PDF);

    await expect(files.confirmUpload(OTHER, file.id)).rejects.toThrow();
  });
});

describe('encryption', () => {
  const crypto = new EnvelopeCrypto(new LocalMasterKey(generateMasterKey()));

  async function readyEncrypted() {
    const { dataKey } = await crypto.createDataKey();
    const files = service({ crypto });
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'statement.pdf',
    });
    await browserUploads(file.objectKey, PDF);
    const confirmed = await files.confirmUpload(TENANT, file.id, {
      dataKey: async () => dataKey,
    });
    return { files, confirmed, dataKey };
  }

  it('stores ciphertext and reads back plaintext', async () => {
    const { files, confirmed, dataKey } = await readyEncrypted();

    expect(confirmed.encrypted).toBe(true);
    // What sits in the bucket must not be the document.
    expect((await storage.get(confirmed.objectKey)).equals(PDF)).toBe(false);
    expect(
      (await files.read(TENANT, confirmed.id, { dataKey: async () => dataKey })).equals(PDF),
    ).toBe(true);
  });

  it('refuses to read an encrypted file without a key', async () => {
    const { files, confirmed } = await readyEncrypted();

    await expect(files.read(TENANT, confirmed.id)).rejects.toThrow();
  });

  it('refuses a presigned download for an encrypted file', async () => {
    const { files, confirmed } = await readyEncrypted();

    // The browser has no key, so a presigned URL would hand it ciphertext.
    // Refusing is the honest answer rather than a limitation to work around.
    await expect(files.downloadUrl(TENANT, confirmed.id)).rejects.toThrow(/encrypted/i);
  });

  it('records the checksum of the plaintext, not of the ciphertext', async () => {
    const { confirmed } = await readyEncrypted();
    const plain = service();
    const { file } = await plain.beginUpload({
      tenantId: TENANT,
      scope: 'request/def',
      filename: 'statement.pdf',
    });
    await browserUploads(file.objectKey, PDF);
    const unencrypted = await plain.confirmUpload(TENANT, file.id);

    // Otherwise "have we already got this document?" answers no every time,
    // because every encryption produces different bytes.
    expect(confirmed.checksum).toBe(unencrypted.checksum);
  });
});

describe('reading and erasing', () => {
  async function ready(tenantId = TENANT, scope = 'request/abc') {
    const files = service();
    const { file } = await files.beginUpload({ tenantId, scope, filename: 'a.pdf' });
    await browserUploads(file.objectKey, PDF);
    return { files, file: await files.confirmUpload(tenantId, file.id) };
  }

  it('reads a file back', async () => {
    const { files, file } = await ready();

    expect((await files.read(TENANT, file.id)).equals(PDF)).toBe(true);
  });

  it('will not read another tenant’s file', async () => {
    const { files, file } = await ready();

    await expect(files.read(OTHER, file.id)).rejects.toThrow();
  });

  it('offers a short-lived download URL', async () => {
    const { files, file } = await ready();

    expect(await files.downloadUrl(TENANT, file.id)).toContain('download');
  });

  it('will not offer a URL for a file that is not ready', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/abc',
      filename: 'a.pdf',
    });

    await expect(files.downloadUrl(TENANT, file.id)).rejects.toThrow();
  });

  it('erases the bytes and keeps the row', async () => {
    const { files, file } = await ready();

    await files.erase(TENANT, file.id);

    expect(storage.keys).not.toContain(file.objectKey);
    // An audit saying a document existed and was destroyed on a date is worth
    // more than a gap where it used to be.
    const row = await dataSource
      .getRepository(StoredFile)
      .findOneOrFail({ where: { id: file.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('erases twice without complaining', async () => {
    const { files, file } = await ready();

    await files.erase(TENANT, file.id);
    await expect(files.erase(TENANT, file.id)).resolves.toBeUndefined();
  });
});

describe('sweeps', () => {
  it('deletes files whose retention has run out, and leaves the rest', async () => {
    const files = service();
    const expired = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/a',
      filename: 'old.pdf',
      retainUntil: new Date('2020-01-01'),
    });
    const kept = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/b',
      filename: 'new.pdf',
      retainUntil: new Date('2099-01-01'),
    });
    await browserUploads(expired.file.objectKey, PDF);
    await browserUploads(kept.file.objectKey, PDF);

    expect(await files.sweepExpired()).toBe(1);

    expect(storage.keys).not.toContain(expired.file.objectKey);
    expect(storage.keys).toContain(kept.file.objectKey);
  });

  it('leaves a file with no retention date alone', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/a',
      filename: 'forever.pdf',
    });
    await browserUploads(file.objectKey, PDF);

    expect(await files.sweepExpired()).toBe(0);
  });

  it('clears away uploads that were started and abandoned', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/a',
      filename: 'abandoned.pdf',
    });

    // A client on a train who closes the page. Normal, not an error.
    expect(await files.sweepAbandoned(new Date(Date.now() + 1000))).toBe(1);
    expect(
      await dataSource.getRepository(StoredFile).findOne({ where: { id: file.id } }),
    ).toBeNull();
  });

  it('does not clear away a finished upload', async () => {
    const files = service();
    const { file } = await files.beginUpload({
      tenantId: TENANT,
      scope: 'request/a',
      filename: 'done.pdf',
    });
    await browserUploads(file.objectKey, PDF);
    await files.confirmUpload(TENANT, file.id);

    expect(await files.sweepAbandoned(new Date(Date.now() + 1000))).toBe(0);
  });
});
