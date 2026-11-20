import { readSecretFile } from '@omnibridge/core';
import { loadKeyring } from '@omnibridge/crypto';
import { createMainDb, mainDbConfig } from '@omnibridge/db';
import {
  LAUNCH_WORKSPACE_ID,
  seedConsoleRows,
  seedLaunch,
  seedLaunchModules,
} from '@omnibridge/db/seed';
import { refuseOutsideDev, seedDemoUser } from './auth/dev-seed.ts';
import { Passwords } from './auth/passwords.ts';

/**
 * DEV ONLY seed (T-0203, ADR-050): the launch workspace and its companies (PRD §0.3, synthetic
 * fields), then the DEV ONLY demo user with a password and confirmed MFA. Runs as the one-off
 * `seed` service of compose.dev.yaml, or `pnpm seed` against a test database. Refuses to run
 * unless OB_ENV is dev or test: it is the only code that writes a known password.
 */
refuseOutsideDev(process.env);
const main = createMainDb(mainDbConfig('omnibridge-seed', 2), (err) => {
  process.stderr.write(`seed: db-main connection error: ${err.message}\n`);
});
try {
  const launch = await seedLaunch(main.db);
  await seedLaunchModules(main.db);
  const keyring = loadKeyring('secrets');
  // PLAT-2: API usage for the console, until M07 feeds it.
  await seedConsoleRows(main.db);
  const demo = await seedDemoUser({
    db: main.db,
    workspaceId: LAUNCH_WORKSPACE_ID,
    keyring,
    hmacKey: Buffer.from(readSecretFile('AUTH_HMAC_KEY'), 'base64url'),
    passwords: new Passwords(),
  });
  process.stdout.write(`seed: ${JSON.stringify({ ...launch.created, demoUser: demo.created })}\n`);
} finally {
  await main.destroy();
}
