import { readSecretFile, requireEnv } from '@omnibridge/core';
import type { PoolConfig } from 'pg';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Connection settings for db-main. The role is chosen by the deployment (ob_app for web and
 * worker, ob_owner only for the migrate job); the password always comes from a secret file.
 */
export function mainDbConfig(
  applicationName: string,
  max: number,
  env: Env = process.env,
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
  };
}
