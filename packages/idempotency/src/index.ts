export { IdempotencyRecord, type IdempotencyStatus } from './entity';
export {
  IdempotencyService,
  fingerprint,
  type BeginResult,
  type IdempotencyOptions,
} from './service';
export {
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_KEY,
  Idempotent,
  IdempotencyInterceptor,
  type IdempotentOptions,
} from './interceptor';
export { IdempotencyModule } from './nest';
export { CreateIdempotencyKey1787656930609 } from './migrations/1787656930609-CreateIdempotencyKey';

import { IdempotencyRecord } from './entity';
import { CreateIdempotencyKey1787656930609 } from './migrations/1787656930609-CreateIdempotencyKey';

/** Register alongside the project's own entities. */
export const idempotencyEntities = [IdempotencyRecord];

/** Register alongside the project's own migrations. */
export const idempotencyMigrations = [CreateIdempotencyKey1787656930609];
