import pg from 'pg';

/** Called with every connection error the pool sees, so none can crash the vault. */
export type PiiPoolErrorHandler = (err: Error) => void;

const ignore: PiiPoolErrorHandler = () => undefined;

/**
 * A db-pii pool that survives a dropped connection, like db-main's (A-005, ADR-069). When the
 * server ends a session, pg emits `error` on the pool for an idle client and on the client for a
 * checked-out one; with no listener either is an uncaught exception. Both go to `onError` here,
 * and the client's next query fails instead. pii-db does not depend on db, so this mirrors
 * `createPool` in packages/db.
 */
export function createPiiPool(
  config: pg.PoolConfig,
  onError: PiiPoolErrorHandler = ignore,
): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('error', onError);
  pool.on('connect', (client) => {
    client.on('error', onError);
  });
  return pool;
}
