import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { MainDb } from './schema.ts';

export type { Pool } from 'pg';

/** Called with every connection error the pool sees, so none can crash the process. */
export type PoolErrorHandler = (err: Error) => void;

const ignore: PoolErrorHandler = () => undefined;

/**
 * A pg pool that survives a dropped connection. When the server ends a session (a restart, or an
 * idle-in-transaction timeout, S1 20 Oct 2026), pg emits `error` on the pool for an idle client
 * and on the client itself for a checked-out one. With no listener either would be an uncaught
 * exception; here both are reported to `onError`, and the client's next query fails instead.
 */
export function createPool(config: pg.PoolConfig, onError: PoolErrorHandler = ignore): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('error', onError);
  pool.on('connect', (client) => {
    client.on('error', onError);
  });
  return pool;
}

/** db-main through Kysely, with the pool it owns. */
export interface MainDbHandle {
  readonly db: Kysely<MainDb>;
  readonly pool: pg.Pool;
  /** Closes the pool. */
  destroy(): Promise<void>;
}

/**
 * The only way app code reaches db-main: apps and other packages never import pg or kysely
 * themselves (dependency-cruiser rule `db-access-only-in-packages-db`, invariant 3).
 */
export function createMainDb(config: pg.PoolConfig, onError?: PoolErrorHandler): MainDbHandle {
  const pool = createPool(config, onError);
  const db = new Kysely<MainDb>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool, destroy: () => db.destroy() };
}

/** True when the database answers a trivial query; never throws. */
export async function ping(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
