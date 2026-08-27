export { detectType, isAccepted, type DetectedType } from './detect';

export {
  FilesService,
  type BeginUploadInput,
  type DataKeyResolver,
  type FilesServiceOptions,
} from './files.service';

export {
  EnvelopeCrypto,
  LocalMasterKey,
  generateMasterKey,
  sameWrappedKey,
  type Envelope,
  type MasterKeyPort,
} from './crypto/envelope';

export {
  PermissiveTestScanner,
  RefusingScanner,
  type ScannerPort,
  type ScanVerdict,
} from './scanning/port';
export { ClamAvScanner, type ClamAvOptions } from './scanning/clamav.scanner';

export { assertTenantOwns, objectKey, safeFilename, tenantOf, type KeyParts } from './storage/keys';
export type { PresignedUpload, PutOptions, StoragePort, StoredObject } from './storage/port';
export { S3Storage, type S3StorageOptions } from './storage/s3.storage';
export { MemoryStorage } from './storage/memory.storage';

import { StoredFile } from './stored-file.entity';
import { CreateStoredFile1787813455183 } from './migrations/1787813455183-CreateStoredFile';

export { StoredFile, type StoredFileState } from './stored-file.entity';
export { CreateStoredFile1787813455183 };

/**
 * Everything the consuming service must register with TypeORM.
 *
 * Exported as arrays so an application lists one name per package rather than
 * importing entities individually and discovering a missing one at runtime.
 */
export const fileEntities = [StoredFile];
export const fileMigrations = [CreateStoredFile1787813455183];
