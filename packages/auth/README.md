# @birtalanrobert/auth

Identity, sessions, single-use tokens, memberships and RBAC primitives.

Deliberately **primitives**: mortar owns the shape, projects own the contents.
There is no shared enumeration of roles — a "manager" in a repair shop and a
"manager" in a recruitment agency have nothing in common.

## Roles are a table, not a string array

`mortar_role` holds the roles; `mortar_membership_role` grants them. Storing
role names as a `text[]` on the membership looks simpler and is wrong: `'manger'`
would be accepted silently, grant nothing, and there would be no way to
enumerate valid roles for a picker, rename one, or find out who holds it.

A Postgres enum array would be worse still — values cannot be removed,
reordering is painful, and `ALTER TYPE ADD VALUE` has transaction restrictions.
For something each project extends differently, it is the least flexible option
available.

- **System roles** (`tenantId` null) are defined by the project and available
  to every tenant. `syncSystemRoles()` is idempotent, so it runs at boot and the
  definitions stay in step with the code that references them.
- **Tenant roles** are created by a tenant for itself, and cannot shadow a
  system role key — otherwise `manager` would mean two things in one tenant and
  which one won would depend on query order.
- **System roles cannot be edited or deleted by a tenant.** An owner who strips
  a permission from `owner` locks themselves out, and the resulting ticket needs
  direct database access to fix.
- **A role still assigned cannot be deleted** — the FK is `ON DELETE RESTRICT`.

**Permissions stay an array on the role**, and that asymmetry is deliberate.
Roles are _entities_: they have identity, are referenced by other rows, get
renamed and listed. Permissions are _values_: bare strings defined in
application code, with no identity, no attributes, and nothing pointing at
them. A `role_permission` table would add a join to every lookup to model what
is simply a list.

## Relations exist where mortar owns both ends — and only there

`User`, `Membership`, `Role`, `MembershipRole`, `Session` and `AuthToken` are
all related properly, with cascade behaviour declared on the relation and
matching the migration's foreign keys.

**`tenantId` is deliberately a plain column with no relation.** Mortar owns no
tenant table: each of the consuming services defines its own, with its own
branding, plan and settings. There is nothing here for a relation to point at,
and inventing a `Tenant` entity in mortar would force one shape on all of them.
A project wanting a foreign key adds it in its own migration.

Relations are **never eager**. Loading every session and token whenever a user
is read would make the login path pay for data it does not use; callers ask
with `relations: { … }`.

`Membership → Role` is modelled as a one-to-many onto the explicit join entity
rather than a `@ManyToMany`, because the join carries `grantedBy` and
`grantedAt` — which a many-to-many has nowhere to put, and declaring both would
give two writers to one table.

## Extending mortar's entities

Mortar is a dependency of every project and knows about none of them, so its
entities can never relate outward — **the arrow only points one way**. Within
that constraint there are three patterns, all proven in
`extending-base.integration.test.ts` and `extending.integration.test.ts` rather
than merely described.

### 1. Extend the base entity — the ergonomic default

Every mortar entity ships as an abstract base plus a concrete default. A
project that needs more declares its own class on the **same table**:

```ts
@Entity({ name: 'mortar_user' })
export class User extends BaseUser {
  @Column({ type: 'varchar', length: 32, nullable: true })
  phoneNumber!: string | null;

  @OneToMany(() => Shift, (s) => s.user)
  shifts?: Shift[];
}

AuthModule.forRoot({ entities: { user: User } });
```

`user.phoneNumber` and `user.shifts` now sit on the user itself — no join, no
second table — and mortar's own services read and write that class.

Three rules, all enforced:

- **Register your subclass, not mortar's default.** Two entities on one table
  makes every query a coin toss. `assertAuthEntitiesValid()` catches it at boot.
- **Keep the class name.** Mortar's entities reference each other by name, so a
  subclass called `AppUser` leaves `Membership.user` unresolvable. Checked at
  boot with an error that explains why, rather than TypeORM's obscure metadata
  failure later.
- **Add your columns in your own migration.** Mortar's migration creates the
  base table; the extra columns are yours to add and to keep.

### 2. A profile table

A one-to-one from a project table to the mortar entity. Useful when the extra
fields are optional, numerous, or belong to a different bounded context.

### 3. A unidirectional `@ManyToOne`

For a project entity that merely _belongs to_ a user, with no need for the
inverse collection. `@ManyToOne` with no inverse side is a first-class relation,
and often the better direction — a collection on a shared entity is one more
thing every read could accidentally load.

## Users are global; membership is per tenant

Several projects here have one human in several tenants — an agent managing
portfolios for four landlords, a recruiter working two agencies, an operator
supporting everybody. A user-per-tenant model forces them into separate
accounts with separate passwords, so `mortar_user` is global and
`mortar_membership` carries the tenant and the roles.

## Passwords

Node's built-in **scrypt** by default: no dependency, no native build, no
platform binaries — which matters for a library consuming services install. The
`PasswordHasher` interface is pluggable, so a project wanting Argon2id supplies
an adapter without mortar taking on the dependency.

Parameters are encoded into the hash (`scrypt$N$r$p$salt$digest`), so cost can
be raised later without locking anyone out: old hashes verify against their own
parameters and are **rehashed on next successful login**.

Two limits that are not arbitrary:

- **Passwords are capped at 1024 characters.** Unbounded input into a
  deliberately expensive KDF is a denial-of-service vector.
- **Digests below 32 bytes are refused.** scrypt is prefix-stable, so verifying
  at the stored digest's length would let a _truncated_ digest match — truncate
  it to one byte and any password succeeds about one time in 256.

## Tokens are stored as digests, never as tokens

Sessions and single-use links both store `sha256(token)`. A leaked sessions
table full of usable tokens is an immediate compromise of every logged-in user;
a table of digests is not.

Plain SHA-256 rather than a password hash, deliberately: these are
high-entropy random values, so there is nothing to brute-force and a slow KDF
would only make every request expensive.

## Sessions are opaque, not JWTs

Every project here needs to revoke access _immediately_ — a dismissed employee,
a lost counter tablet, a compromised account, a suspended tenant. A stateless
token cannot be revoked without building the very lookup table it was meant to
avoid. The lookup is one indexed read.

- **Two lifetimes**: absolute and idle. A shared counter tablet left signed in
  overnight should not stay valid because somebody touched it at closing time.
- **`rotate()` on every privilege change** — signing in, switching tenant.
  Keeping one token across a privilege boundary is session fixation.
- **`revokeAllForUser()`** is the required response to a password change;
  leaving other sessions alive means the attacker keeps their access.

## Enumeration resistance

Wrong password, unknown account and unverified address all return the _same_
error. `verifyPassword` also runs the hasher against a dummy hash when the
account does not exist — without that, "no such user" returns in a millisecond
while a real account takes a hundred, and the difference is a reliable
enumeration oracle however carefully the message is worded.

The same applies to tokens: unknown, expired and already-spent are one error.

## Single-use tokens

Consumption is a **conditional UPDATE**, not a read-then-write: a double-clicked
link or an email client pre-fetching the URL would otherwise both read it as
unspent. The database decides which one wins.

`consumeWith()` spends the token _inside_ the caller's transaction, so a
failure un-spends it — the user's link still works rather than being burned by
a failure that was not their fault.

Issuing a new token supersedes any outstanding one of the same type. Two live
reset links means the older still works after the user asked for a fresh one —
precisely when they feared the first had been seen.
