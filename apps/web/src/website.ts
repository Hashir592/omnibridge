import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  WEBSITE_HEADERS,
  WEBSITE_TIMESTAMP_WINDOW_S,
  type AnyRoute,
  type websiteRoutes,
} from '@omnibridge/contract';
import {
  ApiError,
  isUuid,
  pence,
  type Notifier,
  type TenantContext,
  type TenantRunner,
} from '@omnibridge/core';
import { Secret } from '@omnibridge/crypto';
import type {
  AccountCredentials,
  AuditLog,
  CatalogueRepository,
  ChannelAccountRepository,
  ConnectionRepository,
  MappingChange,
  OrderIngest,
  OrderIngestPorts,
  StockEngine,
  WebsiteConnectionRepository,
} from '@omnibridge/db';
import type { Logger } from '@omnibridge/logger';
import type { JobQueue } from '@omnibridge/queue';
import type { VaultClient } from '@omnibridge/vault-client';
import {
  orderIngestPorts,
  orderIngestStream,
  sendMappingChanged,
  websiteChannelOrder,
  type OrderIngestSteps,
} from '@omnibridge/order-ingest';
import type { FastifyRequest } from 'fastify';
import { connectionBody } from './connections.ts';
import { rawBodyOf, type Handlers } from './contract.ts';

/*
 * M11 website connector and Disconnect (T-1101: WEB-1 to WEB-6, OPS-12, AT-14). Setup is for
 * admins, behind the website_connector module (ADR-059, enforced by the route registry). Website
 * calls are signed (WEB-2) and are stored in the request, buyer details in pii-vault first
 * (ADR-054 FA-04, invariant 7a).
 */

export interface WebsiteOptions {
  connections: Pick<
    WebsiteConnectionRepository,
    'create' | 'settings' | 'setBaseUrl' | 'setKeys' | 'inbound' | 'answered' | 'remember'
  >;
  accounts: Pick<ChannelAccountRepository, 'create' | 'archive'>;
  /** The Connection row an answer carries (INT-4). */
  view: Pick<ConnectionRepository, 'get'>;
  credentials: Pick<AccountCredentials, 'readKind' | 'replaceKind' | 'removeAll'>;
  audit: Pick<AuditLog, 'record'>;
  /** Opens the tenant transactions of website calls, which have no session. */
  tenancy: TenantRunner;
  /** https://app.example: the website calls `<origin>/api/v1/website/<connection>`. */
  appOrigin: string;
  /**
   * Website calls (WEB-3): the order ingest step (vault first, then db-main) and the IDs it
   * answers. Without it the inbound routes answer 404.
   */
  ingest?: {
    steps: OrderIngestSteps;
    orders: Pick<OrderIngest, 'orderIds' | 'asStored' | 'apply'>;
  };
  /**
   * Disconnect (any channel account): ends its listings and clears their manual stock settings
   * (C7.3). Without it the route answers 404.
   */
  /**
   * WEB-3, CAT-5: the website's products become the account's listings; a new listing matched on
   * its exact code sends the mapped event (CAT-6). Without it the route answers 404.
   */
  products?: {
    listings: Pick<CatalogueRepository, 'upsertDiscovered'>;
    mapped: (ctx: TenantContext, change: MappingChange) => Promise<unknown>;
    /**
     * INV-7, FA-16: the products just sent are a website's listing read, so their quantities are
     * compared with their targets; a first run with no drift switches the account's stock writes
     * on (a new website account holds them until then). Called after the call's own transaction
     * has committed, as the worker reconciles after a scan: it opens short transactions of its own,
     * so its stock-row locks never come after the listing locks of the upsert (lock order,
     * F-M10-end-10).
     */
    reconcile?: (workspaceId: string, channelAccountId: string, seenAt: Date) => Promise<unknown>;
  };
  disconnect?: {
    listings: Pick<CatalogueRepository, 'endAll'>;
    stock: Pick<StockEngine, 'onListingsEnded'>;
  };
  logger: Logger;
  now?: () => Date;
}

/**
 * The website push's ingest (WEB-3): the worker's own order steps, vault first, with the web
 * token's corrections path (ADR-083). Built here because only the website files of the web app
 * may reach the ingest step (dependency rule order-ingest-only-website-in-web).
 */
