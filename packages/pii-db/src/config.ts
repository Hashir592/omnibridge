import { readSecretFile, requireEnv } from '@omnibridge/core';
import type { PoolConfig } from 'pg';

type Env = Readonly<Record<string, string | undefined>>;

/** Connection settings for db-pii (vault_app for pii-vault, vault_owner for the migrate job). */
export function piiDbConfig(
  applicationName: string,
  max: number,
  env: Env = process.env,
): PoolConfig {
  return {
    host: requireEnv('DB_PII_HOST', env),
    port: Number(env.DB_PII_PORT ?? '5432'),
    database: requireEnv('DB_PII_NAME', env),
    user: requireEnv('DB_PII_USER', env),
    password: readSecretFile('DB_PII_PASSWORD', env),
    max,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
  };
}
