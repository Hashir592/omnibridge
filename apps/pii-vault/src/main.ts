import { readSecretFile } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { createPiiPool, piiDbConfig, pingPii } from '@omnibridge/pii-db';
import { buildVaultApp } from './app.ts';
import { ServiceTokens } from './auth.ts';
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
const vault = new Vault({ pool, keyring: piiKeyring });

const app = buildVaultApp({ logger, version, dbPii: () => pingPii(pool), vault, tokens });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '8080') });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