export function websiteIngest(deps: {
  ingest: (ports: OrderIngestPorts) => OrderIngest;
  queue: Pick<JobQueue, 'send'>;
  notifier: Pick<Notifier, 'raisePlatform'>;
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  vault: Pick<VaultClient, 'ingest' | 'replace'>;
  logger: Logger;
}): NonNullable<WebsiteOptions['ingest']> {
  const ingest = deps.ingest(
    orderIngestPorts(deps.queue, { notifier: deps.notifier, logger: deps.logger }),
  );
  return {
    steps: orderIngestStream({
      tenancy: deps.tenancy,
      ingest,
      vault: deps.vault,
      logger: deps.logger,
      corrections: 'ingest',
    }),
    orders: ingest,
  };
}

/** CAT-6: a product the website sent that matched a Master SKU is told to M09 and M10. */
export const websiteMapped =
  (queue: Pick<JobQueue, 'send'>) => (ctx: TenantContext, change: MappingChange) =>
    sendMappingChanged(queue, ctx, change, 'auto');

const missing = () => new ApiError({ status: 404, code: 'not_found' });
const notFound = () => Promise.reject(missing());

/** WEB-1: 32 random bytes, URL-safe; shown once and kept only as a hash or encrypted. */
const newKeys = () => ({
  inbound_api_key: `obw_${randomBytes(32).toString('base64url')}`,
  signing_secret: `obs_${randomBytes(32).toString('base64url')}`,
});
export const keyHash = (key: string): Buffer => createHash('sha256').update(key).digest();

/** Equal in constant time; buffers of another length are never equal. */
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Who a signed website call is from, once its key, timestamp and signature are checked. */
interface WebsiteCaller {
  connectionId: string;
  workspaceId: string;
  companyId: string;
}
const callers = new WeakMap<FastifyRequest, WebsiteCaller>();

/**
 * WEB-2, ADR-059, AT-14: the check of a website call, before its body is validated. An unknown
 * connection, or one whose workspace has the module off, is not there (404); a wrong key, a
 * timestamp more than 5 minutes off or a wrong signature of `<timestamp>.<raw body>` is 401.
 * Logs say which check failed, never a value.
 */
export function websiteVerifier(o: WebsiteOptions) {
  const now = o.now ?? (() => new Date());
  return async (request: FastifyRequest, route: AnyRoute): Promise<boolean> => {
    const refuse = (why: string) => {
      o.logger.warn(
        { event: 'website.call_refused', route: route.id, why },
        'website call refused',
      );
      return new ApiError({ status: 401, code: 'unauthorized' });
    };
    const id = (request.params as { connectionId?: unknown }).connectionId;
    if (typeof id !== 'string' || !isUuid(id)) throw missing();
    const found = await o.connections.inbound(id);
    if (found === undefined || !found.moduleOn) throw missing();
    const header = request.headers.authorization;
    const key = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!same(keyHash(key), found.keyHash)) throw refuse('key');
    const stamp = request.headers[WEBSITE_HEADERS.timestamp];
    const at = typeof stamp === 'string' && /^\d{1,12}$/.test(stamp) ? Number(stamp) : Number.NaN;
    if (!(Math.abs(now().getTime() / 1000 - at) <= WEBSITE_TIMESTAMP_WINDOW_S)) {
      throw refuse('timestamp');
    }
    const secret = await o.tenancy.runWorkspace({ workspaceId: found.workspaceId }, (ctx) =>
      o.credentials.readKind(ctx, id, 'website.signing_secret'),
    );
    const sent = request.headers[WEBSITE_HEADERS.signature];
    if (secret === undefined || typeof sent !== 'string' || !/^[0-9a-f]{64}$/i.test(sent)) {
      throw refuse('signature');
    }
    const expected = createHmac('sha256', secret.reveal())
      .update(`${String(at)}.`)
      .update(rawBodyOf(request) ?? Buffer.alloc(0))
      .digest();
    if (!same(Buffer.from(sent, 'hex'), expected)) throw refuse('signature');
    callers.set(request, {
      connectionId: id,
      workspaceId: found.workspaceId,
      companyId: found.companyId,
    });
    return true;
  };
}

/** The checked caller of a website route; never absent once the verifier has run. */
function callerOf(request: FastifyRequest): WebsiteCaller {
  const caller = callers.get(request);
  if (caller === undefined) throw new ApiError({ status: 401, code: 'unauthorized' });
  return caller;
}

