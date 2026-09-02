export { WorkflowModule, type WorkflowModuleOptions } from './workflow.module';
export { LinkService, type IssueOptions, type LinkServiceOptions } from '../links/link.service';
export { LinkRevocation } from '../links/revocation.entity';
export { workflowEntities, workflowMigrations } from './registry';

/*
 * The lifecycle's database half.
 *
 * The machine itself is framework-free and lives on the main entry point — a
 * Next.js status page asking "what can this customer do next" must not install
 * an ORM to find out. What is here is what genuinely needs one: the log's base
 * entity, the SQL that makes a log table append-only, and the service that
 * writes a move inside the caller's transaction.
 */
export { TransitionLogEntity, appendOnlySql, dropAppendOnlySql } from '../machine/log.entity';
export {
  TransitionLog,
  TransitionRefused,
  type Move,
  type Recorded,
  type Reversal,
} from '../machine/log';
