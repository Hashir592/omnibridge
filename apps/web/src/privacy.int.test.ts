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
  /** db-main as ob_owner: plays pg-boss's part for the jobs the fake queue sends (ADR-070). */
  let mainOwner: pg.Pool;
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

  /** Runs inside each send, before it is recorded; a test sets it to race or fail the queue. */
  let beforeSend: (() => Promise<void>) | undefined;
  /** Stands in for the queue: what web would enqueue, checked and then run by hand. */
  const queue: Pick<JobQueue, 'send'> = {
    send: async (def, input) => {
      await beforeSend?.();
      sent.push({
        workspaceId: input.ctx.workspaceId,
        payload: input.payload as Sent['payload'],
        key: input.idempotencyKey,
      });
      const id = randomUUID();
      // The pg-boss row a real send writes. No worker runs here, so it stays created (live)
      // until a test moves it on (ADR-070: the stuck rule reads it).
      await mainOwner.query('INSERT INTO pgboss.job (id, name, data) VALUES ($1, $2, $3)', [
        id,
        def.type,
        { workspace_id: input.ctx.workspaceId },
      ]);
      return { id, created: true };
    },
  };
  /** What pg-boss does to a job: fails it (a last attempt that expired) or cancels it. */
  const setJobState = (jobId: string, state: 'failed' | 'cancelled') =>
    mainOwner.query('UPDATE pgboss.job SET state = $2 WHERE id = $1', [jobId, state]);
  /** What pg-boss retention does to an old job row. */
  const dropJob = (jobId: string) =>
    mainOwner.query('DELETE FROM pgboss.job WHERE id = $1', [jobId]);

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
    mainOwner = new pg.Pool({ ...main.connection('ob_owner'), max: 2 });
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
    await mainOwner.end();
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
    // A-006 (ADR-069): confirmed is in progress, not done: past its due date it stays overdue
    // until the deletion has completed.
    expect(confirmed.json()).toMatchObject({ state: 'confirmed', overdue: true });
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

  it('[DEL-4] a withdraw that races a confirm never leaves a withdrawn request with a deletion job (S5-20261118-02)', async () => {
    const server = app();
    const target = await ingest('order-r1', contact('Rae'), amazonAccount);
    const created = (
      await server.inject({
        method: 'POST',
        url: '/api/erasure-requests',
        headers: headers(admin),
        payload: { identifiers: { email: `${PII_MARKER}rae@example.test` } },
      })
    ).json<{ id: string }>();
    // A second admin withdraws while the confirm is queueing the deletion.
    let raced: number | undefined;
    beforeSend = async () => {
      beforeSend = undefined;
      raced = (
        await server.inject({
          method: 'POST',
          url: `/api/erasure-requests/${created.id}/withdraw`,
          headers: headers(admin),
          payload: { reason: 'wrong_identifiers' },
        })
      ).statusCode;
    };
    sent.length = 0;
    try {
      const confirmed = await server.inject({
        method: 'POST',
        url: `/api/erasure-requests/${created.id}/confirm`,
        headers: headers(admin),
      });
      expect(raced).toBe(409);
      expect(confirmed.statusCode).toBe(202);
      expect(confirmed.json()).toMatchObject({ state: 'confirmed', withdrawnAt: null });
      expect(sent).toHaveLength(1);
      const listed = await server.inject({
        method: 'GET',
        url: '/api/erasure-requests',
        headers: headers(admin),
      });
      const row = listed
        .json<{ items: { id: string; state: string; jobId: string | null }[] }>()
        .items.find((r) => r.id === created.id);
      expect(row?.state).toBe('confirmed');
      expect(row?.jobId).not.toBeNull();
      await runQueued(sent[0] as Sent);
      expect(await alive(target.pii_ref)).toBe(false);
    } finally {
      beforeSend = undefined;
      await server.close();
    }
  });

  it('[DEL-4] a confirm whose queue call fails stays claimed: it cannot be withdrawn, and confirming again queues it once (S5-20261118-02)', async () => {
    const server = app();
    const target = await ingest('order-q1', contact('Quin'), amazonAccount);
    const created = (
      await server.inject({
        method: 'POST',
        url: '/api/erasure-requests',
        headers: headers(admin),
        payload: { identifiers: { email: `${PII_MARKER}quin@example.test` } },
      })
    ).json<{ id: string }>();
    const confirm = () =>
      server.inject({
        method: 'POST',
        url: `/api/erasure-requests/${created.id}/confirm`,
        headers: headers(admin),
      });
    sent.length = 0;
    beforeSend = () => {
      beforeSend = undefined;
      return Promise.reject(new Error('queue down'));
    };
    try {
      expect((await confirm()).statusCode).toBe(500);
      expect(sent).toEqual([]);
      const withdraw = await server.inject({
        method: 'POST',
        url: `/api/erasure-requests/${created.id}/withdraw`,
        headers: headers(admin),
        payload: { reason: 'other' },
      });
      expect(withdraw.statusCode).toBe(409);
      const retried = await confirm();
      expect(retried.statusCode).toBe(202);
      expect(retried.json<{ jobId: string | null }>().jobId).not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.key).toBe(`erasure:${created.id}`);
      // Once queued, another confirm is a conflict and queues nothing.
      expect((await confirm()).statusCode).toBe(409);
      expect(sent).toHaveLength(1);
      await runQueued(sent[0] as Sent);
      expect(await alive(target.pii_ref)).toBe(false);
      // Audited once, when the request was claimed.
      const audit = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
        new AuditLog(db.db).list(c, {}, { limit: 200 }),
      );
      expect(
        audit.items.filter(
          (e) =>
            e.entityId === created.id &&
            (e.after as { kind?: string } | null)?.kind === 'erasure_confirmed',
        ),
      ).toHaveLength(1);
    } finally {
      beforeSend = undefined;
      await server.close();
    }
  });

  // A-006 (ADR-069): confirmed is not completed. A failed deletion shows failed and stays overdue
  // until an admin retries it and it completes; the retry queues the same refs as a new run.
  it('[DEL-4] a failed deletion leaves the request failed and overdue; an admin retries it (audited) and only completion ends the clock (A-006)', async () => {
    const server = app();
    const target = await ingest('order-r1', contact('Rory'), amazonAccount);
    const created = (
      await server.inject({
        method: 'POST',
        url: '/api/erasure-requests',
        headers: headers(admin),
        payload: { identifiers: { email: `${PII_MARKER}rory@example.test` } },
      })
    ).json<{ id: string; dueAt: string }>();
    sent.length = 0;
    const confirmed = await server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${created.id}/confirm`,
      headers: headers(admin),
    });
    expect(confirmed.statusCode).toBe(202);
    const firstJob = confirmed.json<{ jobId: string }>().jobId;
    const listed = async () =>
      (
        await server.inject({
          method: 'GET',
          url: '/api/erasure-requests',
          headers: headers(admin),
        })
      )
        .json<{ items: Record<string, unknown>[] }>()
        .items.find((r) => r.id === created.id);
    const retry = (id: string, userId: string) =>
      server.inject({
        method: 'POST',
        url: `/api/erasure-requests/${id}/retry`,
        headers: headers(userId),
      });
    const savedClock = clock;
    try {
      // Only a failed request can be retried.
      expect((await retry(created.id, admin)).statusCode).toBe(409);
      // The worker's deletion job fails for the last time (as the pii.delete handler records it).
      const erasures = new ErasureRequestRepository(db.db);
      await tenancy.runWorkspace({ workspaceId: A }, (c) => erasures.fail(c, firstJob, clock));
      clock = new Date(Date.parse(created.dueAt) + DAY);
      expect(await listed()).toMatchObject({ state: 'failed', overdue: true, retryCount: 0 });

      expect((await retry(created.id, child)).statusCode).toBe(403);
      expect((await retry(randomUUID(), admin)).statusCode).toBe(404);
      sent.length = 0;
      const retried = await retry(created.id, admin);
      expect(retried.statusCode).toBe(202);
      const body = retried.json<{ jobId: string; state: string; retryCount: number }>();
      expect(body).toMatchObject({ state: 'confirmed', retryCount: 1, overdue: true });
      expect(body.jobId).not.toBe(firstJob);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.key).toBe(`erasure:${created.id}:retry1`);
      expect(sent[0]?.payload.scope).toEqual({ type: 'refs', pii_refs: [target.pii_ref] });
      expect((await retry(created.id, admin)).statusCode).toBe(409);

      // The old job's failure arriving late changes nothing: it is not the request's job now.
      await tenancy.runWorkspace({ workspaceId: A }, (c) => erasures.fail(c, firstJob, clock));
      expect(await listed()).toMatchObject({ state: 'confirmed', overdue: true });

      await runQueued(sent[0] as Sent);
      expect(await alive(target.pii_ref)).toBe(false);
      await tenancy.runWorkspace({ workspaceId: A }, (c) =>
        erasures.complete(c, body.jobId, clock),
      );
      const done = await listed();
      expect(done).toMatchObject({ state: 'completed', overdue: false, failedAt: null });
      expect(done?.completedAt).toEqual(clock.toISOString());

      const audit = await tenancy.runWorkspace({ workspaceId: A }, (c) =>
        new AuditLog(db.db).list(c, {}, { limit: 200 }),
      );
      expect(
        audit.items
          .filter((e) => e.entityId === created.id)
          .map((e) => (e.after as { kind?: string } | null)?.kind),
      ).toEqual(expect.arrayContaining(['erasure_confirmed', 'erasure_retried']));
    } finally {
      clock = savedClock;
      await server.close();
    }
  });

  // ADR-070 (F-M04e-01, F-M04e-02): a confirmed request whose deletion will never finish on its
  // own is stuck: the list says so and an admin can retry it. A request with a live job is not.
  const startRequest = async (server: ReturnType<typeof app>, who: string) => {
    await ingest(`order-${who}`, contact(who), amazonAccount);
    const created = (
      await server.inject({
        method: 'POST',
        url: '/api/erasure-requests',
        headers: headers(admin),
        payload: { identifiers: { email: `${PII_MARKER}${who.toLowerCase()}@example.test` } },
      })
    ).json<{ id: string }>();
    return created.id;
  };
  const confirmAs = (server: ReturnType<typeof app>, id: string) =>
    server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${id}/confirm`,
      headers: headers(admin),
    });
  const listedIn = async (server: ReturnType<typeof app>, id: string) =>
    (await server.inject({ method: 'GET', url: '/api/erasure-requests', headers: headers(admin) }))
      .json<{ items: { id: string; state: string; stuck: boolean; jobId: string | null }[] }>()
      .items.find((r) => r.id === id);
  const retryAs = (server: ReturnType<typeof app>, id: string) =>
    server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${id}/retry`,
      headers: headers(admin),
    });

  it('[DEL-4] a claimed request whose queue call failed shows stuck once the grace period is over; retry queues it as a new run', async () => {
    const server = app();
    const savedClock = clock;
    try {
      const id = await startRequest(server, 'Stella');
      beforeSend = () => {
        beforeSend = undefined;
        return Promise.reject(new Error('queue down'));
      };
      expect((await confirmAs(server, id)).statusCode).toBe(500);
      // Within the grace period the confirm may still be on its way: not stuck, no retry.
      expect(await listedIn(server, id)).toMatchObject({ state: 'confirmed', stuck: false });
      expect((await retryAs(server, id)).statusCode).toBe(409);
      clock = new Date(clock.getTime() + 3 * 60_000);
      expect(await listedIn(server, id)).toMatchObject({
        state: 'confirmed',
        stuck: true,
        jobId: null,
      });
      sent.length = 0;
      const retried = await retryAs(server, id);
      expect(retried.statusCode).toBe(202);
      expect(retried.json()).toMatchObject({ state: 'confirmed', retryCount: 1, stuck: false });
      expect(sent.map((x) => x.key)).toEqual([`erasure:${id}:retry1`]);
      expect(await listedIn(server, id)).toMatchObject({ stuck: false });
      expect((await retryAs(server, id)).statusCode).toBe(409);
    } finally {
      beforeSend = undefined;
      clock = savedClock;
      await server.close();
    }
  });

  it('[DEL-4] a request whose job is live is not stuck (retry 409); once its job failed on an expired last attempt, was cancelled or is gone, it is stuck and retry re-queues it', async () => {
    const server = app();
    const endings: [string, (jobId: string) => Promise<unknown>][] = [
      ['Tess', (j) => setJobState(j, 'failed')],
      ['Uma', (j) => setJobState(j, 'cancelled')],
      ['Vic', (j) => dropJob(j)],
    ];
    try {
      for (const [who, end] of endings) {
        const id = await startRequest(server, who);
        const confirmed = await confirmAs(server, id);
        expect(confirmed.statusCode).toBe(202);
        const jobId = confirmed.json<{ jobId: string }>().jobId;
        expect(await listedIn(server, id)).toMatchObject({ state: 'confirmed', stuck: false });
        expect((await retryAs(server, id)).statusCode).toBe(409);

        // The worker died on the last attempt (or the job was cancelled or removed): no hook ran.
        await end(jobId);
        expect(await listedIn(server, id)).toMatchObject({ state: 'confirmed', stuck: true });
        sent.length = 0;
        const retried = await retryAs(server, id);
        expect(retried.statusCode).toBe(202);
        expect(retried.json<{ jobId: string }>().jobId).not.toBe(jobId);
        expect(sent.map((x) => x.key)).toEqual([`erasure:${id}:retry1`]);
        expect(await listedIn(server, id)).toMatchObject({ state: 'confirmed', stuck: false });
      }
    } finally {
      await server.close();
    }
  });

  it('[DEL-4] a completed request whose job row retention has deleted is never stuck and cannot be retried', async () => {
    const server = app();
    try {
      const id = await startRequest(server, 'Wren');
      const jobId = (await confirmAs(server, id)).json<{ jobId: string }>().jobId;
      await tenancy.runWorkspace({ workspaceId: A }, (c) =>
        new ErasureRequestRepository(db.db).complete(c, jobId, clock),
      );
      await dropJob(jobId);
      expect(await listedIn(server, id)).toMatchObject({ state: 'completed', stuck: false });
      expect((await retryAs(server, id)).statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });

  it('[DEL-4] a confirmed request with no matches is completed at once, so it is never overdue (A-006)', async () => {
    const server = app();
    const created = (
      await server.inject({
        method: 'POST',
        url: '/api/erasure-requests',
        headers: headers(admin),
        payload: { identifiers: { email: `${PII_MARKER}nobody-${randomUUID()}@example.test` } },
      })
    ).json<{ id: string; matchCount: number }>();
    expect(created.matchCount).toBe(0);
    sent.length = 0;
    const res = await server.inject({
      method: 'POST',
      url: `/api/erasure-requests/${created.id}/confirm`,
      headers: headers(admin),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ state: 'completed', overdue: false, jobId: null });
    expect(sent).toEqual([]);
    await server.close();
  });

  it('[DEL-5][DEL-4] a postcode alone is refused for an access export and an erasure; a name with it, or one strong identifier, is not (S5-20261118-04)', async () => {
    const server = app();
    const post = (url: string, identifiers: Record<string, string>) =>
      server.inject({ method: 'POST', url, headers: headers(admin), payload: { identifiers } });
    for (const url of ['/api/access-requests/export', '/api/erasure-requests']) {
      for (const weak of [{ postcode: 'SW1A 1AA' }, { name: `${PII_MARKER}Nobody Buyer` }, {}]) {
        const res = await post(url, weak);
        expect(res.statusCode).toBe(400);
        expect(res.json<{ code: string }>().code).toBe('validation_failed');
        expect(res.body).not.toContain(PII_MARKER);
      }
    }
    const strong = [
      { email: `${PII_MARKER}nobody-s@example.test` },
      { phone: '07700900999' },
      { buyer: `${PII_MARKER}nobody-s` },
      { name: `${PII_MARKER}Nobody Buyer`, postcode: 'SW1A 1AA' },
    ];
    for (const identifiers of strong) {
      expect((await post('/api/erasure-requests', identifiers)).statusCode).toBe(201);
    }
    await server.close();
  });

  it('[DP-8] every /api response says no-store, errors too (S5-20261118 hardening 2)', async () => {
    const server = app();
    const listed = await server.inject({
      method: 'GET',
      url: '/api/erasure-requests',
      headers: headers(admin),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const refused = await server.inject({ method: 'GET', url: '/api/erasure-requests' });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['cache-control']).toBe('no-store');
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
    // Too broad: three records match this name and postcode, over the cap of 2 set for this test.
    await ingest('order-f2', contact('Fay'), ebayAccount);
    await ingest('order-f3', contact('Fay'), ebayAccount);
    const broad = await server.inject({
      method: 'POST',
      url: '/api/access-requests/export',
      headers: headers(admin),
      payload: { identifiers: { name: `${PII_MARKER}Fay Buyer`, postcode: 'SW1A 1AA' } },
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

  // A-001 (ADR-069): the auditor matched 5,001 records of one eBay user and 5,000 were deleted:
  // the match stopped at 5,000 with no word of the rest. Every record must be found (paged) and
  // queued before the 200, and a deletion path that hits a limit must fail loudly.
  it('[AT-10][DEL-4] 5,001 records of one eBay user: an erasure refuses a partial match, and the eBay notice deletes every one (A-001)', async () => {
    const server = app();
    const { username } = SAMPLE.message.notification.data;
    const refs: string[] = [];
    for (let i = 0; i < 5_001; i += 50) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(50, 5_001 - i) }, (_, j) =>
          clients.worker.ingest({
            workspace_id: A,
            kind: 'ebay_feedback',
            channel_account_id: ebayAccount,
            subject_type: 'feedback',
            subject_id: `fb-a001-${String(i + j)}`,
            fields: { buyer_username: username },
          }),
        ),
      );
      refs.push(...batch.map((r) => r.pii_ref));
    }
    const remaining = async () => {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [A]);
        const res = await c.query<{ n: string }>(
          'SELECT count(*) AS n FROM vault.records WHERE pii_ref = ANY($1::uuid[])',
          [refs],
        );
        await c.query('COMMIT');
        return Number(res.rows[0]?.n);
      } finally {
        c.release();
      }
    };
    expect(await remaining()).toBe(5_001);

    // An erasure search that matches more than one answer holds is refused, not stored short.
    const listed = async () =>
      (
        await server.inject({
          method: 'GET',
          url: '/api/erasure-requests',
          headers: headers(admin),
        })
      ).json<{ items: unknown[] }>().items.length;
    const before = await listed();
    const erasure = await server.inject({
      method: 'POST',
      url: '/api/erasure-requests',
      headers: headers(admin),
      payload: { identifiers: { buyer: username } },
    });
    expect(erasure.statusCode).toBe(422);
    expect(erasure.json()).toMatchObject({ code: 'too_many_matches' });
    expect(await listed()).toBe(before);

    // The eBay notice pages through every match and queues them all before it answers.
    sent.length = 0;
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/ebay/account-deletion',
      headers: { 'content-type': 'application/json', 'x-ebay-signature': SAMPLE.signature },
      payload: JSON.stringify(SAMPLE.message),
    });
    expect(res.statusCode).toBe(200);
    const queued = sent.flatMap((s) =>
      s.payload.scope.type === 'refs' ? s.payload.scope.pii_refs : [],
    );
    expect(queued).toHaveLength(5_001);
    expect(new Set(queued)).toEqual(new Set(refs));
    expect(new Set(sent.map((s) => s.key)).size).toBe(sent.length);
    // Each key is a fixed-length hash, so a long notice id never exceeds the 200-character cap.
    expect(sent.every((s) => s.key.length <= 200)).toBe(true);
    for (const s of sent) await runQueued(s);
    expect(await remaining()).toBe(0);
    await server.close();
  }, 300_000);

  it('[DEL-4][DEL-5] no PII reached db-main or the logs', async () => {
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
  });
});
