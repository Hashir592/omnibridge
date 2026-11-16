import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from 'kysely/migration';

/*
 * Forward-only SQL migrations (ADR-005, invariant 15): each `NNNN_name.sql` file becomes a
 * migration with an `up` and no `down`. Kysely runs them in name order, each batch in one
 * transaction, and refuses to run if an applied migration is missing.
 *
 * A file whose first line is `-- migrate: no-transaction` (ADR-047) runs outside any
 * transaction, one statement at a time, so CREATE / DROP INDEX CONCURRENTLY can run on a live
 * table. Such a file may hold only those index statements (each with IF [NOT] EXISTS) and
 * session timeouts. A failed CONCURRENTLY build leaves an invalid index, which IF NOT EXISTS
 * would then skip, so the runner drops an invalid index of that name first: a failed run is
 * safe to repeat. Kysely then records the file with an empty `up`.
 *
 * A twin of this file lives in packages/pii-db, so pii-vault never depends on db-main code.
 */

export const NO_TRANSACTION_MARKER = '-- migrate: no-transaction';

const SET_TIMEOUT = /^SET (lock_timeout|statement_timeout) = '[0-9]+(ms|s|min)?'$/i;
const CREATE_INDEX =
  /^CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS ([a-z_][a-z0-9_]*) ON ([a-z_][a-z0-9_]*)\.[a-z_][a-z0-9_]* /i;
const DROP_INDEX = /^DROP INDEX CONCURRENTLY IF EXISTS [a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i;

/** The statements of a no-transaction file, checked against ADR-047's narrow shape. */
export function noTransactionStatements(file: string, text: string): string[] {
  const statements = text
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
  for (const s of statements) {
    if (!SET_TIMEOUT.test(s) && !CREATE_INDEX.test(s) && !DROP_INDEX.test(s)) {
      throw new Error(
        `${file}: a no-transaction migration holds only CREATE INDEX CONCURRENTLY IF NOT EXISTS, ` +
          `DROP INDEX CONCURRENTLY IF EXISTS and SET timeouts (ADR-047), not: ${s.slice(0, 80)}`,
      );
    }
  }
  return statements;
}

interface SqlFile {
  name: string;
  text: string;
  noTransaction: boolean;
}

async function readSqlFiles(dir: string): Promise<SqlFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(dir, file), 'utf8');
      const noTransaction = text.split('\n', 1)[0]?.trim() === NO_TRANSACTION_MARKER;
      // Checked up front, so a bad file stops the run before anything is applied.
      if (noTransaction) noTransactionStatements(file, text);
      return { name: file.slice(0, -'.sql'.length), text, noTransaction };
    }),
  );
}

class SqlFileMigrationProvider implements MigrationProvider {
  readonly files: SqlFile[];

  constructor(files: SqlFile[]) {
    this.files = files;
  }

  getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    for (const { name, text, noTransaction } of this.files) {
      migrations[name] = {
        // A no-transaction file has already run by the time Kysely records it.
        up: noTransaction
          ? () => Promise.resolve()
          : async (db: Kysely<unknown>) => {
              await sql.raw(text).execute(db);
            },
      };
    }
    return Promise.resolve(migrations);
  }
}

/** Runs a no-transaction file's statements in order on one session, outside any transaction. */
async function runNoTransaction(db: Kysely<unknown>, file: SqlFile): Promise<void> {
  await db.connection().execute(async (conn) => {
    // Kysely's migration lock does not cover this step: a session lock does, so a second runner
    // waits instead of taking a build still in progress (also not valid yet) for a failed one.
    await sql`SELECT pg_advisory_lock(hashtext('omnibridge.migrate.no-transaction'))`.execute(conn);
    try {
      for (const statement of noTransactionStatements(file.name, file.text)) {
        const create = CREATE_INDEX.exec(statement);
        if (create !== null) {
          const [, , index = '', schema = ''] = create;
          const { rows } = await sql<{ invalid: boolean }>`
            SELECT NOT i.indisvalid AS invalid
              FROM pg_index i
              JOIN pg_class c ON c.oid = i.indexrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = ${index} AND n.nspname = ${schema}`.execute(conn);
          if (rows[0]?.invalid === true) {
            await sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.id(schema, index)}`.execute(conn);
          }
        }
        await sql.raw(statement).execute(conn);
      }
    } finally {
      // The session goes back to the pool: leave no timeout or lock behind on it.
      await sql`RESET ALL`.execute(conn);
      await sql`SELECT pg_advisory_unlock_all()`.execute(conn);
    }
  });
}

export interface MigrationOutcome {
  applied: string[];
}

function check(error: unknown, results: readonly MigrationResult[] | undefined): string[] {
  if (error !== undefined) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName ?? 'unknown';
    throw new Error(`Migration ${failed} failed`, { cause: error });
  }
  return (results ?? []).map((r) => r.migrationName);
}

export async function runSqlMigrations(
  db: Kysely<unknown>,
  dir: string,
  /** Only for tests that run a migration set of their own beside the real one. */
  tables?: { migrationTableName: string; migrationLockTableName: string },
): Promise<MigrationOutcome> {
  const files = await readSqlFiles(dir);
  const byName = new Map(files.map((f) => [f.name, f]));
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(files),
    ...tables,
  });
  const applied: string[] = [];
  for (;;) {
    const pending = (await migrator.getMigrations()).filter((m) => m.executedAt === undefined);
    const at = pending.findIndex((m) => byName.get(m.name)?.noTransaction === true);
    if (at === -1) {
      const { error, results } = await migrator.migrateToLatest();
      applied.push(...check(error, results));
      return { applied };
    }
    // The transactional files before it, in one batch as usual.
    const before = pending[at - 1];
    if (before !== undefined) {
      const { error, results } = await migrator.migrateTo(before.name);
      applied.push(...check(error, results));
    }
    const file = byName.get(pending[at]?.name ?? '');
    if (file === undefined) throw new Error('Migration list changed while running');
    try {
      await runNoTransaction(db, file);
    } catch (error) {
      throw new Error(`Migration ${file.name} failed`, { cause: error });
    }
    const { error, results } = await migrator.migrateTo(file.name);
    applied.push(...check(error, results));
  }
}
