import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  AccountCredentials,
  AuditLog,
  CatalogueRepository,
  ChannelAccountRepository,
  CompanyRepository,
  ConnectionRepository,
  createMainDb,
  CredentialRepository,
  MembershipRepository,
  migrateMain,
  OrderIngest,
  Tenancy,
  UserRepository,
  WebsiteConnectionRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { orderIngestStream } from '@omnibridge/order-ingest';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  sessionHeaders,
  startRoleCluster,
  stubAuth,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import { buildWebApp } from './app.ts';

const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const APP = 'https://app.example.test';

/**
 * Website calls (T-1101: WEB-2, WEB-3, AT-14, OPS-12, ADR-054 FA-04): signed with the connection's
 * key and secret, refused when the signature, key or timestamp is wrong, answered once per
 * idempotency key, and stored in the request with the buyer's details in pii-vault first.
 */
describe('website calls, signed and idempotent (T-1101)', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let vaultRoot: pg.Pool;
  let tenancy: Tenancy;
  let vault: TestVault;
  let web: VaultClient;
  const logs: string[] = [];
  const logger = createLogger({
    service: 'web',
    version: 'test',
    destination: { write: (line: string) => (logs.push(line), true) },
  });
  const A = randomUUID();
  const admin = randomUUID();
  let company = '';
  let connection = '';
  let keys = { inbound_api_key: '', signing_secret: '' };
  const keyring = parseKeyring('secrets', generateKekLine(1));

  const app = () => {
    const ingest = new OrderIngest(db.db, {
      catalogue: new CatalogueRepository(db.db),
      ports: {
        cancelPii: () => Promise.resolve(),
        shortenPii: () => Promise.resolve(),
        totalMismatch: () => Promise.resolve(),
        lateMapped: () => Promise.resolve(),
        regroup: () => Promise.resolve(),
      },
    });
    return buildWebApp({
      logger,
      version: 'test',
      checks,
      tenancy,
      ...stubAuth({ OB_ENV: 'test' }),
      modules: new WorkspaceRepository(db.db),
      website: {
        connections: new WebsiteConnectionRepository(db.db),
        accounts: new ChannelAccountRepository(db.db),
        view: new ConnectionRepository(db.db),
        credentials: new AccountCredentials(db.db, new CredentialRepository({ keyring, logger })),
        audit: new AuditLog(db.db),
        tenancy,
        appOrigin: APP,
        ingest: {
          steps: orderIngestStream({ tenancy, ingest, vault: web, logger, corrections: 'ingest' }),
          orders: ingest,
        },
        logger,
      },
    });
  };
  const moduleOn = (on: boolean) =>
    root.query(`SELECT app.workspace_set_module($1, 'website_connector', $2)`, [A, on]);

  const order = (externalOrderId: string, over: Record<string, unknown> = {}) => ({
    externalOrderId,
    status: 'paid',
    currency: 'GBP',
    placedAt: '2026-11-20T09:00:00Z',
    updatedAt: '2026-11-20T09:05:00Z',
    paidAt: '2026-11-20T09:01:00Z',
    lines: [
      {
        externalLineId: 'L1',
        externalSku: 'SKU-1',
        title: 'Mug',
        quantity: 2,
        unitPriceGross: 650,
      },
    ],
    shippingGross: 399,
    discountGross: 0,
    buyer: { name: `${PII_MARKER}Web Buyer`, email: `${PII_MARKER}buyer@example.test` },
    shippingAddress: {
      name: `${PII_MARKER}Web Buyer`,
      line1: `${PII_MARKER}1 Shop Street`,
      city: 'Testville',
      postcode: 'TE1 1ST',
      country: 'GB',
    },
    ...over,
  });

  /** One website call, signed as WEB-2 says, with what is wrong in it set by `bad`. */
  const send = async (
    path: string,
    body: unknown,
    options: {
      key?: string;
      secret?: string;
      /** Seconds the timestamp is off, from the moment the call is signed. */
      skew?: number;
      idempotency?: string;
      tamper?: boolean;
      to?: string;
    } = {},
  ) => {
    const raw = JSON.stringify(body);
    const at = Math.floor(Date.now() / 1000) + (options.skew ?? 0);
    const signature = createHmac('sha256', options.secret ?? keys.signing_secret)
      .update(`${String(at)}.${raw}`)
      .digest('hex');
    const res = await app().inject({
      method: 'POST',
      url: `/api/v1/website/${options.to ?? connection}${path}`,
      headers: {
        authorization: `Bearer ${options.key ?? keys.inbound_api_key}`,
        'x-ob-timestamp': String(at),
        'x-ob-signature': signature,
        'idempotency-key': options.idempotency ?? randomUUID(),
        'content-type': 'application/json',
      },
      payload: options.tamper === true ? raw.replace('Mug', 'Jug') : raw,
    });
    return {
      status: res.statusCode,
      body: res.body,
      json: () => res.json<Record<string, unknown>>(),
    };
  };
  const push = (body: unknown, options: Parameters<typeof send>[2] = {}) =>
    send('/orders', body, options);
  const stored = async (externalOrderId: string) =>
    (
      await root.query<{ id: string; pii_ref: string | null }>(
        'SELECT id, pii_ref FROM app.orders WHERE external_order_id = $1',
        [externalOrderId],
      )
    ).rows;
  const records = async (externalOrderId: string) =>
    (
      await vaultRoot.query<{ pii_ref: string }>(
        'SELECT pii_ref FROM vault.records WHERE workspace_id = $1 AND subject_id = $2',
        [A, `${connection}:${externalOrderId}`],
      )
    ).rows;

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    db = createMainDb({ ...main.connection('ob_app'), max: 4 });
    root = new pg.Pool({ connectionString: main.container.getConnectionUri(), max: 2 });
    vaultRoot = new pg.Pool({ connectionString: pii.container.getConnectionUri(), max: 2 });
    tenancy = new Tenancy(db.db);
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
      journalDir: mkdtempSync(join(tmpdir(), 'ob-journal-')),
    });
    web = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.web });
    await tenancy.run({ workspaceId: A, companyIds: [], userId: admin }, async (c) => {
      await new WorkspaceRepository(db.db).create(c, { name: 'Web' });
      await new UserRepository(db.db).create(c, {
        id: admin,
        email: `${admin}@example.test`,
        name: 'U',
      });
      await new MembershipRepository(db.db).add(c, { userId: admin, role: 'admin' });
    });
    company = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'A Ltd',
        tradingName: 'A',
        registeredAddress: { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' },
      }),
    );
    await moduleOn(true);
    const res = await app().inject({
      method: 'POST',
      url: '/api/connections/website',
      headers: sessionHeaders({ workspaceId: A, userId: admin, sessionId: 's-admin' }),
      payload: {
        company_id: company,
        display_name: 'Shop',
        base_url: 'https://shop.example.test',
        outbound_api_key: 'outbound-key-for-the-shop-0001',
      },
    });
    const made = res.json<{ connection: { id: string }; keys: typeof keys }>();
    connection = made.connection.id;
    keys = made.keys;
  }, 300_000);

  afterAll(async () => {
    await vault.close();
    await db.destroy();
    await Promise.all([root.end(), vaultRoot.end()]);
    await Promise.all([main.container.stop(), pii.container.stop()]);
  });

  it('[AT-14][WEB-2] a signed push stores the order; a wrong key, signature or a timestamp over 5 minutes off is refused', async () => {
    const tag = randomUUID().slice(0, 8);
    const ok = await push(order(`W-OK-${tag}`));
    expect(ok.status).toBe(201);
    const id = ok.json().omnibridgeOrderId;
    expect((await stored(`W-OK-${tag}`)).map((r) => r.id)).toEqual([id]);
    const refused: [string, Parameters<typeof send>[2]][] = [
      ['wrong key', { key: `obw_${'x'.repeat(43)}` }],
      ['wrong secret', { secret: `obs_${'y'.repeat(43)}` }],
      ['too old', { skew: -310 }],
      ['too far ahead', { skew: 310 }],
      ['body changed after signing', { tamper: true }],
    ];
    for (const [why, options] of refused) {
      const externalOrderId = `W-BAD-${tag}-${why.replaceAll(' ', '-')}`;
      expect((await push(order(externalOrderId), options)).status, why).toBe(401);
      expect(await stored(externalOrderId), why).toEqual([]);
    }
    // A connection that is not there is not there.
    expect((await push(order(`W-NONE-${tag}`), { to: randomUUID() })).status).toBe(404);
    // Four minutes off is inside the window.
    expect((await push(order(`W-EDGE-${tag}`), { skew: -240 })).status).toBe(201);
  });

  it('[AT-14][WEB-2] the same idempotency key gives the same answer and stores nothing twice; with another body it is 409', async () => {
    const tag = randomUUID().slice(0, 8);
    const key = `IDEM-${tag}`;
    const body = order(`W-IDEM-${tag}`);
    const first = await push(body, { idempotency: key });
    const again = await push(body, { idempotency: key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(first.status);
    expect(again.json()).toEqual(first.json());
    expect(await stored(`W-IDEM-${tag}`)).toHaveLength(1);
    expect(await records(`W-IDEM-${tag}`)).toHaveLength(1);
    // Another key for the same order is an update: 200, the same ID.
    const update = await push({ ...body, updatedAt: '2026-11-20T09:10:00Z' });
    expect(update.status).toBe(200);
    expect(update.json()).toEqual(first.json());
    // The same key with another body is a conflict, and changes nothing.
    const other = await push({ ...body, shippingGross: 0 }, { idempotency: key });
    expect(other.status).toBe(409);
    const { rows } = await root.query<{ shipping_pence: string }>(
      'SELECT shipping_pence FROM app.orders WHERE external_order_id = $1',
      [`W-IDEM-${tag}`],
    );
    expect(rows).toEqual([{ shipping_pence: '399' }]);
  });

  it('[WEB-3][ORD-4][AT-9] the buyer goes to pii-vault first; db-main, kept answers and logs hold no buyer detail', async () => {
    const tag = randomUUID().slice(0, 8);
    expect((await push(order(`W-PII-${tag}`))).status).toBe(201);
    const [row] = await stored(`W-PII-${tag}`);
    const [record] = await records(`W-PII-${tag}`);
    expect(record?.pii_ref).toBeDefined();
    expect(row?.pii_ref).toBe(record?.pii_ref);
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(logs.filter((l) => l.includes(PII_MARKER))).toEqual([]);
  });

  it('[WEB-3][ORD-4] a newer push corrects the address through the vault; an older one changes nothing', async () => {
    const tag = randomUUID().slice(0, 8);
    const id = `W-FIX-${tag}`;
    expect((await push(order(id))).status).toBe(201);
    const moved = {
      name: `${PII_MARKER}Web Buyer`,
      line1: `${PII_MARKER}9 Moved Road`,
      city: 'Testville',
      postcode: 'TE9 9TH',
      country: 'GB',
    };
    expect(
      (await push(order(id, { updatedAt: '2026-11-20T10:00:00Z', shippingAddress: moved }))).status,
    ).toBe(200);
    const read = async () =>
      (
        await web.readFull({
          workspaceId: A,
          piiRef: (await records(id))[0]?.pii_ref ?? '',
          purpose: 'order_detail',
          actorUserId: admin,
        })
      ).fields;
    expect(await read()).toMatchObject({
      address_line1: `${PII_MARKER}9 Moved Road`,
      postcode: 'TE9 9TH',
    });
    // Older than the stored update: nothing changes.
    await push(order(id, { updatedAt: '2026-11-20T09:30:00Z' }));
    expect(await read()).toMatchObject({ address_line1: `${PII_MARKER}9 Moved Road` });
    expect(await records(id)).toHaveLength(1);
  });

  it('[WEB-3] a body that is not a valid order is 422 with its field errors, and stores nothing', async () => {
    const tag = randomUUID().slice(0, 8);
    for (const [why, body] of [
      ['money not in pence', order(`W-422-${tag}-a`, { shippingGross: 3.99 })],
      ['not GBP', order(`W-422-${tag}-b`, { currency: 'EUR' })],
      ['no lines', order(`W-422-${tag}-c`, { lines: [] })],
    ] as const) {
      const res = await push(body);
      expect(res.status, why).toBe(422);
      expect((res.json().errors as unknown[]).length, why).toBeGreaterThan(0);
    }
    expect(
      (
        await root.query('SELECT 1 FROM app.orders WHERE external_order_id LIKE $1', [
          `W-422-${tag}%`,
        ])
      ).rows,
    ).toEqual([]);
  });

  it('[WEB-1][PLAT-2] with the website module off, every website call answers 404, even when signed', async () => {
    await moduleOn(false);
    try {
      const tag = randomUUID().slice(0, 8);
      expect((await push(order(`W-OFF-${tag}`))).status).toBe(404);
      expect(
        (await send(`/orders/W-OFF-${tag}/cancel`, { cancelledAt: '2026-11-20T10:00:00Z' })).status,
      ).toBe(404);
      expect(
        (
          await send(`/orders/W-OFF-${tag}/refunds`, {
            refundId: 'R1',
            amountGross: 100,
            refundedAt: '2026-11-20T10:00:00Z',
          })
        ).status,
      ).toBe(404);
      expect((await send('/products', { products: [{ externalSku: 'SKU-1' }] })).status).toBe(404);
      expect(await stored(`W-OFF-${tag}`)).toEqual([]);
    } finally {
      await moduleOn(true);
    }
  });
});
