import { randomUUID } from 'node:crypto';
import { Notifier } from '@omnibridge/core';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  AccountCredentials,
  AuditLog,
  ChannelAccountRepository,
  CompanyRepository,
  ConnectionRepository,
  createMainDb,
  CredentialRepository,
  MembershipRepository,
  migrateMain,
  NotificationRepository,
  ShippingRepository,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { buildMockServer } from '@omnibridge/provider-mocks';
import { sessionHeaders, startRoleCluster, stubAuth, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';
import { createEvriFlow } from './oauth-exchange.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const address = { line1: '1 Example Street', city: 'Testville', postcode: 'TE1 1ST' };

/**
 * The shipping routes of T-1201 (EVRI-2, SHIP-1, SHP-2, SHP-7, SHP-9, SHP-5): connecting Evri with
 * a pasted code, label requests that queue one job per shipment in the request's transaction, and
 * the refusals a user meets in plain words.
 */
describe('shipping routes (T-1201)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  const mock = buildMockServer(createLogger({ service: 'mock', version: '0', level: 'silent' }));
  let mockUrl = '';
  const A = randomUUID();
  const admin = randomUUID();
  let company = '';
  let ebay = '';
  const sent: { type: string; key: string }[] = [];

  const app = () =>
    buildWebApp({
      logger,
      version: '0',
      checks,
      tenancy,
      ...stubAuth(),
      shipping: {
        shipping: new ShippingRepository(db.db),
        vault: {
          mergeLabels: () => Promise.resolve(new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n'))),
          storedLabels: () => Promise.resolve({ label_ids: [] }),
        },
        queue: {
          send: (def, input) => {
            sent.push({ type: def.type, key: input.idempotencyKey });
            return Promise.resolve({ id: randomUUID(), created: true });
          },
        },
        audit: new AuditLog(db.db),
        evri: createEvriFlow({
          mode: 'mock',
          mocksUrl: mockUrl,
          mocksPublicUrl: mockUrl,
          secrets: (name) => Promise.resolve(new Secret(`synthetic-${name}`)),
        }),
        accounts: new ChannelAccountRepository(db.db),
        credentials: new AccountCredentials(
          db.db,
          new CredentialRepository({
            keyring: parseKeyring('secrets', generateKekLine(1)),
            logger,
          }),
        ),
        connections: new ConnectionRepository(db.db),
        notifier: new Notifier({ store: new NotificationRepository(db.db) }),
      },
    });
  const asAdmin = sessionHeaders({ workspaceId: A, userId: admin, sessionId: 'session-admin' });
  const order = async () => {
    const id = randomUUID();
    await root.query(
      `INSERT INTO app.orders
         (workspace_id, id, company_id, provider, origin, channel_account_id, external_order_id,
          pii_subject, pii_ref, status, raw_status, placed_at, source_updated_at, tax_point_date,
          goods_pence, gross_pence, stock_moves, created_at, updated_at)
       VALUES ($1, $2, $3, 'ebay', 'ebay', $4::uuid, $5::text, $4::uuid::text || ':' || $5,
               gen_random_uuid(), 'awaiting_dispatch', 'x', now(), now(), now()::date, 1499, 1499,
               false, now(), now())`,
      [A, id, company, ebay, `W-${id.slice(0, 6)}`],
    );
    return id;
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    db = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    mockUrl = await mock.listen({ host: '127.0.0.1', port: 0 });
    await tenancy.run({ workspaceId: A, companyIds: [], userId: admin }, async (ctx) => {
      await new WorkspaceRepository(db.db).create(ctx, { name: 'Ship test' });
      await new UserRepository(db.db).create(ctx, {
        id: admin,
        email: `${admin}@example.test`,
        name: 'admin',
      });
      await new MembershipRepository(db.db).add(ctx, { userId: admin, role: 'admin' });
    });
    company = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      new CompanyRepository(db.db).create(ctx, {
        legalName: 'Ship Ltd',
        tradingName: 'Ship',
        registeredAddress: address,
      }),
    );
    ebay = await tenancy.runWorkspace({ workspaceId: A }, (ctx) =>
      new ChannelAccountRepository(db.db).create(ctx, {
        companyId: company,
        provider: 'ebay',
        displayName: 'eBay',
      }),
    );
  });

  afterAll(async () => {
    await mock.close();
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[EVRI-2][SHIP-1] an admin gets Evri’s sign-in page, pastes the code, and the account is stored with its token encrypted', async () => {
    const server = app();
    const url = await server.inject({
      method: 'GET',
      url: '/api/connections/evri/authorise-url',
      headers: asAdmin,
    });
    expect(url.statusCode, url.body).toBe(200);
    const page = new URL(url.json<{ url: string }>().url);
    expect(page.pathname).toBe('/evri/customer/authorize');
    expect(page.searchParams.get('response_type')).toBe('code');
    expect(page.searchParams.get('redirect_uri')).toBe('https://localhost:8080');
    const code = '0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
    const res = await server.inject({
      method: 'POST',
      url: '/api/connections/evri',
      headers: asAdmin,
      payload: { company_id: company, display_name: 'Evri', auth_code: code },
    });
    expect(res.statusCode, res.body).toBe(201);
    const account = res.json<{ id: string; provider: string }>();
    expect(account.provider).toBe('evri');
    const stored = await root.query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM app.credentials WHERE channel_account_id = $1 GROUP BY kind`,
      [account.id],
    );
    expect(stored.rows).toEqual([{ kind: 'evri.api_key', n: '1' }]);
    const carriers = await server.inject({
      method: 'GET',
      url: '/api/shipping/carriers',
      headers: asAdmin,
    });
    expect(
      carriers.json<{ items: { id: string; services: { code: string }[] }[] }>().items,
    ).toEqual([
      expect.objectContaining({
        id: account.id,
        services: [
          expect.objectContaining({ code: 'standard' }),
          expect.objectContaining({ code: 'signature' }),
          expect.objectContaining({ code: 'next_day' }),
        ],
      }),
    ]);
  });

  it('[SHP-2][SHP-7] labels are requested in one call: one job per shipment, refusals in the batch, costs per service', async () => {
    const server = app();
    const [evri] = (
      await server.inject({ method: 'GET', url: '/api/shipping/carriers', headers: asAdmin })
    ).json<{ items: { id: string }[] }>().items;
    const evriId = evri?.id ?? '';
    const costs = await server.inject({
      method: 'PUT',
      url: `/api/connections/${evriId}/service-costs`,
      headers: asAdmin,
      payload: { items: [{ service_code: 'standard', cost_pence: 289, vat_rate_bp: 2000 }] },
    });
    expect(costs.statusCode, costs.body).toBe(200);
    const unknown = await server.inject({
      method: 'PUT',
      url: `/api/connections/${evriId}/service-costs`,
      headers: asAdmin,
      payload: { items: [{ service_code: 'saturday', cost_pence: 1, vat_rate_bp: 2000 }] },
    });
    expect(unknown.statusCode).toBe(400);
    const [o1, o2] = [await order(), await order()];
    sent.length = 0;
    const res = await server.inject({
      method: 'POST',
      url: '/api/shipping/labels',
      headers: asAdmin,
      payload: {
        orders: [
          {
            order_id: o1,
            carrier_account_id: evriId,
            service_code: 'standard',
            parcels: [{ weight_g: 500 }],
          },
          {
            order_id: o2,
            carrier_account_id: evriId,
            service_code: 'teleport',
            parcels: [{ weight_g: 500 }],
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const batch = res.json<{
      items: { state: string; refusal: string | null; shipment_id: string | null }[];
    }>();
    expect(batch.items.map((i) => [i.state, i.refusal])).toEqual([
      ['queued', null],
      ['refused', 'unknown_service'],
    ]);
    expect(sent).toEqual([
      { type: 'labels.create', key: `labels.create:${batch.items[0]?.shipment_id ?? ''}` },
    ]);
    // A label still being bought cannot be printed or voided yet.
    const shipmentId = batch.items[0]?.shipment_id ?? '';
    const print = await server.inject({
      method: 'POST',
      url: '/api/shipping/labels/print',
      headers: asAdmin,
      payload: { shipment_ids: [shipmentId] },
    });
    expect(print.statusCode).toBe(409);
    const voided = await server.inject({
      method: 'POST',
      url: `/api/shipping/shipments/${shipmentId}/void`,
      headers: asAdmin,
    });
    expect(voided.statusCode).toBe(409);
    expect(voided.json<{ code: string }>().code).toBe('conflict');
    const shipment = await server.inject({
      method: 'GET',
      url: `/api/shipping/shipments/${shipmentId}`,
      headers: asAdmin,
    });
    expect(shipment.json<{ cost_pence: number; vat_rate_bp: number }>()).toMatchObject({
      cost_pence: 289,
      vat_rate_bp: 2000,
    });
  });

  it('[SHP-4][SHP-6] shipping settings default and round-trip, audited', async () => {
    const server = app();
    const get = await server.inject({
      method: 'GET',
      url: '/api/shipping/settings',
      headers: asAdmin,
    });
    expect(get.json()).toEqual({
      auto_dispatch_on_label: true,
      label_format: 'THERMAL',
      packaging_allowance_g: 150,
      packing_slip_enabled: false,
      tracking_hold_minutes: 30,
    });
    const body = { ...get.json<Record<string, unknown>>(), tracking_hold_minutes: 45 };
    const put = await server.inject({
      method: 'PUT',
      url: '/api/shipping/settings',
      headers: asAdmin,
      payload: body,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual(body);
    const audit = await root.query(
      `SELECT count(*)::text AS n FROM app.audit_events WHERE action = 'shipping.settings_changed'`,
    );
    expect(audit.rows[0]).toEqual({ n: '1' });
  });
});
