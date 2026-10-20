import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * An account's second factor: the secret its authenticator app holds, sealed,
 * and what keeps a code from being good twice or guessed.
 *
 * One per account, keyed by it. No relation to `User`, deliberately: the
 * migration's foreign key deletes it with its account, and a relation would
 * tie it into the entity registry for nothing it reads.
 */
export abstract class BaseSecondFactor {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  /** The base32 secret, sealed with the product's key: a leaked dump holds no working secret. */
  @Column({ type: 'text' })
  secretSealed!: string;

  /** When a first code proved the app holds the secret; null while enrolment is pending. */
  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  /** The time step of the last code accepted: none at or before it is accepted again. */
  @Column({ type: 'integer', nullable: true })
  lastStep!: number | null;

  /** The recovery codes not yet used, as SHA-256 hashes. */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  recoveryCodeHashes!: string[];

  /** Wrong codes since the last right one. */
  @Column({ type: 'integer', default: 0 })
  failedAttempts!: number;

  /** No code is checked before this, after too many wrong ones. */
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/** The default second factor. Extend `BaseSecondFactor` to add columns. */
@Entity({ name: 'mortar_second_factor' })
export class SecondFactor extends BaseSecondFactor {}
