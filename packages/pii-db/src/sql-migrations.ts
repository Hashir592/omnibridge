import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

/**
 * Forward-only SQL migrations for db-pii (ADR-005, invariant 15). This is a deliberate twin of
 * packages/db/src/sql-migrations.ts: pii-vault must not depend on any db-main package.
 */
class SqlFileMigrationProvider implements MigrationProvider {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const text = await readFile(join(this.dir, file), 'utf8');
      migrations[file.slice(0, -'.sql'.length)] = {
        up: async (db: Kysely<unknown>) => {
          await sql.raw(text).execute(db);
        },
      };
    }
    return migrations;
  }
}

export interface MigrationOutcome {
  applied: string[];
}

export async function runSqlMigrations(
  db: Kysely<unknown>,
  dir: string,
): Promise<MigrationOutcome> {
  const migrator = new Migrator({ db, provider: new SqlFileMigrationProvider(dir) });
  const { error, results } = await migrator.migrateToLatest();
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown';
    throw new Error(`Migration ${failed} failed`, { cause: error });
  }
  return { applied: (results ?? []).map((r) => r.migrationName) };
}
