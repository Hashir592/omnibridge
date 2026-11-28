import { randomUUID } from 'node:crypto';
import {
  clientUid,
  labelCostShares,
  nextOrderStatus,
  type OrderStatus,
  type TenantContext,
} from '@omnibridge/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { MainDb } from './schema.ts';
import { withBoundTenant, withTenantTransaction } from './tenant.ts';

/*
 * M12 labels in db-main (T-1201: SHIP-1, SHIP-3, EVRI-3, EVRI-6, SHP-5, SHP-7, SHP-9, AT-12, AT-26).
 *
 * A label is bought once per parcel. The web request locks the orders, checks them and writes the
 * shipment and its parcels, each with a client UID unique per carrier account, before any carrier
 * call; the worker only ever moves a parcel on from the state it finds (db-main 0062). At most one
 * live shipment per order, so two requests can never both buy for it. Nothing here holds a buyer
 * detail: label files live in pii-vault (invariant 11).
 *
 * Lock order (as everywhere): an account's group lock, then orders by id, then the rest.
 */

export const LABEL_FORMATS = [
  'THERMAL',
  'DEFAULT',
  'TWO_PER_PAGE',
  'LARGE_SINGLE',
  'LARGE_MULTI',
] as const;
export type LabelFormat = (typeof LABEL_FORMATS)[number];

export type LabelRefusal =
  | 'not_awaiting_dispatch'
  | 'already_labelled'
  | 'address_not_confirmed'
  | 'address_changed_after_label'
  | 'no_buyer_details'
  | 'carrier_needs_reauth'
  | 'unknown_service'
  | 'partial_not_allowed';

export interface ShippingSettings {
  autoDispatchOnLabel: boolean;
  labelFormat: LabelFormat;
  packagingAllowanceG: number;
  packingSlipEnabled: boolean;
  trackingHoldMinutes: number;
}

export const DEFAULT_SHIPPING_SETTINGS: ShippingSettings = {
  autoDispatchOnLabel: true,
  labelFormat: 'THERMAL',
  packagingAllowanceG: 150,
  packingSlipEnabled: false,
  trackingHoldMinutes: 30,
};

export interface CarrierAccountRow {
  id: string;
  provider: 'evri' | 'dpd';
  displayName: string;
  companyId: string;
  needsReauth: boolean;
  paused: boolean;
}

export interface ServiceCost {
  serviceCode: string;
  costPence: bigint;
  vatRateBp: number;
}

export interface LabelOrderInput {
  orderId: string;
  carrierAccountId: string;
  serviceCode: string;
  parcels: readonly { weightG: number }[];
  lineIds?: readonly string[];
  confirmShortened?: boolean;
}

/** Ports the request calls inside its transaction. */
export interface LabelPorts {
  /** Whether a carrier offers this service code (EVRI-6: a fixed list). */
  validService(provider: 'evri' | 'dpd', code: string): boolean;
  /** Queues the label job for a shipment (IDs only, invariant 7a), in the same transaction. */
  queue(ctx: TenantContext, shipment: { id: string; carrierAccountId: string }): Promise<void>;
}

export type ParcelState = 'pending' | 'requesting' | 'created' | 'invalid' | 'unknown' | 'voided';
export type ShipmentStatus = 'requested' | 'created' | 'failed' | 'voided';

export interface ParcelRow {
  id: string;
  parcelNo: number;
  clientUid: string;
  weightG: number;
  state: ParcelState;
  barcode: string | null;
  errorCode: string | null;
  errorFields: string[];
}

/** What the label job needs: IDs, references, weights, value; buyer details come from the vault. */
export interface ShipmentWork {
  id: string;
  companyId: string;
  carrierAccountId: string;
  /** The carrier account's own company (its notices go there, SHIP-1). */
  carrierCompanyId: string;
  provider: 'evri' | 'dpd';
  serviceCode: string;
  status: ShipmentStatus;
  labelFormat: LabelFormat;
  confirmShortened: boolean;
  /** The earliest order first; its reference is the delivery reference. */
  orders: {
    id: string;
    externalOrderId: string;
    piiRef: string | null;
    valuePence: bigint;
    itemDescription: string;
  }[];
  parcels: ParcelRow[];
}

export interface BatchItemView {
  orderId: string;
  orderRef: string;
  shipmentId: string | null;
  state: 'queued' | 'creating' | 'created' | 'failed' | 'refused';
  trackingNumber: string | null;
  refusal: LabelRefusal | null;
  error: { code: string; fields: string[] } | null;
}

export interface ShipmentView {
  id: string;
  carrierAccountId: string;
  provider: 'evri' | 'dpd';
  serviceCode: string;
  status: ShipmentStatus;
  trackingNumber: string | null;
  parcels: ParcelRow[];
  orders: { orderId: string; orderRef: string | null; costSharePence: bigint | null }[];
  costPence: bigint | null;
  vatRateBp: number | null;
  labelStored: boolean;
  labelFormat: LabelFormat;
  createdAt: Date;
  voidedAt: Date | null;
}

export interface ReconcileRow {
  parcelId: string;
  shipmentId: string;
  carrierAccountId: string;
  barcode: string | null;
  clientUid: string;
  reason: 'voided' | 'unknown';
  since: Date;
  orderRefs: string[];
}

/** C3.4: a Ship together member changed; nothing was bought. Names the order, never a buyer. */
export class ShipTogetherChanged extends Error {
  readonly orderRef: string;

  constructor(orderRef: string) {
    super('a ship together member changed');
    this.name = 'ShipTogetherChanged';
    this.orderRef = orderRef;
  }
}

/** The shipment cannot do that now (void a label still being bought, void twice). */
export class ShipmentRefused extends Error {
  readonly code: 'not_found' | 'conflict' | 'tracking_sent';

  constructor(code: 'not_found' | 'conflict' | 'tracking_sent') {
    super(`shipment refused: ${code}`);
    this.name = 'ShipmentRefused';
    this.code = code;
  }
}

