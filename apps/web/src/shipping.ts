import { Readable } from 'node:stream';
import type { shippingRoutes } from '@omnibridge/contract';
import { pageOffset, pageResult } from '@omnibridge/contract';
import {
  ApiError,
  CARRIER_SERVICES,
  carrierErrorWords,
  isCarrierService,
  type Notifier,
  type TenantContext,
} from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import {
  ShipmentRefused,
  ShipTogetherChanged,
  type AccountCredentials,
  type AuditLog,
  type BatchItemView,
  type ChannelAccountRepository,
  type ConnectionRepository,
  type ShipmentView,
  type ShippingRepository,
} from '@omnibridge/db';
import {
  labelsCreateJob,
  labelsDiscardJob,
  labelsFetchJob,
  type JobQueue,
} from '@omnibridge/queue';
import type { VaultClient } from '@omnibridge/vault-client';
import type { Handlers } from './contract.ts';
import { connectionBody } from './connections.ts';
import { EvriCodeRefused, type EvriFlow } from './oauth-exchange.ts';

/*
 * M12 shipping desk, Evri and tracking (T-1201: SHIP-1, SHIP-3, SHIP-4, EVRI-2, EVRI-5, EVRI-6,
 * SHP-2, SHP-5, SHP-7, SHP-9; T-1202 adds the desk, rules, slips and tracking routes).
 *
 * Labels are bought by the worker, at most once per parcel: a request only locks and checks the
 * orders and writes the shipments, in its one transaction, with the label job queued in it. Label
 * files are merged by pii-vault on download and streamed, never stored here (invariant 11).
 */

export interface ShippingOptions {
  shipping: Pick<
    ShippingRepository,
    | 'settings'
    | 'putSettings'
    | 'carrierAccounts'
    | 'costs'
    | 'putCosts'
    | 'requestLabels'
    | 'requestShipTogether'
    | 'batch'
    | 'shipment'
    | 'printable'
    | 'voidShipment'
    | 'reconcile'
    | 'markReconciled'
    | 'confirmAddressCheck'
  >;
  /** The web token: merge labels for printing (logged by the vault) and list stored ones. */
  vault: Pick<VaultClient, 'mergeLabels' | 'storedLabels'>;
  queue: Pick<JobQueue, 'send'>;
  audit: Pick<AuditLog, 'record'>;
  /** EVRI-2: Evri's code flow (INT-2's one web provider call). */
  evri: EvriFlow;
  accounts: Pick<ChannelAccountRepository, 'create'>;
  credentials: Pick<AccountCredentials, 'replaceKind'>;
  connections: Pick<ConnectionRepository, 'get' | 'recordSuccess'>;
  notifier: Pick<Notifier, 'resolve'>;
  now?: () => Date;
}

const notFound = () => Promise.reject(new ApiError({ status: 404, code: 'not_found' }));
const missing = () => new ApiError({ status: 404, code: 'not_found' });
const iso = (d: Date | null) => (d === null ? null : d.toISOString());
const n = (v: bigint | null) => (v === null ? null : Number(v));

function batchBody(id: string, createdAt: Date, items: readonly BatchItemView[]) {
  return {
    id,
    created_at: createdAt.toISOString(),
    done: items.every((i) => i.state !== 'queued' && i.state !== 'creating'),
    items: items.map((i) => ({
      order_id: i.orderId,
      order_ref: i.orderRef,
      shipment_id: i.shipmentId,
      state: i.state,
      tracking_number: i.trackingNumber,
      refusal: i.refusal,
      error:
        i.error === null
          ? null
          : {
              code: i.error.code,
              message: carrierErrorWords(i.error.code),
              fields: i.error.fields,
            },
    })),
  };
}

