import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { EbayGovernor } from '@omnibridge/governor-ebay';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkConfirmationRepository } from './bulk-confirmations.ts';
import { ConnectionRepository } from './connections.ts';
import { JobLeaseRepository } from './job-leases.ts';
import { migrateMain } from './migrate.ts';
import { OutboundWriteRepository } from './outbound.ts';
import { AmazonBucketRepository, EbayBudgetRepository } from './rate-limits.ts';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;
const tenant = (): TenantContext => ({ workspaceId: randomUUID(), companyIds: [randomUUID()] });
const at = (iso: string) => new Date(iso);

/**
 * T-0702 storage: outbound writes and the switches (SAFE-2, SAFE-3), bulk confirmations (SAFE-1),
 * Amazon buckets (RL-1), the eBay budget under concurrency (RL-2, EBAY-8) and the carrier
 * semaphore (RL-4), each on real PostgreSQL.
 */
describe('outbound writes, switches and rate limits (T-0702)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let owner: pg.Pool;

  const asTenant = <T>(ctx: TenantContext, fn: (trx: Kysely<MainDb>) => Promise<T>) =>
    withTenantTransaction(db, ctx, async (trx) => {
      await trx
        .insertInto('app.workspaces')
        .values({ id: ctx.workspaceId, name: 'Outbound test' })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      return fn(trx);
    });
  const newAccount = (ctx: TenantContext, provider: 'ebay' | 'amazon' | 'evri' = 'ebay') =>
    asTenant(ctx, async (trx) => {
      const id = randomUUID();
      await trx
        .insertInto('app.companies')
        .values({
          id: ctx.companyIds[0] ?? '',
          workspace_id: ctx.workspaceId,
          legal_name: 'Outbound Ltd',
          trading_name: 'Outbound',
          address_line1: '1 Test Street',
          address_city: 'Testville',
          address_postcode: 'TE1 1ST',
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('app.channel_accounts')
        .values({
          id,
          workspace_id: ctx.workspaceId,
          company_id: ctx.companyIds[0] ?? '',
          provider,
          display_name: `Account ${provider}`,
        })
        .execute();
      return id;
    });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 12 }),
      }),
    });
    owner = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 1 });
  });

  afterAll(async () => {
    await db.destroy();
    await owner.end();
    await cluster.container.stop();
  });

  it('[SAFE-2] an account paused by its kill switch closes the gate; reads of the paused state are per account', async () => {
    const ctx = tenant();
    const paused = await newAccount(ctx);
    const other = await newAccount(ctx);
    const writes = new OutboundWriteRepository(db);
    const connections = new ConnectionRepository(db);
    const now = at('2026-11-21T12:00:00.000Z');
    expect(await asTenant(ctx, () => connections.setPaused(ctx, paused, true, now))).toBe(true);
    // Setting it again changes nothing.
    expect(await asTenant(ctx, () => connections.setPaused(ctx, paused, true, now))).toBe(false);
    expect(await asTenant(ctx, () => writes.gate(ctx, paused))).toEqual({ maintenance: false, paused: true });
    expect(await asTenant(ctx, () => writes.gate(ctx, other))).toEqual({ maintenance: false, paused: false });
  });

  it('[SAFE-3] the maintenance switch closes the gate for every workspace', async () => {
    const a = tenant();
    const b = tenant();
    const accountA = await newAccount(a);
    const accountB = await newAccount(b);
    const writes = new OutboundWriteRepository(db);
    await owner.query(
      `INSERT INTO app.users (id, email, name) VALUES ($1, $2, 'Operator')`,
      [a.workspaceId, `${a.workspaceId}@example.test`],
    );
    await owner.query(
      `INSERT INTO app.platform_settings (key, value, updated_at, updated_by)
       VALUES ('maintenance', 'true', now(), $1)`,
      [a.workspaceId],
    );
    try {
      expect(await asTenant(a, () => writes.gate(a, accountA))).toEqual({ maintenance: true, paused: false });
      expect(await asTenant(b, () => writes.gate(b, accountB))).toEqual({ maintenance: true, paused: false });
      const { rows } = await owner.query<{ maintenance: boolean }>('SELECT maintenance FROM app.maintenance_state()');
      expect(rows).toEqual([{ maintenance: true }]);
    } finally {
      await owner.query(`DELETE FROM app.platform_settings WHERE key = 'maintenance'`);
    }
  });

  it('[SAFE-2] a write is stored once per key; pausing and deferring spend no attempt; only a send attempt counts', async () => {
    const ctx = tenant();
    const account = await newAccount(ctx);
    const writes = new OutboundWriteRepository(db);
    const now = at('2026-11-21T12:00:00.000Z');
    const input = {
      channelAccountId: account,
      provider: 'ebay' as const,
      operation: 'ebay.stock_push',
      urgent: false,
      idempotencyKey: 'stock:sku-1:v1',
      payload: { sku: 'MOCK-SKU-1', quantity: 3 },
    };
    const first = await asTenant(ctx, () => writes.insert(ctx, input, now));
    const again = await asTenant(ctx, () => writes.insert(ctx, input, now));
    expect(again).toEqual({ id: first.id, created: false });
    await asTenant(ctx, () => writes.pause(ctx, first.id, 'kill_switch', now));
    expect(await asTenant(ctx, () => writes.pausedIds(ctx, { channelAccountId: account, reason: 'kill_switch' }))).toEqual([first.id]);
    expect(await asTenant(ctx, () => writes.unpause(ctx, first.id, now))).toBe(1);
    expect(await asTenant(ctx, () => writes.claim(ctx, first.id, now))).toBe(true);
    // A second worker cannot claim it while it is being sent.
    expect(await asTenant(ctx, () => writes.claim(ctx, first.id, now))).toBe(false);
    expect(await asTenant(ctx, () => writes.defer(ctx, first.id, { until: now, attempted: false, at: now }))).toEqual({ dispatchSeq: 2, attempts: 0 });
    expect(await asTenant(ctx, () => writes.claim(ctx, first.id, now))).toBe(true);
    await asTenant(ctx, () => writes.sent(ctx, first.id, { accepted: 1 }, now));
    expect(await asTenant(ctx, () => writes.get(ctx, first.id))).toMatchObject({ state: 'sent', attempts: 1, pausedReason: null });
    // Another workspace sees none of it.
    const other = tenant();
    expect(await asTenant(other, () => writes.get(other, first.id))).toBeUndefined();
  });

  it('[SAFE-1] a confirmation token is single use, expires, and belongs to its user and accounts', async () => {
    const ctx = tenant();
    const accounts = [await newAccount(ctx), await newAccount(ctx)].sort();
    const user = randomUUID();
    const bulk = new BulkConfirmationRepository(db);
    const now = at('2026-11-21T12:00:00.000Z');
    const { token, expiresAt } = await asTenant(ctx, () =>
      bulk.issue(ctx, { userId: user, action: 'stock_push', accountIds: accounts, params: {} }, now),
    );
    expect(expiresAt).toEqual(at('2026-11-21T12:10:00.000Z'));
    expect(await asTenant(ctx, () => bulk.take(ctx, 'x'.repeat(43), user, now))).toEqual({ outcome: 'not_found' });
    expect(await asTenant(ctx, () => bulk.take(ctx, token, randomUUID(), now))).toEqual({ outcome: 'conflict' });
    expect(await asTenant(ctx, () => bulk.take(ctx, token, user, now))).toEqual({
      outcome: 'ok',
      action: 'stock_push',
      accountIds: accounts,
      params: {},
    });
    expect(await asTenant(ctx, () => bulk.take(ctx, token, user, now))).toEqual({ outcome: 'conflict' });
    const late = await asTenant(ctx, () =>
      bulk.issue(ctx, { userId: user, action: 'stock_push', accountIds: accounts, params: {} }, now),
    );
    expect(await asTenant(ctx, () => bulk.take(ctx, late.token, user, at('2026-11-21T12:10:01.000Z')))).toEqual({ outcome: 'conflict' });
    const other = tenant();
    expect(await asTenant(other, () => bulk.take(other, late.token, user, now))).toEqual({ outcome: 'not_found' });
  });

  it('[RL-1] an Amazon bucket starts full, spends one token per take, refills by time and learns a new rate', async () => {
    const ctx = tenant();
    const account = await newAccount(ctx, 'amazon');
    const buckets = new AmazonBucketRepository(db);
    const t0 = at('2026-11-21T12:00:00.000Z');
    const take = (now: Date, rate = 1, burst = 2) =>
      asTenant(ctx, () => buckets.take(ctx, { channelAccountId: account, operation: 'orders.getOrders', rate, burst, now }));
    expect(await take(t0)).toEqual({ ok: true });
    expect(await take(t0)).toEqual({ ok: true });
    expect(await take(t0)).toEqual({ ok: false, waitMs: 1_000 });
    expect(await take(at('2026-11-21T12:00:01.000Z'))).toEqual({ ok: true });
    await asTenant(ctx, () =>
      buckets.setRate(ctx, { channelAccountId: account, operation: 'orders.getOrders', rate: 0.5, now: t0 }),
    );
    expect(await take(at('2026-11-21T12:00:01.000Z'))).toEqual({ ok: false, waitMs: 2_000 });
  });

  it('[RL-2][EBAY-8] the eBay budget is reserved before send and never exceeded under concurrency, app-wide', async () => {
    const a = tenant();
    const b = tenant();
    const accountA = await newAccount(a);
    const accountB = await newAccount(b);
    const governor = new EbayGovernor(new EbayBudgetRepository(db), { 'sell.inventory': 40 }, () => at('2026-11-21T20:00:00.000Z'));
    // 50 callers from two workspaces race for a cap of 40: urgent work may use 95% (38 calls).
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const ctx = i % 2 === 0 ? a : b;
        const account = i % 2 === 0 ? accountA : accountB;
        // Each reservation is its own short transaction, as in a worker (no outer one holding a
        // connection while it waits).
        return governor.reserve(ctx, { channelAccountId: account, api: 'sell.inventory', urgent: true });
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(38);
    expect(results.filter((r) => r.ok && r.crossedNonUrgent)).toHaveLength(1);
    const { rows: budget } = await owner.query<{ calls: string; cap: string }>(
      `SELECT calls, cap FROM app.ebay_budget_daily WHERE api = 'sell.inventory' AND day = '2026-11-21'`,
    );
    expect(budget).toEqual([{ calls: '38', cap: '40' }]);
    // Each account's own usage row adds up to the same total (RL-5).
    const { rows: usage } = await owner.query<{ total: string }>(
      `SELECT sum(calls)::text AS total FROM app.api_usage_daily WHERE provider = 'ebay' AND api = 'sell.inventory'`,
    );
    expect(usage).toEqual([{ total: '38' }]);
    // Non-urgent work is already past its 80% stop.
    expect(
      await governor.reserve(a, { channelAccountId: accountA, api: 'sell.inventory', urgent: false }),
    ).toMatchObject({ ok: false });
  });

  it('[RL-4] a fifth parallel request to one carrier account waits for a free slot', async () => {
    const ctx = tenant();
    const account = await newAccount(ctx, 'evri');
    const leases = new JobLeaseRepository(db);
    const scope = `http:${account}`;
    const holders = Array.from({ length: 5 }, () => randomUUID());
    const [h1, h2, h3, h4, h5] = holders as [string, string, string, string, string];
    const held = await Promise.all([h1, h2, h3, h4].map((h) => leases.acquire(ctx, scope, 4, h, 30)));
    expect(held).toEqual([true, true, true, true]);
    expect(await leases.acquire(ctx, scope, 4, h5, 30)).toBe(false);
    await leases.release(ctx, scope, h2);
    expect(await leases.acquire(ctx, scope, 4, h5, 30)).toBe(true);
  });
});
