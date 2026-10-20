import { createMainDb, mainDbConfig } from '../src/index.ts';
import { seedLaunch } from './launch.ts';

/**
 * Loads the synthetic launch data into a development database, as ob_app:
 *   OB_ENV=dev DB_MAIN_HOST=… DB_MAIN_NAME=omnibridge DB_MAIN_USER=ob_app \
 *     DB_MAIN_PASSWORD_FILE=… pnpm seed
 * Dev and test only: it refuses to run anywhere else.
 */
if (process.env.OB_ENV !== 'dev' && process.env.OB_ENV !== 'test') {
  throw new Error('The seed runs only with OB_ENV=dev or OB_ENV=test');
}
const main = createMainDb(mainDbConfig('omnibridge-seed', 1));
try {
  const result = await seedLaunch(main.db);
  process.stdout.write(`seed: ${JSON.stringify(result.created)}\n`);
} finally {
  await main.destroy();
}
