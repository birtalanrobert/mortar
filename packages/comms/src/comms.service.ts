import { resolveManager } from '@birtalanrobert/database';
import type { DataSource, EntityManager } from 'typeorm';
import { InboundAddress, type InboundAddressOptions } from './address';
import type { InboundMessage } from './inbound/message';
import { MessageLog } from './message-log.entity';
import { PushSubscription } from './push-subscription.entity';
import { Suppression } from './suppression.entity';
import { REFUSALS_BEFORE_SUPPRESSING, suppressionExpiry } from './suppression';
import {
  MAX_ATTACHMENT_BYTES,
  type Channel,
  type MessagePort,
  type OutboundMessage,
} from './outbound/port';

export interface CommsServiceOptions {
  /** One per channel. A channel with no port cannot be sent on. */
  ports?: Partial<Record<Channel, MessagePort>>;
  /** Absent means this deployment does not accept inbound mail. */
  inbound?: InboundAddressOptions;
}

export interface ReceivedResult {
  /** What the message is about, if it could be routed. */
  subject?: string;
  /** True when this provider id has been handled before. */
  duplicate: boolean;
  log: MessageLog;
}

/**
 * Sending, receiving, and the record of both.
 *
 * Thin on purpose. Templates, locale and tone, quiet hours and the credit
 * ledger are Phase 5, and writing them now would be guessing at requirements
 * three projects away. What exists here is what the seam needs: somewhere to
 * hand a message, somewhere to route one that arrives, and a log that makes
 * both answerable afterwards.
 */
export class CommsService {
  private readonly ports: Partial<Record<Channel, MessagePort>>;
  readonly addresses?: InboundAddress;

  constructor(
    private readonly dataSource: DataSource,
    options: CommsServiceOptions = {},
  ) {
    this.ports = options.ports ?? {};
    this.addresses = options.inbound ? new InboundAddress(options.inbound) : undefined;
  }

  private manager(manager?: EntityManager): EntityManager {
    return manager ?? resolveManager(this.dataSource);
  }

  /** The address a client can forward documents to for one subject. */
  inboundAddressFor(subject: string): string | undefined {
    return this.addresses?.mint(subject);
  }

  /**
   * Whether anything is configured that could carry this channel.
   *
   * For callers that hold a **choice** — somebody with both a mobile number and
   * an email address — rather than an obligation. Without this, a deployment
   * with no text provider records a failure for every such person, when an
   * email would have reached them; asking first turns that into a delivery.
   *
   * It is deliberately not a promise of delivery, and not a substitute for
   * `send`'s honesty. A caller with only one address still sends on it and
   * still gets the failure recorded, because "we tried and there was no way to
   * reach them" is a fact a business needs. This answers the narrower question
   * of which of two real options to take.
   */
  serves(channel: Channel): boolean {
    return this.ports[channel] !== undefined;
  }

  /**
   * A browser saying it will accept notifications.
   *
   * **Idempotent on the endpoint**, because the browser mints exactly one and a
   * PWA that reloads offers it again. A second row would send that person
   * everything twice, which is the fastest way to have push permission revoked.
   *
   * The subject is the product's own reference — an employee, a customer, a rep
   * — and moving an endpoint to a different subject is a real case: a shared
   * tablet somebody else signs into.
   */
  async subscribeToPush(
    input: {
      subject: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      tenantId?: string;
      label?: string;
    },
    manager?: EntityManager,
  ): Promise<PushSubscription> {
    const repository = this.manager(manager).getRepository(PushSubscription);

    await repository.upsert(
      {
        subject: input.subject,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        tenantId: input.tenantId ?? null,
        label: input.label ?? null,
      },
      ['endpoint'],
    );

    return repository.findOneOrFail({ where: { endpoint: input.endpoint } });
  }

  /**
   * Forgetting a browser.
   *
   * Called when somebody turns notifications off, and called by the port when a
   * push service answers 410 — **the same operation for both**, because "they
   * asked us to stop" and "the browser has gone" leave the same row behind and
   * a product that only handled the first would accumulate the second for ever.
   */
  async unsubscribeFromPush(endpoint: string, manager?: EntityManager): Promise<void> {
    await this.manager(manager).getRepository(PushSubscription).delete({ endpoint });
  }