/** WEB-2: every website call names its Idempotency-Key. */
function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers[WEBSITE_HEADERS.idempotencyKey];
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw new ApiError({
      status: 400,
      code: 'bad_request',
      detail: 'Send an Idempotency-Key header of 1 to 200 characters',
    });
  }
  return key;
}

/** What a website call answers, and what its Idempotency-Key replays. */
interface Answer {
  status: 200 | 201;
  body: Readonly<Record<string, unknown>>;
}

/**
 * WEB-2: a website call runs once per Idempotency-Key. The same key and body give the kept
 * answer; another body under it is 409. `prepare` runs with no transaction open (the vault step,
 * ADR-054 FA-04) and returns the work of one tenant transaction, which runs under the key's lock
 * and whose answer is kept.
 */
async function once<A extends Answer>(
  o: WebsiteOptions,
  request: FastifyRequest,
  route: string,
  prepare: (caller: WebsiteCaller) => Promise<(ctx: TenantContext) => Promise<A>>,
): Promise<A> {
  const caller = callerOf(request);
  const key = idempotencyKey(request);
  const hash = createHash('sha256')
    .update(`${route}\n`)
    .update(rawBodyOf(request) ?? Buffer.alloc(0))
    .digest();
  const actor = { workspaceId: caller.workspaceId };
  const account = caller.connectionId;
  const replay = (prior: { requestHash: Buffer; status: number; response: object }): A => {
    if (!prior.requestHash.equals(hash)) {
      throw new ApiError({
        status: 409,
        code: 'conflict',
        detail: 'Idempotency-Key used for another request',
      });
    }
    // The kept answer is one this route gave, so it has this route's shape.
    return { status: prior.status === 201 ? 201 : 200, body: prior.response } as A;
  };
  const prior = await o.tenancy.runWorkspace(actor, (ctx) =>
    o.connections.answered(ctx, account, key),
  );
  if (prior !== undefined) return replay(prior);
  const work = await prepare(caller);
  return o.tenancy.runWorkspace(actor, async (ctx) => {
    // Under the key's lock: a call with the same key that ran meanwhile has answered.
    const meanwhile = await o.connections.answered(ctx, account, key);
    if (meanwhile !== undefined) return replay(meanwhile);
    const answer = await work(ctx);
    await o.connections.remember(ctx, {
      channelAccountId: account,
      companyId: caller.companyId,
      key,
      route,
      requestHash: hash,
      status: answer.status,
      response: answer.body,
    });
    return answer;
  });
}

