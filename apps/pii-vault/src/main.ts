import { loadKeyring } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { createPiiPool, piiDbConfig, pingPii } from '@omnibridge/pii-db';
import { buildVaultApp } from './app.ts';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
const logger = createLogger({ service: 'pii-vault', version });
// The PII master key lives only here (invariant 9). Field encryption starts in M04; loading it at
// boot proves the secret is mounted and well formed.
const piiKeyring = loadKeyring('pii');
logger.info({ event: 'keyring.loaded', kekVersion: piiKeyring.activeVersion }, 'PII KEK loaded');
const pool = createPiiPool(piiDbConfig('omnibridge-pii-vault', 4));

const app = buildVaultApp({ logger, version, dbPii: () => pingPii(pool) });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
