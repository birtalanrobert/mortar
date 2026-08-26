export { AuditLogEntry } from './entity';
export { REDACTED, computeChanges, redactMetadata, type Changes, type DiffOptions } from './diff';
export { AuditService, type AuditQuery, type RecordOptions } from './service';
export { AuditModule } from './nest';
export { CreateAuditLog1787656929609 } from './migrations/1787656929609-CreateAuditLog';

import { AuditLogEntry } from './entity';
import { CreateAuditLog1787656929609 } from './migrations/1787656929609-CreateAuditLog';

/** Register alongside the project's own entities. */
export const auditEntities = [AuditLogEntry];

/** Register alongside the project's own migrations. */
export const auditMigrations = [CreateAuditLog1787656929609];
