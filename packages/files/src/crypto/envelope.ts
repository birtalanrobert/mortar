import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '@birtalanrobert/http';

/**
 * A key that wraps other keys.
 *
 * A port rather than a concrete implementation, because the only difference
 * between a development machine and a regulated deployment is where this lives:
 * a value in the environment for the first, a hardware-backed KMS for the
 * second. Everything above this line is identical either way, which is what
 * makes the upgrade a deployment decision rather than a rewrite.
 */
export interface MasterKeyPort {
  /** Identifies the key that did the wrapping, so rotation is possible. */
  readonly keyId: string;
  wrap(dataKey: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

export interface Envelope {
  /** The tenant's data key, wrapped by the master key. Stored, not secret. */
  wrappedKey: string;
  /** Which master key wrapped it. */
  keyId: string;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope encryption, for the sake of being able to destroy data.
 *
 * Every tenant gets one data key. Files are encrypted with it; the key itself
 * is stored only in wrapped form. Erasing a tenant then means destroying one
 * wrapped key rather than finding and overwriting every object they ever
 * uploaded — which is the difference between an erasure request that can be
 * honoured in seconds and one that cannot honestly be honoured at all, because
 * backups exist.
 *
 * That is the whole argument for the indirection. Encryption at rest is
 * something the storage provider already does; **crypto-shredding is not**.
 */
export class EnvelopeCrypto {
  constructor(private readonly master: MasterKeyPort) {}

  /** A new data key for a tenant, returned unwrapped once and never again. */
  async createDataKey(): Promise<{ envelope: Envelope; dataKey: Buffer }> {
    const dataKey = randomBytes(KEY_BYTES);
    return {
      dataKey,
      envelope: { wrappedKey: await this.master.wrap(dataKey), keyId: this.master.keyId },
    };
  }

  async openDataKey(envelope: Envelope): Promise<Buffer> {
    const dataKey = await this.master.unwrap(envelope.wrappedKey);
    if (dataKey.length !== KEY_BYTES) {
      throw new ValidationError([
        { field: 'wrappedKey', message: 'That is not a data key.', code: 'invalid_data_key' },
      ]);
    }
    return dataKey;
  }

  /**
   * Encrypts one file's contents.
   *
   * A fresh initialisation vector per call, never derived from anything about
   * the file. Reusing an IV under one key in GCM does not merely weaken the
   * ciphertext — it leaks the key stream and, with two messages, the
   * authentication key itself.
   *
   * The IV and the authentication tag are stored alongside the ciphertext
   * rather than beside it in the database, so a restored object is
   * self-describing and a row that has drifted cannot make it undecryptable.
   */
  encrypt(dataKey: Buffer, plaintext: Buffer, aad?: string): Buffer {
    assertDataKey(dataKey);

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv);
    /**
     * The object key is bound in as additional authenticated data.
     *
     * It means a ciphertext copied to a different key — one tenant's object
     * moved under another's prefix — fails to decrypt rather than decrypting
     * into the wrong tenant's hands.
     */
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));

    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  decrypt(dataKey: Buffer, payload: Buffer, aad?: string): Buffer {
    assertDataKey(dataKey);

    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new ValidationError([
        { field: 'payload', message: 'That file is not readable.', code: 'malformed_ciphertext' },
      ]);
    }

    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = payload.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, dataKey, iv);
    decipher.setAuthTag(tag);
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));

    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      /**
       * One message for every failure.
       *
       * A wrong key, a tampered tag and a mismatched object key are all "not
       * readable" to the caller. Distinguishing them tells anyone probing which
       * part of their guess was right.
       */
      throw new ValidationError([
        { field: 'payload', message: 'That file is not readable.', code: 'decryption_failed' },
      ]);
    }
  }
}

/**
 * A master key held in the process, for development and tests.
 *
 * Deliberately not the default and deliberately noisy about what it is. It
 * gives real AES-GCM wrapping, so nothing above it behaves differently — what
 * it does not give is a key that survives the process being compromised, which
 * is the entire point of a KMS.
 */
export class LocalMasterKey implements MasterKeyPort {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(secret: string, keyId = 'local') {
    const key = Buffer.from(secret, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new ValidationError([
        {
          field: 'masterKey',
          message: 'A master key is 32 bytes, base64 encoded.',
          code: 'invalid_master_key',
        },
      ]);
    }
    this.key = key;
    this.keyId = keyId;
  }

  async wrap(dataKey: Buffer): Promise<string> {
    assertDataKey(dataKey);

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    const payload = Buffer.from(wrapped, 'base64');
    if (payload.length !== IV_BYTES + TAG_BYTES + KEY_BYTES) {
      throw new ValidationError([
        { field: 'wrappedKey', message: 'That is not a wrapped key.', code: 'invalid_wrapped_key' },
      ]);
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, payload.subarray(0, IV_BYTES));
    decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

    try {
      return Buffer.concat([
        decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new ValidationError([
        { field: 'wrappedKey', message: 'That key cannot be opened.', code: 'unwrap_failed' },
      ]);
    }
  }
}

/** Generates a master key for an environment file. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Whether two wrapped keys are the same, without leaking where they differ.
 *
 * Used when confirming a rotation applied, which is a comparison of secrets
 * even though both sides are stored.
 */
export function sameWrappedKey(left: string, right: string): boolean {
  const a = Buffer.from(left, 'base64');
  const b = Buffer.from(right, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertDataKey(dataKey: Buffer): void {
  if (dataKey.length !== KEY_BYTES) {
    throw new ValidationError([
      { field: 'dataKey', message: 'A data key is 32 bytes.', code: 'invalid_data_key' },
    ]);
  }
}
