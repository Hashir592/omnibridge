export { mainDbConfig } from './config.ts';
export { MAIN_MIGRATIONS_DIR, migrateMain } from './migrate.ts';
export { createPool, ping, type Pool } from './pool.ts';
export {
  CredentialRepository,
  type CredentialRef,
  type CredentialRepositoryOptions,
  type CredentialSlot,
} from './credentials.ts';
export type { MainDb } from './schema.ts';
