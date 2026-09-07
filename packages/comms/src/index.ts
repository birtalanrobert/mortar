import { MessageLog } from './message-log.entity';
import { CreateMessageLog1787813849846 } from './migrations/1787813849846-CreateMessageLog';
import { Suppression } from './suppression.entity';
import { CreateSuppressions1790400000000 } from './migrations/1790400000000-CreateSuppressions';
import { AllowWhatsApp1791400000000 } from './migrations/1791400000000-AllowWhatsApp';

export { InboundAddress, type InboundAddressOptions, type ParsedAddress } from './address';

export { CommsService, type CommsServiceOptions, type ReceivedResult } from './comms.service';

export { whatsAppEnvSchema, type WhatsAppEnv } from './config';

export { parseMime } from './inbound/mime';
export type { InboundAttachment, InboundMessage, InboundParser } from './inbound/message';

export {
  MAX_ATTACHMENT_BYTES,
  NoopMessagePort,
  type Channel,
  type MessagePort,
  type OutboundAttachment,
  type OutboundMessage,
  type SendResult,
} from './outbound/port';

export { ResendMessagePort, type ResendMessagePortOptions } from './outbound/resend';
export { SmtpMessagePort, type SmtpMessagePortOptions } from './outbound/smtp';
export { TwilioMessagePort, type TwilioMessagePortOptions } from './outbound/twilio';
export {
  NOT_ON_WHATSAPP,
  OUTSIDE_WINDOW,
  WhatsAppMessagePort,
  WhatsAppRefused,
  type WhatsAppMessagePortOptions,
} from './outbound/whatsapp';
export { FallbackMessagePort } from './outbound/fallback';

export { ResendInbound, type ResendInboundOptions, type VerifiedEvent } from './inbound/resend';

export { TwilioReceipts, type TwilioReceipt, type TwilioStatusCallback } from './receipts/twilio';

export { MessageLog, type MessageDirection, type MessageState } from './message-log.entity';
export { Suppression, type SuppressionReason } from './suppression.entity';
export {
  isStopRequest,
  suppressionExpiry,
  REFUSALS_BEFORE_SUPPRESSING,
  REFUSAL_HOLDS_FOR_DAYS,
} from './suppression';
export {
  CreateMessageLog1787813849846,
  CreateSuppressions1790400000000,
  AllowWhatsApp1791400000000,
};

/** Everything the consuming service must register with TypeORM. */
export const commsEntities = [MessageLog, Suppression];
export const commsMigrations = [
  CreateMessageLog1787813849846,
  CreateSuppressions1790400000000,
  AllowWhatsApp1791400000000,
];
