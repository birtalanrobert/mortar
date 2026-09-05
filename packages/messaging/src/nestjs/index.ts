/**
 * The parts that need a database and a container.
 *
 * Separate from the root entry point so that counting segments — which a
 * console does on every keystroke — does not drag TypeORM into a browser
 * bundle.
 */
export { MessageCreditEntry, type CreditReason } from './credits.entity';
export { MessageCreditsService, type CreditBalance } from './credits.service';
export { MessageTemplate, type TemplateChannel } from './template.entity';
export {
  MessageTemplatesService,
  type DefaultTemplate,
  type RenderedMessage,
  type ResolvedTemplate,
} from './templates.service';
export { CreateMessageCredits1788390000000 } from '../migrations/1788390000000-CreateMessageCredits';
export { CreateMessageTemplates1789300000000 } from '../migrations/1789300000000-CreateMessageTemplates';

import { MessageCreditEntry } from './credits.entity';
import { MessageTemplate } from './template.entity';
import { CreateMessageCredits1788390000000 } from '../migrations/1788390000000-CreateMessageCredits';
import { CreateMessageTemplates1789300000000 } from '../migrations/1789300000000-CreateMessageTemplates';

/** Register with the data source, the way every other mortar package is. */
export const messagingEntities = [MessageCreditEntry, MessageTemplate];
export const messagingMigrations = [
  CreateMessageCredits1788390000000,
  CreateMessageTemplates1789300000000,
];
