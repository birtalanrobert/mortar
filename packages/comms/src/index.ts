import { MessageLog } from './message-log.entity';
import { CreateMessageLog1787813849846 } from './migrations/1787813849846-CreateMessageLog';

export { InboundAddress, type InboundAddressOptions, type ParsedAddress } from './address';

export { CommsService, type CommsServiceOptions, type ReceivedResult } from './comms.service';

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

export { ResendInbound, type ResendInboundOptions, type VerifiedEvent } from './inbound/resend';

export { MessageLog, type MessageDirection, type MessageState } from './message-log.entity';
export { CreateMessageLog1787813849846 };

/** Everything the consuming service must register with TypeORM. */
export const commsEntities = [MessageLog];
export const commsMigrations = [CreateMessageLog1787813849846];
