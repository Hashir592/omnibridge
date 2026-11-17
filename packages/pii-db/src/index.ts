import pg from 'pg';

export { piiDbConfig } from './config.ts';
export { migratePii, PII_MIGRATIONS_DIR } from './migrate.ts';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type PoolConfig = pg.PoolConfig;

export function createPiiPool(config: pg.PoolConfig): pg.Pool {
  return new pg.Pool(config);
}

/** True when db-pii answers a trivial query; never throws. */
export async function pingPii(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
