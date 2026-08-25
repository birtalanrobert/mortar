export { AuditLogEntry } from './entity';
export { REDACTED, computeChanges, redactMetadata, type Changes, type DiffOptions } from './diff';
export { AuditService, type AuditQuery, type RecordOptions } from './service';
export { AuditModule } from './nest';
export { CreateAuditLog1700000000001 } from './migrations/1700000000001-CreateAuditLog';

import { CreateAuditLog1700000000001 } from './migrations/1700000000001-CreateAuditLog';
/** Register alongside the project's own migrations. */
export const auditMigrations = [CreateAuditLog1700000000001];
