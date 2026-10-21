import { randomBytes } from 'node:crypto';
import { createTestDataSource } from '@birtalanrobert/database';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SecondFactorEnrolledError,
  SecondFactorInvalidError,
  SecondFactorLockedError,
  SecondFactorNotEnrolledError,
} from './errors';
import { authEntities, authMigrations } from './index';
import { SecondFactorService } from './services/second-factor.service';
import { base32Decode, totpCode, totpStep } from './totp';

let dataSource: DataSource;
let factors: SecondFactorService;
let userId: string;

/** A moment, and the app's code for it — as a phone would show it then. */
const T0 = new Date('2026-10-20T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const codeAt = (secret: string, moment: Date) =>
  totpCode(base32Decode(secret), totpStep(moment.getTime()));

beforeAll(async () => {
  dataSource = await createTestDataSource(authEntities, { migrations: authMigrations });
  // A key made for the run, as a deployment's would be.
  factors = new SecondFactorService(dataSource, {
    secretKey: randomBytes(32),
    issuer: 'Mortar',
    maxFailures: 3,
    lockMs: 60_000,
  });
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE mortar_second_factor, mortar_user CASCADE');
  const [row] = (await dataSource.query(
    `INSERT INTO "mortar_user" ("email") VALUES ('ada@example.com') RETURNING "id"`,
  )) as Array<{ id: string }>;
  userId = row!.id;
});

describe('enrolment', () => {
  it('gives a new secret each time it is begun, then recovery codes once one is confirmed', async () => {
    const first = await factors.begin(userId, 'ada@example.com');
    const again = await factors.begin(userId, 'ada@example.com');
    expect(again.secret).not.toBe(first.secret);
    expect(again.uri).toContain(`secret=${again.secret}`);
    expect((await factors.status(userId))?.confirmed).toBe(false);

    // Whoever began the first holds a secret that no longer confirms anything.
    await expect(factors.confirm(userId, codeAt(first.secret, T0), T0)).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
    const codes = await factors.confirm(userId, codeAt(again.secret, T0), T0);
    expect(codes).toHaveLength(10);
    expect(await factors.status(userId)).toEqual({
      confirmed: true,
      recoveryCodesLeft: 10,
      lockedUntil: null,
    });
    await expect(factors.begin(userId, 'ada@example.com')).rejects.toBeInstanceOf(
      SecondFactorEnrolledError,
    );
  });

  it('keeps the secret sealed, and none of the recovery codes in the clear', async () => {
    const { secret } = await factors.begin(userId, 'ada@example.com');
    const codes = await factors.confirm(userId, codeAt(secret, T0), T0);
    const [row] = (await dataSource.query(
      `SELECT "secret_sealed", "recovery_code_hashes" FROM "mortar_second_factor"`,
    )) as Array<{ secret_sealed: string; recovery_code_hashes: string[] }>;
    expect(row!.secret_sealed).not.toContain(secret);
    expect(row!.secret_sealed).toMatch(/^v1\./);
    for (const code of codes) expect(row!.recovery_code_hashes).not.toContain(code);
  });

  it('refuses a wrong code to confirm, and a code before anything is begun', async () => {
    await expect(factors.verify(userId, '123456', T0)).rejects.toBeInstanceOf(
      SecondFactorNotEnrolledError,
    );
    const { secret } = await factors.begin(userId, 'ada@example.com');
    const wrong = codeAt(secret, at(300));
    await expect(factors.confirm(userId, wrong, T0)).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
    // Begun and not confirmed: nothing to check a sign-in's code against.
    await expect(factors.verify(userId, codeAt(secret, T0), T0)).rejects.toBeInstanceOf(
      SecondFactorNotEnrolledError,
    );
  });
});

describe('a code checked', () => {
  let secret: string;
  let recovery: string[];

  beforeEach(async () => {
    ({ secret } = await factors.begin(userId, 'ada@example.com'));
    recovery = await factors.confirm(userId, codeAt(secret, T0), T0);
  });

  it('is good once: the same code, or an older one, is refused after it', async () => {
    const later = at(60);
    await expect(factors.verify(userId, codeAt(secret, later), later)).resolves.toEqual({
      method: 'totp',
      recoveryCodesLeft: 10,
    });
    await expect(factors.verify(userId, codeAt(secret, later), later)).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
    await expect(factors.verify(userId, codeAt(secret, at(30)), later)).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
  });

  it('takes a recovery code once, as typed, and counts what is left', async () => {
    const [first] = recovery;
    await expect(factors.verify(userId, first!.toUpperCase(), at(60))).resolves.toEqual({
      method: 'recovery',
      recoveryCodesLeft: 9,
    });
    await expect(factors.verify(userId, first!, at(90))).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
  });

  it('locks after too many wrong codes, refusing even a right one until the lock ends', async () => {
    const wrong = codeAt(secret, at(600));
    const tries = [at(60), at(61), at(62)];
    await expect(factors.verify(userId, wrong, tries[0])).rejects.toMatchObject({
      code: 'second_factor_invalid',
      meta: { attemptsLeft: 2 },
    });
    await expect(factors.verify(userId, wrong, tries[1])).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
    await expect(factors.verify(userId, wrong, tries[2])).rejects.toBeInstanceOf(
      SecondFactorLockedError,
    );
    const during = at(90);
    await expect(factors.verify(userId, codeAt(secret, during), during)).rejects.toBeInstanceOf(
      SecondFactorLockedError,
    );

    const after = at(62 + 61);
    await expect(factors.verify(userId, codeAt(secret, after), after)).resolves.toMatchObject({
      method: 'totp',
    });
  });

  it('renews the recovery codes for the app’s code alone, the old ones gone', async () => {
    await expect(factors.renewRecoveryCodes(userId, recovery[0]!, at(60))).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
    const renewed = await factors.renewRecoveryCodes(userId, codeAt(secret, at(60)), at(60));
    expect(renewed).toHaveLength(10);
    await expect(factors.verify(userId, recovery[1]!, at(90))).rejects.toBeInstanceOf(
      SecondFactorInvalidError,
    );
    await expect(factors.verify(userId, renewed[0]!, at(90))).resolves.toMatchObject({
      method: 'recovery',
    });
  });

  it('is gone with its account, and when removed', async () => {
    await factors.remove(userId);
    expect(await factors.status(userId)).toBeNull();

    ({ secret } = await factors.begin(userId, 'ada@example.com'));
    await dataSource.query(`DELETE FROM "mortar_user" WHERE "id" = $1`, [userId]);
    expect(await factors.status(userId)).toBeNull();
  });
});
