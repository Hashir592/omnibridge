import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import type { PoolConfig } from 'pg';
import { createPool } from './pool.ts';
import { installQueueSchema } from './queue-schema.ts';
import { runSqlMigrations, type MigrationOutcome } from './sql-migrations.ts';

/** packages/db/migrations, both from src (tests) and from dist (the image). */
export const MAIN_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Brings db-main up to date as ob_owner: pg-boss schema first (the baseline grants on it),
 * then the forward-only SQL migrations.
 */
export async function migrateMain(owner: PoolConfig): Promise<MigrationOutcome> {
  await installQueueSchema(owner);
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: createPool(owner) }) });
  try {
    return await runSqlMigrations(db, MAIN_MIGRATIONS_DIR);
  } finally {
    await db.destroy();
  }
}
