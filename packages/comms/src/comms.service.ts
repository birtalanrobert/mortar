import { resolveManager } from '@birtalanrobert/database';
import type { DataSource, EntityManager } from 'typeorm';
import { InboundAddress, type InboundAddressOptions } from './address';
import type { InboundMessage } from './inbound/message';
import { MessageLog } from './message-log.entity';
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
          channel: message.channel,
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
}
