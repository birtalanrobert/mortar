import { z } from '@birtalanrobert/config';

/**
 * The variables a deployment needs before it can send on WhatsApp.
 *
 * Shared rather than restated in each service, because more than one has to
 * read them and they have to agree: the worker builds the port from them, and
 * whatever surface a business configures its messages on has to know whether
 * the channel exists before offering it. Two copies of this drift, and the
 * symptom is a setting that silently does nothing.
 */
export const whatsAppEnvSchema = z.object({
  /**
   * The registered sender, in Twilio's own form (`whatsapp:+40…`).
   *
   * Absent means this deployment has no WhatsApp channel. Not an error: it is a
   * number registered with Meta and tied to a display name they approved, which
   * takes days rather than minutes to obtain.
   */
  TWILIO_WHATSAPP_FROM: z.string().optional(),

  /** A messaging service holding the sender, when one is used instead. */
  TWILIO_WHATSAPP_MESSAGING_SERVICE_SID: z.string().optional(),

  /**
   * The approved templates, as content SIDs by key and language.
   *
   * `{"booking.reminder24h":{"ro":"HX…","hu":"HX…"}}`. Two levels deep because
   * approval is per language: a business whose Romanian template is approved
   * and whose Hungarian one is still in review can send to half its customers,
   * and it should.
   *
   * What the outer key means is the product's business — an event name, a
   * document type — so it is not narrowed here.
   */
  WHATSAPP_TEMPLATES: whatsAppTemplates(),
});

export type WhatsAppEnv = z.infer<typeof whatsAppEnvSchema>;

/**
 * A JSON object read from one variable, parsed at boot.
 *
 * Parsed here rather than where it is used so a typo stops the process
 * starting. The alternative is a reminder that quietly went out on the other
 * channel, discovered by asking a customer whether they got it.
 */
function whatsAppTemplates() {
  return z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value.trim() || '{}') as unknown;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'expected a JSON object of content SIDs by key and language',
        });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.record(z.string(), z.string())))
    .default('{}');
}
