import { readSecretFile, requireEnv } from '@omnibridge/core';
import type { PoolConfig } from 'pg';

type Env = Readonly<Record<string, string | undefined>>;

/** Server-side limits on each session's statements and open transactions. */
export interface TxTimeouts {
  /** Any one statement (statement_timeout). */
  readonly statementMs: number;
  /** A transaction left open with no statement running (idle_in_transaction_session_timeout). */
  readonly idleInTransactionMs: number;
}

/** The pg settings for `timeouts`; the server cancels the statement or ends the session. */
export function txTimeouts(
  timeouts: TxTimeouts,
): Pick<PoolConfig, 'statement_timeout' | 'idle_in_transaction_session_timeout'> {
  return {
    statement_timeout: timeouts.statementMs,
    idle_in_transaction_session_timeout: timeouts.idleInTransactionMs,
  };
}

/**
 * Connection settings for db-main. The role is chosen by the deployment (ob_app for web and
 * worker, ob_owner only for the migrate job); the password always comes from a secret file.
 */
export function mainDbConfig(
  applicationName: string,
  max: number,
  env: Env = process.env,
  timeouts?: TxTimeouts,
): PoolConfig {
  return {
    host: requireEnv('DB_MAIN_HOST', env),
    port: Number(env.DB_MAIN_PORT ?? '5432'),
    database: requireEnv('DB_MAIN_NAME', env),
    user: requireEnv('DB_MAIN_USER', env),
    password: readSecretFile('DB_MAIN_PASSWORD', env),
    max,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
    ...(timeouts === undefined ? {} : txTimeouts(timeouts)),
  };
}
