import { randomUUID } from 'node:crypto';
import { pence, type TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogueRepository } from './catalogue.ts';
import { migrateMain } from './migrate.ts';
import { OrderGroupRefused, OrderReads } from './order-reads.ts';
import { OrderIngest, piiSubject, type IncomingOrder } from './orders.ts';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

const p = (n: number) => pence(BigInt(n));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same-buyer groups on real PostgreSQL (ORD-9, C3.3, F-M10-end-07): a person's "not the same buyer"
 * and "remove" against a recompute on another connection.
 */
describe('same-buyer groups and recomputes at once (T-1004)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let pool: pg.Pool;
  let ingest: OrderIngest;
  let reads: OrderReads;
  const now = new Date('2026-11-20T12:00:00Z');

  const world = async () => {
    const company = randomUUID();
    const ctx: TenantContext = { workspaceId: randomUUID(), companyIds: [company] };
    const account = randomUUID();
    await withTenantTransaction(db, ctx, async (trx) => {
      await sql`INSERT INTO app.workspaces (id, name) VALUES (${ctx.workspaceId}::uuid, 'Groups')`.execute(
        trx,
      );
      await sql`INSERT INTO app.companies (id, workspace_id, legal_name, trading_name, address_line1,
                                           address_city, address_postcode)
                VALUES (${company}::uuid, ${ctx.workspaceId}::uuid, 'G Ltd', 'G', '1 Road', 'Town', 'TE1 1ST')`.execute(
        trx,
      );
      await sql`INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
                VALUES (${account}::uuid, ${ctx.workspaceId}::uuid, ${company}::uuid, 'ebay', 'eBay')`.execute(
        trx,
      );
    });
    return { ctx, company, account };
  };
  type World = Awaited<ReturnType<typeof world>>;

  const order = (n: number, over: Partial<IncomingOrder> = {}): IncomingOrder => ({
    externalId: `G-${randomUUID().slice(0, 8)}`,
    rawStatus: 'NOT_STARTED/PAID',
    state: 'awaiting_dispatch',
    updatedAt: new Date(Date.UTC(2026, 10, 20, 9, n)),
    placedAt: new Date(Date.UTC(2026, 10, 20, 9, n)),
    paidAt: new Date(Date.UTC(2026, 10, 20, 9, n)),
    shipBy: null,
    dispatchedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    discount: p(0),
    shipping: p(0),
    channelTotal: null,
    shipToCountry: 'GB',
    fba: false,
    lines: [{ lineId: 'L1', sku: null, quantity: 1, title: null, linePrice: p(1200) }],
    refunds: [],
    pii: { kind: 'stored', piiRef: randomUUID() },
    ...over,
  });
  /** Stores `n` orders of one buyer; returns them, their ids and the recompute's classes. */
  const sameBuyer = async (w: World, n: number) => {
    const orders = Array.from({ length: n }, (_, i) => order(i));
    await ingest.apply(w.ctx, w.account, orders);
    const classes = new Map(orders.map((o) => [piiSubject(w.account, o.externalId), 'buyer']));
    const rows = await links(w);
    return { orders, classes, ids: orders.map((o) => rows.get(o.externalId)?.id ?? '') };
  };
  const links = async (w: World) => {
    const { rows } = await withTenantTransaction(db, w.ctx, (trx) =>
      sql<{ id: string; external_order_id: string; order_group_id: string | null }>`
        SELECT id, external_order_id, order_group_id FROM app.orders`.execute(trx),
    );
    return new Map(rows.map((r) => [r.external_order_id, r]));
  };
  const groupIds = async (w: World) => [
    ...new Set([...(await links(w)).values()].map((r) => r.order_group_id)),
  ];
  const groups = async (w: World, state: string) => {
    const { rows } = await withTenantTransaction(db, w.ctx, (trx) =>
      sql<{ id: string }>`SELECT id FROM app.order_groups WHERE state = ${state}`.execute(trx),
    );
    return rows.map((r) => r.id);
  };
  const exclusions = async (w: World) => {
    const { rows } = await withTenantTransaction(db, w.ctx, (trx) =>
      sql<{ order_a: string; order_b: string; kind: string }>`
        SELECT order_a, order_b, kind FROM app.order_group_exclusions`.execute(trx),
    );
    return rows;
  };
  /** Reads on a connection of their own, stopped just after the first statement that matches. */
  const held = (statement: RegExp) => {
    let reached: () => void = () => undefined;
    const atStatement = new Promise<void>((r) => (reached = r));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const gated = {
      connect: async () => {
        const c = await pool.connect();
        return {
          release: () => {
            c.release();
          },
          query: async (text: string, params?: unknown[]) => {
            const res = await c.query(text, params);
            if (statement.test(text)) {
              reached();
              await gate;
            }
            return res;
          },
        };
      },
      end: () => Promise.resolve(),
    } as unknown as pg.Pool;
    const own = new Kysely<MainDb>({ dialect: new PostgresDialect({ pool: gated }) });
    return {
      reads: new OrderReads(own, { now: () => now }),
      atStatement,
      release: () => {
        release();
      },
    };
  };
  /** A recompute held just after it has read the exclusions. */
  const heldRecompute = async (w: World, classes: ReadonlyMap<string, string>) => {
    const h = held(/FROM app\.order_group_exclusions/);
    const done = h.reads.applyGroups(w.ctx, w.account, classes);
    await h.atStatement;
    return { done, release: h.release };
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    pool = new pg.Pool({ ...cluster.connection('ob_app'), max: 8 });
    db = new Kysely<MainDb>({ dialect: new PostgresDialect({ pool }) });
    reads = new OrderReads(db, { now: () => now });
    ingest = new OrderIngest(db, {
      catalogue: new CatalogueRepository(db),
      ports: {
        cancelPii: () => Promise.resolve(),
        shortenPii: () => Promise.resolve(),
        totalMismatch: () => Promise.resolve(),
        lateMapped: () => Promise.resolve(),
        regroup: () => Promise.resolve(),
      },
      now: () => now,
    });
  }, 300_000);

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  it('[ORD-9] a group dismissed while a recompute runs stays dismissed', async () => {
    const w = await world();
    const { classes } = await sameBuyer(w, 3);
    await reads.applyGroups(w.ctx, w.account, classes);
    const [groupId] = await groupIds(w);
    const run = await heldRecompute(w, classes);
    const dismissed = reads.dismissGroup(w.ctx, groupId ?? '');
    await pause(300);
    run.release();
    await run.done;
    expect(await dismissed).toEqual({ memberCount: 3 });
    expect(await groupIds(w)).toEqual([null]);
    expect(await groups(w, 'open')).toEqual([]);
    expect(await groups(w, 'dismissed')).toEqual([groupId]);
    expect(await exclusions(w)).toHaveLength(3);
    await reads.applyGroups(w.ctx, w.account, classes);
    expect(await groupIds(w)).toEqual([null]);
  });

  it('[ORD-9] a member removed while a recompute runs stays out', async () => {
    const w = await world();
    const { classes, ids, orders } = await sameBuyer(w, 3);
    await reads.applyGroups(w.ctx, w.account, classes);
    const [groupId] = await groupIds(w);
    const run = await heldRecompute(w, classes);
    const removed = reads.removeMember(w.ctx, groupId ?? '', ids[1] ?? '');
    await pause(300);
    run.release();
    await run.done;
    expect((await removed).group.members.map((m) => m.id)).toEqual([ids[0], ids[2]]);
    const after = async () => {
      const rows = await links(w);
      return orders.map((o) => rows.get(o.externalId)?.order_group_id ?? null);
    };
    expect(await after()).toEqual([groupId, null, groupId]);
    await reads.applyGroups(w.ctx, w.account, classes);
    expect(await after()).toEqual([groupId, null, groupId]);
  });

  it('[ORD-9] a recompute that starts while a dismissal is open waits for it', async () => {
    const w = await world();
    const { classes } = await sameBuyer(w, 2);
    await reads.applyGroups(w.ctx, w.account, classes);
    const [groupId] = await groupIds(w);
    const h = held(/INSERT INTO app\.order_group_exclusions/);
    const dismissed = h.reads.dismissGroup(w.ctx, groupId ?? '');
    await h.atStatement;
    let finished = false;
    const run = reads.applyGroups(w.ctx, w.account, classes).then(() => (finished = true));
    await pause(300);
    expect(finished).toBe(false);
    h.release();
    await Promise.all([dismissed, run]);
    expect(await groupIds(w)).toEqual([null]);
    expect(await groups(w, 'open')).toEqual([]);
  });

  it('[ORD-9] two recomputes of one account run one after the other, and build one group', async () => {
    const w = await world();
    const { classes } = await sameBuyer(w, 2);
    const first = await heldRecompute(w, classes);
    let finished = false;
    const second = reads.applyGroups(w.ctx, w.account, classes).then(() => (finished = true));
    await pause(300);
    expect(finished).toBe(false);
    first.release();
    await Promise.all([first.done, second]);
    const ids = await groupIds(w);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBeNull();
    expect(await groups(w, 'open')).toEqual(ids);
    expect(await groups(w, 'closed')).toEqual([]);
  });

  it('[ORD-9] a recompute never waits for, or stops, the actions of another account', async () => {
    const w = await world();
    const { classes } = await sameBuyer(w, 2);
    const other = await world();
    const there = await sameBuyer(other, 2);
    await reads.applyGroups(other.ctx, other.account, there.classes);
    const [groupId] = await groupIds(other);
    const run = await heldRecompute(w, classes);
    expect(await reads.dismissGroup(other.ctx, groupId ?? '')).toEqual({ memberCount: 2 });
    run.release();
    await run.done;
  });

  it('[ORD-9] only an open group of a company the user sees is dismissed or changed, and every pair is kept apart', async () => {
    const w = await world();
    const { classes, ids } = await sameBuyer(w, 4);
    await reads.applyGroups(w.ctx, w.account, classes);
    const [groupId = ''] = await groupIds(w);
    const refusal = async (done: Promise<unknown>) => {
      const e: unknown = await done.then(
        () => undefined,
        (err: unknown) => err,
      );
      return e instanceof OrderGroupRefused ? e.code : e;
    };
    const stranger: TenantContext = { workspaceId: w.ctx.workspaceId, companyIds: [randomUUID()] };
    expect(await refusal(reads.dismissGroup(stranger, groupId ?? ''))).toBe('not_found');
    expect(await refusal(reads.removeMember(stranger, groupId ?? '', ids[0] ?? ''))).toBe(
      'not_found',
    );
    expect(await refusal(reads.dismissGroup(w.ctx, randomUUID()))).toBe('not_found');
    expect(await refusal(reads.removeMember(w.ctx, groupId ?? '', randomUUID()))).toBe(
      'not_a_member',
    );
    // Removed: apart from each of the others, whichever id is smaller.
    await reads.removeMember(w.ctx, groupId ?? '', ids[2] ?? '');
    const apart = await exclusions(w);
    expect(apart.map((e) => e.kind)).toEqual(['removed', 'removed', 'removed']);
    expect(
      apart.map((e) => [e.order_a, e.order_b].filter((id) => id !== ids[2])[0]).sort(),
    ).toEqual([ids[0], ids[1], ids[3]].sort());
    expect(apart.every((e) => [e.order_a, e.order_b].includes(ids[2] ?? ''))).toBe(true);
    // Dismissed: every pair of those left.
    expect(await reads.dismissGroup(w.ctx, groupId ?? '')).toEqual({ memberCount: 3 });
    const pairs = (await exclusions(w)).filter((e) => e.kind === 'dismissed');
    expect(pairs).toHaveLength(3);
    expect(await refusal(reads.dismissGroup(w.ctx, groupId ?? ''))).toBe('not_open');
    expect(await refusal(reads.removeMember(w.ctx, groupId ?? '', ids[0] ?? ''))).toBe('not_open');
    expect(await groups(w, 'dismissed')).toEqual([groupId]);
    // A new order of the same buyer groups with none of those kept apart from each other.
    const late = order(30);
    await ingest.apply(w.ctx, w.account, [late]);
    const more = new Map([...classes, [piiSubject(w.account, late.externalId), 'buyer']]);
    await reads.applyGroups(w.ctx, w.account, more);
    const open = await groups(w, 'open');
    expect(open).toHaveLength(1);
    expect(open).not.toEqual([groupId]);
    expect([...(await links(w)).values()].filter((r) => r.order_group_id !== null)).toHaveLength(2);
  });
});
