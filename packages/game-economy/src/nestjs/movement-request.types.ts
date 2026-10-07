/** A credit or a spend, as a game asks for it. */
export interface MovementRequest {
  readonly currency: string;
  /** Whole units, always positive: the call says which way. */
  readonly amount: number;
  /** Why, in the game's words: `quest.chapter`, `hurry.build`, `stripe.checkout`. */
  readonly reason: string;
  /** What it is about, in the game's words: a payment's id, `world:<id>:chapter:3`. */
  readonly reference?: string;
  /**
   * The same key twice is the same entry: the second call answers with the
   * first's. Unique per holder, across every kind — a webhook delivered twice,
   * a request retried, a chapter's bonus asked for again.
   */
  readonly idempotencyKey: string;
  readonly metadata?: Record<string, unknown>;
  readonly occurredAt?: Date;
}

/** A purchase refunded, whole, as a game asks for it. */
export interface RefundRequest {
  /** The purchase's entry. */
  readonly purchaseId: string;
  readonly reason: string;
  readonly reference?: string;
  readonly idempotencyKey: string;
  readonly metadata?: Record<string, unknown>;
  readonly occurredAt?: Date;
}
