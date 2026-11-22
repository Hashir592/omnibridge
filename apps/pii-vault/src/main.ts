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
// A-005: a connection the server ends is logged (the logger scrubs it), never an uncaught exception.
const pool = createPiiPool(piiDbConfig('omnibridge-pii-vault', 4), (err) => {
  logger.warn({ event: 'db.connection_error', err }, 'db-pii connection error');
});

// One token per caller (invariant 8); each is a Docker secret, never an env value or a log line.
const tokens = new ServiceTokens({
  web: readSecretFile('VAULT_TOKEN_WEB'),
  worker: readSecretFile('VAULT_TOKEN_WORKER'),
  deletion: readSecretFile('VAULT_TOKEN_DELETION'),
});
// DEL-1: tombstones are journalled to this directory (invariant 10), a volume shipped off-site
// by the backup job (T-0405); expiry changes go there too (ADR-068).
const journal = new DeletionJournal(requireEnv('DELETION_JOURNAL_DIR'));
// SEC-12: a canary read is an alarm; IDs only, at warn, for M05's alerts.
const vault = new Vault({
  pool,
  keyring: piiKeyring,
  journal,
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
const deletion = new DeletionService({
  pool,
  journal,
  onWorkspaceClosed: (workspaceId) => {
    vault.forgetKeys(workspaceId);
  },
});

// ADR-068 hardening 4: the access log and canary events are kept 6 years, then purged. Once at
// start and then daily; a failure is logged (no values) and retried the next day.
const DAY_MS = 86_400_000;
const purgeSecurityLogs = async () => {
  try {
    const count = await vault.purgeSecurityLogs();
    logger.info({ event: 'vault.security_log_purge', count }, 'security logs purged');
  } catch (err) {
    logger.error(
      {
        event: 'vault.security_log_purge_failed',
        error: err instanceof Error ? err.name : 'unknown',
      },
      'security log purge failed',
    );
  }
};
void purgeSecurityLogs();
const purgeTimer = setInterval(() => void purgeSecurityLogs(), DAY_MS);
purgeTimer.unref();

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
  clearInterval(purgeTimer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
