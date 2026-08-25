/**
 * Proves how a consuming project extends mortar's identity tables.
 *
 * Mortar is a dependency of every project and knows about none of them, so
 * `User` can never declare a relation to a project's own entity — the arrow
 * only points one way. These tests exercise the two patterns that work within
 * that constraint, so that the documented answer is a demonstrated one.
 */
import { createTestDataSource } from '@mortar/database';
import {
  Column,
  DataSource,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { User as MortarUser } from './entities/user';
import { authEntities, authMigrations } from './index';
import { UserService } from './services/user.service';
import { ScryptHasher } from './password';

/**
 * Pattern one — a **profile table**, for extra fields about the same person.
 *
 * A one-to-one owned by the project. Adding columns to `mortar_user` directly
 * would put a project's schema inside a shared migration, where the next
 * mortar upgrade would not know about it.
 */
@Entity({ name: 'app_user_profile' })
class UserProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  userId!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phoneNumber!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  payrollReference!: string | null;

  // The project owns this relation, so it may declare cascade and load it.
  @OneToOne(() => MortarUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: MortarUser;
}

/**
 * Pattern two — a **project entity relating to a user**, unidirectionally.
 *
 * `@ManyToOne` with no inverse side is a first-class TypeORM relation. The
 * project navigates `shift.user`; nobody navigates `user.shifts`, which is
 * also the cheaper direction — a collection on the shared entity would be one
 * more thing every read of a user might accidentally load.
 */
@Entity({ name: 'app_shift' })
class Shift {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  label!: string;

  @ManyToOne(() => MortarUser, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: MortarUser;
}

let dataSource: DataSource;
let users: UserService;

beforeAll(async () => {
  dataSource = await createTestDataSource([...authEntities, UserProfile, Shift], {
    migrations: authMigrations,
  });
  // The project's own tables, as its own migration would create them.
  await dataSource.query(`
    CREATE TABLE "app_user_profile" (
      "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id"           uuid NOT NULL UNIQUE REFERENCES "mortar_user"("id") ON DELETE CASCADE,
      "phone_number"      varchar(32),
      "payroll_reference" varchar(64)
    )
  `);
  await dataSource.query(`
    CREATE TABLE "app_shift" (
      "id"      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" uuid NOT NULL REFERENCES "mortar_user"("id") ON DELETE CASCADE,
      "label"   text NOT NULL
    )
  `);
  users = new UserService(dataSource, { hasher: new ScryptHasher({ cost: 1024 }) });
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.query('TRUNCATE app_shift, app_user_profile, mortar_user CASCADE');
});

describe('a project extending the user with its own fields', () => {
  it('stores and reads a profile alongside the mortar user', async () => {
    const user = await users.create({ email: 'ana@example.com', password: 'pw-123456' });
    await dataSource
      .getRepository(UserProfile)
      .save({ userId: user.id, phoneNumber: '+40712345678', payrollReference: 'EMP-014' });

    const profile = await dataSource.getRepository(UserProfile).findOneOrFail({
      where: { userId: user.id },
      relations: { user: true },
    });

    expect(profile.phoneNumber).toBe('+40712345678');
    expect(profile.user?.email).toBe('ana@example.com');
  });

  it('cascades from the mortar user into the project table', async () => {
    const user = await users.create({ email: 'ana@example.com' });
    await dataSource.getRepository(UserProfile).save({ userId: user.id, phoneNumber: '+40' });

    await dataSource.getRepository(MortarUser).delete({ id: user.id });

    expect(await dataSource.getRepository(UserProfile).count()).toBe(0);
  });
});

describe('a project entity relating to a user', () => {
  it('navigates from the project entity to the mortar user', async () => {
    const user = await users.create({ email: 'ana@example.com' });
    await dataSource.getRepository(Shift).save([
      { userId: user.id, label: 'Monday early' },
      { userId: user.id, label: 'Tuesday late' },
    ]);

    const shift = await dataSource.getRepository(Shift).findOneOrFail({
      where: { label: 'Monday early' },
      relations: { user: true },
    });
    expect(shift.user?.email).toBe('ana@example.com');
  });

  it('answers "everything for this user" by querying the owning side', async () => {
    // The inverse collection is unavailable by design, and unnecessary: this
    // query is the same work without putting a loadable collection on a
    // shared entity.
    const user = await users.create({ email: 'ana@example.com' });
    await dataSource.getRepository(Shift).save([
      { userId: user.id, label: 'a' },
      { userId: user.id, label: 'b' },
    ]);

    expect(await dataSource.getRepository(Shift).countBy({ userId: user.id })).toBe(2);
  });

  it('leaves mortar services working unchanged alongside project relations', async () => {
    const user = await users.create({ email: 'ana@example.com', password: 'pw-123456' });
    await dataSource.getRepository(Shift).save({ userId: user.id, label: 'x' });

    // The point: registering extra entities against the same DataSource does
    // not disturb anything mortar does.
    const verified = await users.verifyPassword('ana@example.com', 'pw-123456');
    expect(verified.id).toBe(user.id);
  });
});
