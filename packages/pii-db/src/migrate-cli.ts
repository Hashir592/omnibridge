import { createLogger } from '@omnibridge/logger';
import { piiDbConfig } from './config.ts';
import { migratePii } from './migrate.ts';

// One-off migrate job for db-pii. Connects as vault_owner, from the pii-vault image.
const log = createLogger({
  service: 'migrate-pii',
  version: process.env.APP_VERSION ?? '0.0.0-dev',
});

try {
  const { applied } = await migratePii(piiDbConfig('omnibridge-migrate-pii', 2));
  for (const migration of applied) log.info({ event: 'migration.applied', migration }, 'applied');
  log.info({ event: 'migration.done', status: applied.length }, 'db-pii is up to date');
} catch (err) {
  log.error({ err, event: 'migration.failed' }, 'db-pii migration failed');
  process.exitCode = 1;
}
