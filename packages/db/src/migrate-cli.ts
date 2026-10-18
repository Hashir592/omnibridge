import { createLogger } from '@omnibridge/logger';
import { mainDbConfig } from './config.ts';
import { migrateMain } from './migrate.ts';

// One-off migrate job for db-main (ARCHITECTURE.md §7 deploy step 5). Connects as ob_owner.
const log = createLogger({
  service: 'migrate-main',
  version: process.env.APP_VERSION ?? '0.0.0-dev',
});

try {
  const { applied } = await migrateMain(mainDbConfig('omnibridge-migrate', 2));
  for (const migration of applied) log.info({ event: 'migration.applied', migration }, 'applied');
  log.info({ event: 'migration.done', status: applied.length }, 'db-main is up to date');
} catch (err) {
  log.error({ err, event: 'migration.failed' }, 'db-main migration failed');
  process.exitCode = 1;
}