export function websiteHandlers(options?: WebsiteOptions): Handlers<typeof websiteRoutes> {
  if (options === undefined) {
    return {
      createWebsiteConnection: notFound,
      getWebsiteSettings: notFound,
      updateWebsiteSettings: notFound,
      reissueWebsiteKeys: notFound,
      disconnectAccount: notFound,
      websitePushOrder: notFound,
      websiteCancelOrder: notFound,
      websiteRefundOrder: notFound,
      websitePushProducts: notFound,
    };
  }
  const o = options;
  const now = o.now ?? (() => new Date());

  /** The settings the screen shows; never a key. 404 when the account is not a website. */
  const settingsOf = async (tenant: TenantContext, accountId: string) => {
    const row = await o.connections.settings(tenant, accountId);
    if (row === undefined) throw missing();
    const outbound = await o.credentials.readKind(tenant, accountId, 'website.api_key');
    return {
      connection_id: row.channelAccountId,
      inbound_url: `${o.appOrigin}/api/v1/website/${row.channelAccountId}`,
      base_url: row.baseUrl,
      inbound_key_hint: row.inboundKeyHint,
      keys_issued_at: row.keysIssuedAt.toISOString(),
      outbound_key_set: outbound !== undefined,
    };
  };

  /** A new key and secret: the key kept as its hash, the secret encrypted (WEB-1, WEB-2). */
  const issueKeys = async (tenant: TenantContext, accountId: string) => {
    const keys = newKeys();
    await o.credentials.replaceKind(
      tenant,
      accountId,
      'website.signing_secret',
      new Secret(keys.signing_secret),
    );
    return {
      keys,
      keyHash: keyHash(keys.inbound_api_key),
      keyHint: keys.inbound_api_key.slice(-4),
    };
  };

  return {
    createWebsiteConnection: async ({ body, tenant, session, request }) => {
      // A company of another workspace, or one this admin does not see, is not there.
      if (!tenant.companyIds.includes(body.company_id)) throw missing();
      const accountId = await o.accounts.create(tenant, {
        companyId: body.company_id,
        provider: 'website',
        displayName: body.display_name,
        // FA-16: a new account holds its stock writes until its first clean reconciliation.
        holdStockPush: true,
      });
      const { keys, keyHash: hash, keyHint } = await issueKeys(tenant, accountId);
      await o.connections.create(tenant, {
        channelAccountId: accountId,
        companyId: body.company_id,
        baseUrl: body.base_url,
        keyHash: hash,
        keyHint,
      });
      await o.credentials.replaceKind(
        tenant,
        accountId,
        'website.api_key',
        new Secret(body.outbound_api_key),
      );
      await o.audit.record(tenant, {
        action: 'connection.added',
        actor: { kind: 'user', userId: session.userId },
        entityId: accountId,
        after: {
          provider: 'website',
          company_id: body.company_id,
          display_name: body.display_name,
        },
        ip: request.ip,
      });
      const connection = await o.view.get(tenant, accountId, now());
      if (connection === undefined) throw missing();
      return {
        status: 201,
        body: {
          connection: connectionBody(connection),
          settings: await settingsOf(tenant, accountId),
          keys,
        },
      };
    },

    getWebsiteSettings: async ({ params, tenant }) => ({
      status: 200,
      body: await settingsOf(tenant, params.accountId),
    }),

    updateWebsiteSettings: async ({ params, body, tenant, session, request }) => {
      const before = await settingsOf(tenant, params.accountId);
      if (body.base_url !== undefined) {
        await o.connections.setBaseUrl(tenant, params.accountId, body.base_url);
      }
      if (body.outbound_api_key !== undefined) {
        await o.credentials.replaceKind(
          tenant,
          params.accountId,
          'website.api_key',
          new Secret(body.outbound_api_key),
        );
      }
      await o.audit.record(tenant, {
        action: 'website.settings_changed',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.accountId,
        before: { base_url: before.base_url },
        after: {
          base_url: body.base_url ?? before.base_url,
          outbound_key_changed: body.outbound_api_key !== undefined,
        },
        ip: request.ip,
      });
      return { status: 200, body: await settingsOf(tenant, params.accountId) };
    },

    reissueWebsiteKeys: async ({ params, tenant, session, request }) => {
      await settingsOf(tenant, params.accountId);
      const { keys, keyHash: hash, keyHint } = await issueKeys(tenant, params.accountId);
      await o.connections.setKeys(tenant, params.accountId, { keyHash: hash, keyHint });
      const after = await settingsOf(tenant, params.accountId);
      await o.audit.record(tenant, {
        action: 'website.keys_reissued',
        actor: { kind: 'user', userId: session.userId },
        entityId: params.accountId,
        after: { keys_issued_at: after.keys_issued_at },
        ip: request.ip,
      });
      return { status: 200, body: keys };
    },

    disconnectAccount: async ({ params, tenant, session, request }) => {
      const d = o.disconnect;
      if (d === undefined) throw missing();
      const id = params.accountId;
      const before = await o.view.get(tenant, id, now());
      if (before === undefined) throw missing();
      // One transaction (the request's): its writes stop as it is archived; the website's own calls
      // find no connection (app.website_inbound skips archived accounts); syncs and outbound writes
      // see it disconnected.
      const archived = await o.accounts.archive(tenant, id);
      const ended = await d.listings.endAll(tenant, id, now());
      if (ended.length > 0) await d.stock.onListingsEnded(tenant, ended);
      await o.credentials.removeAll(tenant, id);
      if (archived) {
        await o.audit.record(tenant, {
          action: 'connection.removed',
          actor: { kind: 'user', userId: session.userId },
          entityId: id,
          before: {
            provider: before.provider,
            company_id: before.companyId,
            display_name: before.displayName,
          },
          ip: request.ip,
        });
      }
      const after = await o.view.get(tenant, id, now());
      if (after === undefined) throw missing();
      return {
        status: 200,
        body: { connection: connectionBody(after), listings_ended: ended.length },
      };
    },

    websitePushOrder: ({ body, request }) => {
      if (o.ingest === undefined) return notFound();
      const { steps, orders } = o.ingest;
      const id = body.externalOrderId;
      return once(o, request, 'websitePushOrder', async (caller) => {
        const account = caller.connectionId;
        // Vault first, with no transaction open (ADR-054 FA-04, invariant 3).
        const order = websiteChannelOrder(body);
        const job = { workspaceId: caller.workspaceId, channelAccountId: account };
        const ready = (await steps.prepare?.(job, [order])) ?? [order];
        return async (ctx) => {
          const before = await orders.orderIds(ctx, account, [id]);
          await steps.sink(ctx, account, ready);
          const stored = (await orders.orderIds(ctx, account, [id])).get(id);
          if (stored === undefined) throw new Error('website order not stored');
          return { status: before.has(id) ? 200 : 201, body: { omnibridgeOrderId: stored } };
        };
      });
    },

    websiteCancelOrder: ({ params, body, request }) => {
      if (o.ingest === undefined) return notFound();
      const { orders } = o.ingest;
      const ext = params.externalOrderId;
      return once(o, request, 'websiteCancelOrder', (caller) =>
        Promise.resolve(async (ctx: TenantContext) => {
          const account = caller.connectionId;
          const found = await orders.asStored(ctx, account, ext);
          if (found === undefined) throw missing();
          // The state table decides, as for a poll: a dispatched order stays dispatched (FA-10).
          // A cancellation deletes the buyer's record (DEL-1) through ingest's own port.
          await orders.apply(ctx, account, [
            {
              ...found.order,
              state: 'cancelled',
              rawStatus: 'cancelled',
              cancelledAt: new Date(body.cancelledAt),
            },
          ]);
          return { status: 200 as const, body: { omnibridgeOrderId: found.id } };
        }),
      );
    },

    websiteRefundOrder: ({ params, body, request }) => {
      if (o.ingest === undefined) return notFound();
      const { orders } = o.ingest;
      const ext = params.externalOrderId;
      return once(o, request, 'websiteRefundOrder', (caller) =>
        Promise.resolve(async (ctx: TenantContext) => {
          const account = caller.connectionId;
          const found = await orders.asStored(ctx, account, ext);
          if (found === undefined) throw missing();
          const answer = { omnibridgeOrderId: found.id };
          // A refund ID already recorded changes nothing (VAT-6 rows are keyed per refund).
          if (found.order.refunds.some((r) => r.refundId === body.refundId)) {
            return { status: 200 as const, body: answer };
          }
          const refund = {
            refundId: body.refundId,
            refundedAt: new Date(body.refundedAt),
            amount: pence(BigInt(body.amountGross)),
            lines:
              body.lines === null || body.lines === undefined
                ? null
                : body.lines.map((l) => ({
                    lineId: l.externalLineId,
                    quantity: l.quantity,
                    amount: pence(BigInt(l.amountGross)),
                  })),
          };
          await orders.apply(ctx, account, [
            { ...found.order, refunds: [...found.order.refunds, refund] },
          ]);
          // Ingest books a refund only on a paid order; anything else was not recorded.
          const after = await orders.asStored(ctx, account, ext);
          if (!after?.order.refunds.some((r) => r.refundId === body.refundId)) {
            throw new ApiError({
              status: 422,
              code: 'validation_failed',
              detail: 'The order has no payment to refund',
            });
          }
          return { status: 201 as const, body: answer };
        }),
      );
    },

    websitePushProducts: ({ body, request }) => {
      const products = o.products;
      if (products === undefined) return notFound();
      const seenAt = now();
      const caller = callerOf(request);
      const stored = once(o, request, 'websitePushProducts', () =>
        Promise.resolve(async (ctx: TenantContext) => {
          const { autoMapped } = await products.listings.upsertDiscovered(
            ctx,
            caller.connectionId,
            'website',
            body.products.map((p) => ({
              externalSku: p.externalSku,
              // The website names a product by its SKU alone.
              externalId: p.externalSku,
              title: p.title ?? null,
              fulfilment: null,
              inventoryApi: null,
              quantity: p.quantity ?? null,
            })),
            seenAt,
          );
          for (const change of autoMapped) await products.mapped(ctx, change);
          return { status: 200 as const, body: { received: body.products.length } };
        }),
      );
      return stored.then(async (answer) => {
        // The products are stored: a reconcile failure is logged, and the next push runs it again.
        try {
          await products.reconcile?.(caller.workspaceId, caller.connectionId, seenAt);
        } catch (err) {
          o.logger.error(
            { event: 'stock.reconcile_failed', channelAccountId: caller.connectionId, err },
            'reconciliation failed after a website products call',
          );
        }
        return answer;
      });
    },
  };
}