  /** Every browser this subject has agreed to be written to on. */
  async pushSubscriptionsFor(
    subject: string,
    manager?: EntityManager,
  ): Promise<PushSubscription[]> {
    return this.manager(manager)
      .getRepository(PushSubscription)
      .find({ where: { subject }, order: { createdAt: 'ASC' } });
  }

  /**
   * The keys that encrypt to an endpoint.
   *
   * Handed to `WebPushMessagePort` so the transport never learns who is
   * subscribed — it knows an address and the two keys for it, which is all a
   * transport should know.
   */
  async pushKeysFor(
    endpoint: string,
    manager?: EntityManager,
  ): Promise<{ p256dh: string; auth: string } | null> {
    const found = await this.manager(manager)
      .getRepository(PushSubscription)
      .findOne({ where: { endpoint } });

    return found ? { p256dh: found.p256dh, auth: found.auth } : null;
  }

  /**
   * Sends, and records the attempt either way.
   *
   * The log entry is written after the provider answers rather than before,
   * because what is worth recording is what happened. A row saying `accepted`
   * for a message the provider rejected is worse than no row: it is an answer
   * to "did they get it?" that happens to be wrong.
   */
  async send(
    message: OutboundMessage,
    context: { tenantId?: string; subject?: string } = {},
    manager?: EntityManager,
  ): Promise<MessageLog> {
    const repository = this.manager(manager).getRepository(MessageLog);
    const port = this.ports[message.channel];

    /**
     * Refused here rather than at the provider.
     *
     * An attachment over the limit is bounced by the receiving server, often
     * silently and always later — which turns into "the firm never got it and
     * nobody knows why". Failing now records a sentence the sender can act on.
     */
    const attached = (message.attachments ?? []).reduce(
      (total, file) => total + file.content.length,
      0,
    );

    if (attached > MAX_ATTACHMENT_BYTES) {
      return repository.save(
        repository.create({
          tenantId: context.tenantId ?? null,
          direction: 'outbound',
          channel: message.channel,
          subject: context.subject ?? null,
          address: message.to,
          heading: message.subject ?? null,
          state: 'failed',
          detail:
            `Attachments total ${Math.round(attached / 1024 / 1024)} MB, ` +
            `over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`,
          settledAt: new Date(),
        }),
      );
    }

    /*
     * An address that has said no, before the provider is troubled.
     *
     * Checked here rather than by each caller, because "did this number refuse
     * last week?" is not a question a reminder scheduler should have to
     * remember to ask — and forgetting it costs money on every send and, at
     * scale, a sender identity.
     */
    if (context.tenantId) {
      /*
       * The channel asked for, and the one the port may divert to.
       *
       * A port that falls back — WhatsApp to SMS — would otherwise write to
       * somebody who replied STOP to a text, because their refusal is recorded
       * against `sms` and the message was addressed to `whatsapp`. Both are
       * checked, and either one stops it: we cannot promise which channel will
       * carry it, so we must honour the answer on both.
       */
      const stopped =
        (await this.suppressionFor(context.tenantId, message.channel, message.to, manager)) ??
        (port?.fallbackChannel
          ? await this.suppressionFor(context.tenantId, port.fallbackChannel, message.to, manager)
          : null);

      if (stopped) {
        return repository.save(
          repository.create({
            tenantId: context.tenantId,
            direction: 'outbound',
            channel: message.channel,
            subject: context.subject ?? null,
            address: message.to,
            heading: message.subject ?? null,
            /*
             * `discarded`, not `failed`.
             *
             * Nothing went wrong and nobody should be alerted: we chose not to
             * write to somebody who asked us not to, or to a number that has
             * refused repeatedly. A failure rate that counted these would
             * measure the product obeying its own rules.
             */
            state: 'discarded',
            detail:
              stopped.reason === 'unsubscribed'
                ? 'They asked not to be contacted.'
                : `That address has refused ${stopped.failures} times. ${stopped.detail ?? ''}`.trim(),
            settledAt: new Date(),
          }),
        );
      }
    }

    if (!port) {
      return repository.save(
        repository.create({
          tenantId: context.tenantId ?? null,
          direction: 'outbound',
          channel: message.channel,
          subject: context.subject ?? null,
          address: message.to,
          heading: message.subject ?? null,
          state: 'failed',
          detail: `No ${message.channel} provider is configured.`,
          settledAt: new Date(),
        }),
      );
    }

    try {
      const result = await port.send(message);

      return await repository.save(
        repository.create({
          tenantId: context.tenantId ?? null,
          direction: 'outbound',
          // What carried it, which is not always what was asked for: a port may
          // divert, and the log is the answer to "how did this reach them?".
          channel: result.channel ?? message.channel,
          subject: context.subject ?? null,
          providerMessageId: result.providerMessageId ?? null,
          address: message.to,
          heading: message.subject ?? null,
          // `accepted`, not `delivered`. The provider has taken it; whether it
          // reached a person is a later webhook's news.
          state: 'accepted',
          segments: result.segments ?? null,
          // What was attached, not what it contained: the log is read by
          // support, and a client's filenames are not theirs to read.
          metadata: message.attachments?.length
            ? { attachments: message.attachments.length, attachedBytes: attached }
            : {},
        }),
      );
    } catch (error) {
      return repository.save(
        repository.create({
          tenantId: context.tenantId ?? null,
          direction: 'outbound',
          channel: message.channel,
          subject: context.subject ?? null,
          address: message.to,
          heading: message.subject ?? null,
          state: 'failed',
          detail: error instanceof Error ? error.message : String(error),
          settledAt: new Date(),
        }),
      );
    }
  }

