import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import { AuthStore, createMainDb, migrateMain, type MainDbHandle } from '@omnibridge/db';
import { LAUNCH_WORKSPACE_ID, seedLaunch, seedLaunchModules } from '@omnibridge/db/seed';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_ONLY_DEMO_USER, refuseOutsideDev, seedDemoUser } from './auth/dev-seed.ts';
import { Passwords } from './auth/passwords.ts';

const seedScript = fileURLToPath(new URL('./seed-dev.ts', import.meta.url));

describe('DEV ONLY seed (USR-4, ADR-050)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let web: MainDbHandle;

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_ops', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    // The seed logs in as ob_ops (ADR-051), so it is tested as ob_ops.
    main = createMainDb({ ...cluster.connection('ob_ops'), max: 2 });
    web = createMainDb({ ...cluster.connection('ob_app'), max: 1 });
  });

  afterAll(async () => {
    await web.destroy();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[USR-4] the seed refuses to run unless OB_ENV is dev or test', () => {
    for (const env of [{}, { OB_ENV: 'production' }, { OB_ENV: 'staging' }, { OB_ENV: 'DEV' }]) {
      expect(() => {
        refuseOutsideDev(env);
      }).toThrow(/OB_ENV=dev or OB_ENV=test/);
    }
    expect(() => {
      refuseOutsideDev({ OB_ENV: 'dev' });
    }).not.toThrow();
    // The script itself stops before it touches a database.
    const run = spawnSync(process.execPath, ['--conditions=@omnibridge/source', seedScript], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', OB_ENV: 'production' },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('The dev seed runs only with OB_ENV=dev or OB_ENV=test');
  });

  it('[USR-4] the DEV ONLY demo user has a password and confirmed MFA, once', async () => {
    await seedLaunch(main.db);
    const deps = {
      db: main.db,
      workspaceId: LAUNCH_WORKSPACE_ID,
      keyring: parseKeyring('secrets', generateKekLine(1)),
      hmacKey: Buffer.alloc(32, 3),
      passwords: new Passwords(),
    };
    expect(await seedDemoUser(deps)).toEqual({ created: true });
    expect(await seedDemoUser(deps)).toEqual({ created: false });
    // Sign-in (web, ob_app) finds what the seed (ob_ops) wrote.
    const store = new AuthStore(web.db);
    const account = await store.loginLookup(DEV_ONLY_DEMO_USER.email);
    expect(account).toMatchObject({ userId: DEV_ONLY_DEMO_USER.id, mfaConfirmed: true });
    expect(await new Passwords().check(account?.passwordHash, DEV_ONLY_DEMO_USER.password)).toBe(
      true,
    );
    expect(await store.userWorkspaces(DEV_ONLY_DEMO_USER.id)).toEqual([
      expect.objectContaining({ id: LAUNCH_WORKSPACE_ID, role: 'admin' }),
    ]);
  });

  it('[WEB-1][PLAT-2] the seed turns the website connector on for the launch workspace only', async () => {
    await seedLaunch(main.db);
    await seedDemoUser({
      db: main.db,
      workspaceId: LAUNCH_WORKSPACE_ID,
      keyring: parseKeyring('secrets', generateKekLine(1)),
      hmacKey: Buffer.alloc(32, 3),
      passwords: new Passwords(),
    });
    const store = new AuthStore(web.db);
    // Before the module step it is off, like every workspace.
    expect((await store.userWorkspaces(DEV_ONLY_DEMO_USER.id))[0]?.modules).toEqual({
      website_connector: false,
    });
    await seedLaunchModules(main.db);
    await seedLaunchModules(main.db); // a re-run changes nothing
    expect((await store.userWorkspaces(DEV_ONLY_DEMO_USER.id))[0]?.modules).toEqual({
      website_connector: true,
    });
  });
});
