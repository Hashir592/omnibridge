import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuditLog,
  ChannelAccountRepository,
  CompanyRepository,
  createMainDb,
  ErasureRequestRepository,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { PublicKeyCache, challengeResponse } from '@omnibridge/provider-ebay';
import { EBAY_SDK_SAMPLE as SAMPLE } from '@omnibridge/provider-ebay/testing';
import type { JobQueue } from '@omnibridge/queue';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  scanTextForMarkers,
  sessionHeaders,
  startRoleCluster,
  stubAuth,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient, type DeletionScope } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import { buildWebApp } from './app.ts';
import { ebayWebhook } from './webhooks/ebay.ts';

// T-0404: erasure (DEL-4), the subject access export (DEL-5) and the eBay account deletion
// notice (AT-10, FA-14), through web's routes against a real db-main and a real pii-vault.

const DAY = 86_400_000;
const TOKEN = 'synthetic-verification-token-0123456789abcdef';
const ENDPOINT = 'https://app.omnibridge.test/webhooks/ebay/account-deletion';

interface Sent {
  workspaceId: string;
  payload: { trigger: string; scope: DeletionScope };
  key: string;
}

describe('erasure, access export and eBay deletion [DEL-4][DEL-5][AT-10]', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let tenancy: Tenancy;
  let vault: TestVault;
  let owner: pg.Pool;
  const clients = {} as Record<'web' | 'worker' | 'deletion', VaultClient>;
  const logs: string[] = [];
  const sent: Sent[] = [];
  let clock = new Date('2026-11-18T10:00:00.000Z');
  const A = randomUUID();
  const admin = randomUUID();
  const child = randomUUID();
  let ebayAccount = '';
  let amazonAccount = '';
  const headers = (userId: string) =>
    sessionHeaders({ workspaceId: A, userId, sessionId: `s-${userId.slice(0, 8)}` });
  const logger = createLogger({
    service: 'web',
    version: 'test',
    destination: { write: (line: string) => (logs.push(line), true) },
  });

  /** Stands in for the queue: what web would enqueue, checked and then run by hand. */
  const queue: Pick<JobQueue, 'send'> = {
    send: (_def, input) => {
      sent.push({
        workspaceId: input.ctx.workspaceId,
        payload: input.payload as Sent['payload'],
        key: input.idempotencyKey,
      });
      return Promise.resolve({ id: randomUUID(), created: true });
    },
  };

  const contact = (who: string, extra: Record<string, string> = {}) => ({
    name: `${PII_MARKER}${who} Buyer`,
    email: `${PII_MARKER}${who.toLowerCase()}@example.test`,
    postcode: 'SW1A 1AA',
    address_line1: `${PII_MARKER}1 ${who} Street`,
    ...extra,
  });
  const ingest = (subjectId: string, fields: Record<string, string>, channel: string) =>
    clients.web.ingest({
      workspace_id: A,
      kind: 'buyer_contact',
      channel_account_id: channel,
      subject_type: 'order',
      subject_id: subjectId,
      fields,
    });
  const alive = async (piiRef: string) => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [A]);
      const res = await c.query('SELECT 1 FROM vault.records WHERE pii_ref = $1', [piiRef]);
      await c.query('COMMIT');
      return res.rows.length === 1;
    } finally {
      c.release();
    }
  };
  /** What the worker's pii.delete job does with a queued payload. */
  const runQueued = (s: Sent) =>
    clients.deletion.delete({
      workspace_id: s.workspaceId,
      run_id: randomUUID(),
      trigger: s.payload.trigger as 'erasure',
      scope: s.payload.scope,
    });

  const app = () =>
    buildWebApp({
      logger,
      version: 'test',
      checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
      tenancy,
      audit: new AuditLog(db.db),
      ...stubAuth({ OB_ENV: 'test' }),
      privacy: {
        vault: clients.web,
        erasures: new ErasureRequestRepository(db.db),
        queue,
        audit: new AuditLog(db.db),
        now: () => clock,
        maxExportRecords: 2,
      },
      ebay: ebayWebhook({
        verificationToken: TOKEN,
        endpoint: ENDPOINT,
        keys: new PublicKeyCache((kid) =>
          kid === SAMPLE.kid ? Promise.resolve(SAMPLE.key) : Promise.reject(new Error('kid')),
        ).get,
        logger,
        deletion: {
          vault: clients.web,
          accounts: new ChannelAccountRepository(db.db),
          tenancy,
          queue,
        },
      }),
    });

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    db = createMainDb({ ...main.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(db.db);
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
      journalDir: mkdtempSync(join(tmpdir(), 'ob-journal-')),
    });
    owner = new pg.Pool({ ...pii.connection('vault_owner'), max: 2 });
    for (const caller of ['web', 'worker', 'deletion'] as const) {
      clients[caller] = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens[caller] });
    }
    await tenancy.run({ workspaceId: A, companyIds: [] }, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Privacy test' }),
    );
    for (const [id, role] of [
      [admin, 'admin'],
      [child, 'member'],
    ] as const) {
      await tenancy.run({ workspaceId: A, companyIds: [], userId: id }, async (c) => {
        await new UserRepository(db.db).create(c, { id, email: `${id}@example.test`, name: 'U' });
        await new MembershipRepository(db.db).add(c, { userId: id, role });
      });
    }
    const company = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new CompanyRepository(db.db).create(c, {
        legalName: 'Privacy Ltd',
        tradingName: 'Privacy',
        registeredAddress: { line1: '1 Road', city: 'Town', postcode: 'TE1 1ST' },
      }),
    );
    [ebayAccount, amazonAccount] = await tenancy.runWorkspace({ workspaceId: A }, async (c) => {
      const accounts = new ChannelAccountRepository(db.db);
      return [
        await accounts.create(c, { companyId: company, provider: 'ebay', displayName: 'eBay' }),
        await accounts.create(c, { companyId: company, provider: 'amazon', displayName: 'Amz' }),
      ];
    });
  }, 300_000);

  afterAll(async () => {
    await vault.close();
    await owner.end();
    await db.destroy();
    await Promise.all([main.container.stop(), pii.container.stop()]);
  });

  it('[DEL-4] an admin finds every match, sees masks only, confirms, and the matches are deleted; other rows stay', async () => {
    const server = app();
    const first = await ingest('order-e1', contact('Erin'), amazonAccount);
    const second = await ingest('order-e2', contact('Erin', { phone: '07700900111' }), ebayAccount);
    const other = await ingest('order-o1', contact('Otto'), amazonAccount);
    const email = `${PII_MARKER}erin@example.test`;

    const asChild = await server.inject({
      method: 'POST',
      url: '/api/erasure-requests',
      headers: headers(child),
      payload: { identifiers: { email } },
    });
    expect(asChild.statusCode).toBe(403);

    const res = await server.inject({
      method: 'POST',
      url: '/api/erasure-requests',
      headers: headers(admin),
      payload: { identifiers: { email } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain(PII_MARKER);
    const created = res.json<{
      id: string;
      dueAt: string;
      overdue: boolean;
      state: string;
      matchCount: number;
      matches: { piiRef: string; masked: Record<string, string> }[];
    }>();
    expect(created).toMatchObject({ state: 'open', overdue: false, matchCount: 2 });
    expect(created.dueAt).toBe('2026-12-18T10:00:00.000Z');
    expect(created.matches.map((m) => m.piiRef).sort()).toEqual(
      [first.pii_ref, second.pii_ref].sort(),
    );
    expect(created.matches[0]?.masked.email).toMatch(/\*\*\*/);

    // Overdue once a month has passed and it is still open.
    clock = new Date(clock.getTime() + 31 * DAY);
    const listed = await server.inject({
      method: 'GET',
      url: '/api/erasure-requests',
      headers: headers(admin),
    });
    expect(listed.json<{ items: { id: string; overdue: boolean }[] }>().items).toContainEqual(
      expect.objectContaining({ id: created.id, overdue: true }),
    );

    sent.length = 0;
    const confirmed = await server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${created.id}/confirm`,
      headers: headers(admin),
    });
    expect(confirmed.statusCode).toBe(202);
    expect(confirmed.json()).toMatchObject({ state: 'confirmed', overdue: false });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(PII_MARKER);
    expect(sent[0]?.payload.scope).toEqual({
      type: 'refs',
      pii_refs: [first.pii_ref, second.pii_ref].sort(),
    });
    await runQueued(sent[0] as Sent);
    expect(await alive(first.pii_ref)).toBe(false);
    expect(await alive(second.pii_ref)).toBe(false);
    expect(await alive(other.pii_ref)).toBe(true);

    const again = await server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${created.id}/confirm`,
      headers: headers(admin),
    });
    expect(again.statusCode).toBe(409);
    // Business rows with no PII are kept (DEL-4's legal-obligation exception): only vault records go.
    const companies = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new CompanyRepository(db.db).list(c),
    );
    expect(companies).toHaveLength(1);
    const audit = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new AuditLog(db.db).list(c, {}, { limit: 50 }),
    );
    expect(audit.items.map((e) => e.after)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'erasure_requested', row_count: 2 }),
        expect.objectContaining({ kind: 'erasure_confirmed', row_count: 2 }),
      ]),
    );
    await server.close();
  });

  it('[DEL-4] an admin withdraws an open request with a reason: nothing is deleted, it is never overdue, it cannot be confirmed (ADR-067)', async () => {
    const server = app();
    const kept = await ingest('order-w1', contact('Wren'), amazonAccount);
    const start = (identifiers: Record<string, string>) =>
      server.inject({
        method: 'POST',
        url: '/api/erasure-requests',
        headers: headers(admin),
        payload: { identifiers },
      });
    const withdraw = (id: string, userId: string, payload: unknown) =>
      server.inject({
        method: 'POST',
        url: `/api/erasure-requests/${id}/withdraw`,
        headers: headers(userId),
        payload: payload as Record<string, unknown>,
      });
    const wrong = (await start({ email: `${PII_MARKER}wren@example.test` })).json<{ id: string }>();

    // Admins only; a reason from the fixed list is required.
    expect((await withdraw(wrong.id, child, { reason: 'wrong_identifiers' })).statusCode).toBe(403);
    expect((await withdraw(wrong.id, admin, {})).statusCode).toBe(400);
    expect((await withdraw(wrong.id, admin, { reason: 'typed by hand' })).statusCode).toBe(400);
    expect((await withdraw(randomUUID(), admin, { reason: 'other' })).statusCode).toBe(404);

    sent.length = 0;
    const res = await withdraw(wrong.id, admin, { reason: 'wrong_identifiers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: wrong.id,
      state: 'withdrawn',
      overdue: false,
      withdrawReason: 'wrong_identifiers',
      withdrawnAt: clock.toISOString(),
      jobId: null,
    });
    expect(sent).toEqual([]);
    expect(await alive(kept.pii_ref)).toBe(true);

    // Never overdue, even long after its due date.
    clock = new Date(clock.getTime() + 60 * DAY);
    const listed = await server.inject({
      method: 'GET',
      url: '/api/erasure-requests',
      headers: headers(admin),
    });
    expect(listed.json<{ items: { id: string }[] }>().items).toContainEqual(
      expect.objectContaining({ id: wrong.id, state: 'withdrawn', overdue: false }),
    );

    // A withdrawn request can be neither withdrawn again nor confirmed.
    expect((await withdraw(wrong.id, admin, { reason: 'other' })).statusCode).toBe(409);
    const confirm = await server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${wrong.id}/confirm`,
      headers: headers(admin),
    });
    expect(confirm.statusCode).toBe(409);
    expect(sent).toEqual([]);

    // A confirmed request cannot be withdrawn.
    const done = (await start({ email: `${PII_MARKER}nobody-w@example.test` })).json<{
      id: string;
    }>();
    await server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${done.id}/confirm`,
      headers: headers(admin),
    });
    expect((await withdraw(done.id, admin, { reason: 'duplicate' })).statusCode).toBe(409);

    // Audited with the reason code and the count only, never an identifier.
    const audit = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
      new AuditLog(db.db).list(c, {}, { limit: 100 }),
    );
    const event = audit.items.find(
      (e) =>
        e.entityId === wrong.id &&
        (e.after as { kind?: string } | null)?.kind === 'erasure_withdrawn',
    );
    expect(event?.after).toEqual({ kind: 'erasure_withdrawn', row_count: 1 });
    expect(event?.reason).toBe('wrong_identifiers');
    expect(JSON.stringify(audit.items)).not.toContain(PII_MARKER);
    await server.close();
  });

  it("[DEL-5] the access export holds that buyer's records only, streamed, every read logged", async () => {
    const server = app();
    const mine = await ingest('order-f1', contact('Fay'), amazonAccount);
    await ingest('order-g1', contact('Gus'), amazonAccount);
    const res = await server.inject({
      method: 'POST',
      url: '/api/access-requests/export',
      headers: headers(admin),
      payload: { identifiers: { email: `${PII_MARKER}fay@example.test` } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toContain('no-store');
    const file = res.json<{ records: { subjectId: string; fields: Record<string, string> }[] }>();
    expect(file.records).toHaveLength(1);
    expect(file.records[0]?.subjectId).toBe('order-f1');
    expect(file.records[0]?.fields.name).toBe(`${PII_MARKER}Fay Buyer`);
    expect(res.body).not.toContain('Gus');
    const child403 = await server.inject({
      method: 'POST',
      url: '/api/access-requests/export',
      headers: headers(child),
      payload: { identifiers: { email: `${PII_MARKER}fay@example.test` } },
    });
    expect(child403.statusCode).toBe(403);
    // Too broad: three records share this postcode, over the cap of 2 set for this test.
    const broad = await server.inject({
      method: 'POST',
      url: '/api/access-requests/export',
      headers: headers(admin),
      payload: { identifiers: { postcode: 'SW1A 1AA' } },
    });
    expect(broad.statusCode).toBe(422);
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [A]);
      const reads = await c.query(
        `SELECT pii_ref FROM vault.access_log WHERE purpose = 'subject_access' AND actor_user_id = $1`,
        [admin],
      );
      await c.query('COMMIT');
      expect(reads.rows).toEqual([{ pii_ref: mine.pii_ref }]);
    } finally {
      c.release();
    }
    await server.close();
  });

  it("[AT-10] a signed eBay notice deletes that user's eBay records only, matched exactly ('AbC' never 'abc'); the challenge still answers the right hash", async () => {
    const server = app();
    const { username, userId } = SAMPLE.message.notification.data;
    const feedback = await clients.worker.ingest({
      workspace_id: A,
      kind: 'ebay_feedback',
      channel_account_id: ebayAccount,
      subject_type: 'feedback',
      subject_id: 'fb-at10',
      fields: { buyer_username: username },
    });
    const ebayOrder = await ingest(
      'ebay-order-at10',
      contact('Hal', { channel_buyer_id: userId }),
      ebayAccount,
    );
    // The same username on Amazon is another person: never deleted by an eBay notice.
    const amazonOrder = await ingest(
      'amz-order-at10',
      contact('Ida', { channel_username: username }),
      amazonAccount,
    );
    // ADR-066: IDs and usernames that differ only in case are other people on eBay too.
    const otherCaseId = await ingest(
      'ebay-order-case-id',
      contact('Jo', { channel_buyer_id: userId.toLowerCase() }),
      ebayAccount,
    );
    const otherCaseName = await clients.worker.ingest({
      workspace_id: A,
      kind: 'ebay_feedback',
      channel_account_id: ebayAccount,
      subject_type: 'feedback',
      subject_id: 'fb-case-name',
      fields: { buyer_username: username.toUpperCase() },
    });
    sent.length = 0;
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/ebay/account-deletion',
      headers: { 'content-type': 'application/json', 'x-ebay-signature': SAMPLE.signature },
      payload: JSON.stringify(SAMPLE.message),
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({
      trigger: 'ebay_account_deletion',
      scope: { type: 'refs', pii_refs: [feedback.pii_ref, ebayOrder.pii_ref].sort() },
    });
    expect(JSON.stringify(sent)).not.toContain(username);
    expect(JSON.stringify(sent)).not.toContain(userId);
    await runQueued(sent[0] as Sent);
    expect(await alive(feedback.pii_ref)).toBe(false);
    expect(await alive(ebayOrder.pii_ref)).toBe(false);
    expect(await alive(amazonOrder.pii_ref)).toBe(true);
    expect(await alive(otherCaseId.pii_ref)).toBe(true);
    expect(await alive(otherCaseName.pii_ref)).toBe(true);

    // A second notice for the same user finds nothing left and queues nothing.
    sent.length = 0;
    await server.inject({
      method: 'POST',
      url: '/webhooks/ebay/account-deletion',
      headers: { 'content-type': 'application/json', 'x-ebay-signature': SAMPLE.signature },
      payload: JSON.stringify(SAMPLE.message),
    });
    expect(sent).toEqual([]);

    const challenge = await server.inject({
      method: 'GET',
      url: '/webhooks/ebay/account-deletion?challenge_code=abc123',
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json()).toEqual({
      challengeResponse: challengeResponse('abc123', TOKEN, ENDPOINT),
    });
    // The receipt holds counts, never the user.
    const text = logs.join('');
    expect(text).toContain(
      '"event":"ebay.account_deletion.received","topic":"MARKETPLACE_ACCOUNT_DELETION","verified":true,"count":2',
    );
    expect(text).not.toContain(userId);
    expect(text).not.toContain(`"${username}"`);
    await server.close();
  });

  it('[DEL-4][DEL-5] no PII reached db-main or the logs', async () => {
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
  });
});
