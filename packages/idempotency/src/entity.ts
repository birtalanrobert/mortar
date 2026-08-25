import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export type IdempotencyStatus = 'in_progress' | 'completed';

/**
 * A claimed idempotency key and, once the work has committed, the response to
 * replay for any repeat of it.
 */
@Entity({ name: 'mortar_idempotency_key' })
@Unique('uq_idempotency_scope_key', ['tenantId', 'scope', 'key'])
@Index('idx_idempotency_expires', ['expiresAt'])
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Null for unauthenticated or platform-level operations. */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  /**
   * The operation this key belongs to, e.g. `POST /orders`.
   *
   * Without a scope, a client reusing one key across two different endpoints
   * would get the first endpoint's response back from the second — so the key
   * alone is not the identity.
   */
  @Column({ type: 'varchar', length: 128 })
  scope!: string;

  /** The client-supplied key. */
  @Column({ type: 'varchar', length: 255 })
  key!: string;

  /**
   * Hash of the request payload.
   *
   * Lets us tell a genuine retry from a client that reused a key for a
   * different request — the second is a bug, and silently returning the first
   * request's response would hide it.
   */
  @Column({ type: 'char', length: 64 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: IdempotencyStatus;

  @Column({ type: 'int', nullable: true })
  responseStatus!: number | null;

  /**
   * The stored response, as JSON text.
   *
   * Deliberately `text` rather than `jsonb`: this is an opaque blob to be
   * replayed verbatim, never queried into. `text` also keeps SQL NULL
   * unambiguous — it means "no response recorded", whereas a `jsonb` column
   * would conflate that with a handler that genuinely returned null.
   */
  @Column({ type: 'text', nullable: true })
  responseBody!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  claimedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  /** After this, the key may be claimed afresh. */
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;
}
