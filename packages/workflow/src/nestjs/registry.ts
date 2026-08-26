import { LinkRevocation } from '../links/revocation.entity';
import { CreateLinkRevocation1787754027798 } from '../migrations/1787754027798-CreateLinkRevocation';

/** Register alongside the project's own entities. */
export const workflowEntities = [LinkRevocation];

/** Register alongside the project's own migrations. */
export const workflowMigrations = [CreateLinkRevocation1787754027798];
