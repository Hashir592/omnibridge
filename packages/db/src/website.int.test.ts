import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateMain } from './migrate.ts';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';
import { WebsiteConnectionRepository } from './website.ts';

const hash = (key: string) => createHash('sha256').update(key).digest();

/**
 * The website connector's db-main half (T-1101: WEB-1, WEB-2, AT-14, TEN-1). A website call names
 * its connection before any tenant context exists: one definer function answers that connection
 * and nothing else, and every other read stays inside its workspace and company.
 */
describe('website connections in db-main (T-1101)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let pool: pg.Pool;
  let root: pg.Pool;
  let repo: WebsiteConnectionRepository;

  /** A workspace with two companies and a website account under the first. */
  const world = async (provider: 'website' | 'ebay' = 'website') => {
    const workspaceId = randomUUID();
    const [company, other] = [randomUUID(), randomUUID()];
    const account = randomUUID();
    const ctx: TenantContext = { workspaceId, companyIds: [company, other] };
    await root.query(`INSERT INTO app.workspaces (id, name) VALUES ($1, 'Web')`, [workspaceId]);
    for (const id of [company, other]) {
      await root.query(
        `INSERT INTO app.companies (id, workspace_id, legal_name, trading_name, address_line1,
                                    address_city, address_postcode)
         VALUES ($1, $2, 'W Ltd', 'W', '1 Road', 'Town', 'TE1 1ST')`,
        [id, workspaceId],
      );
    }
    await root.query(
      `INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
       VALUES ($1, $2, $3, $4, 'Shop')`,
      [account, workspaceId, company, provider],
    );
    const key = `obw_${randomUUID()}`;
    if (provider === 'website') {
      await repo.create(ctx, {
        channelAccountId: account,
        companyId: company,
        baseUrl: 'https://shop.example.test',
        keyHash: hash(key),
        keyHint: key.slice(-4),
      });
    }
    return { ctx, workspaceId, company, other, account, key };
  };
  const moduleOn = (workspaceId: string, on: boolean) =>
    root.query(`SELECT app.workspace_set_module($1, 'website_connector', $2)`, [workspaceId, on]);

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    pool = new pg.Pool({ ...cluster.connection('ob_app'), max: 4 });
    db = new Kysely<MainDb>({ dialect: new PostgresDialect({ pool }) });
    repo = new WebsiteConnectionRepository(db);
  }, 300_000);

  afterAll(async () => {
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[WEB-2][TEN-1] the inbound lookup answers the one connection it names, and its module', async () => {
    const a = await world();
    const b = await world();
    expect(await repo.inbound(a.account)).toEqual({
      workspaceId: a.workspaceId,
      companyId: a.company,
      keyHash: hash(a.key),
      moduleOn: false,
    });
    await moduleOn(a.workspaceId, true);
    expect((await repo.inbound(a.account))?.moduleOn).toBe(true);
    expect((await repo.inbound(b.account))?.moduleOn).toBe(false);
    // Nothing for an unknown connection, an account that is not a website, or an archived one.
    expect(await repo.inbound(randomUUID())).toBeUndefined();
    expect(await repo.inbound((await world('ebay')).account)).toBeUndefined();
    await root.query('UPDATE app.channel_accounts SET archived_at = now() WHERE id = $1', [
      b.account,
    ]);
    expect(await repo.inbound(b.account)).toBeUndefined();
    // As ob_app, with no tenant context, no row of either table is readable.
    for (const table of ['website_connections', 'website_idempotency']) {
      expect((await pool.query(`SELECT 1 FROM app.${table}`)).rows, table).toEqual([]);
    }
  });

  it('[WEB-1][TEN-1][PERM-3] settings are read and changed only in their workspace and company', async () => {
    const a = await world();
    const b = await world();
    expect(await repo.settings(a.ctx, a.account)).toMatchObject({
      channelAccountId: a.account,
      companyId: a.company,
      baseUrl: 'https://shop.example.test',
      inboundKeyHint: a.key.slice(-4),
    });
    // From workspace B, or from A for a user who sees only the other company: nothing.
    expect(await repo.settings(b.ctx, a.account)).toBeUndefined();
    const otherOnly = { workspaceId: a.workspaceId, companyIds: [a.other] };
    expect(await repo.settings(otherOnly, a.account)).toBeUndefined();
    expect(await repo.setBaseUrl(otherOnly, a.account, 'https://evil.example.test')).toBe(false);
    expect(await repo.setBaseUrl(b.ctx, a.account, 'https://evil.example.test')).toBe(false);
    expect(await repo.setBaseUrl(a.ctx, a.account, 'https://new.example.test')).toBe(true);
    // A new key: the lookup answers its hash, never the old one's.
    const next = `obw_${randomUUID()}`;
    expect(
      await repo.setKeys(a.ctx, a.account, { keyHash: hash(next), keyHint: next.slice(-4) }),
    ).toBe(true);
    expect((await repo.inbound(a.account))?.keyHash).toEqual(hash(next));
    expect(await repo.settings(a.ctx, a.account)).toMatchObject({
      baseUrl: 'https://new.example.test',
      inboundKeyHint: next.slice(-4),
    });
    // The base URL must be HTTPS, in the database too.
    await expect(repo.setBaseUrl(a.ctx, a.account, 'http://shop.example.test')).rejects.toThrow();
  });

  it('[AT-14][WEB-2] an answer is remembered per account and key, kept as given, and only in its workspace', async () => {
    const a = await world();
    const b = await world();
    const answer = {
      route: 'websitePushOrder',
      requestHash: hash('body'),
      status: 201,
      response: { omnibridgeOrderId: randomUUID() },
    };
    expect(await repo.answered(a.ctx, a.account, 'K-1')).toBeUndefined();
    await withTenantTransaction(db, a.ctx, async () => {
      await repo.remember(a.ctx, {
        channelAccountId: a.account,
        companyId: a.company,
        key: 'K-1',
        ...answer,
      });
    });
    expect(await repo.answered(a.ctx, a.account, 'K-1')).toEqual(answer);
    expect(await repo.answered(b.ctx, a.account, 'K-1')).toBeUndefined();
    // The same key again is refused, and no answer can be changed.
    await expect(
      repo.remember(a.ctx, {
        channelAccountId: a.account,
        companyId: a.company,
        key: 'K-1',
        ...answer,
      }),
    ).rejects.toThrow();
    await expect(
      withTenantTransaction(db, a.ctx, (trx) =>
        sql`UPDATE app.website_idempotency SET status = 200`.execute(trx),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
