import { readSecretFile, requireEnv } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { PoolConfig } from 'pg';
import type { MainDb } from './schema.ts';

/*
 * ob_platform, the workspace id list (invariant 2), lives behind its own entry point,
 * `@omnibridge/db/platform`, not the package index. A dependency-cruiser rule lets only the
 * worker's PLATFORM_JOBS module and the one-off KEK re-wrap job import it (ADR-049).
 */

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The workspace id list, read as ob_platform (invariant 2): the fan-out of all-workspace jobs
 * such as the KEK re-wrap. It reads ids only; each workspace's own work then runs as ob_app (or ob_worker) in
 * that workspace's tenant transaction.
 */
export class WorkspaceDirectory {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async listIds(): Promise<string[]> {
    // Any other role sees no workspace through RLS, so an all-workspace job would silently do
    // nothing and report success. Refuse instead.
    const { rows } = await sql<{ role: string }>`SELECT current_user AS role`.execute(this.#db);
    const role = rows[0]?.role;
    if (role !== 'ob_platform') {
      throw new Error(`The workspace list is read as ob_platform only, not as ${String(role)}`);
    }
    const ids = await this.#db.selectFrom('app.workspaces').select('id').orderBy('id').execute();
    return ids.map((row) => row.id);
  }
}

/**
 * Connection settings for ob_platform, which reads the workspace id list and nothing else
 * (invariant 2). Only the scheduler fan-out and the one-off KEK re-wrap job use it.
 */
export function platformDbConfig(applicationName: string, env: Env = process.env): PoolConfig {
  return {
    host: requireEnv('DB_MAIN_HOST', env),
    port: Number(env.DB_MAIN_PORT ?? '5432'),
    database: requireEnv('DB_MAIN_NAME', env),
    user: requireEnv('DB_PLATFORM_USER', env),
    password: readSecretFile('DB_PLATFORM_PASSWORD', env),
    max: 1,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
  };
}