function shipmentBody(s: ShipmentView) {
  return {
    id: s.id,
    carrier_account_id: s.carrierAccountId,
    provider: s.provider,
    service_code: s.serviceCode,
    status: s.status,
    tracking_number: s.trackingNumber,
    parcels: s.parcels.map((p) => ({
      parcel_no: p.parcelNo,
      weight_g: p.weightG,
      state: p.state,
      barcode: p.barcode,
      error:
        p.errorCode === null
          ? null
          : { code: p.errorCode, message: carrierErrorWords(p.errorCode), fields: p.errorFields },
    })),
    orders: s.orders.map((o) => ({
      order_id: o.orderId,
      order_ref: o.orderRef,
      cost_share_pence: n(o.costSharePence),
    })),
    cost_pence: n(s.costPence),
    vat_rate_bp: s.vatRateBp,
    label_stored: s.labelStored,
    created_at: s.createdAt.toISOString(),
    voided_at: iso(s.voidedAt),
  };
}

/** The label files of a shipment are its bought parcels (one file per parcel). */
const labelIds = (s: ShipmentView) =>
  s.parcels.filter((p) => p.barcode !== null && p.state === 'created').map((p) => p.id);

const pdfBody = (bytes: Uint8Array) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    stream: Readable.from([buffer]),
    contentType: 'application/pdf',
    sizeBytes: buffer.length,
  };
};

