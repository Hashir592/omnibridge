import { readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import {
  CompanyRepository,
  createMainDb,
  FileRepository,
  JobRecordRepository,
  mainDbConfig,
  ping,
  Tenancy,
  WorkspaceRepository,
} from '@omnibridge/db';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
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
const main = createMainDb(mainDbConfig('omnibridge-web', 10), (err) => {
  logger.warn({ event: 'db.connection_error', err }, 'db-main connection error');
});
const piiVaultUrl = requireEnv('PII_VAULT_URL');

// Encrypted files and the key that signs their 5-minute download links (NFR-5).
const linkKey = Buffer.from(readSecretFile('FILE_LINK_HMAC_KEY'), 'base64url');
if (linkKey.length < 32) throw new Error('FILE_LINK_HMAC_KEY must hold at least 32 bytes');
const filesDir = requireEnv('FILES_DIR');
const fileStore = new EncryptedLocalFileStore({
  root: filesDir,
  keys: new FileKeyStore(filesDir, secretsKeyring),
  metadata: new FileRepository(main.db),
  linkKey,
});

async function piiVaultHealthy(): Promise<boolean> {
  const res = await fetch(new URL('/healthz', piiVaultUrl), { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) return false;
  const body = (await res.json()) as { db_pii?: unknown };
  return body.db_pii === 'ok';
}

const app = buildWebApp({
  logger,
  version,
  checks: { dbMain: () => ping(main.pool), dbPii: piiVaultHealthy },
  tenancy: new Tenancy(main.db),
  directory: {
    workspaces: new WorkspaceRepository(main.db),
    companies: new CompanyRepository(main.db),
  },
  // No session or platform resolver until T-0203: those routes answer 401 (closed, never open).
  jobs: new JobRecordRepository(main.db),
  files: { store: fileStore, linkKey },
  // Unset until the edge's address range is fixed (M22); then the edge's CIDR only.
  ...(process.env.TRUSTED_PROXIES ? { trustedProxies: process.env.TRUSTED_PROXIES } : {}),
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

const shutdown = async () => {
  await app.close();
  await main.destroy();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