interface LockedOrder {
  id: string;
  company_id: string;
  channel_account_id: string;
  external_order_id: string;
  status: OrderStatus;
  raw_status: string;
  pii_ref: string | null;
  pii_deleted_at: Date | null;
  address_shortened: boolean;
  address_changed_after_label: boolean;
  order_group_id: string | null;
  placed_at: Date;
}

const ORDER_LOCK_COLUMNS = sql`id, company_id, channel_account_id, external_order_id, status,
  raw_status, pii_ref, pii_deleted_at, address_shortened, address_changed_after_label,
  order_group_id, placed_at`;

const big = (v: string | number | bigint | null): bigint | null => (v === null ? null : BigInt(v));

export class ShippingRepository {
  readonly #db: Kysely<MainDb>;
  readonly #now: () => Date;

  constructor(db: Kysely<MainDb>, options: { now?: () => Date } = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
  }

  // ---- Settings, carriers and costs ---------------------------------------------------------

  async settings(ctx: TenantContext): Promise<ShippingSettings> {
    const { rows } = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql<{
        auto_dispatch_on_label: boolean;
        label_format: LabelFormat;
        packaging_allowance_g: string;
        packing_slip_enabled: boolean;
        tracking_hold_minutes: string;
      }>`SELECT auto_dispatch_on_label, label_format, packaging_allowance_g, packing_slip_enabled,
                tracking_hold_minutes
           FROM app.shipping_settings WHERE workspace_id = ${ctx.workspaceId}::uuid`.execute(trx),
    );
    const r = rows[0];
    if (r === undefined) return DEFAULT_SHIPPING_SETTINGS;
    return {
      autoDispatchOnLabel: r.auto_dispatch_on_label,
      labelFormat: r.label_format,
      packagingAllowanceG: Number(r.packaging_allowance_g),
      packingSlipEnabled: r.packing_slip_enabled,
      trackingHoldMinutes: Number(r.tracking_hold_minutes),
    };
  }

  async putSettings(ctx: TenantContext, s: ShippingSettings): Promise<ShippingSettings> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`INSERT INTO app.shipping_settings (workspace_id, auto_dispatch_on_label, label_format,
                                             packaging_allowance_g, packing_slip_enabled,
                                             tracking_hold_minutes, updated_at)
          VALUES (${ctx.workspaceId}::uuid, ${s.autoDispatchOnLabel}, ${s.labelFormat},
                  ${s.packagingAllowanceG}, ${s.packingSlipEnabled}, ${s.trackingHoldMinutes},
                  ${this.#now()})
          ON CONFLICT (workspace_id) DO UPDATE
             SET auto_dispatch_on_label = EXCLUDED.auto_dispatch_on_label,
                 label_format = EXCLUDED.label_format,
                 packaging_allowance_g = EXCLUDED.packaging_allowance_g,
                 packing_slip_enabled = EXCLUDED.packing_slip_enabled,
                 tracking_hold_minutes = EXCLUDED.tracking_hold_minutes,
                 updated_at = EXCLUDED.updated_at`.execute(trx),
    );
    return this.settings(ctx);
  }

  /** SHIP-1: every carrier account of the workspace, whatever company owns it; never archived. */
  async carrierAccounts(ctx: TenantContext): Promise<CarrierAccountRow[]> {
    const { rows } = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql<{
        id: string;
        provider: 'evri' | 'dpd';
        display_name: string;
        company_id: string;
        needs_reauth_at: Date | null;
        paused: boolean;
      }>`
        SELECT a.id, a.provider, a.display_name, a.company_id, a.needs_reauth_at,
               (a.paused_at IS NOT NULL) AS paused
          FROM app.channel_accounts a
         WHERE a.workspace_id = ${ctx.workspaceId}::uuid AND a.provider IN ('evri', 'dpd')
           AND a.archived_at IS NULL
         ORDER BY a.display_name, a.id`.execute(trx),
    );
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      displayName: r.display_name,
      companyId: r.company_id,
      needsReauth: r.needs_reauth_at !== null,
      paused: r.paused,
    }));
  }

  async costs(ctx: TenantContext, carrierAccountId: string): Promise<ServiceCost[]> {
    const { rows } = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql<{ service_code: string; cost_pence: string; vat_rate_bp: string }>`
        SELECT service_code, cost_pence, vat_rate_bp FROM app.carrier_service_costs
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND channel_account_id = ${carrierAccountId}::uuid
         ORDER BY service_code`.execute(trx),
    );
    return rows.map((r) => ({
      serviceCode: r.service_code,
      costPence: BigInt(r.cost_pence),
      vatRateBp: Number(r.vat_rate_bp),
    }));
  }

  /** SHP-7: replaces the table. A shipment keeps the figures it was made with. */
  async putCosts(
    ctx: TenantContext,
    carrierAccountId: string,
    costs: readonly ServiceCost[],
  ): Promise<ServiceCost[]> {
    const now = this.#now();
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`DELETE FROM app.carrier_service_costs
                 WHERE workspace_id = ${ctx.workspaceId}::uuid
                   AND channel_account_id = ${carrierAccountId}::uuid`.execute(trx);
      for (const c of costs) {
        await sql`INSERT INTO app.carrier_service_costs
                    (workspace_id, channel_account_id, service_code, cost_pence, vat_rate_bp, updated_at)
                  VALUES (${ctx.workspaceId}::uuid, ${carrierAccountId}::uuid, ${c.serviceCode},
                          ${c.costPence.toString()}::bigint, ${c.vatRateBp}, ${now})`.execute(trx);
      }
    });
    return this.costs(ctx, carrierAccountId);
  }

  // ---- Label requests (web, one transaction) --------------------------------------------------

  /**
   * SHP-2: labels for up to 200 orders. Each order is locked and checked; a refused one buys
   * nothing and the rest go ahead. Every shipment and its parcels are written before the label
   * job is queued, in this transaction. Throws `not_found` when an order is not visible.
   */
  async requestLabels(
    ctx: TenantContext,
    input: { userId: string | null; orders: readonly LabelOrderInput[] },
    ports: LabelPorts,
  ): Promise<{ batchId: string }> {
    const now = this.#now();
    const batchId = randomUUID();
    // Bound, so the label job is queued in this same transaction (invariant 7a: IDs only).
    return withBoundTenant(this.#db, ctx, async (trx, bound) => {
      const ids = [...new Set(input.orders.map((o) => o.orderId))].sort();
      const locked = await this.#lockOrders(trx, ctx, ids);
      if (locked.size !== ids.length) throw new ShipmentRefused('not_found');
      const carriers = await this.#carriers(
        trx,
        ctx,
        input.orders.map((o) => o.carrierAccountId),
      );
      await sql`INSERT INTO app.label_batches (workspace_id, id, created_by, created_at)
                VALUES (${ctx.workspaceId}::uuid, ${batchId}::uuid, ${input.userId}::uuid, ${now})`.execute(
        trx,
      );
      for (const [i, req] of input.orders.entries()) {
        const order = locked.get(req.orderId);
        if (order === undefined) throw new ShipmentRefused('not_found');
        const live = await this.#liveShipment(trx, ctx, order.id);
        const carrier = carriers.get(req.carrierAccountId);
        const refusal: LabelRefusal | null =
          live !== null
            ? 'already_labelled'
            : order.status !== 'awaiting_dispatch'
              ? 'not_awaiting_dispatch'
              : order.address_changed_after_label
                ? 'address_changed_after_label'
                : order.pii_ref === null || order.pii_deleted_at !== null
                  ? 'no_buyer_details'
                  : carrier === undefined || carrier.needsReauth
                    ? 'carrier_needs_reauth'
                    : !ports.validService(carrier.provider, req.serviceCode)
                      ? 'unknown_service'
                      : req.lineIds !== undefined
                        ? 'partial_not_allowed'
                        : order.address_shortened && req.confirmShortened !== true
                          ? 'address_not_confirmed'
                          : null;
        let shipmentId: string | null = live;
        if (refusal === null && carrier !== undefined) {
          shipmentId = await this.#createShipment(trx, ctx, {
            members: [order],
            carrier,
            serviceCode: req.serviceCode,
            parcels: req.parcels,
            confirmShortened: req.confirmShortened === true,
            idempotencyBase: `order:${order.id}`,
            groupId: null,
            userId: input.userId,
          });
          await ports.queue(bound, { id: shipmentId, carrierAccountId: carrier.id });
        }
        await sql`INSERT INTO app.label_batch_items
                    (workspace_id, batch_id, position, order_id, company_id, shipment_id, refusal)
                  VALUES (${ctx.workspaceId}::uuid, ${batchId}::uuid, ${i + 1}, ${order.id}::uuid,
                          ${order.company_id}::uuid, ${shipmentId}::uuid, ${refusal})`.execute(trx);
      }
      return { batchId };
    });
  }

  /**
   * SHP-9, C3.4: one label for the ticked members of a same-buyer group. The account's group lock,
   * then the members in id order; each is re-checked (still Awaiting dispatch, same open group, no
   * live label). Any change refuses the whole request and names the order. The key is the group
   * and the sorted members, so a repeat returns the first batch.
   */
  async requestShipTogether(
    ctx: TenantContext,
    input: {
      userId: string | null;
      groupId: string;
      orderIds: readonly string[];
      carrierAccountId: string;
      serviceCode: string;
      parcels: readonly { weightG: number }[];
      confirmShortened?: boolean;
    },
    ports: LabelPorts,
  ): Promise<{ batchId: string }> {
    const now = this.#now();
    return withBoundTenant(this.#db, ctx, async (trx, bound) => {
      const { rows: where } = await sql<{ channel_account_id: string }>`
        SELECT channel_account_id FROM app.order_groups
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${input.groupId}::uuid`.execute(
        trx,
      );
      const account = where[0]?.channel_account_id;
      if (account === undefined) throw new ShipmentRefused('not_found');
      // The same lock as every change to the account's groups (OrderReads), so a recompute
      // cannot move a member while this request checks it.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`order-groups:${account}`}, 0))`.execute(
        trx,
      );
      const ids = [...new Set(input.orderIds)].sort();
      const key = `group:${input.groupId}:${ids.join(',')}`;
      const repeat = await this.#repeatBatch(trx, ctx, key);
      if (repeat !== null) return { batchId: repeat };
      const locked = await this.#lockOrders(trx, ctx, ids);
      if (locked.size !== ids.length) throw new ShipmentRefused('not_found');
      const { rows: group } = await sql<{ state: string }>`
        SELECT state FROM app.order_groups
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${input.groupId}::uuid
         FOR UPDATE`.execute(trx);
      const members = [...locked.values()].sort(
        (a, b) => a.placed_at.getTime() - b.placed_at.getTime() || (a.id < b.id ? -1 : 1),
      );
      for (const m of members) {
        const changed =
          group[0]?.state !== 'open' ||
          m.order_group_id !== input.groupId ||
          m.status !== 'awaiting_dispatch' ||
          m.address_changed_after_label ||
          m.pii_ref === null ||
          m.pii_deleted_at !== null ||
          (await this.#liveShipment(trx, ctx, m.id)) !== null;
        if (changed) throw new ShipTogetherChanged(m.external_order_id);
      }
      const carrier = (await this.#carriers(trx, ctx, [input.carrierAccountId])).get(
        input.carrierAccountId,
      );
      const batchId = randomUUID();
      await sql`INSERT INTO app.label_batches (workspace_id, id, created_by, created_at)
                VALUES (${ctx.workspaceId}::uuid, ${batchId}::uuid, ${input.userId}::uuid, ${now})`.execute(
        trx,
      );
      const refusal: LabelRefusal | null =
        carrier === undefined || carrier.needsReauth
          ? 'carrier_needs_reauth'
          : !ports.validService(carrier.provider, input.serviceCode)
            ? 'unknown_service'
            : members.some((m) => m.address_shortened) && input.confirmShortened !== true
              ? 'address_not_confirmed'
              : null;
      let shipmentId: string | null = null;
      if (refusal === null && carrier !== undefined) {
        shipmentId = await this.#createShipment(trx, ctx, {
          members,
          carrier,
          serviceCode: input.serviceCode,
          parcels: input.parcels,
          confirmShortened: input.confirmShortened === true,
          idempotencyBase: key,
          groupId: input.groupId,
          userId: input.userId,
        });
        await ports.queue(bound, { id: shipmentId, carrierAccountId: carrier.id });
      }
      for (const [i, m] of members.entries()) {
        await sql`INSERT INTO app.label_batch_items
                    (workspace_id, batch_id, position, order_id, company_id, shipment_id, refusal)
                  VALUES (${ctx.workspaceId}::uuid, ${batchId}::uuid, ${i + 1}, ${m.id}::uuid,
                          ${m.company_id}::uuid, ${shipmentId}::uuid, ${refusal})`.execute(trx);
      }
      return { batchId };
    });
  }

  async batch(ctx: TenantContext, batchId: string): Promise<BatchItemView[] | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows: head } = await sql`SELECT 1 FROM app.label_batches
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${batchId}::uuid`.execute(trx);
      if (head.length === 0) return undefined;
      const { rows } = await sql<{
        order_id: string;
        external_order_id: string;
        shipment_id: string | null;
        refusal: LabelRefusal | null;
        status: ShipmentStatus | null;
        tracking_number: string | null;
        requesting: boolean;
        error_code: string | null;
        error_fields: string[] | null;
      }>`
        SELECT i.order_id, o.external_order_id, i.shipment_id, i.refusal, s.status,
               s.tracking_number,
               EXISTS (SELECT 1 FROM app.parcels p WHERE p.workspace_id = i.workspace_id
                         AND p.shipment_id = i.shipment_id AND p.state <> 'pending') AS requesting,
               f.error_code, f.error_fields
          FROM app.label_batch_items i
          JOIN app.orders o ON o.workspace_id = i.workspace_id AND o.id = i.order_id
          LEFT JOIN app.shipments s ON s.workspace_id = i.workspace_id AND s.id = i.shipment_id
          LEFT JOIN LATERAL (
            SELECT p.error_code, p.error_fields FROM app.parcels p
             WHERE p.workspace_id = i.workspace_id AND p.shipment_id = i.shipment_id
               AND p.state IN ('invalid', 'unknown')
             ORDER BY p.parcel_no LIMIT 1) f ON true
         WHERE i.workspace_id = ${ctx.workspaceId}::uuid AND i.batch_id = ${batchId}::uuid
         ORDER BY i.position`.execute(trx);
      return rows.map((r): BatchItemView => {
        const state: BatchItemView['state'] =
          r.refusal !== null
            ? 'refused'
            : r.status === 'created'
              ? 'created'
              : r.status === 'failed' || r.status === 'voided'
                ? 'failed'
                : r.requesting
                  ? 'creating'
                  : 'queued';
        return {
          orderId: r.order_id,
          orderRef: r.external_order_id,
          shipmentId: r.shipment_id,
          state,
          trackingNumber: r.tracking_number,
          refusal: r.refusal,
          error:
            r.status === 'voided'
              ? { code: 'label.voided', fields: [] }
              : state === 'failed' && r.error_code !== null
                ? { code: r.error_code, fields: r.error_fields ?? [] }
                : null,
        };
      });
    });
  }

  async shipment(ctx: TenantContext, shipmentId: string): Promise<ShipmentView | undefined> {
    return withTenantTransaction(this.#db, ctx, (trx) => this.#view(trx, ctx, shipmentId));
  }

  /** The shipments' label states, for a print request (all must be stored). */
  async printable(
    ctx: TenantContext,
    shipmentIds: readonly string[],
  ): Promise<{ id: string; labelStored: boolean; status: ShipmentStatus; companyId: string }[]> {
    const { rows } = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql<{ id: string; label_stored: boolean; status: ShipmentStatus; company_id: string }>`
        SELECT id, label_stored, status, company_id FROM app.shipments
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND id = ANY (${sql.val([...shipmentIds])}::uuid[])`.execute(trx),
    );
    return rows.map((r) => ({
      id: r.id,
      labelStored: r.label_stored,
      status: r.status,
      companyId: r.company_id,
    }));
  }

  // ---- The label job (worker, short transactions) ---------------------------------------------

  async work(ctx: TenantContext, shipmentId: string): Promise<ShipmentWork | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{
        id: string;
        company_id: string;
        carrier_account_id: string;
        provider: 'evri' | 'dpd';
        service_code: string;
        status: ShipmentStatus;
        label_format: LabelFormat;
        confirm_shortened: boolean;
        carrier_company_id: string;
      }>`SELECT s.id, s.company_id, s.carrier_account_id, s.provider, s.service_code, s.status,
                s.label_format, s.confirm_shortened, a.company_id AS carrier_company_id
           FROM app.shipments s
           JOIN app.channel_accounts a ON a.workspace_id = s.workspace_id
                                      AND a.id = s.carrier_account_id
          WHERE s.workspace_id = ${ctx.workspaceId}::uuid AND s.id = ${shipmentId}::uuid`.execute(
        trx,
      );
      const s = rows[0];
      if (s === undefined) return undefined;
      const { rows: orders } = await sql<{
        id: string;
        external_order_id: string;
        pii_ref: string | null;
        value: string;
        description: string | null;
      }>`
        SELECT o.id, o.external_order_id, o.pii_ref,
               greatest(o.goods_pence - o.discount_pence, 0)::text AS value,
               (SELECT string_agg(coalesce(l.title, l.external_sku, 'Item'), ', '
                                  ORDER BY l.line_no)
                  FROM app.order_lines l
                 WHERE l.workspace_id = o.workspace_id AND l.order_id = o.id
                   AND l.removed_at IS NULL) AS description
          FROM app.shipment_orders so
          JOIN app.orders o ON o.workspace_id = so.workspace_id AND o.id = so.order_id
         WHERE so.workspace_id = ${ctx.workspaceId}::uuid AND so.shipment_id = ${shipmentId}::uuid
         ORDER BY so.position`.execute(trx);
      return {
        id: s.id,
        companyId: s.company_id,
        carrierAccountId: s.carrier_account_id,
        carrierCompanyId: s.carrier_company_id,
        provider: s.provider,
        serviceCode: s.service_code,
        status: s.status,
        labelFormat: s.label_format,
        confirmShortened: s.confirm_shortened,
        orders: orders.map((o) => ({
          id: o.id,
          externalOrderId: o.external_order_id,
          piiRef: o.pii_ref,
          valuePence: BigInt(o.value),
          itemDescription: (o.description ?? 'Goods').slice(0, 100),
        })),
        parcels: await this.#parcels(trx, ctx, shipmentId),
      };
    });
  }

  /**
   * Marks a parcel as sent before the carrier call. Returns its state before: `requesting` means
   * an earlier attempt sent it and its answer was never stored; the carrier's duplicate check
   * then decides, and the parcel is never bought twice.
   */
  async parcelSending(ctx: TenantContext, parcelId: string): Promise<ParcelState | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ state: ParcelState }>`
        SELECT state FROM app.parcels
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${parcelId}::uuid FOR UPDATE`.execute(
        trx,
      );
      const before = rows[0]?.state;
      if (before === 'pending') {
        await sql`UPDATE app.parcels SET state = 'requesting', updated_at = ${this.#now()}
                   WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${parcelId}::uuid`.execute(
          trx,
        );
      }
      return before;
    });
  }

  /** Stores the carrier's answer for a parcel that was sent; any other state is left alone. */
  async parcelAnswered(
    ctx: TenantContext,
    parcelId: string,
    answer:
      | { state: 'created'; barcode: string }
      | { state: 'invalid'; errors: readonly { code: string; fields: readonly string[] }[] }
      | { state: 'unknown' },
  ): Promise<void> {
    const now = this.#now();
    const first = answer.state === 'invalid' ? answer.errors[0] : undefined;
    const code =
      answer.state === 'invalid'
        ? (first?.code ?? 'carrier.invalid')
        : answer.state === 'unknown'
          ? 'evri.duplicate_client_uid'
          : null;
    const fields = answer.state === 'invalid' ? answer.errors.flatMap((e) => e.fields) : [];
    await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`UPDATE app.parcels
             SET state = ${answer.state},
                 barcode = ${answer.state === 'created' ? answer.barcode : null},
                 error_code = ${code},
                 error_fields = ${sql.val(fields.slice(0, 20))}::text[],
                 reconcile_since = ${answer.state === 'unknown' ? now : null},
                 updated_at = ${now}
           WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${parcelId}::uuid
             AND state = 'requesting'`.execute(trx),
    );
  }

  /**
   * The label job gave up (its retries ran out): no parcel stays in flight. A parcel that was sent
   * may exist at the carrier, so it is `unknown` and goes on the reconcile list; one never sent is
   * refused. The shipment then fails, freeing its orders to be labelled again.
   */
  async abandon(ctx: TenantContext, shipmentId: string): Promise<ShipmentStatus | undefined> {
    const now = this.#now();
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`UPDATE app.parcels
                   SET state = 'unknown', error_code = 'carrier.no_answer',
                       reconcile_since = coalesce(reconcile_since, ${now}), updated_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
                   AND state = 'requesting'`.execute(trx);
      await sql`UPDATE app.parcels
                   SET state = 'invalid', error_code = 'carrier.unavailable', updated_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
                   AND state = 'pending'`.execute(trx);
    });
    return this.settle(ctx, shipmentId);
  }

  /** The worker found a reason not to buy (EVRI-4: the address had to be shortened). */
  async refuse(ctx: TenantContext, shipmentId: string, refusal: LabelRefusal): Promise<void> {
    const now = this.#now();
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ status: ShipmentStatus }>`
        SELECT status FROM app.shipments
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid FOR UPDATE`.execute(
        trx,
      );
      if (rows[0]?.status !== 'requested') return;
      const { rows: sent } = await sql`SELECT 1 FROM app.parcels
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
           AND state <> 'pending'`.execute(trx);
      if (sent.length > 0) return;
      await sql`UPDATE app.shipments SET status = 'failed', updated_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid`.execute(
        trx,
      );
      await sql`UPDATE app.shipment_orders SET live = false
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid`.execute(
        trx,
      );
      await sql`UPDATE app.label_batch_items SET refusal = ${refusal}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid`.execute(
        trx,
      );
      if (refusal === 'address_not_confirmed') {
        await sql`UPDATE app.orders o SET address_shortened = true, updated_at = ${now}
                    FROM app.shipment_orders so
                   WHERE so.workspace_id = ${ctx.workspaceId}::uuid
                     AND so.shipment_id = ${shipmentId}::uuid
                     AND o.workspace_id = so.workspace_id AND o.id = so.order_id`.execute(trx);
      }
    });
  }

  async labelStored(ctx: TenantContext, shipmentId: string): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`UPDATE app.shipments SET label_stored = true, updated_at = ${this.#now()}
           WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid`.execute(trx),
    );
  }

  /**
   * Once every parcel has an answer: all created makes the shipment created and moves its orders
   * to Label created; any refused or unknown parcel fails it, so its orders may be labelled again,
   * and the parcels already bought go on the reconcile list (EVRI-6). Idempotent.
   */
  async settle(ctx: TenantContext, shipmentId: string): Promise<ShipmentStatus | undefined> {
    const now = this.#now();
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows: members } = await sql<{ order_id: string }>`
        SELECT order_id FROM app.shipment_orders
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
         ORDER BY order_id`.execute(trx);
      // Orders first, by id, then the shipment: the lock order of every label path.
      await this.#lockOrders(
        trx,
        ctx,
        members.map((m) => m.order_id),
      );
      const { rows } = await sql<{ status: ShipmentStatus }>`
        SELECT status FROM app.shipments
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid FOR UPDATE`.execute(
        trx,
      );
      const status = rows[0]?.status;
      if (status !== 'requested') return status;
      const parcels = await this.#parcels(trx, ctx, shipmentId);
      if (parcels.some((p) => p.state === 'pending' || p.state === 'requesting')) {
        return 'requested';
      }
      const ok = parcels.every((p) => p.state === 'created');
      if (!ok) {
        await sql`UPDATE app.shipments SET status = 'failed', updated_at = ${now}
                   WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid`.execute(
          trx,
        );
        await sql`UPDATE app.shipment_orders SET live = false
                   WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid`.execute(
          trx,
        );
        await sql`UPDATE app.parcels SET reconcile_since = ${now}, updated_at = ${now}
                   WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
                     AND state = 'created' AND reconcile_since IS NULL`.execute(trx);
        return 'failed';
      }
      await sql`UPDATE app.shipments SET status = 'created', tracking_number = ${parcels[0]?.barcode ?? null},
                       updated_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid`.execute(
        trx,
      );
      for (const m of members) await this.#moveOrder(trx, ctx, m.order_id, 'label_created', false);
      return 'created';
    });
  }

  // ---- Void and reconcile (SHP-5, EVRI-6) ---------------------------------------------------

  /**
   * Void in OmniBridge: every order on the label returns to Awaiting dispatch and stays grouped;
   * its parcels go on the reconcile list once. No carrier call. 409 while the label is still
   * being bought. (A void after dispatch is T-1202's, ADR-089 3.)
   */
  async voidShipment(ctx: TenantContext, shipmentId: string): Promise<ShipmentView> {
    const now = this.#now();
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows: members } = await sql<{ order_id: string }>`
        SELECT order_id FROM app.shipment_orders
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
         ORDER BY order_id`.execute(trx);
      if (members.length === 0) throw new ShipmentRefused('not_found');
      const orders = await this.#lockOrders(
        trx,
        ctx,
        members.map((m) => m.order_id),
      );
      if (orders.size !== members.length) throw new ShipmentRefused('not_found');
      const { rows } = await sql<{ status: ShipmentStatus }>`
        SELECT status FROM app.shipments
         WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid FOR UPDATE`.execute(
        trx,
      );
      if (rows[0]?.status !== 'created') throw new ShipmentRefused('conflict');
      const statuses = [...orders.values()].map((o) => o.status);
      // A dispatched order (or later) has had its tracking sent; anything else changed under it.
      if (
        statuses.some(
          (st) =>
            st !== 'label_created' &&
            st !== 'awaiting_dispatch' &&
            st !== 'cancelled' &&
            st !== 'pending_payment',
        )
      ) {
        throw new ShipmentRefused('tracking_sent');
      }
      if (statuses.some((st) => st !== 'label_created')) throw new ShipmentRefused('conflict');
      await sql`UPDATE app.shipments SET status = 'voided', voided_at = ${now}, updated_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid`.execute(
        trx,
      );
      await sql`UPDATE app.shipment_orders SET live = false
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid`.execute(
        trx,
      );
      await sql`UPDATE app.parcels SET state = 'voided', reconcile_since = coalesce(reconcile_since, ${now}),
                       updated_at = ${now}
                 WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
                   AND state = 'created'`.execute(trx);
      for (const m of members) {
        await this.#moveOrder(trx, ctx, m.order_id, 'awaiting_dispatch', true);
      }
      const view = await this.#view(trx, ctx, shipmentId);
      if (view === undefined) throw new ShipmentRefused('not_found');
      return view;
    });
  }

  async reconcile(
    ctx: TenantContext,
    page: { limit: number; offset: number },
  ): Promise<{ rows: ReconcileRow[]; total: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows: count } = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM app.parcels
         WHERE workspace_id = ${ctx.workspaceId}::uuid
           AND reconcile_since IS NOT NULL AND reconciled_at IS NULL`.execute(trx);
      const { rows } = await sql<{
        id: string;
        shipment_id: string;
        carrier_account_id: string;
        barcode: string | null;
        client_uid: string;
        state: ParcelState;
        reconcile_since: Date;
        refs: string[] | null;
      }>`
        SELECT p.id, p.shipment_id, p.carrier_account_id, p.barcode, p.client_uid, p.state,
               p.reconcile_since,
               (SELECT array_agg(o.external_order_id ORDER BY so.position)
                  FROM app.shipment_orders so
                  JOIN app.orders o ON o.workspace_id = so.workspace_id AND o.id = so.order_id
                 WHERE so.workspace_id = p.workspace_id AND so.shipment_id = p.shipment_id) AS refs
          FROM app.parcels p
         WHERE p.workspace_id = ${ctx.workspaceId}::uuid
           AND p.reconcile_since IS NOT NULL AND p.reconciled_at IS NULL
         ORDER BY p.reconcile_since, p.id
         LIMIT ${page.limit} OFFSET ${page.offset}`.execute(trx);
      return {
        total: Number(count[0]?.n ?? 0),
        rows: rows.map((r) => ({
          parcelId: r.id,
          shipmentId: r.shipment_id,
          carrierAccountId: r.carrier_account_id,
          barcode: r.barcode,
          clientUid: r.client_uid,
          reason: r.state === 'unknown' ? 'unknown' : 'voided',
          since: r.reconcile_since,
          orderRefs: r.refs ?? [],
        })),
      };
    });
  }

  async markReconciled(ctx: TenantContext, parcelId: string): Promise<boolean> {
    const res = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`UPDATE app.parcels SET reconciled_at = ${this.#now()}, updated_at = ${this.#now()}
           WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${parcelId}::uuid
             AND reconcile_since IS NOT NULL AND reconciled_at IS NULL`.execute(trx),
    );
    return Number(res.numAffectedRows ?? 0n) > 0;
  }

  // ---- ADR-081: the address changed after the label was printed ------------------------------

  /** A user checked the order after its address changed; it may be dispatched again. */
  async confirmAddressCheck(ctx: TenantContext, orderId: string): Promise<boolean> {
    const res = await withTenantTransaction(this.#db, ctx, (trx) =>
      sql`UPDATE app.orders SET address_changed_after_label = false, updated_at = ${this.#now()}
           WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderId}::uuid`.execute(trx),
    );
    return Number(res.numAffectedRows ?? 0n) > 0;
  }

  // ---- Internals ------------------------------------------------------------------------------

  async #lockOrders(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, LockedOrder>> {
    if (ids.length === 0) return new Map();
    const { rows } = await sql<LockedOrder>`
      SELECT ${ORDER_LOCK_COLUMNS} FROM app.orders
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ANY (${sql.val([...ids])}::uuid[])
       ORDER BY id
       FOR UPDATE`.execute(trx);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async #carriers(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    ids: readonly string[],
  ): Promise<Map<string, { id: string; provider: 'evri' | 'dpd'; needsReauth: boolean }>> {
    const { rows } = await sql<{
      id: string;
      provider: 'evri' | 'dpd';
      needs_reauth_at: Date | null;
    }>`
      SELECT id, provider, needs_reauth_at FROM app.channel_accounts
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ANY (${sql.val([...new Set(ids)])}::uuid[])
         AND provider IN ('evri', 'dpd') AND archived_at IS NULL`.execute(trx);
    return new Map(
      rows.map((r) => [
        r.id,
        { id: r.id, provider: r.provider, needsReauth: r.needs_reauth_at !== null },
      ]),
    );
  }

  async #liveShipment(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    orderId: string,
  ): Promise<string | null> {
    const { rows } = await sql<{ shipment_id: string }>`
      SELECT shipment_id FROM app.shipment_orders
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND order_id = ${orderId}::uuid AND live`.execute(
      trx,
    );
    return rows[0]?.shipment_id ?? null;
  }

  /** A Ship together repeat: the batch of the live shipment made under this key, if any. */
  async #repeatBatch(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    key: string,
  ): Promise<string | null> {
    const { rows } = await sql<{ batch_id: string }>`
      SELECT i.batch_id FROM app.shipments s
        JOIN app.label_batch_items i ON i.workspace_id = s.workspace_id AND i.shipment_id = s.id
       WHERE s.workspace_id = ${ctx.workspaceId}::uuid
         AND s.idempotency_key LIKE ${`${key}#%`}
         AND s.status IN ('requested', 'created')
       ORDER BY s.created_at DESC LIMIT 1`.execute(trx);
    return rows[0]?.batch_id ?? null;
  }

  /**
   * One shipment, its orders (earliest first, with their cost shares) and its parcels. The key is
   * the request's base and a running number, so a voided or failed request never blocks the next.
   */
  async #createShipment(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    input: {
      members: readonly LockedOrder[];
      carrier: { id: string; provider: 'evri' | 'dpd' };
      serviceCode: string;
      parcels: readonly { weightG: number }[];
      confirmShortened: boolean;
      idempotencyBase: string;
      groupId: string | null;
      userId: string | null;
    },
  ): Promise<string> {
    const now = this.#now();
    const id = randomUUID();
    const lead = input.members[0];
    if (lead === undefined) throw new Error('a shipment needs an order');
    const { rows: tries } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.shipments
       WHERE workspace_id = ${ctx.workspaceId}::uuid
         AND idempotency_key LIKE ${`${input.idempotencyBase}#%`}`.execute(trx);
    const key = `${input.idempotencyBase}#${String(Number(tries[0]?.n ?? 0) + 1)}`;
    const { rows: cost } = await sql<{ cost_pence: string; vat_rate_bp: string }>`
      SELECT cost_pence, vat_rate_bp FROM app.carrier_service_costs
       WHERE workspace_id = ${ctx.workspaceId}::uuid
         AND channel_account_id = ${input.carrier.id}::uuid
         AND service_code = ${input.serviceCode}`.execute(trx);
    const costPence = big(cost[0]?.cost_pence ?? null);
    const { rows: fmt } = await sql<{ label_format: LabelFormat }>`
      SELECT label_format FROM app.shipping_settings
       WHERE workspace_id = ${ctx.workspaceId}::uuid`.execute(trx);
    await sql`
      INSERT INTO app.shipments (workspace_id, id, company_id, carrier_account_id, provider,
                                 service_code, status, idempotency_key, group_id, label_format,
                                 confirm_shortened, cost_pence, vat_rate_bp, created_by,
                                 created_at, updated_at)
      VALUES (${ctx.workspaceId}::uuid, ${id}::uuid, ${lead.company_id}::uuid,
              ${input.carrier.id}::uuid, ${input.carrier.provider}, ${input.serviceCode},
              'requested', ${key}, ${input.groupId}::uuid,
              ${fmt[0]?.label_format ?? DEFAULT_SHIPPING_SETTINGS.labelFormat},
              ${input.confirmShortened}, ${costPence?.toString() ?? null}::bigint,
              ${cost[0]?.vat_rate_bp ?? null}::bigint, ${input.userId}::uuid, ${now}, ${now})`.execute(
      trx,
    );
    const shares = costPence === null ? null : labelCostShares(costPence, input.members.length);
    for (const [i, m] of input.members.entries()) {
      await sql`
        INSERT INTO app.shipment_orders (workspace_id, shipment_id, order_id, company_id, position,
                                         cost_share_pence)
        VALUES (${ctx.workspaceId}::uuid, ${id}::uuid, ${m.id}::uuid, ${m.company_id}::uuid,
                ${i + 1}, ${shares?.[i]?.toString() ?? null}::bigint)`.execute(trx);
    }
    // The client UID runs on per reference on this carrier account, so a relabel, or an order of
    // another channel with the same reference, never repeats one (EVRI-3).
    const ref = lead.external_order_id.slice(0, 240);
    const { rows: used } = await sql<{ n: string }>`
      SELECT coalesce(max(substring(client_uid FROM char_length(${ref}) + 2)::bigint), 0)::text AS n
        FROM app.parcels
       WHERE workspace_id = ${ctx.workspaceId}::uuid
         AND carrier_account_id = ${input.carrier.id}::uuid
         AND left(client_uid, char_length(${ref}) + 1) = ${`${ref}-`}
         AND substring(client_uid FROM char_length(${ref}) + 2) ~ '^[0-9]{1,9}$'`.execute(trx);
    let seq = Number(used[0]?.n ?? 0);
    for (const [i, p] of input.parcels.entries()) {
      seq += 1;
      await sql`
        INSERT INTO app.parcels (workspace_id, id, shipment_id, company_id, carrier_account_id,
                                 parcel_no, client_uid, weight_g, state, created_at, updated_at)
        VALUES (${ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${id}::uuid,
                ${lead.company_id}::uuid, ${input.carrier.id}::uuid, ${i + 1},
                ${clientUid(ref, seq)}, ${p.weightG}, 'pending', ${now}, ${now})`.execute(trx);
    }
    return id;
  }

  async #parcels(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    shipmentId: string,
  ): Promise<ParcelRow[]> {
    const { rows } = await sql<{
      id: string;
      parcel_no: string;
      client_uid: string;
      weight_g: string;
      state: ParcelState;
      barcode: string | null;
      error_code: string | null;
      error_fields: string[];
    }>`
      SELECT id, parcel_no, client_uid, weight_g, state, barcode, error_code, error_fields
        FROM app.parcels
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND shipment_id = ${shipmentId}::uuid
       ORDER BY parcel_no`.execute(trx);
    return rows.map((r) => ({
      id: r.id,
      parcelNo: Number(r.parcel_no),
      clientUid: r.client_uid,
      weightG: Number(r.weight_g),
      state: r.state,
      barcode: r.barcode,
      errorCode: r.error_code,
      errorFields: r.error_fields,
    }));
  }

  /** An order's status by the table (FA-10), with its status event; `labelVoid` for a void. */
  async #moveOrder(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    orderId: string,
    to: OrderStatus,
    labelVoid: boolean,
  ): Promise<void> {
    const now = this.#now();
    const { rows } = await sql<{ status: OrderStatus; raw_status: string; company_id: string }>`
      SELECT status, raw_status, company_id FROM app.orders
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderId}::uuid`.execute(trx);
    const o = rows[0];
    if (o === undefined) return;
    const next = nextOrderStatus(o.status, to, { labelVoid });
    if (next === o.status) return;
    await sql`UPDATE app.orders SET status = ${next}, updated_at = ${now}
               WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${orderId}::uuid`.execute(
      trx,
    );
    await sql`
      INSERT INTO app.order_status_events
        (workspace_id, id, company_id, order_id, status, raw_status, source_at, created_at)
      VALUES (${ctx.workspaceId}::uuid, ${randomUUID()}::uuid, ${o.company_id}::uuid,
              ${orderId}::uuid, ${next}, ${o.raw_status}, ${now}, ${now})`.execute(trx);
  }

  async #view(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    shipmentId: string,
  ): Promise<ShipmentView | undefined> {
    const { rows } = await sql<{
      id: string;
      carrier_account_id: string;
      provider: 'evri' | 'dpd';
      service_code: string;
      status: ShipmentStatus;
      tracking_number: string | null;
      cost_pence: string | null;
      vat_rate_bp: string | null;
      label_stored: boolean;
      label_format: LabelFormat;
      created_at: Date;
      voided_at: Date | null;
    }>`
      SELECT id, carrier_account_id, provider, service_code, status, tracking_number, cost_pence,
             vat_rate_bp, label_stored, label_format, created_at, voided_at
        FROM app.shipments
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND id = ${shipmentId}::uuid`.execute(trx);
    const s = rows[0];
    if (s === undefined) return undefined;
    // An order of a company the user cannot see is listed by ID only (ARCHITECTURE 6.1).
    const { rows: members } = await sql<{
      order_id: string;
      external_order_id: string | null;
      cost_share_pence: string | null;
    }>`
      SELECT so.order_id, o.external_order_id, so.cost_share_pence
        FROM app.shipment_orders so
        LEFT JOIN app.orders o ON o.workspace_id = so.workspace_id AND o.id = so.order_id
       WHERE so.workspace_id = ${ctx.workspaceId}::uuid AND so.shipment_id = ${shipmentId}::uuid
       ORDER BY so.position`.execute(trx);
    return {
      id: s.id,
      carrierAccountId: s.carrier_account_id,
      provider: s.provider,
      serviceCode: s.service_code,
      status: s.status,
      trackingNumber: s.tracking_number,
      parcels: await this.#parcels(trx, ctx, shipmentId),
      orders: members.map((m) => ({
        orderId: m.order_id,
        orderRef: m.external_order_id,
        costSharePence: big(m.cost_share_pence),
      })),
      costPence: big(s.cost_pence),
      vatRateBp: s.vat_rate_bp === null ? null : Number(s.vat_rate_bp),
      labelStored: s.label_stored,
      labelFormat: s.label_format,
      createdAt: s.created_at,
      voidedAt: s.voided_at,
    };
  }
}
