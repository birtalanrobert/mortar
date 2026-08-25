/**
 * Proves the **base-entity extension** pattern: a project's class maps the
 * same table as mortar's, adding its own columns and relations.
 *
 * In its own file because it drops and rebuilds the schema, which would wipe
 * the tables the sibling suite creates.
 */
import { createTestDataSource } from '@birtalanrobert/database';
import {
  Column,
  DataSource,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthToken } from './entities/auth-token';
import { Membership } from './entities/membership';
import { MembershipRole } from './entities/membership-role';
import { Role } from './entities/role';
import { Session } from './entities/session';
import { BaseUser } from './entities/user';
import { ScryptHasher } from './password';
import { assertAuthEntitiesValid, defaultAuthEntityRegistry } from './registry';
import { UserService } from './services/user.service';
import { authMigrations } from './index';

const TENANT_ID = '00000000-0000-0000-0000-0000000000aa';

// ---------------------------------------------------------------------------
// Pattern three — **extending the base entity itself**.
//
// The project's class maps the *same table* as mortar's, adding its own
// columns and relations. This is the ergonomic option: `user.phoneNumber` and
// `user.shifts` sit on the user, with no join and no second table.
// ---------------------------------------------------------------------------

@Entity({ name: 'mortar_user' })
@Index('uq_ext_user_email', ['email'], { unique: true })
class User extends BaseUser {
  @Column({ type: 'varchar', length: 32, nullable: true })
  phoneNumber!: string | null;

  @OneToMany('ExtShift', 'user')
  shifts?: ExtShift[];
}

@Entity({ name: 'ext_shift' })
class ExtShift {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  label!: string;

  @ManyToOne('User', 'shifts', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;
}

describe('extending the base entity', () => {
  let extDs: DataSource;
  let extUsers: UserService;

  beforeAll(async () => {
    extDs = await createTestDataSource(
      // The project's User replaces mortar's; mortar's own default is not
      // registered, because two entities on one table is the failure mode.
      [User, Membership, Role, MembershipRole, Session, AuthToken, ExtShift],
      { migrations: authMigrations },
    );
    await extDs.query(`ALTER TABLE "mortar_user" ADD COLUMN "phone_number" varchar(32)`);
    await extDs.query(`
      CREATE TABLE "ext_shift" (
        "id"      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL REFERENCES "mortar_user"("id") ON DELETE CASCADE,
        "label"   text NOT NULL
      )
    `);
    extUsers = new UserService(extDs, {
      hasher: new ScryptHasher({ cost: 1024 }),
      entities: { user: User },
    });
  });

  afterAll(async () => {
    if (extDs?.isInitialized) await extDs.destroy();
  });

  beforeEach(async () => {
    await extDs.query('TRUNCATE ext_shift, mortar_user CASCADE');
  });

  it('inherits every base column and adds the project column', () => {
    const columns = extDs.getMetadata(User).columns.map((c) => c.propertyName);
    expect(columns).toContain('email'); // from BaseUser
    expect(columns).toContain('passwordHash'); // from BaseUser
    expect(columns).toContain('phoneNumber'); // from the project
    expect(extDs.getMetadata(User).tableName).toBe('mortar_user');
  });

  it('lets mortar services operate on the project subclass', async () => {
    const created = await extUsers.create({ email: 'ana@example.com', password: 'pw-123456' });
    await extDs.getRepository(User).update({ id: created.id }, { phoneNumber: '+40712345678' });

    // Mortar's own login path, against the project's entity.
    const verified = await extUsers.verifyPassword('ana@example.com', 'pw-123456');
    expect(verified.id).toBe(created.id);
    expect((verified as User).phoneNumber).toBe('+40712345678');
  });

  it('carries the project relation on the user itself', async () => {
    const user = await extUsers.create({ email: 'ana@example.com' });
    await extDs.getRepository(ExtShift).save([
      { userId: user.id, label: 'Monday early' },
      { userId: user.id, label: 'Tuesday late' },
    ]);

    // The payoff: no profile table, no join to write by hand.
    const loaded = await extDs.getRepository(User).findOneOrFail({
      where: { id: user.id },
      relations: { shifts: true },
    });
    expect(loaded.shifts).toHaveLength(2);
  });

  it("keeps mortar's own relations working against the subclass", async () => {
    const user = await extUsers.create({ email: 'ana@example.com' });
    await extUsers.addMembership(user.id, TENANT_ID, []);

    const membership = await extDs.getRepository(Membership).findOneOrFail({
      where: { userId: user.id },
      relations: { user: true },
    });
    expect(membership.user?.email).toBe('ana@example.com');
  });
});

describe('registration mistakes are caught at boot', () => {
  it('rejects a subclass that was renamed', () => {
    class AppUser extends BaseUser {}
    expect(() =>
      assertAuthEntitiesValid({ entityMetadatas: [] } as unknown as DataSource, {
        ...defaultAuthEntityRegistry,
        user: AppUser,
      }),
    ).toThrow(/must be called 'User'/);
  });

  it('explains why, rather than leaving an obscure metadata error', () => {
    class AppUser extends BaseUser {}
    expect(() =>
      assertAuthEntitiesValid({ entityMetadatas: [] } as unknown as DataSource, {
        ...defaultAuthEntityRegistry,
        user: AppUser,
      }),
    ).toThrow(/reference each other by class name/);
  });
});
