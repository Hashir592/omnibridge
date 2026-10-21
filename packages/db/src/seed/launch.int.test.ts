import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  migrateMain,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '../index.ts';
import { LAUNCH_WORKSPACE_ID, seedLaunch } from './launch.ts';

describe('launch seed (PRD §0.3)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 2 });
  });

  afterAll(async () => {
    await main.destroy();
    await cluster.container.stop();
  });

  it('[TEN-2] the launch seed creates one workspace, three companies and their channel accounts; a re-run changes nothing', async () => {
    const first = await seedLaunch(main.db);
    const second = await seedLaunch(main.db);
    expect(second).toEqual({
      ...first,
      created: { workspaces: 0, companies: 0, channelAccounts: 0 },
    });
    expect(first.created).toEqual({ workspaces: 1, companies: 3, channelAccounts: 10 });

    const tenancy = new Tenancy(main.db);
    const seen = await tenancy.runWorkspace({ workspaceId: LAUNCH_WORKSPACE_ID }, async (ctx) => ({
      workspace: await new WorkspaceRepository(main.db).get(ctx),
      companies: await new CompanyRepository(main.db).list(ctx),
      accounts: await new ChannelAccountRepository(main.db).list(ctx),
    }));
    expect(seen.workspace).toMatchObject({ plan: 'free_internal', currency: 'GBP' });
    expect(seen.companies).toHaveLength(3);
    // One fulfilment provider that also buys the stock; the other two are neither.
    expect(
      seen.companies.filter((c) => c.isFulfilmentProvider && c.isPurchasingCompany),
    ).toHaveLength(1);
    expect(
      seen.companies.filter((c) => !c.isFulfilmentProvider && !c.isPurchasingCompany),
    ).toHaveLength(2);
    const perCompany = (provider: string) =>
      new Set(seen.accounts.filter((a) => a.provider === provider).map((a) => a.companyId)).size;
    expect(perCompany('amazon')).toBe(3);
    expect(perCompany('amazon_ads')).toBe(3);
    expect(perCompany('ebay')).toBe(3);
    expect(seen.accounts.filter((a) => a.provider === 'website')).toHaveLength(1);
  });
});