  /**
   * Routes an inbound message and records that it arrived.
   *
   * Returns `duplicate` rather than throwing when the provider redelivers,
   * because redelivery is how at-least-once works and the caller's correct
   * response is to do nothing quietly.
   *
   * A message that cannot be routed is still logged — as `discarded`, with the
   * address it was sent to. Someone will eventually ask why a forwarded
   * document never appeared, and "it went to an address nobody issued" is an
   * answer only a log can give.
   */
  async receive(message: InboundMessage, manager?: EntityManager): Promise<ReceivedResult> {
    const repository = this.manager(manager).getRepository(MessageLog);
    const providerMessageId = message.providerMessageId ?? message.messageId ?? null;

    if (providerMessageId) {
      const seen = await repository.findOne({
        where: { direction: 'inbound', providerMessageId },
      });
      if (seen) {
        return { subject: seen.subject ?? undefined, duplicate: true, log: seen };
      }
    }

    const routed = this.addresses?.find([...message.to, ...message.cc]);

    const log = await repository.save(
      repository.create({
        direction: 'inbound',
        channel: 'email',
        subject: routed?.subject ?? null,
        providerMessageId,
        address: message.from,
        heading: message.subject || null,
        state: routed ? 'received' : 'discarded',
        detail: routed ? null : 'No recognised recipient address.',
        // The body is never stored. A reminder is innocuous; inbound mail here
        // is bank statements, and a log table is the last place they should be
        // when someone asks for an erasure.
        metadata: {
          attachments: message.attachments.filter((file) => !file.inline).length,
          authentication: message.authentication ?? {},
        },
        settledAt: new Date(),
      }),
    );

    return { subject: routed?.subject, duplicate: false, log };
  }

  /**
   * Records what a provider later said about a message it accepted.
   *
   * Matched on the provider's id, which is the only identifier both sides
   * share. A receipt for something we have no record of is ignored rather than
   * inserted: it belongs to another environment sharing the provider account,
   * and inventing a row for it would put another system's messages in this
   * one's log.
   */
  async settle(
    providerMessageId: string,
    state: 'delivered' | 'bounced' | 'failed',
    detail?: string,
    manager?: EntityManager,
  ): Promise<MessageLog | undefined> {
    const repository = this.manager(manager).getRepository(MessageLog);

    const log = await repository.findOne({ where: { direction: 'outbound', providerMessageId } });
    if (!log) return undefined;

    await repository.update(
      { id: log.id },
      { state, detail: detail ?? null, settledAt: new Date() },
    );

    return repository.findOneOrFail({ where: { id: log.id } });
  }

