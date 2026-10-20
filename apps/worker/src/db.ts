import { mainDbConfig, type TxTimeouts } from '@omnibridge/db';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Limits on every job handler's tenant transaction (S1, 20 Oct 2026): the server cancels a
 * statement that runs too long and ends a session left idle inside a transaction, so a stuck job
 * cannot hold locks or a connection for ever. One transaction per job is safe today because no
 * job calls a provider yet; M07 splits provider jobs into short transactions around each call.
 * The idle limit outlasts a virus scan, which holds its transaction while clamd reads the file
 * (CLAMD_TIMEOUT_MS, 120 s).
 */
export const WORKER_TX_TIMEOUTS: TxTimeouts = {
  statementMs: 60_000,
  idleInTransactionMs: 180_000,
};

/** The handler pool: one connection per running job, so `max` follows WORKER_CONCURRENCY. */
export function workerHandlerDbConfig(
  max: number,
  env: Env = process.env,
): ReturnType<typeof mainDbConfig> {
  return mainDbConfig('omnibridge-worker-jobs', max, env, WORKER_TX_TIMEOUTS);
}
