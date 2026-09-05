import { Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { InjectDataSource } from '@birtalanrobert/database';
import { runInTenantTransaction } from '@birtalanrobert/tenancy';
import { MessageTemplate, type TemplateChannel } from './template.entity';
import { renderTemplate, type RenderResult } from '../template';

/** The product's own words, used when a tenant has not written their own. */
export interface DefaultTemplate {
  readonly event: string;
  readonly channel: TemplateChannel;
  readonly locale: string;
  readonly heading?: string;
  readonly body: string;
}

export interface ResolvedTemplate {
  readonly event: string;
  readonly channel: TemplateChannel;
  readonly locale: string;
  readonly heading: string | null;
  readonly body: string;
  readonly enabled: boolean;
  /** Whether these are the tenant's words or the product's. */
  readonly custom: boolean;
}

export interface RenderedMessage {
  readonly heading: string | null;
  readonly body: string;
  readonly missing: readonly string[];
}

/**
 * Finding the right words, and letting a tenant change them.
 *
 * Resolution goes: **the tenant's version in this language, then the tenant's
 * version in the product's fallback language, then the product's default.** The
 * middle step is the one worth stating — a salon that rewrote its Romanian
 * confirmation and never touched the Hungarian one would otherwise have a
 * carefully worded message in one language and the stock text in the other,
 * which is worse than either being consistent.
 *
 * Every read runs inside the tenant's policy. `mortar_message_templates` is
 * under row-level security and an unbound read returns *nothing* — which here
 * means silently sending the product's default text to a business that had
 * written its own, and nobody finds out until a customer quotes it back.
 */
@Injectable()
export class MessageTemplatesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * What this tenant would send for this event, in this language.
   *
   * `defaults` is the product's own list. Passing it on every call rather than
   * configuring it once keeps this package ignorant of any product's events,
   * which is the property that lets eight of them share the table.
   */
  async resolve(
    tenantId: string,
    key: { event: string; channel: TemplateChannel; locale: string },
    defaults: readonly DefaultTemplate[],
    fallbackLocale?: string,
    manager?: EntityManager,
  ): Promise<ResolvedTemplate | null> {
    const work = async (scoped: EntityManager): Promise<ResolvedTemplate | null> => {
      const repository = scoped.getRepository(MessageTemplate);

      const own = await repository.findOne({
        where: { tenantId, event: key.event, channel: key.channel, locale: key.locale },
      });

      if (own) return view(own, true);

      /*
       * The tenant's words in another language, before the product's in this
       * one.
       *
       * A business that rewrote its Romanian confirmation and never touched the
       * Hungarian one is better served by its own words — which say what it
       * actually does about deposits and lateness — than by stock text that
       * happens to be in the right language and describes a different business.
       */
      if (fallbackLocale && fallbackLocale !== key.locale) {
        const fallback = await repository.findOne({
          where: { tenantId, event: key.event, channel: key.channel, locale: fallbackLocale },
        });

        if (fallback) return view(fallback, true);
      }

      const supplied =
        defaults.find(
          (entry) =>
            entry.event === key.event &&
            entry.channel === key.channel &&
            entry.locale === key.locale,
        ) ??
        (fallbackLocale
          ? defaults.find(
              (entry) =>
                entry.event === key.event &&
                entry.channel === key.channel &&
                entry.locale === fallbackLocale,
            )
          : undefined);

      if (!supplied) return null;

      return {
        event: supplied.event,
        channel: supplied.channel,
        locale: supplied.locale,
        heading: supplied.heading ?? null,
        body: supplied.body,
        enabled: true,
        custom: false,
      };
    };

    return manager ? work(manager) : runInTenantTransaction(this.dataSource, work, { tenantId });
  }

  /**
   * Resolves and fills in, in one step.
   *
   * Returns null when the tenant has turned the message off — which the caller
   * must treat as "do not send" rather than "send an empty one". Distinct from
   * a missing template, which resolves to the product's default.
   */
  async render(
    tenantId: string,
    key: { event: string; channel: TemplateChannel; locale: string },
    variables: Readonly<Record<string, string | number | null | undefined>>,
    defaults: readonly DefaultTemplate[],
    fallbackLocale?: string,
    manager?: EntityManager,
  ): Promise<RenderedMessage | null> {
    const template = await this.resolve(tenantId, key, defaults, fallbackLocale, manager);
    if (!template || !template.enabled) return null;

    const body: RenderResult = renderTemplate(template.body, variables);
    const heading = template.heading ? renderTemplate(template.heading, variables) : null;

    return {
      heading: heading?.text ?? null,
      body: body.text,
      missing: [...new Set([...body.missing, ...(heading?.missing ?? [])])],
    };
  }

  /** Everything this tenant has written, for an editor to list. */
  async list(tenantId: string, manager?: EntityManager): Promise<MessageTemplate[]> {
    const work = (scoped: EntityManager) =>
      scoped.getRepository(MessageTemplate).find({
        where: { tenantId },
        order: { event: 'ASC', channel: 'ASC', locale: 'ASC' },
      });

    return manager ? work(manager) : runInTenantTransaction(this.dataSource, work, { tenantId });
  }

  /**
   * Writes a tenant's own version, replacing whatever was there.
   *
   * An upsert rather than a create-or-update pair: two callers saving the same
   * template at once is an ordinary thing in a console with two tabs open, and
   * the unique index is what settles it.
   */
  async save(
    tenantId: string,
    input: {
      event: string;
      channel: TemplateChannel;
      locale: string;
      heading?: string | null;
      body: string;
      enabled?: boolean;
    },
    manager?: EntityManager,
  ): Promise<MessageTemplate> {
    const work = async (scoped: EntityManager): Promise<MessageTemplate> => {
      await scoped.query(
        `INSERT INTO "mortar_message_templates"
           ("tenant_id", "event", "channel", "locale", "heading", "body", "enabled")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ("tenant_id", "event", "channel", "locale")
         DO UPDATE SET "heading" = EXCLUDED."heading",
                       "body" = EXCLUDED."body",
                       "enabled" = EXCLUDED."enabled",
                       "updated_at" = now()`,
        [
          tenantId,
          input.event,
          input.channel,
          input.locale,
          input.heading ?? null,
          input.body,
          input.enabled ?? true,
        ],
      );

      return scoped.getRepository(MessageTemplate).findOneOrFail({
        where: {
          tenantId,
          event: input.event,
          channel: input.channel,
          locale: input.locale,
        },
      });
    };

    return manager ? work(manager) : runInTenantTransaction(this.dataSource, work, { tenantId });
  }

  /**
   * Puts a template back to the product's words.
   *
   * Deleting the row rather than copying the default into it: a stored copy
   * stops tracking the product's own improvements, and a business that "reset"
   * a template would keep whatever the wording happened to be that afternoon.
   */
  async reset(
    tenantId: string,
    key: { event: string; channel: TemplateChannel; locale: string },
    manager?: EntityManager,
  ): Promise<void> {
    const work = async (scoped: EntityManager): Promise<void> => {
      await scoped.getRepository(MessageTemplate).delete({
        tenantId,
        event: key.event,
        channel: key.channel,
        locale: key.locale,
      });
    };

    if (manager) await work(manager);
    else await runInTenantTransaction(this.dataSource, work, { tenantId });
  }
}

const view = (row: MessageTemplate, custom: boolean): ResolvedTemplate => ({
  event: row.event,
  channel: row.channel,
  locale: row.locale,
  heading: row.heading,
  body: row.body,
  enabled: row.enabled,
  custom,
});
