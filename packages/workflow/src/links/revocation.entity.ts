import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A public link that must no longer be accepted.
 *
 * Revocation is a row rather than a flag on the subject because a subject
 * usually has several live links — one per party, plus every re-issue — and
 * they are revoked individually. Revoking "the link" is almost never what is
 * meant.
 *
 * The table only ever grows within a token's lifetime; a row for a token that
 * has since expired is dead weight, and `expiresAt` is carried so it can be
 * swept without having to parse tokens back.
 */
@Entity({ name: 'mortar_link_revocation' })
@Unique('uq_link_revocation_jti', ['jti'])
@Index('idx_link_revocation_subject', ['tenantId', 'subject'])
@Index('idx_link_revocation_expires', ['expiresAt'])
export class LinkRevocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  /** The token id from the claims. */
  @Column({ type: 'varchar', length: 64 })
  jti!: string;

  /** Carried so every link for one subject can be revoked in one statement. */
  @Column({ type: 'varchar', length: 160 })
  subject!: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  party!: string | null;

  /**
   * Free string, not a foreign key: a revocation is frequently the work of the
   * system rather than a user — a re-issue supersedes the previous link.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  revokedBy!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  /** When the revoked token would have expired anyway. Drives the sweep. */
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  revokedAt!: Date;
}
