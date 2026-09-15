import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A short public link, with its claims in the row instead of in the token.
 *
 * **This table carries no row-level security policy, and that is the whole
 * point of it.** A handle arrives from a stranger with a URL and nothing else —
 * no session, no tenant, nothing to bind a policy to — so the lookup that turns
 * it into a tenant cannot itself require one. It is the same reason a tenant
 * registry has none, and the same trap: a policy here would make every public
 * link return "not found", successfully, for ever.
 *
 * What keeps that safe is that the row holds no secrets. It says which tenant
 * and which subject a handle refers to, and the caller binds that tenant and
 * reads the subject under its policy as usual. Nothing about the order, the
 * customer or the money is reachable from here.
 */
@Entity({ name: 'mortar_public_link' })
@Index('idx_public_link_subject', ['tenantId', 'subject'])
@Index('idx_public_link_expires', ['expiresAt'])
export class PublicLink {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The unguessable part of the URL, as 22 base64url characters.
   *
   * Unique across every tenant, because that is how it is looked up — there is
   * no tenant to scope it by until it has been.
   */
  @Column({ type: 'varchar', length: 22, unique: true })
  handle!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * What the link is about, as `type:id`.
   *
   * The type prefix is not decoration: it stops a handle minted for one kind of
   * entity being accepted by a handler expecting another.
   */
  @Column({ type: 'varchar', length: 160 })
  subject!: string;

  /**
   * Who this particular link is for, where a subject has several participants.
   *
   * A mortgage application needs documents from two spouses; each gets their
   * own link and sees only their own items. Without this, one party's link
   * opens the other party's documents.
   */
  @Column({ type: 'varchar', length: 160, nullable: true })
  party!: string | null;

  /**
   * When it stops working, or null for "as long as the subject exists".
   *
   * Null is a real answer rather than a missing one. A customer's order status
   * link is printed on their receipt and should work while the order does;
   * inventing a lifetime for it would break a link somebody still has in their
   * pocket, and the honest lever for cutting it off is revocation.
   */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  /** Set rather than deleted, so a link that stopped working can be explained. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  /**
   * Free string, not a foreign key: a revocation is frequently the work of the
   * system rather than a user — a re-issue supersedes the previous link.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  revokedBy!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
