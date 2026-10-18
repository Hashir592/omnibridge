import { requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import { createPool, mainDbConfig, ping } from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { buildWebApp } from './app.ts';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
const logger = createLogger({ service: 'web', version });
// Fail at boot, not at first use, if the secrets master key is missing or malformed (SEC-6).
const secretsKeyring = loadKeyring('secrets');
logger.info(
  { event: 'keyring.loaded', kekVersion: secretsKeyring.activeVersion },
  'secrets KEK loaded',
);
const pool = createPool(mainDbConfig('omnibridge-web', 10));
const piiVaultUrl = requireEnv('PII_VAULT_URL');

async function piiVaultHealthy(): Promise<boolean> {
  const res = await fetch(new URL('/healthz', piiVaultUrl), { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) return false;
  const body = (await res.json()) as { db_pii?: unknown };
  return body.db_pii === 'ok';
}

const app = buildWebApp({
  logger,
  version,
  checks: { dbMain: () => ping(pool), dbPii: piiVaultHealthy },
  // Unset until the edge's address range is fixed (M22); then the edge's CIDR only.
  ...(process.env.TRUSTED_PROXIES ? { trustedProxies: process.env.TRUSTED_PROXIES } : {}),
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
