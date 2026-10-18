import pg from 'pg';

export type { Pool } from 'pg';

export function createPool(config: pg.PoolConfig): pg.Pool {
  return new pg.Pool(config);
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
