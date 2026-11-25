import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateMain } from './migrate.ts';
import { OrderReads, type OrderFilter } from './order-reads.ts';
import type { MainDb } from './schema.ts';

/** ARCHITECTURE 7's planner settings, for the sessions the list runs in. */
const SETTINGS = [
  'work_mem=8MB',
  'random_page_cost=1.1',
  'effective_io_concurrency=200',
  'effective_cache_size=1GB',
];
const ORDERS = 100_000;
const COUNT_CAP = 10_001;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Temp Written Blocks'?: number;
  Plans?: PlanNode[];
}

/**
 * The order list on real PostgreSQL (ORD-1, ORD-2, CAP-7, F-M10-end-09): what it returns, and how
 * it reads 100,000 orders. The statements are the ones `list` sends, explained as ob_app.
 */
describe('the order list (T-1004)', () => {
  let cluster: RoleCluster;
  let root: pg.Pool;
  let pool: pg.Pool;
  let db: Kysely<MainDb>;
  let reads: OrderReads;
  const sentSql: { text: string; params: unknown[] }[] = [];
  const now = new Date('2026-11-20T12:00:00Z');

  interface World {
    ctx: TenantContext;
    account: string;
  }
  const world = async (): Promise<World> => {
    const ws = randomUUID();
    const company = randomUUID();
    const account = randomUUID();
    await root.query(`INSERT INTO app.workspaces (id, name) VALUES ($1, 'List')`, [ws]);
    await root.query(
      `INSERT INTO app.companies (id, workspace_id, legal_name, trading_name, address_line1,
                                  address_city, address_postcode)
       VALUES ($1, $2, 'L Ltd', 'L', '1 Road', 'Town', 'TE1 1ST')`,
      [company, ws],
    );
    await root.query(
      `INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
       VALUES ($1, $2, $3, 'ebay', 'eBay')`,
      [account, ws, company],
    );
    return { ctx: { workspaceId: ws, companyIds: [company] }, account };
  };
  const put = async (
    w: World,
    o: {
      ref: string;
      at: string;
      status?: string;
      group?: string;
      sku?: string;
      external?: string;
    },
  ): Promise<string> => {
    const id = randomUUID();
    const [ws, company] = [w.ctx.workspaceId, w.ctx.companyIds[0]];
    await root.query(
      `INSERT INTO app.orders
         (workspace_id, id, company_id, provider, origin, channel_account_id, external_order_id,
          pii_subject, status, raw_status, placed_at, source_updated_at, tax_point_date, goods_pence,
          gross_pence, stock_moves, order_group_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'ebay', 'ebay', $4::uuid, $5::text, $4::uuid::text || ':' || $5, $6, 'x', $7::timestamptz, $7::timestamptz, $7::timestamptz::date, 100, 100,
               false, $8, now(), now())`,
      [ws, id, company, w.account, o.ref, o.status ?? 'awaiting_dispatch', o.at, o.group ?? null],
    );
    let sku: string | null = null;
    if (o.sku !== undefined) {
      const found = await root.query<{ id: string }>(
        'SELECT id FROM app.master_skus WHERE workspace_id = $1 AND sku = $2',
        [ws, o.sku],
      );
      sku = found.rows[0]?.id ?? randomUUID();
      if (found.rows.length === 0) {
        await root.query(
          `INSERT INTO app.master_skus (workspace_id, id, sku, title, short_description, weight_g, created_at, updated_at)
           VALUES ($1, $2, $3, 'T', 's', 1, now(), now())`,
          [ws, sku, o.sku],
        );
      }
    }
    await root.query(
      `INSERT INTO app.order_lines
         (workspace_id, id, company_id, order_id, line_no, external_line_id, external_sku, quantity,
          unit_gross_pence, line_gross_pence, master_sku_id, provisional_rate_bp, stored_unmapped,
          created_at)
       VALUES ($1, gen_random_uuid(), $2, $3, 1, 'L1', $4, 1, 100, 100, $5, 2000, false, now())`,
      [ws, company, id, o.external ?? null, sku],
    );
    return id;
  };
  const group = async (w: World, state = 'open') => {
    const id = randomUUID();
    await root.query(
      `INSERT INTO app.order_groups (workspace_id, id, company_id, channel_account_id, state, created_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [w.ctx.workspaceId, id, w.ctx.companyIds[0], w.account, state],
    );
    return id;
  };
  const refs = async (w: World, f: OrderFilter, offset = 0, limit = 50) => {
    const { items, total } = await reads.list(w.ctx, f, { offset, limit }, COUNT_CAP);
    return { refs: items.map((i) => i.orderRef), total, items };
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    pool = new pg.Pool({
      ...cluster.connection('ob_app'),
      max: 2,
      options: SETTINGS.map((s) => `-c ${s}`).join(' '),
    });
    // The same pool, noting each statement the list sends.
    const noting = {
      connect: async () => {
        const c = await pool.connect();
        return {
          release: () => {
            c.release();
          },
          query: (text: string, params: unknown[] = []) => {
            sentSql.push({ text, params });
            return c.query(text, params);
          },
        };
      },
      end: () => pool.end(),
    } as unknown as pg.Pool;
    db = new Kysely<MainDb>({ dialect: new PostgresDialect({ pool: noting }) });
    reads = new OrderReads(db, { now: () => now });
  }, 300_000);

  afterAll(async () => {
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[ORD-1][ORD-9] newest first; a group is one unit at its earliest visible member, never split, and the total counts units', async () => {
    const w = await world();
    const g = await group(w);
    const dead = await group(w, 'dismissed');
    await put(w, { ref: 'A', at: '2026-11-01T10:00:00Z' });
    await put(w, { ref: 'B1', at: '2026-11-02T10:00:00Z', group: g });
    await put(w, { ref: 'C', at: '2026-11-03T10:00:00Z', group: dead });
    await put(w, { ref: 'B2', at: '2026-11-04T10:00:00Z', group: g });
    await put(w, { ref: 'D', at: '2026-11-05T10:00:00Z', group: dead });
    await put(w, { ref: 'B3', at: '2026-11-06T10:00:00Z', group: g, status: 'dispatched' });
    const all = await refs(w, {});
    expect(all.refs).toEqual(['D', 'C', 'B1', 'B2', 'B3', 'A']);
    expect(all.total).toBe(4);
    expect(
      all.items.map((i) => i.group && [i.group.size, i.group.position, i.group.hidden]),
    ).toEqual([null, null, [3, 1, 0], [3, 2, 0], [3, 3, 0], null]);
    // Pages of units: the group is whole on its page.
    expect((await refs(w, {}, 0, 2)).refs).toEqual(['D', 'C']);
    expect((await refs(w, {}, 2, 1)).refs).toEqual(['B1', 'B2', 'B3']);
    expect((await refs(w, {}, 3, 2)).refs).toEqual(['A']);
    // A filter that hides members: the unit moves to its earliest visible one, and says how many hide.
    const late = await refs(w, { from: '2026-11-04' });
    expect(late.refs).toEqual(['D', 'B2', 'B3']);
    expect(late.total).toBe(2);
    expect(late.items.map((i) => i.group?.hidden ?? null)).toEqual([null, 1, 1]);
    const shipped = await refs(w, { status: 'dispatched' });
    expect(shipped.refs).toEqual(['B3']);
    expect(shipped.items[0]?.group).toMatchObject({ size: 3, position: 3, hidden: 2 });
    // The count stops at its cap.
    expect((await reads.list(w.ctx, {}, { offset: 0, limit: 50 }, 3)).total).toBe(3);
    // The export is every order on its own, newest first.
    const rows = await reads.exportRows(w.ctx, {}, 10);
    expect(rows?.map((r) => r.orderRef)).toEqual(['B3', 'D', 'B2', 'C', 'B1', 'A']);
    expect(await reads.exportRows(w.ctx, {}, 5)).toBeUndefined();
  });

  it('[ORD-2] search finds order references and SKUs by how they start, whatever their case, and nothing else', async () => {
    const w = await world();
    await put(w, { ref: '04-12345-67890', at: '2026-11-01T10:00:00Z', external: 'MUG-Blue' });
    await put(w, { ref: 'Web_100%', at: '2026-11-02T10:00:00Z', sku: 'JUG-Red', external: 'X-9' });
    await put(w, { ref: 'WebX100', at: '2026-11-03T10:00:00Z', sku: 'Ästhetik-1' });
    const found = async (q: string) => (await refs(w, { q })).refs;
    expect(await found('04-123')).toEqual(['04-12345-67890']);
    expect(await found('mug-b')).toEqual(['04-12345-67890']);
    expect(await found('MUG-BLUE')).toEqual(['04-12345-67890']);
    expect(await found('jug')).toEqual(['Web_100%']);
    expect(await found('x-9')).toEqual(['Web_100%']);
    expect(await found('ÄSTH')).toEqual(['WebX100']);
    // Only from the start; the usual wildcards are just characters; spaces around it do not count.
    expect(await found('12345')).toEqual([]);
    expect(await found('blue')).toEqual([]);
    expect(await found('web_')).toEqual(['Web_100%']);
    expect(await found('web_100%')).toEqual(['Web_100%']);
    expect(await found('%')).toEqual([]);
    expect(await found('  webx ')).toEqual(['WebX100']);
    expect(await found('web')).toEqual(['WebX100', 'Web_100%']);
    // With another filter as well.
    expect((await refs(w, { q: 'web', to: '2026-11-02' })).refs).toEqual(['Web_100%']);
    // A group's member that the search does not find is hidden, one that it finds is not.
    const g = await group(w);
    await put(w, { ref: 'GRP-1', at: '2026-11-04T10:00:00Z', group: g, sku: 'PAN-1' });
    await put(w, { ref: 'GRP-2', at: '2026-11-05T10:00:00Z', group: g, external: 'PAN-X' });
    await put(w, { ref: 'GRP-3', at: '2026-11-06T10:00:00Z', group: g });
    const pans = await refs(w, { q: 'pan-' });
    expect(pans.items.map((i) => [i.orderRef, i.group?.hidden])).toEqual([
      ['GRP-1', 1],
      ['GRP-2', 1],
    ]);
    expect((await refs(w, { q: 'grp-2' })).items.map((i) => i.group?.hidden)).toEqual([2]);
  });

  it('[ORD-2][TEN-1] rows from before the search columns are filled, and the tenant rules are back on afterwards', async () => {
    const w = await world();
    await put(w, { ref: 'OLD-1', at: '2026-11-01T10:00:00Z', sku: 'OLDSKU', external: 'Old-Ext' });
    for (const [table, column] of [
      ['orders', 'search_ref'],
      ['order_lines', 'search_sku'],
      ['master_skus', 'search_sku'],
    ] as const) {
      await root.query(`UPDATE app.${table} SET ${column} = NULL WHERE workspace_id = $1`, [
        w.ctx.workspaceId,
      ]);
    }
    expect((await refs(w, { q: 'old' })).refs).toEqual([]);
    const file = readFileSync(
      new URL('../migrations/0059_search_columns.sql', import.meta.url),
      'utf8',
    );
    const owner = new pg.Client(cluster.connection('ob_owner'));
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(file.slice(file.indexOf('-- Rows stored before this')));
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    for (const q of ['old-1', 'oldsku', 'old-ext']) {
      expect((await refs(w, { q })).refs, q).toEqual(['OLD-1']);
    }
    const { rows } = await root.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace = 'app'::regnamespace AND relforcerowsecurity
          AND relname IN ('orders', 'order_lines', 'master_skus') ORDER BY relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(['master_skus', 'order_lines', 'orders']);
  });

  it('[CAP-7][ORD-1][ORD-2] at 100,000 orders a page reads its own rows, by index, in under a second', async () => {
    const w = await world();
    const [ws, company] = [w.ctx.workspaceId, w.ctx.companyIds[0]];
    await root.query(
      `INSERT INTO app.master_skus (workspace_id, id, sku, title, short_description, weight_g, created_at, updated_at)
       SELECT $1, gen_random_uuid(), 'SKU-' || lpad(n::text, 4, '0'), 'T', 's', 1, now(), now()
         FROM generate_series(1, 500) AS n`,
      [ws],
    );
    // A year of orders; 300 waiting, the newest; one in fifty in a group of two.
    await root.query(
      `INSERT INTO app.order_groups (workspace_id, id, company_id, channel_account_id, state, created_at)
       SELECT $1, ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, $2, $3, 'open', now()
         FROM generate_series(1, $4::int / 100) AS n`,
      [ws, company, w.account, ORDERS],
    );
    await root.query(
      `INSERT INTO app.orders
         (workspace_id, id, company_id, provider, origin, channel_account_id, external_order_id,
          pii_subject, status, raw_status, placed_at, source_updated_at, tax_point_date, goods_pence,
          gross_pence, stock_moves, order_group_id, created_at, updated_at)
       SELECT $1, gen_random_uuid(), $2, 'ebay', 'ebay', $3::uuid, 'REF-' || lpad(n::text, 7, '0'),
              $3::uuid::text || ':REF-' || n, CASE WHEN n > $4::int - 300 THEN 'awaiting_dispatch' ELSE 'dispatched' END,
              'x', t.at, t.at, t.at::date, 1200, 1200, false,
              CASE WHEN n % 100 < 2
                THEN ('00000000-0000-4000-8000-' || lpad((n / 100 + 1)::text, 12, '0'))::uuid END,
              now(), now()
         FROM generate_series(0, $4::int - 1) AS n
        CROSS JOIN LATERAL (SELECT '2026-11-20T00:00:00Z'::timestamptz
                                   - ($4::int - n) * interval '5 minutes' AS at) t`,
      [ws, company, w.account, ORDERS],
    );
    // The checks of the lines that follow plan for this many orders, not for the few before.
    await root.query('ANALYZE app.orders');
    await root.query(
      `INSERT INTO app.order_lines
         (workspace_id, id, company_id, order_id, line_no, external_line_id, external_sku, quantity,
          unit_gross_pence, line_gross_pence, master_sku_id, provisional_rate_bp, stored_unmapped,
          created_at)
       SELECT $1, gen_random_uuid(), $2, o.id, 1, 'L1', 'EXT-' || s.sku, 1, 1200, 1200, s.id, 2000, false, now()
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM app.orders WHERE workspace_id = $1) o
         JOIN (SELECT id, sku, row_number() OVER (ORDER BY sku) AS n FROM app.master_skus WHERE workspace_id = $1) s
           ON s.n = o.n % 500 + 1`,
      [ws, company],
    );
    await root.query(
      'VACUUM ANALYZE app.orders, app.order_lines, app.order_groups, app.master_skus',
    );

    /** Each statement the list sends for a filter, with what its plan read. */
    const plans = async (f: OrderFilter, offset = 0) => {
      sentSql.length = 0;
      await reads.list(w.ctx, f, { offset, limit: 50 }, COUNT_CAP);
      const sent = sentSql.filter((s) => s.text.includes('app.orders o'));
      const out = [];
      for (const s of sent) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [ws]);
          await c.query(`SELECT set_config('app.company_ids', $1, true)`, [`{${String(company)}}`]);
          const res = await c.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${s.text}`,
            s.params,
          );
          const nodes: PlanNode[] = [];
          const walk = (p: PlanNode) => {
            nodes.push(p);
            (p.Plans ?? []).forEach(walk);
          };
          const top = res.rows[0]?.['QUERY PLAN'][0].Plan;
          if (top !== undefined) walk(top);
          out.push({
            seq: nodes
              .filter((p) => p['Node Type'] === 'Seq Scan')
              .map((p) => p['Relation Name'])
              .filter((t) => t === 'orders' || t === 'order_lines'),
            indexes: new Set(nodes.map((p) => p['Index Name'])),
            orders: nodes
              .filter((p) => p['Relation Name'] === 'orders')
              .reduce((n, p) => n + p['Actual Rows'] * p['Actual Loops'], 0),
            temp: top?.['Temp Written Blocks'] ?? 0,
          });
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
      }
      return out;
    };
    const times = async (f: OrderFilter, offset = 0) => {
      const ms: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        await reads.list(w.ctx, f, { offset, limit: 50 }, COUNT_CAP);
        ms.push(performance.now() - started);
      }
      ms.sort((a, b) => a - b);
      return ms[18] ?? Infinity;
    };

    const [page, count] = await plans({});
    expect(page?.seq).toEqual([]);
    expect(page?.indexes).toContain('orders_placed');
    // The page's 50 units and their groups, a few times over, never the workspace.
    expect(page?.orders).toBeLessThan(1_000);
    expect(page?.temp).toBe(0);
    // The count stops at its cap.
    expect(count?.orders).toBeLessThan(2 * COUNT_CAP);
    expect(count?.temp).toBe(0);
    const [week] = await plans({ from: '2026-11-13' });
    expect(week?.seq).toEqual([]);
    expect(week?.orders).toBeLessThan(1_000);
    const [byRef] = await plans({ q: 'ref-00500' });
    expect(byRef?.seq).toEqual([]);
    expect(byRef?.indexes).toContain('orders_search_ref');
    expect(byRef?.orders).toBeLessThan(2_000);
    const [bySku] = await plans({ q: 'sku-0042' });
    expect(bySku?.seq).toEqual([]);
    expect(bySku?.indexes).toContain('master_skus_search');
    expect(bySku?.orders).toBeLessThan(5_000);
    const [byExternal] = await plans({ q: 'EXT-SKU-0042' });
    expect(byExternal?.seq).toEqual([]);
    expect(byExternal?.indexes).toContain('order_lines_search_sku');

    const p95 = {
      first: await times({}),
      deep: await times({}, 5_000),
      week: await times({ from: '2026-11-13' }),
      status: await times({ status: 'awaiting_dispatch' }),
      rare: await times({ flag: 'oversold' }),
      ref: await times({ q: 'ref-0050000' }),
      wide: await times({ q: 'ref' }),
      sku: await times({ q: 'sku-0042' }),
      external: await times({ q: 'ext-sku-0042' }),
      none: await times({ q: 'nothing-starts-so' }),
    };
    expect(Object.entries(p95).filter(([, ms]) => ms >= 1_000)).toEqual([]);
    expect((await refs(w, {})).total).toBe(COUNT_CAP);
    const one = await refs(w, { q: 'ref-0050000' });
    expect(one.items.map((i) => [i.orderRef, i.group?.size, i.group?.hidden])).toEqual([
      ['REF-0050000', 2, 1],
    ]);
  }, 600_000);
});
