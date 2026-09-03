import { Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { InjectDataSource } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import { MessageCreditEntry, type CreditReason } from './credits.entity';

export interface CreditBalance {
  /** Segments remaining. Can go negative if a send was allowed on credit. */
  readonly balance: number;
  readonly entries: readonly MessageCreditEntry[];
}

/**
 * A tenant's message credit, as a ledger.
 *
 * Every method here takes a tenant and runs inside its policy, including the
 * reads: `mortar_message_credits` is under row-level security, and an unbound
 * read returns *nothing* rather than failing — a balance of zero for a tenant
 * with credit, which reads as a billing bug and is really a missing binding.
 */
@Injectable()
export class MessageCreditsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** The balance, and enough recent movement to explain it. */
  async balance(tenantId: string, take = 50): Promise<CreditBalance> {
    return runInTenantTransaction(
      this.dataSource,
      async (manager) => ({
        balance: await this.sum(manager),
        entries: await manager.getRepository(MessageCreditEntry).find({
          where: { tenantId },
          order: { createdAt: 'DESC' },
          take,
        }),
      }),
      { tenantId },
    );
  }

  /**
   * Adds credit, or corrects it.
   *
   * An entry rather than an update: buying a thousand segments and an operator
   * writing off a hundred are two facts, and a balance that only remembers the
   * current number can explain neither.
   */
  async add(
    tenantId: string,
    segments: number,
    reason: Extract<CreditReason, 'purchase' | 'adjustment' | 'refund'>,
    note?: string,
    manager?: EntityManager,
  ): Promise<number> {
    return this.write(tenantId, { segments, reason, note: note ?? null, subjectId: null }, manager);
  }

  /**
   * Debits what a message actually cost.
   *
   * Negative, and in segments rather than messages — `countSegments` is what
   * decides how many, because a provider charges for segments and one
   * diacritic more than doubles them.
   */
  async debit(
    tenantId: string,
    segments: number,
    subjectId: string | null,
    note?: string,
    manager?: EntityManager,
  ): Promise<number> {
    return this.write(
      tenantId,
      {
        // Written negative here rather than trusting the caller's sign: a
        // debit passed in positive would silently top the tenant up.
        segments: -Math.abs(segments),
        reason: 'message',
        subjectId,
        note: note ?? null,
      },
      manager,
    );
  }

  /**
   * Whether there is enough to send.
   *
   * A question rather than an enforcement: what to do when there is not — hold,
   * refuse, send anyway and invoice — is the owning product's decision, and
   * this package should not be making it on their behalf.
   */
  async canAfford(tenantId: string, segments: number): Promise<boolean> {
    const { balance } = await this.balance(tenantId, 0);
    return balance >= segments;
  }

  private async write(
    tenantId: string,
    entry: {
      segments: number;
      reason: CreditReason;
      subjectId: string | null;
      note: string | null;
    },
    manager?: EntityManager,
  ): Promise<number> {
    const work = async (scoped: EntityManager) => {
      const repository = scoped.getRepository(MessageCreditEntry);
      await repository.save(repository.create({ tenantId, ...entry }));
      return this.sum(scoped);
    };

    // A caller already inside a tenant transaction passes its manager, so the
    // debit commits or rolls back with whatever it is paying for.
    return manager ? work(manager) : runInTenantTransaction(this.dataSource, work, { tenantId });
  }

  private async sum(manager: EntityManager): Promise<number> {
    const [total] = await manager.query<Array<{ balance: string | null }>>(
      `SELECT sum("segments") AS balance FROM "mortar_message_credits"`,
    );
    return Number(total?.balance ?? 0);
  }
}
