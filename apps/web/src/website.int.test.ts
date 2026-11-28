import { createHash, randomUUID } from 'node:crypto';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
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
  Tenancy,
  UserRepository,
  WebsiteConnectionRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { sessionHeaders, startRoleCluster, stubAuth, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

const logger = createLogger({ service: 'web', version: 'test', level: 'silent' });
const checks = { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) };
const APP = 'https://app.example.test';
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * The website connector's setup (T-1101: WEB-1, PLAT-2, ADR-059): an admin connects a website and
 * copies its keys once; the account holds its stock writes until a clean reconciliation (FA-16);
 * nothing secret is stored in clear; with the module off every website route is not there.
 */
describe('website connector setup (T-1101)', () => {
  let cluster: RoleCluster;
  let db: MainDbHandle;
  let root: pg.Pool;
  let tenancy: Tenancy;
  const A = randomUUID();
  const B = randomUUID();
  const admin = randomUUID();
  const child = randomUUID();
  const adminB = randomUUID();
  let company = '';
  let companyB = '';
  let ebay = '';
  const keyring = parseKeyring('secrets', generateKekLine(1));

  const app = () =>
    buildWebApp({
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
        logger,
      },
    });
  const as = (workspaceId: string, userId: string) =>
    sessionHeaders({ workspaceId, userId, sessionId: `s-${userId.slice(0, 8)}` });
  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const res = await app().inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return {
      status: res.statusCode,
      body: res.body,
      json: () => res.json<Record<string, unknown>>(),
    };
  };
  const moduleOn = (workspaceId: string, on: boolean) =>
    root.query(`SELECT app.workspace_set_module($1, 'website_connector', $2)`, [workspaceId, on]);
  const connect = (over: Record<string, unknown> = {}, headers = as(A, admin)) =>
    call('POST', '/api/connections/website', headers, {
      company_id: company,
      display_name: 'Shop',
      base_url: 'https://shop.example.test',
      outbound_api_key: 'outbound-key-for-the-shop-0001',
      ...over,
    });

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    root = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 2 });
    db = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    for (const [ws, users] of [
      [
        A,
        [
          [admin, 'admin'],
          [child, 'member'],
        ],
      ],
      [B, [[adminB, 'admin']]],
    ] as const) {
      for (const [id, role] of users) {
        await tenancy.run({ workspaceId: ws, companyIds: [], userId: id }, async (c) => {
          if (role === 'admin') await new WorkspaceRepository(db.db).create(c, { name: 'Web' });
          await new UserRepository(db.db).create(c, { id, email: `${id}@example.test`, name: 'U' });
          await new MembershipRepository(db.db).add(c, { userId: id, role });
        });
      }
    }
    const address = { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' };
    company = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'A Ltd',
        tradingName: 'A',
        registeredAddress: address,
      }),
    );
    companyB = await tenancy.runWorkspace({ workspaceId: B }, (c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'B Ltd',
        tradingName: 'B',
        registeredAddress: address,
      }),
    );
    ebay = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new ChannelAccountRepository(db.db).create(c, {
        companyId: company,
        provider: 'ebay',
        displayName: 'eBay',
      }),
    );
    await moduleOn(A, true);
    await moduleOn(B, true);
  }, 300_000);

  afterAll(async () => {
    await db.destroy();
    await root.end();
    await cluster.container.stop();
  });

  it('[WEB-1] an admin connects a website: keys shown once, stock writes held, nothing secret stored in clear', async () => {
    const res = await connect();
    expect(res.status).toBe(201);
    const { connection, settings, keys } = res.json() as {
      connection: { id: string; provider: string; company_id: string; display_name: string };
      settings: Record<string, unknown>;
      keys: { inbound_api_key: string; signing_secret: string };
    };
    expect(connection).toMatchObject({
      provider: 'website',
      company_id: company,
      display_name: 'Shop',
    });
    expect(keys.inbound_api_key).toMatch(/^obw_[A-Za-z0-9_-]{43}$/);
    expect(keys.signing_secret).toMatch(/^obs_[A-Za-z0-9_-]{43}$/);
    expect(settings).toMatchObject({
      connection_id: connection.id,
      inbound_url: `${APP}/api/v1/website/${connection.id}`,
      base_url: 'https://shop.example.test',
      inbound_key_hint: keys.inbound_api_key.slice(-4),
      outbound_key_set: true,
    });
    // FA-16: a new account holds its stock writes until its first clean reconciliation.
    const { rows } = await root.query<{ held: Date | null; hash: Buffer }>(
      `SELECT a.stock_push_held_since AS held, w.inbound_key_hash AS hash
         FROM app.channel_accounts a JOIN app.website_connections w ON w.channel_account_id = a.id
        WHERE a.id = $1`,
      [connection.id],
    );
    expect(rows[0]?.held).not.toBeNull();
    expect(rows[0]?.hash).toEqual(sha256(keys.inbound_api_key));
    // Never in clear: not the key, the secret or the website's key, in any table.
    const { rows: dump } = await root.query<{ t: string }>(
      `SELECT coalesce(string_agg(row_to_json(w)::text, ' '), '') AS t FROM app.website_connections w`,
    );
    const { rows: creds } = await root.query<{ t: string }>(
      `SELECT string_agg(encode(encrypted_value, 'escape'), ' ') AS t FROM app.credentials`,
    );
    for (const secret of [
      keys.inbound_api_key,
      keys.signing_secret,
      'outbound-key-for-the-shop-0001',
    ]) {
      expect(dump[0]?.t ?? '').not.toContain(secret);
      expect(creds[0]?.t ?? '').not.toContain(secret);
    }
    // The settings never show a key again.
    const read = await call('GET', `/api/connections/${connection.id}/website`, as(A, admin));
    expect(read.status).toBe(200);
    expect(read.json()).toEqual(settings);
    for (const secret of [keys.inbound_api_key, keys.signing_secret]) {
      expect(read.body).not.toContain(secret);
    }
    const audit = await root.query<{ action: string }>(
      'SELECT action FROM app.audit_events WHERE entity_id = $1',
      [connection.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['connection.added']);
  });

  it('[WEB-1][PERM-3][PERM-4] only an admin sets a website up, under a company of their own workspace', async () => {
    expect((await connect({}, as(A, child))).status).toBe(403);
    expect((await connect({ company_id: companyB })).status).toBe(404);
    expect((await connect({ base_url: 'http://shop.example.test' })).status).toBe(400);
    const { connection } = (await connect()).json() as { connection: { id: string } };
    // Another workspace's admin, or a non-website account: not there.
    for (const [id, headers] of [
      [connection.id, as(B, adminB)],
      [ebay, as(A, admin)],
    ] as const) {
      expect((await call('GET', `/api/connections/${id}/website`, headers)).status).toBe(404);
      expect(
        (
          await call('PUT', `/api/connections/${id}/website`, headers, {
            base_url: 'https://x.test',
          })
        ).status,
      ).toBe(404);
      expect((await call('POST', `/api/connections/${id}/website/keys`, headers)).status).toBe(404);
    }
    expect(
      (await call('GET', `/api/connections/${connection.id}/website`, as(A, child))).status,
    ).toBe(403);
  });

  it('[WEB-1] the base URL and the website key change; new keys replace the old ones at once', async () => {
    const { connection, keys } = (await connect()).json() as {
      connection: { id: string };
      keys: { inbound_api_key: string; signing_secret: string };
    };
    const url = `/api/connections/${connection.id}/website`;
    expect((await call('PUT', url, as(A, admin), {})).status).toBe(400);
    const changed = await call('PUT', url, as(A, admin), {
      base_url: 'https://new.example.test',
      outbound_api_key: 'outbound-key-for-the-shop-0002',
    });
    expect(changed.status).toBe(200);
    expect(changed.json()).toMatchObject({
      base_url: 'https://new.example.test',
      outbound_key_set: true,
    });
    const fresh = await call('POST', `${url}/keys`, as(A, admin));
    expect(fresh.status).toBe(200);
    const next = fresh.json() as { inbound_api_key: string; signing_secret: string };
    expect(next.inbound_api_key).not.toBe(keys.inbound_api_key);
    expect(next.signing_secret).not.toBe(keys.signing_secret);
    const { rows } = await root.query<{ hash: Buffer }>(
      'SELECT inbound_key_hash AS hash FROM app.website_connections WHERE channel_account_id = $1',
      [connection.id],
    );
    expect(rows[0]?.hash).toEqual(sha256(next.inbound_api_key));
    expect((await call('GET', url, as(A, admin))).json()).toMatchObject({
      inbound_key_hint: next.inbound_api_key.slice(-4),
    });
    const audit = await root.query<{ action: string }>(
      'SELECT action FROM app.audit_events WHERE entity_id = $1 ORDER BY occurred_at, action',
      [connection.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'connection.added',
      'website.settings_changed',
      'website.keys_reissued',
    ]);
  });

  it('[WEB-1][PLAT-2] with the website module off, every setup route answers 404', async () => {
    const { connection } = (await connect()).json() as { connection: { id: string } };
    await moduleOn(A, false);
    try {
      const url = `/api/connections/${connection.id}/website`;
      expect((await connect()).status).toBe(404);
      expect((await call('GET', url, as(A, admin))).status).toBe(404);
      expect((await call('PUT', url, as(A, admin), { base_url: 'https://x.test' })).status).toBe(
        404,
      );
      expect((await call('POST', `${url}/keys`, as(A, admin))).status).toBe(404);
    } finally {
      await moduleOn(A, true);
    }
  });
});
