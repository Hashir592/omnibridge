import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateMain } from './migrate.ts';
import type { MainDb } from './schema.ts';
import {
  ShipmentRefused,
  ShippingRepository,
  ShipTogetherChanged,
  type LabelPorts,
} from './shipping.ts';
import { withTenantTransaction } from './tenant.ts';

/**
 * Labels in db-main (T-1201: SHIP-1, EVRI-3, SHP-5, SHP-7, SHP-9, AT-26). A label is bought once
 * per parcel: the request writes the shipment and its parcels under row locks before any carrier
 * call, and at most one live shipment exists per order. Carrier accounts serve every company.
 */
describe('labels and shipments in db-main (T-1201)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let pool: pg.Pool;
  let root: pg.Pool;
  let repo: ShippingRepository;
  const queued: string[] = [];
  const ports: LabelPorts = {
    validService: (_p, code) => ['standard', 'signature', 'next_day'].includes(code),
    queue: (_ctx, s) => {
      queued.push(s.id);
      return Promise.resolve();
    },
  };

  const company = async (workspaceId: string) => {
    const id = randomUUID();
    await root.query(
      `INSERT INTO app.companies (id, workspace_id, legal_name, trading_name, address_line1,
                                  address_city, address_postcode)
       VALUES ($1, $2, 'S Ltd', 'S', '1 Road', 'Town', 'TE1 1ST')`,
      [id, workspaceId],
    );
    return id;
  };
  const account = async (
    workspaceId: string,
    companyId: string,
    provider: 'evri' | 'ebay' | 'website',
  ) => {
    const id = randomUUID();
    await root.query(
      `INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, workspaceId, companyId, provider, `${provider} account`],
    );
    return id;
  };
  let refs = 0;
  const order = async (
    w: { workspaceId: string },
    companyId: string,
    channelAccountId: string,
    over: { group?: string; at?: string; status?: string; shortened?: boolean } = {},
  ) => {
    const id = randomUUID();
    const ref = `W${String((refs += 1)).padStart(5, '0')}`;
    await root.query(
      `INSERT INTO app.orders
         (workspace_id, id, company_id, provider, origin, channel_account_id, external_order_id,
          pii_subject, pii_ref, status, raw_status, placed_at, source_updated_at, tax_point_date,
          goods_pence, gross_pence, stock_moves, order_group_id, address_shortened, created_at,
          updated_at)
       VALUES ($1, $2, $3, 'ebay', 'ebay', $4::uuid, $5::text, $4::uuid::text || ':' || $5,
               gen_random_uuid(), $6, 'x', $7::timestamptz, $7::timestamptz,
               $7::timestamptz::date, 1499, 1499, false, $8, $9, now(), now())`,
      [
        w.workspaceId,
        id,
        companyId,
        channelAccountId,
        ref,
        over.status ?? 'awaiting_dispatch',
        over.at ?? '2026-11-27T10:00:00Z',
        over.group ?? null,
        over.shortened ?? false,
      ],
    );
    return { id, ref };
  };
  const group = async (w: { workspaceId: string }, companyId: string, channelAccountId: string) => {
    const id = randomUUID();
    await root.query(
      `INSERT INTO app.order_groups (workspace_id, id, company_id, channel_account_id, state, created_at)
       VALUES ($1, $2, $3, $4, 'open', now())`,
      [w.workspaceId, id, companyId, channelAccountId],
    );
    return id;
  };
  /** A workspace with two companies: an Evri account under A, an eBay account under each. */
  const world = async () => {
    const workspaceId = randomUUID();
    await root.query(`INSERT INTO app.workspaces (id, name) VALUES ($1, 'Ship')`, [workspaceId]);
    const a = await company(workspaceId);
    const b = await company(workspaceId);
    const evri = await account(workspaceId, a, 'evri');
    const ebayA = await account(workspaceId, a, 'ebay');
    const ebayB = await account(workspaceId, b, 'ebay');
    const all: TenantContext = { workspaceId, companyIds: [a, b] };
    return { workspaceId, a, b, evri, ebayA, ebayB, all };
  };
  const label = (orderId: string, carrierAccountId: string, over: object = {}) => ({
    orderId,
    carrierAccountId,
    serviceCode: 'standard',
    parcels: [{ weightG: 500 }],
    ...over,
  });
  const count = async (sqlText: string, params: unknown[]) =>
    Number((await root.query<{ n: string }>(sqlText, params)).rows[0]?.n ?? 0);

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    pool = new pg.Pool({ ...cluster.connection('ob_app'), max: 6 });
    db = new Kysely<MainDb>({ dialect: new PostgresDialect({ pool }) });
    repo = new ShippingRepository(db);
  }, 300_000);

  afterAll(async () => {
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[SHIP-1][TEN-5] a child holding only company B sees and ships with A’s Evri account, never A’s marketplace account, and cannot change A’s carrier', async () => {
    const w = await world();
    const childB: TenantContext = { workspaceId: w.workspaceId, companyIds: [w.b] };
    // Reads: every carrier account; marketplace accounts of B only.
    expect((await repo.carrierAccounts(childB)).map((c) => c.id)).toEqual([w.evri]);
    const visible = await withTenantTransaction(db, childB, (trx) =>
      sql<{ id: string }>`SELECT id FROM app.channel_accounts ORDER BY id`.execute(trx),
    );
    expect(visible.rows.map((r) => r.id).sort()).toEqual([w.evri, w.ebayB].sort());
    // Writes still need the account's company.
    const changed = await withTenantTransaction(db, childB, (trx) =>
      sql`UPDATE app.channel_accounts SET display_name = 'mine' WHERE id = ${w.evri}::uuid`.execute(
        trx,
      ),
    );
    expect(Number(changed.numAffectedRows)).toBe(0);
    await expect(
      withTenantTransaction(db, childB, (trx) =>
        sql`INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
            VALUES (${randomUUID()}::uuid, ${w.workspaceId}::uuid, ${w.a}::uuid, 'evri', 'x')`.execute(
          trx,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // B's order ships on A's Evri account.
    const o = await order(w, w.b, w.ebayB);
    const { batchId } = await repo.requestLabels(
      childB,
      { userId: null, orders: [label(o.id, w.evri)] },
      ports,
    );
    const items = await repo.batch(childB, batchId);
    expect(items?.[0]).toMatchObject({ orderId: o.id, state: 'queued', refusal: null });
    // Another workspace sees nothing of it.
    const other = await world();
    expect(await repo.carrierAccounts(other.all)).toHaveLength(1);
    expect(await repo.batch(other.all, batchId)).toBeUndefined();
  });

  it('[EVRI-3][SHIP-3] two identical requests make one shipment and one set of parcels', async () => {
    const w = await world();
    const o = await order(w, w.a, w.ebayA);
    queued.length = 0;
    const req = {
      userId: null,
      orders: [label(o.id, w.evri, { parcels: [{ weightG: 500 }, { weightG: 700 }] })],
    };
    const [first, second] = await Promise.all([
      repo.requestLabels(w.all, req, ports),
      repo.requestLabels(w.all, req, ports),
    ]);
    expect(
      await count('SELECT count(*) AS n FROM app.shipment_orders WHERE order_id = $1', [o.id]),
    ).toBe(1);
    expect(queued).toHaveLength(1);
    const views = [await repo.batch(w.all, first.batchId), await repo.batch(w.all, second.batchId)];
    const refusals = views.map((v) => v?.[0]?.refusal).sort();
    expect(refusals).toEqual(['already_labelled', null]);
    // Both point at the same shipment.
    expect(new Set(views.map((v) => v?.[0]?.shipmentId)).size).toBe(1);
    const { rows: parcels } = await root.query<{ client_uid: string; state: string }>(
      `SELECT p.client_uid, p.state FROM app.parcels p JOIN app.shipment_orders so
          ON so.workspace_id = p.workspace_id AND so.shipment_id = p.shipment_id
        WHERE so.order_id = $1 ORDER BY p.parcel_no`,
      [o.id],
    );
    expect(parcels).toEqual([
      { client_uid: `${o.ref}-1`, state: 'pending' },
      { client_uid: `${o.ref}-2`, state: 'pending' },
    ]);
  });

  it('[EVRI-3] a parcel is sent once: a second send finds it requesting, and an unknown answer goes to the reconcile list', async () => {
    const w = await world();
    const o = await order(w, w.a, w.ebayA);
    const { batchId } = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(o.id, w.evri)] },
      ports,
    );
    const shipmentId = (await repo.batch(w.all, batchId))?.[0]?.shipmentId ?? '';
    const work = await repo.work(w.all, shipmentId);
    const parcel = work?.parcels[0]?.id ?? '';
    expect(await repo.parcelSending(w.all, parcel)).toBe('pending');
    // The answer was lost; the retry sees the parcel was already sent.
    expect(await repo.parcelSending(w.all, parcel)).toBe('requesting');
    await repo.parcelAnswered(w.all, parcel, { state: 'unknown' });
    expect(await repo.settle(w.all, shipmentId)).toBe('failed');
    const list = await repo.reconcile(w.all, { limit: 20, offset: 0 });
    expect(list.rows).toEqual([
      expect.objectContaining({ parcelId: parcel, reason: 'unknown', clientUid: `${o.ref}-1` }),
    ]);
    // The order can be labelled again; the next parcel gets the next client UID.
    const again = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(o.id, w.evri)] },
      ports,
    );
    const next = (await repo.batch(w.all, again.batchId))?.[0]?.shipmentId ?? '';
    expect((await repo.work(w.all, next))?.parcels[0]?.clientUid).toBe(`${o.ref}-2`);
  });

  it('[EVRI-3] a label job that gave up frees its orders: a sent parcel is unknown, an unsent one refused', async () => {
    const w = await world();
    const o = await order(w, w.a, w.ebayA);
    const { batchId } = await repo.requestLabels(
      w.all,
      {
        userId: null,
        orders: [label(o.id, w.evri, { parcels: [{ weightG: 500 }, { weightG: 600 }] })],
      },
      ports,
    );
    const shipmentId = (await repo.batch(w.all, batchId))?.[0]?.shipmentId ?? '';
    const parcels = (await repo.work(w.all, shipmentId))?.parcels ?? [];
    await repo.parcelSending(w.all, parcels[0]?.id ?? '');
    expect(await repo.abandon(w.all, shipmentId)).toBe('failed');
    const view = await repo.shipment(w.all, shipmentId);
    expect(view?.parcels.map((p) => [p.state, p.errorCode])).toEqual([
      ['unknown', 'carrier.no_answer'],
      ['invalid', 'carrier.unavailable'],
    ]);
    const list = await repo.reconcile(w.all, { limit: 20, offset: 0 });
    expect(list.rows.map((r) => r.parcelId)).toEqual([parcels[0]?.id]);
    const again = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(o.id, w.evri)] },
      ports,
    );
    expect((await repo.batch(w.all, again.batchId))?.[0]?.state).toBe('queued');
  });

  it('[EVRI-3] two channels with the same order reference never share a client UID on one carrier account', async () => {
    const w = await world();
    const first = await order(w, w.a, w.ebayA);
    // The same reference from the other company's account.
    const other = randomUUID();
    await root.query(
      `INSERT INTO app.orders
         (workspace_id, id, company_id, provider, origin, channel_account_id, external_order_id,
          pii_subject, pii_ref, status, raw_status, placed_at, source_updated_at, tax_point_date,
          goods_pence, gross_pence, stock_moves, created_at, updated_at)
       VALUES ($1, $2, $3, 'ebay', 'ebay', $4::uuid, $5::text, $4::uuid::text || ':' || $5,
               gen_random_uuid(), 'awaiting_dispatch', 'x', now(), now(), now()::date, 1, 1,
               false, now(), now())`,
      [w.workspaceId, other, w.b, w.ebayB, first.ref],
    );
    const { batchId } = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(first.id, w.evri), label(other, w.evri)] },
      ports,
    );
    const items = (await repo.batch(w.all, batchId)) ?? [];
    const uids = await Promise.all(
      items.map(async (i) => (await repo.work(w.all, i.shipmentId ?? ''))?.parcels[0]?.clientUid),
    );
    expect(uids).toEqual([`${first.ref}-1`, `${first.ref}-2`]);
  });

  it('[AT-12][SHIP-4] an INVALID parcel fails its order with the carrier code and paths; the batch shows it', async () => {
    const w = await world();
    const good = await order(w, w.a, w.ebayA);
    const bad = await order(w, w.a, w.ebayA);
    const { batchId } = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(good.id, w.evri), label(bad.id, w.evri)] },
      ports,
    );
    const items = (await repo.batch(w.all, batchId)) ?? [];
    for (const [i, item] of items.entries()) {
      const work = await repo.work(w.all, item.shipmentId ?? '');
      const p = work?.parcels[0]?.id ?? '';
      await repo.parcelSending(w.all, p);
      await repo.parcelAnswered(
        w.all,
        p,
        i === 0
          ? { state: 'created', barcode: 'H00MOCK000000001' }
          : {
              state: 'invalid',
              errors: [
                {
                  code: 'evri.invalid_property',
                  fields: ['deliveryDetails.deliveryAddress.postcode'],
                },
              ],
            },
      );
      await repo.settle(w.all, item.shipmentId ?? '');
    }
    const after = (await repo.batch(w.all, batchId)) ?? [];
    expect(after.map((i) => i.state)).toEqual(['created', 'failed']);
    expect(after[0]?.trackingNumber).toBe('H00MOCK000000001');
    expect(after[1]?.error).toEqual({
      code: 'evri.invalid_property',
      fields: ['deliveryDetails.deliveryAddress.postcode'],
    });
    const status = await root.query<{ id: string; status: string }>(
      'SELECT id, status FROM app.orders WHERE id = ANY($1) ORDER BY id',
      [[good.id, bad.id]],
    );
    expect(Object.fromEntries(status.rows.map((r) => [r.id, r.status]))).toEqual({
      [good.id]: 'label_created',
      [bad.id]: 'awaiting_dispatch',
    });
  });

  it('[EVRI-4] a shortened address is refused until confirmed; nothing is bought', async () => {
    const w = await world();
    const o = await order(w, w.a, w.ebayA, { shortened: true });
    const refused = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(o.id, w.evri)] },
      ports,
    );
    expect((await repo.batch(w.all, refused.batchId))?.[0]).toMatchObject({
      state: 'refused',
      refusal: 'address_not_confirmed',
      shipmentId: null,
    });
    const confirmed = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(o.id, w.evri, { confirmShortened: true })] },
      ports,
    );
    expect((await repo.batch(w.all, confirmed.batchId))?.[0]?.state).toBe('queued');
  });

  it('[AT-26][SHP-9] two users pressing Ship together at once make exactly one label; shares add up, earliest first', async () => {
    const w = await world();
    const g = await group(w, w.a, w.ebayA);
    const m1 = await order(w, w.a, w.ebayA, { group: g, at: '2026-11-27T09:00:00Z' });
    const m2 = await order(w, w.a, w.ebayA, { group: g, at: '2026-11-27T09:05:00Z' });
    const m3 = await order(w, w.a, w.ebayA, { group: g, at: '2026-11-27T09:10:00Z' });
    await repo.putCosts(w.all, w.evri, [
      { serviceCode: 'standard', costPence: 1000n, vatRateBp: 2000 },
    ]);
    const req = {
      userId: null,
      groupId: g,
      orderIds: [m3.id, m1.id, m2.id],
      carrierAccountId: w.evri,
      serviceCode: 'standard',
      parcels: [{ weightG: 1500 }],
    };
    const results = await Promise.allSettled([
      repo.requestShipTogether(w.all, req, ports),
      repo.requestShipTogether(w.all, req, ports),
    ]);
    // Either the repeat returns the first batch, or it is refused: never a second label.
    expect(await count('SELECT count(*) AS n FROM app.shipments WHERE group_id = $1', [g])).toBe(1);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const { rows: shares } = await root.query<{
      order_id: string;
      share: string;
      position: string;
    }>(
      `SELECT so.order_id, so.cost_share_pence AS share, so.position FROM app.shipment_orders so
         JOIN app.shipments s ON s.workspace_id = so.workspace_id AND s.id = so.shipment_id
        WHERE s.group_id = $1 ORDER BY so.position`,
      [g],
    );
    expect(shares.map((s) => [s.order_id, s.share])).toEqual([
      [m1.id, '334'],
      [m2.id, '333'],
      [m3.id, '333'],
    ]);
    const { rows: snap } = await root.query<{ cost_pence: string; vat_rate_bp: string }>(
      'SELECT cost_pence, vat_rate_bp FROM app.shipments WHERE group_id = $1',
      [g],
    );
    expect(snap[0]).toEqual({ cost_pence: '1000', vat_rate_bp: '2000' });
    // A later cost change never touches the label made (SHP-7).
    await repo.putCosts(w.all, w.evri, [
      { serviceCode: 'standard', costPence: 2000n, vatRateBp: 0 },
    ]);
    expect(
      (await root.query('SELECT cost_pence FROM app.shipments WHERE group_id = $1', [g])).rows[0],
    ).toEqual({ cost_pence: '1000' });
  });

  it('[AT-26][SHP-9] a member that changed refuses Ship together and names it; nothing is bought', async () => {
    const w = await world();
    const g = await group(w, w.a, w.ebayA);
    const m1 = await order(w, w.a, w.ebayA, { group: g });
    const m2 = await order(w, w.a, w.ebayA, { group: g, status: 'cancelled' });
    const err = await repo
      .requestShipTogether(
        w.all,
        {
          userId: null,
          groupId: g,
          orderIds: [m1.id, m2.id],
          carrierAccountId: w.evri,
          serviceCode: 'standard',
          parcels: [{ weightG: 900 }],
        },
        ports,
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShipTogetherChanged);
    expect((err as ShipTogetherChanged).orderRef).toBe(m2.ref);
    expect(await count('SELECT count(*) AS n FROM app.shipments WHERE group_id = $1', [g])).toBe(0);
  });

  it('[SHP-5][EVRI-6] a void returns every member to Awaiting dispatch, keeps the group, lists the label once, calls no carrier', async () => {
    const w = await world();
    const g = await group(w, w.a, w.ebayA);
    const m1 = await order(w, w.a, w.ebayA, { group: g });
    const m2 = await order(w, w.a, w.ebayA, { group: g });
    const { batchId } = await repo.requestShipTogether(
      w.all,
      {
        userId: null,
        groupId: g,
        orderIds: [m1.id, m2.id],
        carrierAccountId: w.evri,
        serviceCode: 'standard',
        parcels: [{ weightG: 900 }],
      },
      ports,
    );
    const shipmentId = (await repo.batch(w.all, batchId))?.[0]?.shipmentId ?? '';
    // Voiding while the label is still being bought is refused.
    await expect(repo.voidShipment(w.all, shipmentId)).rejects.toBeInstanceOf(ShipmentRefused);
    const p = (await repo.work(w.all, shipmentId))?.parcels[0]?.id ?? '';
    await repo.parcelSending(w.all, p);
    await repo.parcelAnswered(w.all, p, { state: 'created', barcode: 'H00MOCK000000777' });
    expect(await repo.settle(w.all, shipmentId)).toBe('created');
    const view = await repo.voidShipment(w.all, shipmentId);
    expect(view.status).toBe('voided');
    const { rows } = await root.query<{ status: string; order_group_id: string }>(
      'SELECT status, order_group_id FROM app.orders WHERE id = ANY($1)',
      [[m1.id, m2.id]],
    );
    expect(rows).toEqual([
      { status: 'awaiting_dispatch', order_group_id: g },
      { status: 'awaiting_dispatch', order_group_id: g },
    ]);
    const list = await repo.reconcile(w.all, { limit: 20, offset: 0 });
    expect(list.rows.filter((r) => r.shipmentId === shipmentId)).toEqual([
      expect.objectContaining({ reason: 'voided', barcode: 'H00MOCK000000777' }),
    ]);
    // A second void is refused and lists nothing twice.
    await expect(repo.voidShipment(w.all, shipmentId)).rejects.toBeInstanceOf(ShipmentRefused);
    expect(await repo.markReconciled(w.all, p)).toBe(true);
    expect(await repo.markReconciled(w.all, p)).toBe(false);
  });

  it('[ORD-4][SHP-5] a changed address refuses a label until a user confirms the check (ADR-081)', async () => {
    const w = await world();
    const o = await order(w, w.a, w.ebayA);
    await root.query('UPDATE app.orders SET address_changed_after_label = true WHERE id = $1', [
      o.id,
    ]);
    const refused = await repo.requestLabels(
      w.all,
      { userId: null, orders: [label(o.id, w.evri)] },
      ports,
    );
    expect((await repo.batch(w.all, refused.batchId))?.[0]?.refusal).toBe(
      'address_changed_after_label',
    );
    expect(await repo.confirmAddressCheck(w.all, o.id)).toBe(true);
    const { rows } = await root.query(
      'SELECT address_changed_after_label FROM app.orders WHERE id = $1',
      [o.id],
    );
    expect(rows[0]).toEqual({ address_changed_after_label: false });
  });

  it('[SHP-2][SHP-4][SHP-7] settings and costs default sensibly and round-trip', async () => {
    const w = await world();
    expect(await repo.settings(w.all)).toEqual({
      autoDispatchOnLabel: true,
      labelFormat: 'THERMAL',
      packagingAllowanceG: 150,
      packingSlipEnabled: false,
      trackingHoldMinutes: 30,
    });
    const s = {
      autoDispatchOnLabel: false,
      labelFormat: 'LARGE_SINGLE' as const,
      packagingAllowanceG: 200,
      packingSlipEnabled: true,
      trackingHoldMinutes: 45,
    };
    expect(await repo.putSettings(w.all, s)).toEqual(s);
    expect(
      await repo.putCosts(w.all, w.evri, [
        { serviceCode: 'standard', costPence: 289n, vatRateBp: 2000 },
        { serviceCode: 'next_day', costPence: 499n, vatRateBp: 2000 },
      ]),
    ).toEqual([
      { serviceCode: 'next_day', costPence: 499n, vatRateBp: 2000 },
      { serviceCode: 'standard', costPence: 289n, vatRateBp: 2000 },
    ]);
  });
});
