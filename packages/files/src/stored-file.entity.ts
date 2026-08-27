import { Check, Column, Entity, Index, Unique } from 'typeorm';
import { BaseEntity, JSON_COLUMN, TIMESTAMP_COLUMN } from '@birtalanrobert/database';

/**
 * `bigint` arrives from `pg` as a string, because a Postgres bigint does not
 * fit a JavaScript number in general. A file size does — no file here is
 * anywhere near 2^53 bytes — so converting is safe, and leaving it as a string
 * means every arithmetic comparison silently becomes a lexicographic one.
 */
const bigintAsNumber = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * Where a file is in its journey from a client's phone to a professional's
 * folder.
 *
 * `pending` exists because a direct upload is two steps with a gap in between:
 * the row is written when the URL is signed, and the bytes arrive afterwards
 * without touching the API. A row that never leaves `pending` is an upload that
 * was started and abandoned, which is a normal thing for a client on a train to
 * do and something the retention sweep must be able to recognise.
 *
 * `infected` is kept rather than deleted. A professional asking "what happened
 * to the file I was told about" deserves an answer, and a firm with a client
 * sending malware has a problem worth being able to see.
 */
export type StoredFileState = 'pending' | 'scanning' | 'ready' | 'infected' | 'rejected';

@Entity({ name: 'mortar_stored_file' })
@Index('ix_mortar_stored_file_scope', ['tenantId', 'scope'])
@Index('ix_mortar_stored_file_state', ['state', 'createdAt'])
@Unique('uq_mortar_stored_file_key', ['objectKey'])
@Check(
  'ck_mortar_stored_file_state',
  `"state" IN ('pending', 'scanning', 'ready', 'infected', 'rejected')`,
)
export class StoredFile extends BaseEntity {
  @Column({ type: 'uuid' })
  tenantId!: string;

  /** What this belongs to, as `type/id`. Mirrors the key's middle segment. */
  @Column({ type: 'varchar', length: 128 })
  scope!: string;

  /**
   * The full object key.
   *
   * Stored rather than recomputed, because a key is a location and locations
   * outlive the rules that produced them: change the scheme in a year and every
   * old object still has to be findable.
   */
  @Column({ type: 'varchar', length: 512 })
  objectKey!: string;

  /** What the person called it. Shown back to them; never used as a key. */
  @Column({ type: 'varchar', length: 255 })
  filename!: string;

  /**
   * Detected from the bytes, never taken from the upload's header.
   *
   * Null while the file is `pending`, because nothing has been read yet.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  contentType!: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintAsNumber })
  size!: number | null;

  /** SHA-256 of the plaintext, for recognising the same document twice. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  checksum!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  state!: StoredFileState;

  /** Why it was refused, in words a professional can pass on to their client. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /**
   * Whether the stored bytes are encrypted with the tenant's data key.
   *
   * A column rather than an assumption, so that files written before a tenant
   * had a key remain readable and a migration can be gradual.
   */
  @Column({ type: 'boolean', default: false })
  encrypted!: boolean;

  /** Which master key wrapped the data key, so rotation can find its work. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  keyId!: string | null;

  /** Anything the owning service wants to keep beside the file. */
  @Column({ ...JSON_COLUMN, default: () => `'{}'::jsonb` })
  metadata!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 128, nullable: true })
  uploadedBy!: string | null;

  @Column({ ...TIMESTAMP_COLUMN, nullable: true })
  scannedAt!: Date | null;

  /**
   * When this becomes eligible for deletion.
   *
   * Written by whoever owns the file rather than computed here: retention is a
   * policy of the thing the file belongs to — a request, an application, a
   * claim — and this package has no business having an opinion about it.
   */
  @Column({ ...TIMESTAMP_COLUMN, nullable: true })
  retainUntil!: Date | null;

  @Column({ ...TIMESTAMP_COLUMN, nullable: true })
  deletedAt!: Date | null;
}
