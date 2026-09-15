import { LinkRevocation } from '../links/revocation.entity';
import { PublicLink } from '../links/public-link.entity';
import { CreateLinkRevocation1787754027798 } from '../migrations/1787754027798-CreateLinkRevocation';
import { CreatePublicLink1790600000000 } from '../migrations/1790600000000-CreatePublicLink';

/** Register alongside the project's own entities. */
export const workflowEntities = [LinkRevocation, PublicLink];

/** Register alongside the project's own migrations. */
export const workflowMigrations = [
  CreateLinkRevocation1787754027798,
  CreatePublicLink1790600000000,
];
