import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { runSqlMigrations, type MigrationOutcome } from './sql-migrations.ts';

/** packages/pii-db/migrations, both from src (tests) and from dist (the image). */
export const PII_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Brings db-pii up to date as vault_owner. */
export async function migratePii(owner: pg.PoolConfig): Promise<MigrationOutcome> {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool(owner) }) });
  try {
    return await runSqlMigrations(db, PII_MIGRATIONS_DIR);
  } finally {
    await db.destroy();
  }
}
