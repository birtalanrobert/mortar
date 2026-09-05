import { Column, Entity, Unique } from 'typeorm';
import { BaseEntity, MONEY_AMOUNT_COLUMN } from '@birtalanrobert/database';
import type { Interval, Tier } from '../plans';

/**
 * What we sell, as rows rather than as a constant in a deployment.
 *
 * A constant would be simpler and is wrong for one reason: a plan is referenced
 * by every subscription ever sold on it, and a business that bought "Salon, 149
 * lei, five staff included" in March keeps those terms when the price list
 * changes in April. Editing a constant rewrites history for everybody on it.
 *
 * **Deliberately not tenant-scoped.** This is our price list, the same for
 * everybody, and a per-tenant plan is how a company ends up with four hundred
 * bespoke contracts it cannot change.
 */
@Entity('mortar_plans')
@Unique('uq_plans_code', ['code'])
export class BillingPlan extends BaseEntity {
  /** Stable across price changes, because it is what a subscription stores. */
  @Column('varchar', { length: 64 })
  code!: string;

  @Column('varchar', { length: 120 })
  name!: string;

  @Column('varchar', { length: 8, default: 'month' })
  interval!: Interval;

  @Column('varchar', { length: 3 })
  currency!: string;

  @Column(MONEY_AMOUNT_COLUMN)
  basePrice!: string;

  @Column('integer', { default: 0 })
  includedQuantity!: number;

  /** Graduated bands past the allowance. Empty is a flat plan. */
  @Column('jsonb', { default: () => "'[]'::jsonb" })
  tiers!: Tier[];

  /** Ceilings by name. `null` inside it is unlimited, which is a real answer. */
  @Column('jsonb', { default: () => "'{}'::jsonb" })
  limits!: Record<string, number | null>;

  /** What this plan switches on. Absence is the gate; there is no deny list. */
  @Column('jsonb', { default: () => "'[]'::jsonb" })
  features!: string[];

  @Column('integer', { default: 0 })
  trialDays!: number;

  /**
   * The provider's own price identifier.
   *
   * Nullable because a deployment with no billing provider still has a price
   * list — the plans gate features whether or not anybody can be charged.
   */
  @Column('varchar', { length: 128, nullable: true })
  externalPriceId!: string | null;

  /** Off the shelf, without taking it from anybody already on it. */
  @Column('boolean', { default: true })
  sellable!: boolean;

  @Column('integer', { default: 100 })
  sortOrder!: number;
}
