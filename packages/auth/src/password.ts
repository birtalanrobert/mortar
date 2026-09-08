import {
  pbkdf2,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions as NodeScryptOptions,
} from 'node:crypto';

/**
 * Promisified scrypt.
 *
 * Written out rather than using `promisify`, which collapses the overloads and
 * loses the options argument — the very argument that carries the cost
 * parameters.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: NodeScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}

/**
 * A password hashing strategy.
 *
 * Pluggable because the right answer changes over time and because mortar
 * should not force a native dependency on every consumer. The default
 * uses Node's built-in scrypt — zero dependencies, no build step, no
 * platform-specific binaries — and a project wanting Argon2id supplies an
 * adapter without mortar taking on the dependency.
 */
export interface PasswordHasher {
  readonly id: string;
  hash(password: string): Promise<string>;
  /** Must be timing-safe. */
  verify(password: string, encoded: string): Promise<boolean>;
  /** Whether an existing hash was produced with weaker parameters. */
  needsRehash(encoded: string): boolean;
}

export interface ScryptOptions {
  /**
   * CPU/memory cost, a power of two. Memory used is roughly `128 * N * r`
   * bytes — 16 MB at the default.
   *
   * Raising this is the main security lever and the main denial-of-service
   * lever at once: every login costs the server that memory, so a login
   * endpoint without rate limiting becomes a way to exhaust the machine.
   */
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  keyLength?: number;
  saltLength?: number;
}

const DEFAULTS: Required<ScryptOptions> = {
  cost: 16384, // 2^14
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
  saltLength: 16,
};

/**
 * scrypt-based hashing.
 *
 * Encoded as `scrypt$N$r$p$salt$hash`, so the parameters travel with the hash
 * and can be raised later without invalidating existing passwords — the old
 * ones simply verify against their own parameters and are rehashed on next
 * successful login.
 */
export class ScryptHasher implements PasswordHasher {
  readonly id = 'scrypt';
  private readonly options: Required<ScryptOptions>;

  constructor(options: ScryptOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    if ((this.options.cost & (this.options.cost - 1)) !== 0) {
      throw new Error(`scrypt cost must be a power of two, received ${this.options.cost}`);
    }
  }

  async hash(password: string): Promise<string> {
    assertPasswordLength(password);
    const { cost, blockSize, parallelization, keyLength, saltLength } = this.options;
    const salt = randomBytes(saltLength);
    const derived = await scryptAsync(password.normalize('NFKC'), salt, keyLength, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: maxmemFor(cost, blockSize),
    });

    return [
      'scrypt',
      cost,
      blockSize,
      parallelization,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parse(encoded);
    if (!parsed) return false;

    try {
      const derived = await scryptAsync(
        password.normalize('NFKC'),
        parsed.salt,
        parsed.hash.length,
        {
          N: parsed.cost,
          r: parsed.blockSize,
          p: parsed.parallelization,
          maxmem: maxmemFor(parsed.cost, parsed.blockSize),
        },
      );

      // Length-checked before comparing: timingSafeEqual throws on a length
      // mismatch, and that throw would itself be an oracle.
      if (derived.length !== parsed.hash.length) return false;
      return timingSafeEqual(derived, parsed.hash);
    } catch {
      return false;
    }
  }

  needsRehash(encoded: string): boolean {
    const parsed = parse(encoded);
    if (!parsed) return true;
    return (
      parsed.cost < this.options.cost ||
      parsed.blockSize < this.options.blockSize ||
      parsed.parallelization < this.options.parallelization
    );
  }
}

/**
 * PBKDF2 options. The iteration count is the only lever that matters.
 *
 * OWASP's current floor for PBKDF2-HMAC-SHA256 is 600,000, which is what this
 * defaults to.
 */
export interface Pbkdf2Options {
  iterations?: number;
  keyLength?: number;
  saltLength?: number;
}

const PBKDF2_DEFAULTS: Required<Pbkdf2Options> = {
  iterations: 600_000,
  keyLength: 32,
  saltLength: 16,
};

/**
 * PBKDF2-HMAC-SHA256 hashing, for a secret a **browser** must also verify.
 *
 * `ScryptHasher` is the right default and stays it: scrypt is memory-hard and
 * PBKDF2 is not, so an attacker with a GPU gets far more out of the same money
 * here. This exists for one situation, and only that one — a credential that
 * has to be checked with no network, on a device.
 *
 * The Web Crypto API implements PBKDF2 and does not implement scrypt. A
 * surface that must authenticate offline therefore either verifies a PBKDF2
 * hash with the platform's own primitive, or ships a JavaScript scrypt into
 * every bundle, or holds a *second* hash of the same secret in a second
 * format. The third is the worst of the three: two representations of one
 * secret is two things to keep in step, and the day they disagree is the day
 * somebody cannot clock in.
 *
 * **Use it only where offline verification is the requirement**, and only for
 * secrets whose real protection is something else — a rate limit, a locked
 * cabinet, a short lifetime. For an account password, use scrypt.
 *
 * Encoded as `pbkdf2$sha256$iterations$salt$hash`, so the parameters travel
 * with the hash and can be raised later without invalidating what exists.
 */
