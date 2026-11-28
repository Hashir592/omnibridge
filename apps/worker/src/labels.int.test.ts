import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secret } from '@omnibridge/crypto';
import type { Notifier } from '@omnibridge/core';
import {
  createMainDb,
  migrateMain,
  ShippingRepository,
  Tenancy,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { createEvriAdapter } from '@omnibridge/provider-evri';
import { ProviderHttp, ProviderUnavailable, SlotsFull } from '@omnibridge/provider-kit';
import { buildMockServer, ScenarioStore } from '@omnibridge/provider-mocks';
import { GovernorWait, type PreparingJob } from '@omnibridge/queue';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  scanTextForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import {
  labelsCreateHandler,
  labelsFetchHandler,
  recipientFrom,
  type LabelJobDeps,
} from './labels.ts';

/**
 * The label job end to end (T-1201: SHIP-3, SHIP-4, EVRI-2 to EVRI-5, AT-12, AT-9, RL-4): db-main
 * shipments, the buyer's record in a real pii-vault, Evri as its mock (checked against the official
 * specification). A parcel is bought once; label files reach the vault only.
 */
describe('label jobs across db-main, pii-vault and Evri (T-1201)', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let vault: TestVault;
  let workerVault: VaultClient;
  let webVault: VaultClient;
  let shipping: ShippingRepository;
  let mocksUrl = '';
  const scenarios = new ScenarioStore();
  const mock = buildMockServer(
    createLogger({ service: 'mock', version: '0', level: 'silent' }),
    scenarios,
  );
  const logs: string[] = [];
  const logger = createLogger({
    service: 'test',
    version: '0',
    destination: { write: (line: string) => (logs.push(line), true) },
  });
  const ws = randomUUID();
  const company = randomUUID();
  const ebay = randomUUID();
  const evriAccount = randomUUID();
  /** The mock's account key is the code the admin pasted; its token carries it. */
  const code = `TOKENMARK-evri-${randomUUID()}`;
  let token = '';
  const ctx = { workspaceId: ws, companyIds: [company] };
  const authFailures: { revoked: boolean }[] = [];
  const raised: string[] = [];
  let slotFull = false;

  const deps = (): LabelJobDeps => ({
    tenancy: new Tenancy(db.db),
    shipping,
    credentials: { read: () => Promise.resolve(new Secret(token)) },
    connections: {
      recordAuthFailure: (_c, _id, _at, options) => {
        authFailures.push(options);
        return Promise.resolve({ failures: 1, marked: true });
      },
      recordSuccess: () => Promise.resolve({ reauthCleared: false }),
    },
    notifier: {
      raise: (_c: unknown, input: { type: string }) => {
        raised.push(input.type);
        return Promise.resolve();
      },
      resolve: () => Promise.resolve(),
    } as unknown as Pick<Notifier, 'raise' | 'resolve'>,
    vault: workerVault,
    evri: () =>
      Promise.resolve(createEvriAdapter({ http: new ProviderHttp({ mode: 'mock', mocksUrl }) })),
    slot: (_ws, _account, fn) => {
      if (slotFull) return Promise.reject(new SlotsFull('evri', new Date(Date.now() + 15_000)));
      return fn();
    },
  });
  const preparing = (shipmentId: string): PreparingJob<{ shipment_id: string }> => ({
    jobId: randomUUID(),
    envelope: {
      workspace_id: ws,
      channel_account_id: evriAccount,
      idempotency_key: randomUUID(),
      attempt: 1,
      type: 'labels.create',
      payload: { shipment_id: shipmentId },
    },
    payload: { shipment_id: shipmentId },
    attempt: 1,
    progress: () => Promise.resolve(),
  });
  const run = (shipmentId: string) => labelsCreateHandler(deps()).prepare(preparing(shipmentId));
  const posts = async () =>
    (
      (await (
        await fetch(`${mocksUrl}/_mock/evri/parcels?account=${encodeURIComponent(code)}`)
      ).json()) as { posts: number; parcels: { clientUID: string; barcode: string }[] }
    ).posts;

  let n = 0;
  /** A paid order with its buyer in the vault, as ingest leaves it. */
  const order = async (line1 = `${PII_MARKER}1 Capitol House`) => {
    const ref = `W${String((n += 1)).padStart(5, '0')}-${randomUUID().slice(0, 4)}`;
    const { pii_ref } = await workerVault.ingest({
      workspace_id: ws,
      kind: 'buyer_contact',
      channel_account_id: ebay,
      subject_type: 'order',
      subject_id: `${ebay}:${ref}`,
      fields: {
        name: `${PII_MARKER}Jo Bloggs`,
        address_line1: line1,
        city: 'Leeds',
        postcode: 'LS27 0AB',
        email: `${PII_MARKER}jo@example.test`,
        phone: '07700900123',
      },
    });
    const id = randomUUID();
    await root.query(
      `INSERT INTO app.orders
         (workspace_id, id, company_id, provider, origin, channel_account_id, external_order_id,
          pii_subject, pii_ref, status, raw_status, placed_at, source_updated_at, tax_point_date,
          goods_pence, gross_pence, stock_moves, created_at, updated_at)
       VALUES ($1, $2, $3, 'ebay', 'ebay', $4::uuid, $5::text, $4::uuid::text || ':' || $5, $6,
               'awaiting_dispatch', 'x', now(), now(), now()::date, 1499, 1499, false, now(), now())`,
      [ws, id, company, ebay, ref, pii_ref],
    );
    return { id, ref };
  };
  const label = async (orderIds: string[], over: object = {}) => {
    const { batchId } = await new Tenancy(db.db).runWorkspace({ workspaceId: ws }, (c) =>
      shipping.requestLabels(
        { ...c, companyIds: ctx.companyIds },
        {
          userId: null,
          orders: orderIds.map((orderId) => ({
            orderId,
            carrierAccountId: evriAccount,
            serviceCode: 'standard',
            parcels: [{ weightG: 1124 }],
            ...over,
          })),
        },
        { validService: () => true, queue: () => Promise.resolve() },
      ),
    );
    const items = (await shipping.batch(ctx, batchId)) ?? [];
    return { batchId, shipments: items.map((i) => i.shipmentId ?? '') };
  };

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_worker']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
      journalDir: mkdtempSync(join(tmpdir(), 'ob-journal-')),
      labelsDir: mkdtempSync(join(tmpdir(), 'ob-labels-')),
    });
    workerVault = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.worker });
    webVault = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.web });
    db = createMainDb({ ...main.connection('ob_app'), max: 4 });
    root = new pg.Pool({ connectionString: main.container.getConnectionUri(), max: 2 });
    shipping = new ShippingRepository(db.db);
    mocksUrl = await mock.listen({ host: '127.0.0.1', port: 0 });
    token = (
      await createEvriAdapter({
        http: new ProviderHttp({ mode: 'mock', mocksUrl }),
        clientId: new Secret('synthetic-client-id'),
        clientSecret: new Secret('synthetic-client-secret'),
      }).exchangeCode(code)
    ).token.reveal();
    await root.query(`INSERT INTO app.workspaces (id, name) VALUES ($1, 'Labels')`, [ws]);
    await root.query(
      `INSERT INTO app.companies (id, workspace_id, legal_name, trading_name, address_line1,
                                  address_city, address_postcode)
       VALUES ($1, $2, 'Labels Ltd', 'Labels', '1 Test Street', 'Testville', 'TE1 1ST')`,
      [company, ws],
    );
    for (const [id, provider] of [
      [ebay, 'ebay'],
      [evriAccount, 'evri'],
    ] as const) {
      await root.query(
        `INSERT INTO app.channel_accounts (id, workspace_id, company_id, provider, display_name)
         VALUES ($1, $2, $3, $4, $4)`,
        [id, ws, company, provider],
      );
    }
  }, 300_000);

  afterAll(async () => {
    await mock.close();
    await vault.close();
    await db.destroy();
    await root.end();
    await Promise.all([main.container.stop(), pii.container.stop()]);
  }, 120_000);

  it('[EVRI-4] the recipient fits Evri: name split, lines re-flowed, a long line flagged', () => {
    const fitted = recipientFrom({
      name: 'Mary Ann Smith',
      address_line1: 'Flat 12 Riverside Court Mill Lane',
      city: 'Leeds',
      postcode: 'ls27 0ab',
    });
    expect(fitted.recipient).toMatchObject({
      firstName: 'Mary Ann',
      lastName: 'Smith',
      lines: ['Flat 12 Riverside Court Mill', 'Lane', 'Leeds'],
      postcode: 'LS27 0AB',
    });
    expect(fitted.shortened).toBe(false);
    const long = recipientFrom({
      name: 'Jo Bloggs',
      address_line1: 'The Old Rectory Cottage Annexe Building',
      address_line2: 'Upper Little Snoring Road',
      address_line3: 'Thursford Green',
      city: 'Fakenham',
      county: 'Norfolk',
      postcode: 'NR21 0AA',
    });
    expect(long.shortened).toBe(true);
    expect(long.recipient.lines.length).toBeLessThanOrEqual(4);
  });

  it('[AT-12][SHIP-4][EVRI-5] one INVALID parcel fails its order; the other is bought and its label reaches the vault', async () => {
    const [a, b] = [await order(), await order()];
    const { batchId, shipments } = await label([a.id, b.id]);
    const before = await posts();
    scenarios.set('evri', code, 'invalid_parcel', 1);
    await run(shipments[0] ?? '');
    await run(shipments[1] ?? '');
    expect((await posts()) - before).toBe(2);
    const items = (await shipping.batch(ctx, batchId)) ?? [];
    expect(items.map((i) => i.state)).toEqual(['failed', 'created']);
    expect(items[0]?.error).toEqual({
      code: 'evri.delivery_unavailable',
      fields: ['deliveryDetails.deliveryAddress.postcode'],
    });
    const created = await shipping.shipment(ctx, shipments[1] ?? '');
    expect(created?.labelStored).toBe(true);
    expect(created?.trackingNumber).toMatch(/^H00MOCK/);
    // The label prints from the vault.
    const pdf = await webVault.mergeLabels({
      workspaceId: ws,
      labelIds: (created?.parcels ?? []).map((p) => p.id),
    });
    expect(Buffer.from(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('[EVRI-5][SHP-5][AT-12] a reprint fetches by barcode and never creates a parcel', async () => {
    const o = await order();
    const { shipments } = await label([o.id]);
    await run(shipments[0] ?? '');
    const id = shipments[0] ?? '';
    const parcels = (await shipping.shipment(ctx, id))?.parcels ?? [];
    // The file is lost (as after a restore): the reprint fetches it again.
    await workerVault.discardLabels(
      ws,
      parcels.map((p) => p.id),
    );
    const before = await posts();
    await labelsFetchHandler(deps()).prepare(preparing(id));
    expect(await posts()).toBe(before);
    expect(
      (
        await workerVault.storedLabels(
          ws,
          parcels.map((p) => p.id),
        )
      ).label_ids,
    ).toHaveLength(parcels.length);
    // Running the create job again buys nothing either.
    await run(id);
    expect(await posts()).toBe(before);
  });

  it('[EVRI-3] a lost answer, then the retry: Evri refuses the duplicate, the parcel is unknown, never bought twice', async () => {
    const o = await order();
    const { shipments } = await label([o.id]);
    const id = shipments[0] ?? '';
    scenarios.set('evri', code, 'lost_answer', 1);
    await expect(run(id)).rejects.toBeInstanceOf(ProviderUnavailable);
    await run(id);
    const view = await shipping.shipment(ctx, id);
    expect(view?.status).toBe('failed');
    expect(view?.parcels[0]?.state).toBe('unknown');
    const list = await shipping.reconcile(ctx, { limit: 100, offset: 0 });
    expect(list.rows.some((r) => r.shipmentId === id && r.reason === 'unknown')).toBe(true);
    const held = (
      (await (
        await fetch(`${mocksUrl}/_mock/evri/parcels?account=${encodeURIComponent(code)}`)
      ).json()) as { parcels: { clientUID: string }[] }
    ).parcels.filter((p) => p.clientUID === `${o.ref}-1`);
    expect(held).toHaveLength(1);
  });

  it('[RL-4] a full carrier cap is a governor wait: nothing is sent and the parcel stays pending', async () => {
    const o = await order();
    const { shipments } = await label([o.id]);
    const before = await posts();
    slotFull = true;
    try {
      await expect(run(shipments[0] ?? '')).rejects.toBeInstanceOf(GovernorWait);
    } finally {
      slotFull = false;
    }
    expect(await posts()).toBe(before);
    expect((await shipping.shipment(ctx, shipments[0] ?? ''))?.parcels[0]?.state).toBe('pending');
    // The next run sends it once.
    await run(shipments[0] ?? '');
    expect((await shipping.shipment(ctx, shipments[0] ?? ''))?.status).toBe('created');
  });

  it('[EVRI-4] a shortened address without the user’s yes buys nothing', async () => {
    const o = await order(`${PII_MARKER}Llanfairpwllgwyngyllgogerychwyrndrobwll`);
    // db-main does not know yet; the job finds out from the vault record and refuses.
    const { batchId, shipments } = await label([o.id]);
    const before = await posts();
    await run(shipments[0] ?? '');
    expect(await posts()).toBe(before);
    const item = (await shipping.batch(ctx, batchId))?.[0];
    expect(item).toMatchObject({ state: 'refused', refusal: 'address_not_confirmed' });
    const { rows } = await root.query('SELECT address_shortened FROM app.orders WHERE id = $1', [
      o.id,
    ]);
    expect(rows[0]).toEqual({ address_shortened: true });
  });

  it('[EVRI-2] a 401 marks the carrier account Needs re-authorisation with its notice; nothing is bought', async () => {
    const o = await order();
    const { shipments } = await label([o.id]);
    scenarios.set('evri', code, 'revoked');
    try {
      await run(shipments[0] ?? '');
    } finally {
      scenarios.clear();
    }
    expect(authFailures.at(-1)).toEqual({ revoked: true });
    expect(raised).toContain('channel.auth_lost');
    const view = await shipping.shipment(ctx, shipments[0] ?? '');
    expect(view?.status).toBe('failed');
    expect(view?.parcels[0]?.errorCode).toBe('evri.unauthorised');
  });

  it('[AT-9][SHIP-4][DP-8] no buyer detail reaches db-main, the job tables or the logs', async () => {
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
  });
});