export function shippingHandlers(options?: ShippingOptions): Handlers<typeof shippingRoutes> {
  // T-1202 builds these: until then they answer 404.
  const later = {
    getShippingRules: notFound,
    putShippingRules: notFound,
    getShippingDesk: notFound,
    packingSlips: notFound,
    listOrderTracking: notFound,
    resendTracking: notFound,
  };
  if (options === undefined) {
    return {
      ...later,
      listCarrierAccounts: notFound,
      getEvriAuthoriseUrl: notFound,
      connectEvri: notFound,
      reauthoriseEvri: notFound,
      getServiceCosts: notFound,
      putServiceCosts: notFound,
      getShippingSettings: notFound,
      putShippingSettings: notFound,
      createLabels: notFound,
      shipTogether: notFound,
      getLabelBatch: notFound,
      printLabels: notFound,
      getShipment: notFound,
      reprintShipment: notFound,
      voidShipment: notFound,
      listReconcile: notFound,
      markReconciled: notFound,
      confirmAddressCheck: notFound,
    };
  }
  const o = options;
  const now = o.now ?? (() => new Date());

  /** Every label job is queued in the request's transaction, IDs only (invariant 7a). */
  const ports = {
    validService: isCarrierService,
    queue: async (ctx: TenantContext, s: { id: string; carrierAccountId: string }) => {
      await o.queue.send(labelsCreateJob, {
        ctx,
        channelAccountId: s.carrierAccountId,
        idempotencyKey: `labels.create:${s.id}`,
        payload: { shipment_id: s.id },
      });
    },
  };

  /** A carrier account the user may use (SHIP-1: any company's). */
  const carrier = async (tenant: TenantContext, accountId: string) => {
    const found = (await o.shipping.carrierAccounts(tenant)).find((c) => c.id === accountId);
    if (found === undefined) throw missing();
    return found;
  };

  const exchange = async (code: string): Promise<Secret> => {
    try {
      return (await o.evri.exchange(code)).token;
    } catch (err) {
      if (err instanceof EvriCodeRefused) {
        throw new ApiError({
          status: 400,
          code: 'validation_failed',
          detail:
            'Evri did not accept this code. A code works once, within 72 hours of signing in.',
          errors: [{ location: 'body', path: 'auth_code', message: 'Get a new code from Evri' }],
        });
      }
      throw err;
    }
  };

  const batchAnswer = async (tenant: TenantContext, batchId: string) => {
    const items = await o.shipping.batch(tenant, batchId);
    if (items === undefined) throw missing();
    return { status: 202 as const, body: batchBody(batchId, now(), items) };
  };

  const refused = (err: unknown): never => {
    if (err instanceof ShipmentRefused) {
      if (err.code === 'not_found') throw missing();
      if (err.code === 'tracking_sent') {
        throw new ApiError({
          status: 409,
          code: 'tracking_sent',
          detail:
            'Tracking was already sent to the channel, so this label can no longer be voided here.',
        });
      }
      throw new ApiError({
        status: 409,
        code: 'conflict',
        detail:
          'This label is still being bought, was already voided, or one of its orders changed. Read it again.',
      });
    }
    throw err;
  };

  return {
    ...later,

    // ---- Carriers (SHIP-1, EVRI-2, SHP-7) --------------------------------------------------

    listCarrierAccounts: async ({ tenant }) => ({
      status: 200,
      body: {
        items: (await o.shipping.carrierAccounts(tenant)).map((c) => ({
          id: c.id,
          provider: c.provider,
          display_name: c.displayName,
          company_id: c.companyId,
          status: c.needsReauth ? 'needs_reauth' : c.paused ? 'paused' : 'active',
          services: CARRIER_SERVICES[c.provider].map((s) => ({ ...s })),
        })),
      },
    }),

    getEvriAuthoriseUrl: async () => {
      const url = await o.evri.authoriseUrl();
      if (url === undefined) {
        throw new ApiError({
          status: 503,
          code: 'service_unavailable',
          detail: 'Evri cannot be connected yet: its app credentials are not set.',
        });
      }
      return { status: 200, body: { url } };
    },

    connectEvri: async ({ body, tenant, session, request }) => {
      if (!tenant.companyIds.includes(body.company_id)) throw missing();
      const token = await exchange(body.auth_code);
      const accountId = await o.accounts.create(tenant, {
        companyId: body.company_id,
        provider: 'evri',
        displayName: body.display_name,
      });
      await o.credentials.replaceKind(tenant, accountId, 'evri.api_key', token);
      await o.audit.record(tenant, {
        action: 'connection.added',
        actor: { kind: 'user', userId: session.userId },
        entityId: accountId,
        after: { provider: 'evri', company_id: body.company_id, display_name: body.display_name },
        ip: request.ip,
      });
      const connection = await o.connections.get(tenant, accountId, now());
      if (connection === undefined) throw missing();
      return { status: 201, body: connectionBody(connection) };
    },

    reauthoriseEvri: async ({ params, body, tenant, session, request }) => {
      const account = await o.connections.get(tenant, params.accountId, now());
      if (account?.provider !== 'evri') throw missing();
      const token = await exchange(body.auth_code);
      await o.credentials.replaceKind(tenant, params.accountId, 'evri.api_key', token);
      const { reauthCleared } = await o.connections.recordSuccess(tenant, params.accountId, now());
      if (reauthCleared) {
        await o.notifier.resolve(tenant, 'channel.auth_lost', {
          kind: 'channel_account',
          id: params.accountId,
        });
      }
      await o.audit.record(tenant, {
        action: 'connection.reauthorised',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.accountId,
        after: { provider: 'evri', expires_at: null },
        ip: request.ip,
      });
      const connection = await o.connections.get(tenant, params.accountId, now());
      if (connection === undefined) throw missing();
      return { status: 200, body: connectionBody(connection) };
    },

    getServiceCosts: async ({ params, tenant }) => {
      await carrier(tenant, params.accountId);
      const items = await o.shipping.costs(tenant, params.accountId);
      return {
        status: 200,
        body: {
          items: items.map((c) => ({
            service_code: c.serviceCode,
            cost_pence: Number(c.costPence),
            vat_rate_bp: c.vatRateBp,
          })),
        },
      };
    },

    putServiceCosts: async ({ params, body, tenant, session, request }) => {
      const account = await carrier(tenant, params.accountId);
      const unknown = body.items.find((c) => !isCarrierService(account.provider, c.service_code));
      if (unknown !== undefined) {
        throw new ApiError({
          status: 400,
          code: 'validation_failed',
          errors: [
            { location: 'body', path: 'items', message: `Unknown service ${unknown.service_code}` },
          ],
        });
      }
      const items = await o.shipping.putCosts(
        tenant,
        params.accountId,
        body.items.map((c) => ({
          serviceCode: c.service_code,
          costPence: BigInt(c.cost_pence),
          vatRateBp: c.vat_rate_bp,
        })),
      );
      await o.audit.record(tenant, {
        action: 'shipping.costs_changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.accountId,
        after: { service_count: items.length },
        ip: request.ip,
      });
      return {
        status: 200,
        body: {
          items: items.map((c) => ({
            service_code: c.serviceCode,
            cost_pence: Number(c.costPence),
            vat_rate_bp: c.vatRateBp,
          })),
        },
      };
    },

    // ---- Settings (SHP-2, SHP-4, SHP-6, ADR-089) -------------------------------------------

    getShippingSettings: async ({ tenant }) => {
      const s = await o.shipping.settings(tenant);
      return {
        status: 200,
        body: {
          auto_dispatch_on_label: s.autoDispatchOnLabel,
          label_format: s.labelFormat,
          packaging_allowance_g: s.packagingAllowanceG,
          packing_slip_enabled: s.packingSlipEnabled,
          tracking_hold_minutes: s.trackingHoldMinutes,
        },
      };
    },

    putShippingSettings: async ({ body, tenant, session, request }) => {
      const before = await o.shipping.settings(tenant);
      const s = await o.shipping.putSettings(tenant, {
        autoDispatchOnLabel: body.auto_dispatch_on_label,
        labelFormat: body.label_format,
        packagingAllowanceG: body.packaging_allowance_g,
        packingSlipEnabled: body.packing_slip_enabled,
        trackingHoldMinutes: body.tracking_hold_minutes,
      });
      await o.audit.record(tenant, {
        action: 'shipping.settings_changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: tenant.workspaceId,
        before: {
          auto_dispatch_on_label: before.autoDispatchOnLabel,
          label_format: before.labelFormat,
          packaging_allowance_g: before.packagingAllowanceG,
          packing_slip_enabled: before.packingSlipEnabled,
          tracking_hold_minutes: before.trackingHoldMinutes,
        },
        after: body,
        ip: request.ip,
      });
      return {
        status: 200,
        body: {
          auto_dispatch_on_label: s.autoDispatchOnLabel,
          label_format: s.labelFormat,
          packaging_allowance_g: s.packagingAllowanceG,
          packing_slip_enabled: s.packingSlipEnabled,
          tracking_hold_minutes: s.trackingHoldMinutes,
        },
      };
    },

    // ---- Labels (SHP-2, SHP-5, SHP-9, EVRI-5, EVRI-6) --------------------------------------

    createLabels: async ({ body, tenant, session }) => {
      try {
        const { batchId } = await o.shipping.requestLabels(
          tenant,
          {
            userId: session.userId,
            orders: body.orders.map((r) => ({
              orderId: r.order_id,
              carrierAccountId: r.carrier_account_id,
              serviceCode: r.service_code,
              parcels: r.parcels.map((p) => ({ weightG: p.weight_g })),
              ...(r.line_ids === undefined ? {} : { lineIds: r.line_ids }),
              ...(r.confirm_shortened === undefined
                ? {}
                : { confirmShortened: r.confirm_shortened }),
            })),
          },
          ports,
        );
        return await batchAnswer(tenant, batchId);
      } catch (err) {
        return refused(err);
      }
    },

    shipTogether: async ({ body, tenant, session }) => {
      try {
        const { batchId } = await o.shipping.requestShipTogether(
          tenant,
          {
            userId: session.userId,
            groupId: body.group_id,
            orderIds: body.order_ids,
            carrierAccountId: body.carrier_account_id,
            serviceCode: body.service_code,
            parcels: body.parcels.map((p) => ({ weightG: p.weight_g })),
            ...(body.confirm_shortened === undefined
              ? {}
              : { confirmShortened: body.confirm_shortened }),
          },
          ports,
        );
        return await batchAnswer(tenant, batchId);
      } catch (err) {
        if (err instanceof ShipTogetherChanged) {
          throw new ApiError({
            status: 409,
            code: 'order_changed',
            detail: `Order ${err.orderRef} changed since this was opened. Nothing was bought; check the group and try again.`,
          });
        }
        return refused(err);
      }
    },

    getLabelBatch: async ({ params, tenant }) => {
      const items = await o.shipping.batch(tenant, params.batchId);
      if (items === undefined) throw missing();
      return { status: 200, body: batchBody(params.batchId, now(), items) };
    },

    printLabels: async ({ body, tenant, session }) => {
      const ids: string[] = [];
      for (const shipmentId of body.shipment_ids) {
        const s = await o.shipping.shipment(tenant, shipmentId);
        if (s === undefined) throw missing();
        if (s.status !== 'created' || !s.labelStored) {
          throw new ApiError({
            status: 409,
            code: 'conflict',
            detail: 'A label is not ready to print. Reprint it, or remove it from this print.',
          });
        }
        ids.push(...labelIds(s));
      }
      if (ids.length === 0 || ids.length > 200) {
        throw new ApiError({ status: 400, code: 'bad_request', detail: 'Print 1 to 200 labels.' });
      }
      const pdf = await o.vault.mergeLabels({
        workspaceId: tenant.workspaceId,
        labelIds: ids,
        actorUserId: session.userId,
      });
      return { status: 200, body: pdfBody(pdf) };
    },

    getShipment: async ({ params, tenant }) => {
      const s = await o.shipping.shipment(tenant, params.shipmentId);
      if (s === undefined) throw missing();
      return { status: 200, body: shipmentBody(s) };
    },

    reprintShipment: async ({ params, tenant, session }) => {
      const s = await o.shipping.shipment(tenant, params.shipmentId);
      if (s === undefined) throw missing();
      if (s.status !== 'created') {
        throw new ApiError({
          status: 409,
          code: 'conflict',
          detail: 'Only a bought label reprints.',
        });
      }
      const ids = labelIds(s);
      const { label_ids: stored } = await o.vault.storedLabels(tenant.workspaceId, ids);
      if (ids.length > 0 && ids.every((id) => stored.includes(id))) {
        const pdf = await o.vault.mergeLabels({
          workspaceId: tenant.workspaceId,
          labelIds: ids,
          actorUserId: session.userId,
        });
        return { status: 200, body: pdfBody(pdf) };
      }
      // EVRI-5: fetched again by barcode; never a new parcel.
      await o.queue.send(labelsFetchJob, {
        ctx: tenant,
        channelAccountId: s.carrierAccountId,
        idempotencyKey: `labels.fetch:${s.id}:${String(now().getTime())}`,
        payload: { shipment_id: s.id },
      });
      return { status: 202, body: shipmentBody(s) };
    },

    voidShipment: async ({ params, tenant, session, request }) => {
      let view: ShipmentView;
      try {
        view = await o.shipping.voidShipment(tenant, params.shipmentId);
      } catch (err) {
        return refused(err);
      }
      // SHP-5: the voided label's file leaves the vault at once (invariant 11).
      await o.queue.send(labelsDiscardJob, {
        ctx: tenant,
        channelAccountId: view.carrierAccountId,
        idempotencyKey: `labels.discard:${view.id}`,
        payload: { shipment_id: view.id },
      });
      await o.audit.record(tenant, {
        action: 'label.voided',
        actor: { kind: 'user', userId: session.userId },
        entityId: view.id,
        after: { order_count: view.orders.length },
        ip: request.ip,
      });
      return { status: 200, body: shipmentBody(view) };
    },

    listReconcile: async ({ query, tenant }) => {
      const { rows, total } = await o.shipping.reconcile(tenant, {
        limit: query.limit,
        offset: pageOffset(query),
      });
      return {
        status: 200,
        body: await pageResult({
          items: rows.map((r) => ({
            parcel_id: r.parcelId,
            shipment_id: r.shipmentId,
            carrier_account_id: r.carrierAccountId,
            barcode: r.barcode,
            client_uid: r.clientUid,
            reason: r.reason,
            since: r.since.toISOString(),
            order_refs: r.orderRefs,
          })),
          page: query.page,
          limit: query.limit,
          countUpTo: () => Promise.resolve(total),
        }),
      };
    },

    markReconciled: async ({ params, tenant }) => {
      if (!(await o.shipping.markReconciled(tenant, params.parcelId))) throw missing();
      return { status: 204, body: null };
    },

    confirmAddressCheck: async ({ params, tenant }) => {
      if (!(await o.shipping.confirmAddressCheck(tenant, params.orderId))) throw missing();
      // ADR-081: the warning goes once the order has been checked.
      await o.notifier.resolve(tenant, 'shipping.address_changed', {
        kind: 'order',
        id: params.orderId,
      });
      return { status: 204, body: null };
    },
  };
}
