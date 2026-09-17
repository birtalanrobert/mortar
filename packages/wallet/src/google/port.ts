/**
 * Google's half, behind an interface.
 *
 * Much simpler than Apple's, and the asymmetry is Google's rather than ours:
 * there is no device registration, no push and no fetch. An update is a write
 * to the object, and the phone finds out on its own.
 *
 * Which means the *hard* thing on this side is not the protocol but knowing
 * whether a write landed — so the port returns an outcome per call and the
 * recording fake can be made to refuse, exactly as APNs' can.
 */

export interface GoogleWriteResult {
  /** The identifier written, `{issuerId}.{suffix}`. */
  id: string;
  status: number;
  /** Google's own message when it refused. */
  reason?: string;
  /** Whether the row was created rather than updated. */
  created: boolean;
}

export interface GoogleWalletPort {
  /** The programme. Written once per programme and again when its terms change. */
  upsertClass(loyaltyClass: Record<string, unknown>): Promise<GoogleWriteResult>;

  /** One holder's card. Written on every change. */
  upsertObject(loyaltyObject: Record<string, unknown>): Promise<GoogleWriteResult>;
}

/**
 * Records what would have been written, and accepts all of it.
 *
 * The counterpart of `RecordingApns`, and used the same way: a local run and
 * every test can prove the *payload* without a Google Cloud project.
 */
export class RecordingGoogleWallet implements GoogleWalletPort {
  readonly classes: Record<string, unknown>[] = [];
  readonly objects: Record<string, unknown>[] = [];

  private readonly answers = new Map<string, { status: number; reason: string }>();
  private readonly known = new Set<string>();

  upsertClass(loyaltyClass: Record<string, unknown>): Promise<GoogleWriteResult> {
    this.classes.push(loyaltyClass);
    return Promise.resolve(this.answer(loyaltyClass));
  }

  upsertObject(loyaltyObject: Record<string, unknown>): Promise<GoogleWriteResult> {
    this.objects.push(loyaltyObject);
    return Promise.resolve(this.answer(loyaltyObject));
  }

  /** The most recent write for an identifier, which is what a test asserts on. */
  latestObject(id: string): Record<string, unknown> | undefined {
    return [...this.objects].reverse().find((one) => one.id === id);
  }

  refuse(id: string, status: number, reason: string): void {
    this.answers.set(id, { status, reason });
  }

  clear(): void {
    this.classes.length = 0;
    this.objects.length = 0;
    this.answers.clear();
    this.known.clear();
  }

  private answer(payload: Record<string, unknown>): GoogleWriteResult {
    const id = String(payload.id ?? '');
    const refusal = this.answers.get(id);

    if (refusal) return { id, status: refusal.status, reason: refusal.reason, created: false };

    const created = !this.known.has(id);
    this.known.add(id);

    return { id, status: 200, created };
  }
}