export class Pbkdf2Hasher implements PasswordHasher {
  readonly id = 'pbkdf2';
  private readonly options: Required<Pbkdf2Options>;

  constructor(options: Pbkdf2Options = {}) {
    this.options = { ...PBKDF2_DEFAULTS, ...options };
  }

  async hash(password: string): Promise<string> {
    assertPasswordLength(password);
    const { iterations, keyLength, saltLength } = this.options;
    const salt = randomBytes(saltLength);
    const derived = await pbkdf2Async(password.normalize('NFKC'), salt, iterations, keyLength);

    return [
      'pbkdf2',
      'sha256',
      iterations,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parsePbkdf2(encoded);
    if (!parsed) return false;

    try {
      const derived = await pbkdf2Async(
        password.normalize('NFKC'),
        parsed.salt,
        parsed.iterations,
        parsed.hash.length,
      );

      return timingSafeEqual(derived, parsed.hash);
    } catch {
      return false;
    }
  }

  needsRehash(encoded: string): boolean {
    const parsed = parsePbkdf2(encoded);
    if (!parsed) return true;
    return parsed.iterations < this.options.iterations;
  }
}

interface ParsedPbkdf2 {
  iterations: number;
  salt: Buffer;
  hash: Buffer;
}

function parsePbkdf2(encoded: string): ParsedPbkdf2 | null {
  const parts = encoded.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return null;

  const parsed: ParsedPbkdf2 = {
    iterations: Number(parts[2]),
    salt: Buffer.from(parts[3] ?? '', 'base64'),
    hash: Buffer.from(parts[4] ?? '', 'base64'),
  };

  if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1000) return null;
  if (parsed.salt.length < 8) return null;
  /*
   * The same truncation trap as scrypt's, and for the same reason: PBKDF2 is
   * prefix-stable, so verifying at the *stored* length means a digest truncated
   * to one byte matches roughly one attempt in 256.
   */
  if (parsed.hash.length < MIN_DIGEST_BYTES) return null;

  return parsed;
}

function pbkdf2Async(
  password: string,
  salt: Buffer,
  iterations: number,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, keyLength, 'sha256', (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}

interface ParsedHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  hash: Buffer;
}

/**
 * Smallest digest we will accept, in bytes.
 *
 * scrypt is prefix-stable: the first N bytes of a long derivation equal the
 * whole of a short one with the same salt and parameters. So verifying at the
 * *stored* digest's length means a truncated digest still matches — truncate
 * it to one byte and any password succeeds roughly one time in 256.
 *
 * Deriving at the stored length is still right (it lets the key length be
 * raised over time), but the stored length itself must be plausible.
 */
const MIN_DIGEST_BYTES = 32;

function parse(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, cost, blockSize, parallelization, salt, hash] = parts;
  const parsed: ParsedHash = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
    salt: Buffer.from(salt ?? '', 'base64'),
    hash: Buffer.from(hash ?? '', 'base64'),
  };
  if (!Number.isInteger(parsed.cost) || parsed.cost < 2) return null;
  if (!Number.isInteger(parsed.blockSize) || parsed.blockSize < 1) return null;
  if (!Number.isInteger(parsed.parallelization) || parsed.parallelization < 1) return null;
  if (parsed.salt.length < 8) return null;
  if (parsed.hash.length < MIN_DIGEST_BYTES) return null;
  return parsed;
}

function maxmemFor(cost: number, blockSize: number): number {
  // Node's default maxmem is 32 MB, which rejects anything above roughly
  // N=2^14 at r=8. Sized from the parameters plus headroom instead.
  return 256 * cost * blockSize + 1024 * 1024;
}

/**
 * Upper bound on password length.
 *
 * Unbounded input into a deliberately expensive KDF is a denial-of-service
 * vector — a one-megabyte "password" costs the server real work per attempt.
 */
export const MAX_PASSWORD_LENGTH = 1024;

function assertPasswordLength(password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

/** The default hasher: no dependencies, no native build. */
export const defaultPasswordHasher = new ScryptHasher();
