import { createLogger } from '@omnibridge/logger';
import { createPiiPool, piiDbConfig, pingPii } from '@omnibridge/pii-db';
import { buildVaultApp } from './app.ts';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
const logger = createLogger({ service: 'pii-vault', version });
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