  /** Everything sent or received about one subject, newest first. */
  async history(tenantId: string, subject: string, manager?: EntityManager): Promise<MessageLog[]> {
    return this.manager(manager)
      .getRepository(MessageLog)
      .find({ where: { tenantId, subject }, order: { createdAt: 'DESC' } });
  }

  // ── Addresses that have said no ──────────────────────────────────────────

  /**
   * The live suppression for an address, if there is one.
   *
   * An expired refusal is not one: people change telephones, and holding a
   * number for ever over one bad fortnight loses a customer nobody meant to
   * lose.
   */
  async suppressionFor(
    tenantId: string,
    channel: Channel,
    address: string,
    manager?: EntityManager,
  ): Promise<Suppression | null> {
    const found = await this.manager(manager)
      .getRepository(Suppression)
      .findOne({ where: { tenantId, channel, address } });

    if (!found) return null;
    if (found.expiresAt && found.expiresAt.getTime() <= Date.now()) return null;

    return found;
  }

  /**
   * Records that an address refused, and stops writing to it once it is clear.
   *
   * Counted rather than acted on immediately: one failure is a telephone
   * switched off, and suppressing on the first would silence a customer who was
   * on an aeroplane. The threshold and the hold are in `suppression.ts`.
   */
  async recordRefusal(
    tenantId: string,
    channel: Channel,
    address: string,
    detail?: string,
    manager?: EntityManager,
  ): Promise<Suppression> {
    const repository = this.manager(manager).getRepository(Suppression);
    const existing = await repository.findOne({ where: { tenantId, channel, address } });

    if (!existing) {
      return repository.save(
        repository.create({
          tenantId,
          channel,
          address,
          reason: 'refused',
          detail: detail ?? null,
          failures: 1,
          // Nothing is suppressed on the first refusal, so the hold starts only
          // once the count says the address is genuinely gone.
          expiresAt: new Date(0),
        }),
      );
    }

    /*
     * An unsubscribe is never downgraded to a refusal.
     *
     * They arrive in either order — a person replies STOP and their number is
     * later disconnected — and a refusal's ninety-day expiry would quietly
     * resume writing to somebody who asked us to stop.
     */
    if (existing.reason === 'unsubscribed') return existing;

    const failures = existing.failures + 1;

    await repository.update(
      { id: existing.id, tenantId },
      {
        failures,
        detail: detail ?? existing.detail,
        expiresAt:
          failures >= REFUSALS_BEFORE_SUPPRESSING ? suppressionExpiry('refused') : new Date(0),
      },
    );

    return (await repository.findOneOrFail({
      where: { id: existing.id, tenantId },
    })) as Suppression;
  }

  /**
   * Records that a person asked not to be contacted.
   *
   * Immediate, permanent, and it overrides whatever was there — the opposite of
   * a refusal in every respect, because it is a decision rather than a fact
   * about a network.
   */
  async unsubscribe(
    tenantId: string,
    channel: Channel,
    address: string,
    detail?: string,
    manager?: EntityManager,
  ): Promise<Suppression> {
    const repository = this.manager(manager).getRepository(Suppression);
    const existing = await repository.findOne({ where: { tenantId, channel, address } });

    if (existing) {
      await repository.update(
        { id: existing.id, tenantId },
        { reason: 'unsubscribed', detail: detail ?? existing.detail, expiresAt: null },
      );

      return repository.findOneOrFail({ where: { id: existing.id, tenantId } });
    }

    return repository.save(
      repository.create({
        tenantId,
        channel,
        address,
        reason: 'unsubscribed',
        detail: detail ?? null,
        failures: 0,
        expiresAt: null,
      }),
    );
  }

  /** Lets an address be written to again, at the business's request. */
  async allowAgain(
    tenantId: string,
    channel: Channel,
    address: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.manager(manager).getRepository(Suppression).delete({ tenantId, channel, address });
  }
}
