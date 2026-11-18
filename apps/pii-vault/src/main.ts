import { readSecretFile, requireEnv } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { createPiiPool, piiDbConfig, pingPii } from '@omnibridge/pii-db';
import { buildVaultApp } from './app.ts';
import { ServiceTokens } from './auth.ts';
import { DeletionJournal, DeletionService } from './deletion.ts';
import { Vault } from './vault.ts';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
const logger = createLogger({ service: 'pii-vault', version });
// The PII master key lives only here (invariant 9); it wraps every workspace's data and index keys.
const piiKeyring = loadKeyring('pii');
logger.info({ event: 'keyring.loaded', kekVersion: piiKeyring.activeVersion }, 'PII KEK loaded');
const pool = createPiiPool(piiDbConfig('omnibridge-pii-vault', 4));

// One token per caller (invariant 8); each is a Docker secret, never an env value or a log line.
const tokens = new ServiceTokens({
  web: readSecretFile('VAULT_TOKEN_WEB'),
  worker: readSecretFile('VAULT_TOKEN_WORKER'),
  deletion: readSecretFile('VAULT_TOKEN_DELETION'),
});
// SEC-12: a canary read is an alarm; IDs only, at warn, for M05's alerts.
const vault = new Vault({
  pool,
  keyring: piiKeyring,
  onCanary: (event) => {
    logger.warn(
      { event: 'vault.canary_read', workspaceId: event.workspaceId },
      'canary record read',
    );
  },
});
// ADR-066 (T-0407): give records from before the exact buyer index their entry. Runs before
// the vault serves, so an eBay notice never meets a record without one; a no-op once done.
// A failure is logged (no values) and never keeps the vault down: the next start retries.
// Nothing is deployed yet (ADR-029), so this only touches dev data; remove it before M22.
try {
  const backfilled = await vault.backfillBuyerExact();
  logger.info(
    { event: 'vault.buyer_exact_backfill', count: backfilled },
    'exact buyer index ready',
  );
} catch (err) {
  logger.error(
    {
      event: 'vault.buyer_exact_backfill_failed',
      error: err instanceof Error ? err.name : 'unknown',
    },
    'exact buyer index backfill failed',
  );
}
// DEL-1: tombstones are also journalled to this directory (invariant 10), a volume shipped
// off-site by the backup job (T-0405).
const deletion = new DeletionService({
  pool,
  journal: new DeletionJournal(requireEnv('DELETION_JOURNAL_DIR')),
  onWorkspaceClosed: (workspaceId) => {
    vault.forgetKeys(workspaceId);
  },
});

const app = buildVaultApp({
  logger,
  version,
  dbPii: () => pingPii(pool),
  vault,
  tokens,
  deletion,
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
