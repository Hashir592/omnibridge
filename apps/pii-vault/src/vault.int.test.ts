import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateIndexKey,
  generateKekLine,
  parseKeyring,
  unwrapIndexKey,
} from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { migratePii } from '@omnibridge/pii-db';
import {
  PII_MARKER,
  scanTextForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient, VaultError } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildVaultApp } from './app.ts';
import { ServiceTokens } from './auth.ts';
import { DeletionJournal, DeletionService } from './deletion.ts';
import { Vault, VAULT_KEY_SCOPE } from './vault.ts';

// T-0402: the PII store and its capability-scoped API, against a real db-pii with the real roles.

const token = () => randomBytes(32).toString('base64url');

describe('pii-vault core [DP-4][DP-5][DP-6][DP-7]', () => {
  let cluster: RoleCluster;
  let appPool: pg.Pool;
  let ownerPool: pg.Pool;
  /** The cluster's superuser: reads raw heap pages, nothing else. */
  let rootPool: pg.Pool;
  let close: () => Promise<void>;
  let vault: Vault;
  let baseUrl = '';
  const logs: string[] = [];
  const tokens = { web: token(), worker: token(), deletion: token() };
  const clients = {} as Record<keyof typeof tokens, VaultClient>;
  const A = randomUUID();
  const B = randomUUID();
  const keyring = parseKeyring('pii', generateKekLine(1));
  const journalDir = mkdtempSync(join(tmpdir(), 'ob-journal-'));
  const journalLines = () =>
    readdirSync(journalDir)
      .flatMap((f) => readFileSync(join(journalDir, f), 'utf8').split('\n'))
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, string>);
  const account = randomUUID();
  const otherAccount = randomUUID();

  const contact = (n: string, extra: Record<string, string> = {}) => ({
    name: `${PII_MARKER}Jane ${n} Smith`,
    email: `${PII_MARKER}${n}@example.test`,
    phone: '+44 7700 900' + n.padStart(3, '0').slice(-3),
    address_line1: `${PII_MARKER}${n} High Street`,
    postcode: 'G2 1AA',
    ...extra,
  });
  const ingest = (
    workspaceId: string,
    subjectId: string,
    fields: Record<string, string>,
    channel = account,
  ) =>
    clients.web.ingest({
      workspace_id: workspaceId,
      kind: 'buyer_contact',
      channel_account_id: channel,
      subject_type: 'order',
      subject_id: subjectId,
      fields,
    });
  /** Raw SQL as a db-pii role, in one workspace (row-level security binds the owner too). */
  const raw = async (pool: pg.Pool, workspaceId: string, sql: string, params: unknown[] = []) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      const res = await c.query(sql, params);
      await c.query('COMMIT');
      return res.rows as Record<string, unknown>[];
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']);
    await migratePii(cluster.connection('vault_owner'));
    appPool = new pg.Pool({ ...cluster.connection('vault_app'), max: 4 });
    ownerPool = new pg.Pool({ ...cluster.connection('vault_owner'), max: 2 });
    rootPool = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 1 });
    await rootPool.query('CREATE EXTENSION IF NOT EXISTS pageinspect');
    const logger = createLogger({
      service: 'pii-vault',
      version: 'test',
      destination: { write: (line: string) => (logs.push(line), true) },
    });
    vault = new Vault({
      pool: appPool,
      keyring,
      journal: new DeletionJournal(journalDir),
      onCanary: (event) => {
        logger.warn(
          { event: 'vault.canary_read', workspaceId: event.workspaceId },
          'canary record read',
        );
      },
    });
    await vault.ensureVaultKey();
    const app = buildVaultApp({
      logger,
      version: 'test',
      dbPii: () => Promise.resolve(true),
      vault,
      tokens: new ServiceTokens(tokens),
      deletion: new DeletionService({
        pool: appPool,
        journal: new DeletionJournal(journalDir),
      }),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(port)}`;
    for (const caller of ['web', 'worker', 'deletion'] as const) {
      clients[caller] = new VaultClient({ baseUrl, token: tokens[caller] });
    }
    close = () => app.close();
  }, 300_000);

  afterAll(async () => {
    await close();
    await Promise.all([appPool.end(), ownerPool.end(), rootPool.end()]);
    await cluster.container.stop();
  });

  it('[DP-6] fields are stored as AES-256-GCM ciphertext only: a raw read shows no plaintext', async () => {
    const { pii_ref } = await ingest(A, 'order-1', contact('101'));
    const rows = await raw(ownerPool, A, 'SELECT * FROM vault.record_fields WHERE pii_ref = $1', [
      pii_ref,
    ]);
    expect(rows.length).toBe(5);
    for (const row of rows) {
      const bytes = row.ciphertext as Buffer;
      expect(bytes.includes(Buffer.from(PII_MARKER))).toBe(false);
      expect(bytes.includes(Buffer.from('G2 1AA'))).toBe(false);
    }
    const everything = JSON.stringify(
      await raw(
        ownerPool,
        A,
        `SELECT r.*, b.* FROM vault.records r JOIN vault.blind_index b USING (workspace_id, pii_ref)`,
      ),
    );
    expect(everything).not.toContain(PII_MARKER);
    // The workspace key is stored wrapped, never as 32 plain bytes.
    const keys = await raw(
      ownerPool,
      A,
      'SELECT kind, octet_length(wrapped) AS n FROM vault.workspace_keys',
    );
    expect(keys.map((k) => k.kind).sort()).toEqual(['data', 'index']);
    expect(keys.every((k) => Number(k.n) > 32)).toBe(true);
  });

  it('[DP-7] read-full returns the record for an allowed purpose and logs who, why and which, never a value', async () => {
    const { pii_ref } = await ingest(A, 'order-2', contact('102'));
    const actor = randomUUID();
    const full = await clients.web.readFull({
      workspaceId: A,
      piiRef: pii_ref,
      purpose: 'order_detail',
      actorUserId: actor,
    });
    expect(full.fields.name).toBe(`${PII_MARKER}Jane 102 Smith`);
    expect(full.subject_id).toBe('order-2');
    const log = await raw(ownerPool, A, 'SELECT * FROM vault.access_log WHERE pii_ref = $1', [
      pii_ref,
    ]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      caller: 'web',
      capability: 'read_full',
      purpose: 'order_detail',
      actor_user_id: actor,
    });
    expect(JSON.stringify(log)).not.toContain(PII_MARKER);
  });

  it('[DP-7] a caller without the capability or purpose gets 403', async () => {
    const { pii_ref } = await ingest(A, 'order-3', contact('103'));
    const refused = async (p: Promise<unknown>) => {
      const err: unknown = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VaultError);
      return (err as VaultError).status;
    };
    expect(
      await refused(
        clients.deletion.readFull({ workspaceId: A, piiRef: pii_ref, purpose: 'label' }),
      ),
    ).toBe(403);
    expect(
      await refused(
        clients.worker.search({
          workspaceId: A,
          purpose: 'order_search',
          query: { postcode: 'G2 1AA' },
        }),
      ),
    ).toBe(403);
    expect(
      await refused(clients.web.readFull({ workspaceId: A, piiRef: pii_ref, purpose: 'label' })),
    ).toBe(403);
    expect(
      await refused(
        clients.deletion.ingest({
          workspace_id: A,
          kind: 'ebay_feedback',
          subject_type: 'feedback',
          subject_id: 'f',
          fields: { buyer_username: 'x' },
        }),
      ),
    ).toBe(403);
    const stranger = new VaultClient({ baseUrl, token: token() });
    expect(await refused(stranger.mask(A, [pii_ref]))).toBe(401);
  });

  it('[DP-7] a pii_ref of another workspace is not found (404), for every capability', async () => {
    const { pii_ref } = await ingest(A, 'order-4', contact('104'));
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 200,
        (e: unknown) => (e as VaultError).status,
      );
    expect(
      await status(
        clients.web.readFull({ workspaceId: B, piiRef: pii_ref, purpose: 'order_detail' }),
      ),
    ).toBe(404);
    expect(await status(clients.web.match(B, pii_ref))).toBe(404);
    expect((await clients.web.mask(B, [pii_ref])).records).toEqual([]);
    expect(
      (
        await clients.web.search({
          workspaceId: B,
          purpose: 'order_search',
          query: { postcode: 'G21AA' },
        })
      ).matches,
    ).toEqual([]);
  });

  it('[DP-5] only the DP-5 fields of each kind are accepted', async () => {
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 201,
        (e: unknown) => (e as VaultError).status,
      );
    expect(await status(ingest(A, 'order-5', { name: 'x', vat_number: 'GB123' }))).toBe(422);
    expect(
      await status(
        clients.web.ingest({
          workspace_id: A,
          kind: 'ebay_feedback',
          subject_type: 'feedback',
          subject_id: 'f1',
          fields: { email: 'a@b.test' },
        }),
      ),
    ).toBe(422);
  });

  it('[DP-7] masks are computed on request in the ORD-5 shape and never stored', async () => {
    const { pii_ref } = await ingest(A, 'order-6', {
      name: 'Jane Smith',
      postcode: 'g2 1aa',
      email: 'jane@example.test',
    });
    const masked = await clients.web.mask(A, [pii_ref]);
    expect(masked.records[0]?.fields).toMatchObject({
      name: 'J. S***',
      postcode: 'G2',
      email: 'j***@e***',
    });
    const stored = JSON.stringify(
      await raw(ownerPool, A, 'SELECT * FROM vault.record_fields WHERE pii_ref = $1', [pii_ref]),
    );
    expect(stored).not.toContain('S***');
  });

  it('[DP-7] a blind-index search finds a normalised match and logs the count only', async () => {
    const { pii_ref } = await ingest(
      A,
      'order-7',
      contact('107', { postcode: 'EH1 1YZ', email: 'Mixed.Case@Example.TEST' }),
    );
    const found = await clients.web.search({
      workspaceId: A,
      purpose: 'erasure',
      query: { postcode: ' eh11yz ', email: 'mixed.case@example.test' },
    });
    expect(found.matches.map((m) => m.pii_ref)).toEqual([pii_ref]);
    expect(found.truncated).toBe(false);
    expect(found.matches[0]).toMatchObject({ subject_type: 'order', subject_id: 'order-7' });
    const log = await raw(
      ownerPool,
      A,
      `SELECT * FROM vault.access_log WHERE capability = 'search' AND purpose = 'erasure'`,
    );
    expect(log.at(-1)).toMatchObject({ result_count: '1', pii_ref: null });
    expect(JSON.stringify(log)).not.toContain('EH1');
    // Every identifier must match: the right postcode with a wrong email finds nothing.
    const none = await clients.web.search({
      workspaceId: A,
      purpose: 'erasure',
      query: { postcode: 'EH1 1YZ', email: 'other@example.test' },
    });
    expect(none.matches).toEqual([]);
  });

  it('[DP-7] match returns only same-buyer subject IDs on the same channel account (ORD-9)', async () => {
    const same = { name: 'Sam Same', address_line1: '1 Same Road', postcode: 'AB1 2CD' };
    const first = await ingest(A, 'order-m1', same);
    await ingest(A, 'order-m2', { ...same, name: '  sam   SAME ', postcode: 'ab12cd' });
    await ingest(A, 'order-m3', same, otherAccount);
    await ingest(A, 'order-m4', { ...same, address_line1: '2 Other Road' });
    expect((await clients.worker.match(A, first.pii_ref)).subject_ids).toEqual(['order-m2']);
  });

  it('[DP-7] a purpose opens only the kinds it covers: a label never reads an eBay message', async () => {
    const { pii_ref } = await clients.worker.ingest({
      workspace_id: A,
      kind: 'ebay_message',
      subject_type: 'conversation',
      subject_id: 'conv-1',
      fields: { message_body: `${PII_MARKER}hello`, sender_username: `${PII_MARKER}buyer1` },
    });
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 200,
        (e: unknown) => (e as VaultError).status,
      );
    expect(
      await status(clients.worker.readFull({ workspaceId: A, piiRef: pii_ref, purpose: 'label' })),
    ).toBe(403);
    expect(
      await status(clients.worker.readFull({ workspaceId: A, piiRef: pii_ref, purpose: 'inbox' })),
    ).toBe(200);
    const log = await raw(ownerPool, A, 'SELECT purpose FROM vault.access_log WHERE pii_ref = $1', [
      pii_ref,
    ]);
    expect(log.map((l) => l.purpose)).toEqual(['inbox']);
  });

  it('[DP-5] a record ingested with no expiry still goes within the 90-day hard limit', async () => {
    const { pii_ref } = await ingest(A, 'order-backstop', contact('199'));
    const rows = await raw(
      ownerPool,
      A,
      'SELECT created_at, delete_after FROM vault.records WHERE pii_ref = $1',
      [pii_ref],
    );
    const days =
      ((rows[0]?.delete_after as Date).getTime() - (rows[0]?.created_at as Date).getTime()) /
      86_400_000;
    expect(days).toBeCloseTo(90, 3);
  });

  it('[DEL-1][DP-6] delete_after is accepted only from now minus 1 day to now plus 90 days (F-M04h-02)', async () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const status = (p: Promise<unknown>) =>
      p.then(
        () => 200,
        (e: unknown) => (e instanceof VaultError ? e.status : 0),
      );
    const withExpiry = (subject: string, deleteAfter: string) =>
      clients.web.ingest({
        workspace_id: A,
        kind: 'buyer_contact',
        channel_account_id: account,
        subject_type: 'order',
        subject_id: subject,
        delete_after: deleteAfter,
        fields: contact('201'),
      });
    expect(await status(withExpiry('exp-late', at(90 * DAY + HOUR)))).toBe(400);
    expect(await status(withExpiry('exp-early', at(-DAY - HOUR)))).toBe(400);
    expect(await status(withExpiry('exp-9999', '9999-12-31T00:00:00Z'))).toBe(400);
    const { pii_ref } = await withExpiry('exp-ok', at(90 * DAY - HOUR));
    expect(await status(withExpiry('exp-past-ok', at(-DAY + HOUR)))).toBe(200);
    const expiry = (deleteAfter: string) =>
      clients.worker.setExpiry({
        workspace_id: A,
        pii_refs: [pii_ref],
        delete_after: deleteAfter,
        reason: 'delivery',
      });
    expect(await status(expiry(at(90 * DAY + HOUR)))).toBe(400);
    expect(await status(expiry(at(-DAY - HOUR)))).toBe(400);
    expect(await expiry(at(25 * DAY))).toEqual({ updated: 1 });
  });

  it('[DP-5] reads never make keys: an unknown workspace gets none and answers empty or 404 (F-M04h-04)', async () => {
    const unknown = randomUUID();
    const ref = randomUUID();
    expect(await clients.web.mask(unknown, [ref])).toEqual({ records: [] });
    expect(
      await clients.web.search({
        workspaceId: unknown,
        purpose: 'order_search',
        query: { postcode: 'G2 1AA' },
      }),
    ).toEqual({ matches: [], truncated: false });
    const missing = await clients.web
      .readFull({ workspaceId: unknown, piiRef: ref, purpose: 'order_detail' })
      .catch((e: unknown) => e);
    expect((missing as VaultError).status).toBe(404);
    const matched = await clients.web.match(unknown, ref).catch((e: unknown) => e);
    expect((matched as VaultError).status).toBe(404);
    expect(await raw(ownerPool, unknown, 'SELECT 1 FROM vault.workspace_keys')).toEqual([]);
    expect(await raw(ownerPool, unknown, 'SELECT 1 FROM vault.access_log')).toEqual([]);
  });

  it('[SEC-12] each workspace gets one canary that no search finds; reading or masking it writes a canary event', async () => {
    const C = randomUUID();
    await ingest(C, 'order-canary-1', contact('301'));
    const canaries = await raw(
      ownerPool,
      C,
      'SELECT pii_ref, delete_after FROM vault.records WHERE canary',
    );
    expect(canaries).toHaveLength(1);
    const canary = canaries[0]?.pii_ref as string;
    expect(String(canaries[0]?.delete_after)).toBe('Infinity');
    // No blind index, so no search or match reaches it.
    expect(
      await raw(ownerPool, C, 'SELECT 1 FROM vault.blind_index WHERE pii_ref = $1', [canary]),
    ).toEqual([]);
    const found = await clients.web.search({
      workspaceId: C,
      purpose: 'erasure',
      query: { name: 'Canary Record' },
    });
    expect(found.matches).toEqual([]);
    // A second ingest makes no second canary.
    await ingest(C, 'order-canary-2', contact('302'));
    expect(await raw(ownerPool, C, 'SELECT 1 FROM vault.records WHERE canary')).toHaveLength(1);
    const before = logs.length;
    await clients.web.readFull({ workspaceId: C, piiRef: canary, purpose: 'order_detail' });
    await clients.web.mask(C, [canary]);
    const events = await raw(
      ownerPool,
      C,
      'SELECT pii_ref, caller, capability FROM vault.canary_events ORDER BY id',
    );
    expect(events).toEqual([
      { pii_ref: canary, caller: 'web', capability: 'read_full' },
      { pii_ref: canary, caller: 'web', capability: 'mask' },
    ]);
    expect(logs.slice(before).filter((l) => l.includes('vault.canary_read'))).toHaveLength(2);
  });

  it('[SEC-12] the canary expiry cannot be moved, so the expiry job never deletes it (S5-20261118 hardening 3)', async () => {
    const D = randomUUID();
    const { pii_ref: real } = await ingest(D, 'order-canary-exp', contact('303'));
    const canary = (await raw(ownerPool, D, 'SELECT pii_ref FROM vault.records WHERE canary'))[0]
      ?.pii_ref as string;
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(
      await clients.worker.setExpiry({
        workspace_id: D,
        pii_refs: [canary, real],
        delete_after: soon,
        reason: 'dispatch',
      }),
    ).toEqual({ updated: 1 });
    const rows = await raw(
      ownerPool,
      D,
      'SELECT pii_ref, delete_after FROM vault.records WHERE pii_ref = ANY($1::uuid[])',
      [[canary, real]],
    );
    const after = new Map(rows.map((r) => [r.pii_ref as string, String(r.delete_after)]));
    expect(after.get(canary)).toBe('Infinity');
    expect(after.get(real)).not.toBe('Infinity');
  });

  it('[DP-7] access-log rows and canary events go after 6 years, in every workspace, and only through the purge (ADR-068)', async () => {
    const E = randomUUID();
    const F = randomUUID();
    const old = "now() - interval '6 years' - interval '1 day'";
    const recent = "now() - interval '6 years' + interval '1 day'";
    for (const w of [E, F]) {
      for (const at of [old, recent]) {
        await raw(
          ownerPool,
          w,
          `INSERT INTO vault.access_log (workspace_id, at, caller, capability, purpose, result_count)
           VALUES ($1, ${at}, 'web', 'search', 'erasure', 0)`,
          [w],
        );
        await raw(
          ownerPool,
          w,
          `INSERT INTO vault.canary_events (workspace_id, pii_ref, at, caller, capability)
           VALUES ($1, gen_random_uuid(), ${at}, 'web', 'mask')`,
          [w],
        );
      }
    }
    // The vault's own role cannot delete them directly.
    await expect(
      raw(appPool, E, 'DELETE FROM vault.access_log WHERE workspace_id = $1', [E]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      raw(appPool, E, 'DELETE FROM vault.canary_events WHERE workspace_id = $1', [E]),
    ).rejects.toThrow(/permission denied/);
    // Outside the purge, the owner sees no other workspace's rows either.
    expect(
      await raw(ownerPool, E, 'SELECT 1 FROM vault.access_log WHERE workspace_id = $1', [F]),
    ).toEqual([]);

    expect(await vault.purgeSecurityLogs()).toBeGreaterThanOrEqual(4);
    for (const w of [E, F]) {
      const logRows = await raw(
        ownerPool,
        w,
        `SELECT at > now() - interval '6 years' AS recent FROM vault.access_log`,
      );
      expect(logRows).toEqual([{ recent: true }]);
      const events = await raw(
        ownerPool,
        w,
        `SELECT at > now() - interval '6 years' AS recent FROM vault.canary_events`,
      );
      expect(events).toEqual([{ recent: true }]);
    }
    expect(await vault.purgeSecurityLogs()).toBe(0);
  });

  it('[AT-10] an eBay user is matched by ID or username in every workspace that holds PII; web only', async () => {
    const E1 = randomUUID();
    const E2 = randomUUID();
    const user = `pIIMARK-ebayuser-${randomUUID().slice(0, 6)}`.replace('pIIMARK', PII_MARKER);
    const feedback = await clients.worker.ingest({
      workspace_id: E1,
      kind: 'ebay_feedback',
      channel_account_id: account,
      subject_type: 'feedback',
      subject_id: 'fb-1',
      fields: { buyer_username: user },
    });
    const order = await clients.web.ingest({
      workspace_id: E2,
      kind: 'buyer_contact',
      channel_account_id: otherAccount,
      subject_type: 'order',
      subject_id: 'ebay-order-1',
      fields: { ...contact('401'), channel_buyer_id: 'EBAY-ID-77' },
    });
    await ingest(E2, 'someone-else', contact('402'));
    // ADR-066: exact values only; surrounding spaces are trimmed.
    const res = await clients.web.ebayUserMatch({
      user_id: ' EBAY-ID-77 ',
      username: user,
    });
    const byWorkspace = Object.fromEntries(
      res.workspaces.map((w) => [w.workspace_id, w.matches.map((m) => m.pii_ref)]),
    );
    expect(byWorkspace[E1]).toEqual([feedback.pii_ref]);
    expect(byWorkspace[E2]).toEqual([order.pii_ref]);
    expect(await clients.web.ebayUserMatch({ username: 'nobody-at-all' })).toEqual({
      workspaces: [],
      next: null,
    });
    const refused = await clients.worker.ebayUserMatch({ username: user }).catch((e: unknown) => e);
    expect((refused as VaultError).status).toBe(403);
    const logged = await raw(
      ownerPool,
      E1,
      `SELECT purpose, result_count FROM vault.access_log WHERE purpose = 'ebay_account_deletion'`,
    );
    expect(logged).toEqual([{ purpose: 'ebay_account_deletion', result_count: '1' }]);
  });

  // A-001 (ADR-069): the match was cut at 5,000 with no word of the rest. Paged now: every ref
  // comes back exactly once, across workspaces, and `next` is null only after the last one.
  it('[AT-10] the eBay user match pages through every record in every workspace, each once', async () => {
    const user = `${PII_MARKER}ebay-paged-${randomUUID().slice(0, 6)}`;
    const P1 = randomUUID();
    const P2 = randomUUID();
    const expected: string[] = [];
    for (const [ws, n] of [
      [P1, 4],
      [P2, 3],
    ] as const) {
      for (let i = 0; i < n; i += 1) {
        const r = await clients.worker.ingest({
          workspace_id: ws,
          kind: 'ebay_feedback',
          channel_account_id: account,
          subject_type: 'feedback',
          subject_id: `fb-page-${String(i)}`,
          fields: { buyer_username: user },
        });
        expected.push(r.pii_ref);
      }
    }
    const seen: string[] = [];
    let cursor: { workspace_id: string; pii_ref: string } | null = null;
    let pages = 0;
    do {
      const page = await vault.ebayUserMatch(
        { username: user, ...(cursor === null ? {} : { cursor }) },
        { caller: 'web' },
        3,
      );
      const refs = page.workspaces.flatMap((w) => w.matches.map((m) => m.pii_ref));
      expect(refs.length).toBeLessThanOrEqual(3);
      seen.push(...refs);
      cursor = page.next;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen)).toEqual(new Set(expected));
  });

  it("[AT-10] a notice for 'AbC' matches 'AbC' and leaves 'abc' (ADR-066: exact, trim only)", async () => {
    const W = randomUUID();
    const suffix = randomUUID().slice(0, 6);
    const upper = await ingest(W, 'case-upper', {
      ...contact('501'),
      channel_buyer_id: `${PII_MARKER}AbC-${suffix}`,
    });
    const lower = await ingest(W, 'case-lower', {
      ...contact('502'),
      channel_buyer_id: `${PII_MARKER}abc-${suffix}`,
    });
    const named = await clients.worker.ingest({
      workspace_id: W,
      kind: 'ebay_feedback',
      channel_account_id: account,
      subject_type: 'feedback',
      subject_id: 'case-name-upper',
      fields: { buyer_username: `${PII_MARKER}AbC-name-${suffix}` },
    });
    await clients.worker.ingest({
      workspace_id: W,
      kind: 'ebay_feedback',
      channel_account_id: account,
      subject_type: 'feedback',
      subject_id: 'case-name-lower',
      fields: { buyer_username: `${PII_MARKER}abc-name-${suffix}` },
    });
    const refs = async (q: { user_id?: string; username?: string }) =>
      (await clients.web.ebayUserMatch(q)).workspaces
        .filter((w) => w.workspace_id === W)
        .flatMap((w) => w.matches.map((m) => m.pii_ref));
    expect(await refs({ user_id: `${PII_MARKER}AbC-${suffix}` })).toEqual([upper.pii_ref]);
    expect(await refs({ user_id: ` ${PII_MARKER}abc-${suffix}	` })).toEqual([lower.pii_ref]);
    expect(await refs({ user_id: `${PII_MARKER}ABC-${suffix}` })).toEqual([]);
    expect(await refs({ username: `${PII_MARKER}AbC-name-${suffix}` })).toEqual([named.pii_ref]);
    // The case-folded buyer index still serves DEL-4 search: both people are found there.
    const search = await clients.web.search({
      workspaceId: W,
      purpose: 'erasure',
      query: { buyer: `${PII_MARKER}ABC-${suffix}` },
    });
    expect(search.matches.map((m) => m.pii_ref).sort()).toEqual(
      [upper.pii_ref, lower.pii_ref].sort(),
    );
  });

  it('[AT-10] the start-up backfill gives older records their exact buyer entry, once (ADR-066)', async () => {
    const W = randomUUID();
    const id = `${PII_MARKER}Old-Buyer-${randomUUID().slice(0, 6)}`;
    const old = await ingest(W, 'old-order', { ...contact('601'), channel_buyer_id: id });
    const plain = await ingest(W, 'no-buyer', contact('602'));
    // As a record ingested before 0006: no buyer_exact entry.
    await raw(ownerPool, W, `DELETE FROM vault.blind_index WHERE field = 'buyer_exact'`);
    const found = async () =>
      (await clients.web.ebayUserMatch({ user_id: id })).workspaces.filter(
        (w) => w.workspace_id === W,
      );
    expect(await found()).toEqual([]);
    expect(await vault.backfillBuyerExact()).toBeGreaterThanOrEqual(1);
    expect((await found()).flatMap((w) => w.matches.map((m) => m.pii_ref))).toEqual([old.pii_ref]);
    const entries = await raw(
      ownerPool,
      W,
      `SELECT pii_ref FROM vault.blind_index WHERE field = 'buyer_exact'`,
    );
    expect(entries).toEqual([{ pii_ref: old.pii_ref }]);
    expect(entries).not.toContainEqual({ pii_ref: plain.pii_ref });
    expect(await vault.backfillBuyerExact()).toBe(0);
  });

  it('[ORD-4] one buyer record per order: a repeated ingest returns the same ref and adds nothing', async () => {
    const W = randomUUID();
    const subject = `${account}:ORDER-ONCE`;
    const first = await ingest(W, subject, contact('501'));
    const again = await ingest(W, subject, contact('502'));
    expect(again.pii_ref).toBe(first.pii_ref);
    const rows = await raw(
      ownerPool,
      W,
      `SELECT pii_ref FROM vault.records WHERE subject_id = $1 AND NOT canary`,
      [subject],
    );
    expect(rows).toEqual([{ pii_ref: first.pii_ref }]);
    // The first details stay: the repeat changed nothing.
    const read = await clients.web.readFull({
      workspaceId: W,
      piiRef: first.pii_ref,
      purpose: 'order_detail',
    });
    expect(read.fields.email).toBe(`${PII_MARKER}501@example.test`);
    // Messages and feedback are not orders: each ingest is its own record, as before.
    const message = (n: string) =>
      clients.web.ingest({
        workspace_id: W,
        kind: 'ebay_message',
        channel_account_id: account,
        subject_type: 'conversation',
        subject_id: 'conv-once',
        fields: { message_body: `${PII_MARKER}hello ${n}`, sender_username: 'someone' },
      });
    expect((await message('1')).pii_ref).not.toBe((await message('2')).pii_ref);
  });

  it('[DEL-1][AT-10] after an eBay deletion notice the buyer is never stored again (ADR-068 tombstone check)', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-ebay-user-${randomUUID().slice(0, 8)}`;
    await ingest(W, `${account}:BEFORE-NOTICE`, contact('601', { channel_buyer_id: userId }));
    const match = await clients.web.ebayUserMatch({ user_id: userId, username: 'reused-name' });
    expect(match.workspaces.find((w) => w.workspace_id === W)?.matches).toHaveLength(1);
    // A re-poll or backfill of the same buyer is refused with 409 and stores nothing.
    const refused = await ingest(
      W,
      `${account}:AFTER-NOTICE`,
      contact('602', { channel_buyer_id: userId }),
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(VaultError);
    expect((refused as VaultError).status).toBe(409);
    expect((refused as VaultError).code).toBe('buyer_deleted');
    const stored = await raw(ownerPool, W, `SELECT 1 FROM vault.records WHERE subject_id = $1`, [
      `${account}:AFTER-NOTICE`,
    ]);
    expect(stored).toEqual([]);
    // User ID first: a different buyer who now holds the same username is stored as normal.
    const other = await ingest(
      W,
      `${account}:NEW-HOLDER`,
      contact('603', { channel_buyer_id: `${userId}-other`, channel_username: 'reused-name' }),
    );
    expect(other.pii_ref).toMatch(/^[0-9a-f-]{36}$/);
    // eBay orders carry the username only: an order placed before the notice is refused, one
    // placed after it (the name reused by someone else) is stored.
    const byName = (subject: string, placedAt: string) =>
      clients.web.ingest({
        workspace_id: W,
        kind: 'buyer_contact',
        channel_account_id: account,
        subject_type: 'order',
        subject_id: `${account}:${subject}`,
        placed_at: placedAt,
        fields: contact('604', { channel_username: 'reused-name' }),
      });
    const early = await byName('NAME-EARLY', '2020-01-01T00:00:00Z').catch((e: unknown) => e);
    expect((early as VaultError).code).toBe('buyer_deleted');
    const later = await byName('NAME-LATER', new Date(Date.now() + 60_000).toISOString());
    expect(later.pii_ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DEL-1][AT-10] a deleted user ID is refused in the username field as well', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-ebay-user-${randomUUID().slice(0, 8)}`;
    await ingest(W, `${account}:SLOT-SEED`, contact('621'));
    await clients.web.ebayUserMatch({ user_id: userId });
    // Placed after the notice: only the user ID rule can refuse it.
    const refused = await clients.worker
      .ingest({
        workspace_id: W,
        kind: 'buyer_contact',
        channel_account_id: account,
        subject_type: 'order',
        subject_id: `${account}:SLOT`,
        placed_at: new Date(Date.now() + 60_000).toISOString(),
        fields: contact('622', { channel_username: userId }),
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(VaultError);
    expect((refused as VaultError).code).toBe('buyer_deleted');
  });

  it('[DEL-1][AT-10] a second notice for a reused username also covers the orders of its second owner', async () => {
    const W = randomUUID();
    const username = `PIIMARK-reused-${randomUUID().slice(0, 8)}`;
    const pause = () => new Promise((r) => setTimeout(r, 25));
    await ingest(W, `${account}:TWICE-SEED`, contact('631'));
    await clients.web.ebayUserMatch({ username });
    await pause();
    const between = new Date().toISOString();
    await pause();
    await clients.web.ebayUserMatch({ username });
    const store = (subject: string, placedAt: string) =>
      clients.worker.ingest({
        workspace_id: W,
        kind: 'buyer_contact',
        channel_account_id: account,
        subject_type: 'order',
        subject_id: `${account}:${subject}`,
        placed_at: placedAt,
        fields: contact('632', { channel_username: username }),
      });
    const refused = await store('TWICE', between).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(VaultError);
    expect((refused as VaultError).code).toBe('buyer_deleted');
    // A third owner, after both notices, is stored.
    const third = await store('THIRD', new Date(Date.now() + 60_000).toISOString());
    expect(third.pii_ref).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[DEL-1][AT-10] a notice waits for an ingest already past its check, and finds its record', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-race-${randomUUID().slice(0, 8)}`;
    await ingest(W, `${account}:RACE-SEED`, contact('641'));
    // A vault whose ingest stops between the deleted-buyer check and its write.
    let reached: () => void = () => undefined;
    const atWrite = new Promise<void>((r) => (reached = r));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const gated = {
      query: appPool.query.bind(appPool),
      connect: async () => {
        const c = await appPool.connect();
        return {
          release: () => {
            c.release();
          },
          query: async (text: string, params?: unknown[]) => {
            if (text.trimStart().startsWith('INSERT INTO vault.records')) {
              reached();
              await gate;
            }
            return c.query(text, params);
          },
        };
      },
    } as unknown as pg.Pool;
    const slow = new Vault({ pool: gated, keyring }).ingest({
      workspace_id: W,
      kind: 'buyer_contact',
      channel_account_id: account,
      subject_type: 'order',
      subject_id: `${account}:RACE`,
      fields: contact('642', { channel_buyer_id: userId }),
    });
    await atWrite;
    const notice = clients.web.ebayUserMatch({ user_id: userId });
    await new Promise((r) => setTimeout(r, 300));
    release();
    const { pii_ref } = await slow;
    const match = await notice;
    expect(
      match.workspaces
        .filter((w) => w.workspace_id === W)
        .flatMap((w) => w.matches.map((m) => m.pii_ref)),
    ).toEqual([pii_ref]);
  });

  /** Ingest as the order stream does: the channel and the placed time with the buyer. */
  const order = (
    workspaceId: string,
    subject: string,
    fields: Record<string, string>,
    over: {
      placed_at?: string;
      channel?: 'amazon' | 'ebay' | 'website';
      delete_after?: string;
      source_updated_at?: string;
    } = {},
  ) =>
    clients.worker.ingest({
      workspace_id: workspaceId,
      kind: 'buyer_contact',
      channel_account_id: account,
      subject_type: 'order',
      subject_id: `${account}:${subject}`,
      fields,
      ...over,
    });
  const codeOf = async (p: Promise<unknown>) => {
    const e: unknown = await p.catch((err: unknown) => err);
    return e instanceof VaultError ? e.code : 'stored';
  };
  const soon = () => new Date(Date.now() + 60_000).toISOString();
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const DAY = 86_400_000;
  /** A pool whose ingest stops just before it writes its record. */
  const gatedPool = () => {
    let reached: () => void = () => undefined;
    const atWrite = new Promise<void>((r) => (reached = r));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const pool = {
      query: appPool.query.bind(appPool),
      connect: async () => {
        const c = await appPool.connect();
        return {
          release: () => {
            c.release();
          },
          query: async (text: string, params?: unknown[]) => {
            if (text.trimStart().startsWith('INSERT INTO vault.records')) {
              reached();
              await gate;
            }
            return c.query(text, params);
          },
        };
      },
    } as unknown as pg.Pool;
    return {
      pool,
      atWrite,
      release: () => {
        release();
      },
    };
  };

  it('[DEL-1][AT-10] a notice covers a workspace that holds nothing yet: its first orders are refused', async () => {
    const tag = randomUUID().slice(0, 8);
    const userId = `PIIMARK-first-${tag}`;
    const username = `PIIMARK-name-${tag}`;
    await clients.web.ebayUserMatch({ user_id: userId, username });
    const byId = order(randomUUID(), 'F1', contact('701', { channel_buyer_id: userId }));
    expect(await codeOf(byId)).toBe('buyer_deleted');
    const byName = order(randomUUID(), 'F2', contact('702', { channel_username: username }), {
      placed_at: ago(DAY),
    });
    expect(await codeOf(byName)).toBe('buyer_deleted');
  });

  it('[DEL-1][AT-10] a notice waits for the very first ingest of a new workspace, and finds its record', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-newws-${randomUUID().slice(0, 8)}`;
    const g = gatedPool();
    const slow = new Vault({ pool: g.pool, keyring }).ingest({
      workspace_id: W,
      kind: 'buyer_contact',
      channel_account_id: account,
      subject_type: 'order',
      subject_id: `${account}:NEWWS`,
      fields: contact('703', { channel_buyer_id: userId }),
    });
    await g.atWrite;
    const notice = clients.web.ebayUserMatch({ user_id: userId });
    await new Promise((r) => setTimeout(r, 300));
    g.release();
    const { pii_ref } = await slow;
    expect((await notice).workspaces).toEqual([
      { workspace_id: W, matches: [expect.objectContaining({ pii_ref })] },
    ]);
  });

  it('[DEL-1][AT-10] a notice never stalls ingest for long: it gives up, and eBay sends it again', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-stall-${randomUUID().slice(0, 8)}`;
    const g = gatedPool();
    const slow = new Vault({ pool: g.pool, keyring }).ingest({
      workspace_id: W,
      kind: 'buyer_contact',
      channel_account_id: account,
      subject_type: 'order',
      subject_id: `${account}:STALL`,
      fields: contact('704'),
    });
    await g.atWrite;
    const started = Date.now();
    try {
      expect(await codeOf(clients.web.ebayUserMatch({ user_id: userId }))).not.toBe('stored');
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      g.release();
      await slow;
    }
    await clients.web.ebayUserMatch({ user_id: userId });
    const again = order(W, 'STALL-2', contact('705', { channel_buyer_id: userId }));
    expect(await codeOf(again)).toBe('buyer_deleted');
  });

  it('[AT-10][EBAY-2] an eBay deletion refuses eBay buyers only; a buyer with no channel counts as eBay', async () => {
    const userId = `PIIMARK-channel-${randomUUID().slice(0, 8)}`;
    const W = randomUUID();
    await clients.web.ebayUserMatch({ user_id: userId });
    const fields = contact('706', { channel_buyer_id: userId });
    expect(await codeOf(order(W, 'C-WEB', fields, { channel: 'website' }))).toBe('stored');
    expect(await codeOf(order(W, 'C-AMZ', fields, { channel: 'amazon' }))).toBe('stored');
    expect(await codeOf(order(W, 'C-EBAY', fields, { channel: 'ebay' }))).toBe('buyer_deleted');
    expect(await codeOf(order(W, 'C-NONE', fields))).toBe('buyer_deleted');
  });

  it('[DEL-1][AT-10] a username entry is dated from the notice, at most now, and only moves forward', async () => {
    const W = randomUUID();
    const name = () => `PIIMARK-dated-${randomUUID().slice(0, 8)}`;
    const placed = (n: string, at: string) =>
      codeOf(
        order(W, randomUUID(), contact('707', { channel_username: n }), {
          placed_at: at,
          channel: 'ebay',
        }),
      );
    // The account was closed two days ago; the name's new owner ordered yesterday.
    const old = name();
    await clients.web.ebayUserMatch({ username: old, noticed_at: ago(2 * DAY) });
    expect(await placed(old, ago(3 * DAY))).toBe('buyer_deleted');
    expect(await placed(old, ago(DAY))).toBe('stored');
    // Sent again (or replayed) days later: the date is still the notice's own.
    await clients.web.ebayUserMatch({ username: old, noticed_at: ago(2 * DAY) });
    expect(await placed(old, ago(DAY))).toBe('stored');
    // A date in the future counts as now.
    const future = name();
    await clients.web.ebayUserMatch({ username: future, noticed_at: ago(-5 * DAY) });
    expect(await placed(future, ago(60_000))).toBe('buyer_deleted');
    expect(await placed(future, soon())).toBe('stored');
    // No date means now; an older notice that arrives later never moves it back.
    const none = name();
    await clients.web.ebayUserMatch({ username: none });
    await clients.web.ebayUserMatch({ username: none, noticed_at: ago(30 * DAY) });
    expect(await placed(none, ago(DAY))).toBe('buyer_deleted');
  });

  it('[DEL-2][AT-10] a closed workspace takes nothing with it: the buyer stays refused elsewhere', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-kept-${randomUUID().slice(0, 8)}`;
    await order(W, 'K1', contact('708', { channel_buyer_id: userId }));
    await clients.web.ebayUserMatch({ user_id: userId });
    await clients.deletion.delete({
      workspace_id: W,
      run_id: randomUUID(),
      trigger: 'workspace_closure',
      scope: { type: 'workspace' },
    });
    const elsewhere = order(randomUUID(), 'K2', contact('709', { channel_buyer_id: userId }));
    expect(await codeOf(elsewhere)).toBe('buyer_deleted');
  });

  it('[DEL-2][AT-10] a notice writes nothing into any workspace, so a closing one is never written to', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-closing-${randomUUID().slice(0, 8)}`;
    await order(W, 'W1', contact('710', { channel_buyer_id: userId }));
    await clients.web.ebayUserMatch({ user_id: userId });
    expect(
      await raw(ownerPool, W, 'SELECT 1 FROM vault.deleted_buyers WHERE workspace_id = $1', [W]),
    ).toEqual([]);
  });

  it('[DP-6][AT-10] a deleted-buyer entry is a MAC with its key version, under a key of its own', async () => {
    const userId = `PIIMARK-shape-${randomUUID().slice(0, 8)}`;
    const before = (await appPool.query('SELECT 1 FROM vault.ebay_deleted_buyers')).rowCount ?? 0;
    await clients.web.ebayUserMatch({ user_id: userId });
    // Pages and repeats add nothing.
    await clients.web.ebayUserMatch({ user_id: userId });
    const { rows } = await ownerPool.query<Record<string, unknown>>(
      'SELECT * FROM vault.ebay_deleted_buyers ORDER BY received_at',
    );
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1) ?? {};
    expect(Object.keys(row).sort()).toEqual(
      ['field', 'key_version', 'mac', 'noticed_at', 'received_at'].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain(PII_MARKER);
    expect((row.mac as Buffer).length).toBe(32);
    // The key is made once, whoever starts first, and the vault cannot change or delete it.
    await vault.ensureVaultKey();
    await new Vault({ pool: appPool, keyring }).ensureVaultKey();
    const keys = await ownerPool.query('SELECT version FROM vault.vault_keys');
    expect(keys.rowCount).toBe(1);
    for (const sql of [
      'DELETE FROM vault.vault_keys',
      'UPDATE vault.vault_keys SET kek_version = 2',
      'DELETE FROM vault.ebay_deleted_buyers',
      `UPDATE vault.ebay_deleted_buyers SET mac = decode(repeat('00', 32), 'hex')`,
    ]) {
      await expect(appPool.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it('[DP-6][AT-10] an entry under any stored key version still refuses; without the key nothing is stored', async () => {
    const userId = `PIIMARK-version-${randomUUID().slice(0, 8)}`;
    const next = generateIndexKey(keyring, VAULT_KEY_SCOPE, 2);
    await ownerPool.query(
      `INSERT INTO vault.vault_keys (kind, version, kek_version, wrapped, created_at)
       VALUES ('deleted_buyers', 2, $1, $2, now())`,
      [next.wrapped.kekVersion, next.wrapped.wrapped],
    );
    const older = `PIIMARK-older-${randomUUID().slice(0, 8)}`;
    const oldKey = await ownerPool.query<{ kek_version: string; wrapped: Buffer }>(
      'SELECT kek_version, wrapped FROM vault.vault_keys WHERE version = 1',
    );
    const v1 = unwrapIndexKey(keyring, {
      workspaceId: VAULT_KEY_SCOPE,
      version: 1,
      kekVersion: Number(oldKey.rows[0]?.kek_version),
      wrapped: oldKey.rows[0]?.wrapped ?? Buffer.alloc(0),
    });
    await ownerPool.query(
      `INSERT INTO vault.ebay_deleted_buyers (key_version, field, mac, noticed_at, received_at)
       VALUES (1, 'ebay_user_id', $1, now(), now() - interval '1 day')`,
      [v1.mac('ebay_user_id', older)],
    );
    await clients.web.ebayUserMatch({ user_id: userId });
    await ownerPool.query(
      `UPDATE vault.ebay_deleted_buyers SET key_version = 2, mac = $1
        WHERE received_at = (SELECT max(received_at) FROM vault.ebay_deleted_buyers)`,
      [next.indexKey.mac('ebay_user_id', userId)],
    );
    const store = (v: Vault, subject: string, who = userId) =>
      v
        .ingest({
          workspace_id: randomUUID(),
          kind: 'buyer_contact',
          subject_type: 'order',
          subject_id: subject,
          fields: contact('711', { channel_buyer_id: who }),
        })
        .then(
          () => 'stored',
          (e: unknown) => (e instanceof Error ? e.constructor.name : 'error'),
        );
    expect(await store(new Vault({ pool: appPool, keyring }), 'V2')).toBe('BuyerDeleted');
    expect(await store(new Vault({ pool: appPool, keyring }), 'V1', older)).toBe('BuyerDeleted');
    await ownerPool.query('DELETE FROM vault.vault_keys WHERE version = 2');
    await ownerPool.query('DELETE FROM vault.ebay_deleted_buyers WHERE key_version = 2');
    // No key at all (a vault that never ran its start-up step) stores no buyer.
    const { rows } = await ownerPool.query('DELETE FROM vault.vault_keys RETURNING *');
    const k = rows[0] as Record<string, unknown>;
    try {
      expect(await store(new Vault({ pool: appPool, keyring }), 'NOKEY')).toBe('Error');
    } finally {
      await ownerPool.query(
        `INSERT INTO vault.vault_keys (kind, version, kek_version, wrapped, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [k.kind, k.version, k.kek_version, k.wrapped, k.created_at],
      );
    }
  });

  it('[DP-5][DEL-1] deleted-buyer entries go 180 days after the last notice, and only through the purge', async () => {
    const add = (days: number) =>
      ownerPool.query(
        `INSERT INTO vault.ebay_deleted_buyers (key_version, field, mac, noticed_at, received_at)
         VALUES (1, 'ebay_user_id', $1, now() - interval '400 days', now() - make_interval(days => $2))`,
        [randomBytes(32), days],
      );
    await add(179);
    await add(181);
    const count = async () =>
      (await ownerPool.query('SELECT 1 FROM vault.ebay_deleted_buyers')).rowCount ?? 0;
    const before = await count();
    expect(await vault.purgeDeletedBuyers()).toBe(1);
    expect(await count()).toBe(before - 1);
    expect(await vault.purgeDeletedBuyers()).toBe(0);
    // A notice sent again counts from then: its entry is not old.
    const again = `PIIMARK-again-${randomUUID().slice(0, 8)}`;
    await clients.web.ebayUserMatch({ user_id: again });
    await ownerPool.query(
      `UPDATE vault.ebay_deleted_buyers SET received_at = now() - interval '200 days'
        WHERE received_at = (SELECT max(received_at) FROM vault.ebay_deleted_buyers)`,
    );
    await clients.web.ebayUserMatch({ user_id: again });
    expect(await vault.purgeDeletedBuyers()).toBe(0);
  });

  it('[AT-10] a later page of one notice writes no entry and no journal line', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-pages-${randomUUID().slice(0, 8)}`;
    for (const n of ['1', '2']) {
      await order(W, `PG${n}`, contact(`72${n}`, { channel_buyer_id: userId }));
    }
    const lines = () => journalLines().filter((l) => l.type === 'ebay_deleted').length;
    const before = lines();
    const first = await vault.ebayUserMatch({ user_id: userId }, { caller: 'web' }, 1);
    expect(first.next).not.toBeNull();
    const second = await vault.ebayUserMatch(
      { user_id: userId, cursor: first.next ?? undefined },
      { caller: 'web' },
      1,
    );
    expect(second.workspaces).toHaveLength(1);
    expect(lines()).toBe(before + 1);
  });

  it('[DEL-1][DP-8] a deleted-buyer entry is journalled off-site before it commits: a MAC and dates, no value', async () => {
    const userId = `PIIMARK-journal-${randomUUID().slice(0, 8)}`;
    const before = journalLines().filter((l) => l.type === 'ebay_deleted').length;
    await clients.web.ebayUserMatch({ user_id: userId, username: `${userId}-name` });
    const lines = journalLines().filter((l) => l.type === 'ebay_deleted');
    expect(lines).toHaveLength(before + 2);
    for (const line of lines.slice(before)) {
      expect(Object.keys(line).sort()).toEqual(
        ['at', 'field', 'key_version', 'mac', 'noticed_at', 'type'].sort(),
      );
      expect(line.mac).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(scanTextForMarkers(journalLines().map((l) => JSON.stringify(l)))).toEqual([]);
  });

  it('[ORD-4][DEL-1] a record already expired takes the date asked for when its order is stored again', async () => {
    const W = randomUUID();
    const { pii_ref } = await order(W, 'AGAIN', contact('712'));
    const expiry = async () =>
      (
        await raw(ownerPool, W, 'SELECT delete_after FROM vault.records WHERE pii_ref = $1', [
          pii_ref,
        ])
      )[0]?.delete_after as Date;
    // The orphan sweep expired it; then its order arrives after all.
    await clients.worker.setExpiry({
      workspace_id: W,
      pii_refs: [pii_ref],
      delete_after: ago(1000),
      reason: 'orphan',
    });
    const wanted = ago(-30 * DAY);
    const again = await order(W, 'AGAIN', contact('712'), { delete_after: wanted });
    expect(again.pii_ref).toBe(pii_ref);
    expect((await expiry()).toISOString()).toBe(wanted);
    expect(
      journalLines()
        .filter((l) => l.pii_ref === pii_ref)
        .at(-1),
    ).toMatchObject({
      type: 'expiry',
      delete_after: wanted,
    });
    // A live record keeps its date: a repeat never moves it.
    await order(W, 'AGAIN', contact('712'), { delete_after: ago(-80 * DAY) });
    expect((await expiry()).toISOString()).toBe(wanted);
  });

  const read = async (W: string, piiRef: string) =>
    (
      await clients.web.readFull({
        workspaceId: W,
        piiRef,
        purpose: 'order_detail',
        actorUserId: randomUUID(),
      })
    ).fields;
  const address = (n: string, over: Record<string, string> = {}) => ({
    name: `${PII_MARKER}Ada ${n}`,
    address_line1: `${PII_MARKER}${n} New Street`,
    city: 'Newtown',
    postcode: 'NE1 1ST',
    country: 'GB',
    ...over,
  });

  /** The stored bytes of a record's fields and blind indexes. */
  const oldBytes = async (W: string, piiRef: string): Promise<Buffer[]> => [
    ...(
      await raw(
        ownerPool,
        W,
        'SELECT ciphertext AS b FROM vault.record_fields WHERE pii_ref = $1',
        [piiRef],
      )
    ).map((r) => r.b as Buffer),
    ...(
      await raw(ownerPool, W, 'SELECT mac AS b FROM vault.blind_index WHERE pii_ref = $1', [piiRef])
    ).map((r) => r.b as Buffer),
  ];
  /** How many rows of the two tables' heap pages, dead or alive, still hold one of these values. */
  const inHeap = async (values: readonly Buffer[]): Promise<number> => {
    let n = 0;
    for (const table of ['vault.record_fields', 'vault.blind_index']) {
      const { rows } = await rootPool.query<{ n: string }>(
        `SELECT count(*) AS n
           FROM generate_series(0, pg_relation_size($1::text::regclass)
                                     / current_setting('block_size')::bigint - 1) AS p
          CROSS JOIN LATERAL heap_page_items(get_raw_page($1::text, p)) AS i
          WHERE EXISTS (SELECT 1 FROM unnest($2::bytea[]) AS v
                         WHERE position(v IN i.t_data) > 0)`,
        [table, values],
      );
      n += Number(rows[0]?.n ?? 0);
    }
    return n;
  };

  it('[ORD-4][ORD-9] a corrected address replaces the one record in place: same ref, same date, new indexes', async () => {
    const W = randomUUID();
    const first = await order(
      W,
      'R1',
      address('1', {
        address_line2: 'Flat 2',
        email: `${PII_MARKER}ada@example.test`,
        channel_username: 'ada-1',
      }),
      { source_updated_at: ago(2 * DAY) },
    );
    const twin = await order(
      W,
      'R2',
      address('9', { postcode: 'NE9 9ZZ', channel_username: 'ada-1' }),
    );
    const before = await raw(ownerPool, W, 'SELECT * FROM vault.records WHERE pii_ref = $1', [
      first.pii_ref,
    ]);
    const match = async () => (await clients.worker.match(W, first.pii_ref)).subject_ids;
    expect(await match()).toEqual([]);
    expect(
      await clients.worker.replace({
        workspace_id: W,
        pii_ref: first.pii_ref,
        channel: 'ebay',
        subject_id: `${account}:R1`,
        source_updated_at: ago(DAY),
        fields: address('9', { postcode: 'NE9 9ZZ', channel_username: 'ada-1' }),
      }),
    ).toEqual({ changed: true });
    // The delivery block is replaced whole; the email it did not send is kept.
    expect(await read(W, first.pii_ref)).toEqual({
      ...address('9', { postcode: 'NE9 9ZZ', channel_username: 'ada-1' }),
      email: `${PII_MARKER}ada@example.test`,
    });
    const found = async (postcode: string) =>
      (
        await clients.web.search({ workspaceId: W, purpose: 'order_search', query: { postcode } })
      ).matches.map((m) => m.pii_ref);
    expect(await found('NE1 1ST')).toEqual([]);
    expect((await found('NE9 9ZZ')).sort()).toEqual([first.pii_ref, twin.pii_ref].sort());
    // The same buyer and address now: the match key moved with it.
    expect(await match()).toEqual([`${account}:R2`]);
    const after = await raw(ownerPool, W, 'SELECT * FROM vault.records WHERE pii_ref = $1', [
      first.pii_ref,
    ]);
    expect(after).toEqual([{ ...before[0], source_updated_at: after[0]?.source_updated_at }]);
    expect((after[0]?.source_updated_at as Date).getTime()).toBeGreaterThan(Date.now() - 1.5 * DAY);
    const stored = await raw(ownerPool, W, 'SELECT ciphertext FROM vault.record_fields');
    expect(stored.some((r) => (r.ciphertext as Buffer).includes(Buffer.from('New Street')))).toBe(
      false,
    );
  });

  it('[ORD-4][DEL-1] a correction that must change nothing changes nothing', async () => {
    const W = randomUUID();
    const stored = address('5', { channel_username: 'eve-5' });
    const { pii_ref } = await order(W, 'N1', stored, { source_updated_at: ago(DAY) });
    const ask = (over: Record<string, unknown> = {}) =>
      clients.worker.replace({
        workspace_id: W,
        pii_ref,
        channel: 'ebay',
        subject_id: `${account}:N1`,
        source_updated_at: ago(1000),
        fields: address('6'),
        ...over,
      });
    const without = (key: string) =>
      Object.fromEntries(Object.entries(address('6')).filter(([k]) => k !== key));
    const same = { changed: false };
    // Older, or the same update seen again.
    expect(await ask({ source_updated_at: ago(2 * DAY) })).toEqual(same);
    // No address, no name, or masked by the channel.
    expect(await ask({ fields: without('address_line1') })).toEqual(same);
    expect(await ask({ fields: without('postcode') })).toEqual(same);
    expect(await ask({ fields: without('name') })).toEqual(same);
    for (const key of ['name', 'address_line1', 'postcode']) {
      expect(await ask({ fields: { ...address('6'), [key]: 'A***' } }), key).toEqual(same);
    }
    // Another order's subject, or a ref that is not there.
    expect(await ask({ subject_id: `${account}:OTHER` })).toEqual(same);
    expect(await ask({ pii_ref: randomUUID() })).toEqual(same);
    expect(await read(W, pii_ref)).toEqual(stored);
    // The same values again: nothing written, but the update's time now counts.
    expect(await ask({ fields: stored, source_updated_at: ago(5000) })).toEqual(same);
    expect(await ask({ source_updated_at: ago(6000) })).toEqual(same);
    expect(await read(W, pii_ref)).toEqual(stored);
    // A deleted buyer, and a record past its date.
    await clients.web.ebayUserMatch({ user_id: 'PIIMARK-gone-6' });
    const gone = { ...address('6'), channel_username: 'PIIMARK-gone-6' };
    expect(await codeOf(ask({ fields: gone }))).toBe('buyer_deleted');
    expect(
      await codeOf(
        clients.web.replace({
          workspace_id: W,
          pii_ref,
          subject_id: `${account}:N1`,
          source_updated_at: ago(1000),
          fields: address('6'),
        }),
      ),
    ).toBe('capability_missing');
    await clients.worker.setExpiry({
      workspace_id: W,
      pii_refs: [pii_ref],
      delete_after: ago(1000),
      reason: 'orphan',
    });
    expect(await ask()).toEqual(same);
    // It never makes a record, and a closed workspace takes none.
    const { rows } = await appPool.query('SELECT 1');
    expect(rows).toHaveLength(1);
    expect(await raw(ownerPool, W, 'SELECT pii_ref FROM vault.records WHERE NOT canary')).toEqual([
      { pii_ref },
    ]);
    await clients.deletion.delete({
      workspace_id: W,
      run_id: randomUUID(),
      trigger: 'workspace_closure',
      scope: { type: 'workspace' },
    });
    expect(await codeOf(ask())).toBe('workspace_closed');
  });

  it('[ORD-4] a masked delivery field refuses the block; a masked email, phone or ID is left out', async () => {
    const W = randomUUID();
    const email = `${PII_MARKER}real@example.test`;
    const stored = address('21', {
      email,
      phone: '+447700900121',
      channel_username: 'real-21',
      channel_buyer_id: 'real-id-21',
    });
    const { pii_ref } = await order(W, 'MASK', stored, { source_updated_at: ago(2 * DAY) });
    let step = 0;
    const ask = async (fields: Record<string, string>) => {
      step += 1;
      const { changed } = await clients.worker.replace({
        workspace_id: W,
        pii_ref,
        subject_id: `${account}:MASK`,
        source_updated_at: ago(DAY - step * 1000),
        fields,
      });
      return changed;
    };
    const delivery = [
      'name',
      'address_line1',
      'address_line2',
      'address_line3',
      'city',
      'county',
      'postcode',
      'country',
      'delivery_instructions',
    ];
    for (const key of delivery) {
      for (const mask of ['F***', 'F\u2022\u2022']) {
        expect(await ask({ ...address('22'), [key]: mask }), key).toBe(false);
      }
    }
    expect(await read(W, pii_ref)).toEqual(stored);
    const masked = {
      email: 'j***@e***',
      phone: '*****123',
      channel_username: 'r***1',
      channel_buyer_id: '\u2022\u2022\u2022',
    };
    expect(await ask({ ...address('23'), ...masked })).toBe(true);
    expect(await read(W, pii_ref)).toEqual({ ...stored, ...address('23') });
    // The blind indexes hold the real values still.
    const { matches } = await clients.web.search({
      workspaceId: W,
      purpose: 'order_search',
      query: { email },
    });
    expect(matches.map((m) => m.pii_ref)).toEqual([pii_ref]);
    expect(await ask({ ...address('23'), ...masked })).toBe(false);
  });

  it('[ORD-4][DEL-1] an ingest that finds an older record applies its newer block, and only then', async () => {
    const W = randomUUID();
    const first = await order(
      W,
      'ING',
      address('31', { email: `${PII_MARKER}kept@example.test` }),
      { source_updated_at: ago(3 * DAY) },
    );
    const [was] = await raw(
      ownerPool,
      W,
      'SELECT delete_after FROM vault.records WHERE pii_ref = $1',
      [first.pii_ref],
    );
    const again = (fields: Record<string, string>, at?: string) =>
      order(W, 'ING', fields, at === undefined ? {} : { source_updated_at: at });
    // Older, the same time, no time, masked or no whole address: the record stays.
    expect(await again(address('32'), ago(4 * DAY))).toEqual(first);
    expect(await again(address('32'))).toEqual(first);
    expect(await again(address('32', { address_line2: 'F***' }), ago(2.9 * DAY))).toEqual(first);
    expect(await again({ name: 'X', postcode: 'NE1 1ST' }, ago(2.8 * DAY))).toEqual(first);
    expect(await read(W, first.pii_ref)).toMatchObject(address('31'));
    // A newer one is applied, as a correction is.
    const newer = ago(2 * DAY);
    expect(await again(address('33'), newer)).toEqual(first);
    expect(await read(W, first.pii_ref)).toEqual({
      ...address('33'),
      email: `${PII_MARKER}kept@example.test`,
    });
    expect(await again(address('32'), newer)).toEqual(first);
    expect(await read(W, first.pii_ref)).toMatchObject(address('33'));
    const rows = await raw(
      ownerPool,
      W,
      'SELECT pii_ref, delete_after FROM vault.records WHERE NOT canary',
    );
    expect(rows).toEqual([{ pii_ref: first.pii_ref, delete_after: was?.delete_after }]);
    // The buyer the record would hold is checked: an ID it already has counts.
    const userId = `PIIMARK-ing-${randomUUID().slice(0, 8)}`;
    await order(W, 'ING2', address('34', { channel_buyer_id: userId }), {
      source_updated_at: ago(DAY),
    });
    await clients.web.ebayUserMatch({ user_id: userId });
    const late = order(W, 'ING2', address('35'), { source_updated_at: ago(1000) });
    expect(await codeOf(late)).toBe('buyer_deleted');
  });

  it('[DEL-1][DP-6] an ingest that applies a newer block leaves no old value in the heap', async () => {
    const W = randomUUID();
    const { pii_ref } = await order(W, 'HEAP1', address('41'), { source_updated_at: ago(DAY) });
    const old = await oldBytes(W, pii_ref);
    const moved = address('42', { city: 'Elsewhere', country: 'IE', postcode: 'D02 1AA' });
    await order(W, 'HEAP1', moved, { source_updated_at: ago(1000) });
    expect(await inHeap(old)).toBe(0);
  });

  it('[ORD-4] a correction never waits for another VACUUM, and a failed one is logged, not thrown', async () => {
    const W = randomUUID();
    const { pii_ref } = await order(W, 'VAC', address('51'), { source_updated_at: ago(DAY) });
    const ask = (v: Pick<VaultClient, 'replace'>, n: string, ms: number) =>
      v.replace({
        workspace_id: W,
        pii_ref,
        subject_id: `${account}:VAC`,
        source_updated_at: ago(ms),
        fields: address(n),
      });
    const c = await ownerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE vault.record_fields IN SHARE UPDATE EXCLUSIVE MODE');
      const started = Date.now();
      expect(await ask(clients.worker, '52', 60_000)).toEqual({ changed: true });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    const failed: string[] = [];
    const failing = {
      connect: () => appPool.connect(),
      query: (text: string, params?: unknown[]) =>
        text.startsWith('VACUUM')
          ? Promise.reject(new TypeError(`${PII_MARKER}no`))
          : appPool.query(text, params),
    } as unknown as pg.Pool;
    const other = new Vault({
      pool: failing,
      keyring,
      onVacuumFailed: (name: string) => {
        failed.push(name);
      },
    });
    expect(await ask(other, '53', 1_000)).toEqual({ changed: true });
    expect(failed).toEqual(['TypeError']);
    expect(await read(W, pii_ref)).toMatchObject(address('53'));
  });

  it('[DEL-1][AT-10] a correction that leaves the buyer ID out is still checked against the record it would change', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-kept-id-${randomUUID().slice(0, 8)}`;
    const { pii_ref } = await order(W, 'KID', address('8', { channel_buyer_id: userId }), {
      source_updated_at: ago(DAY),
    });
    await clients.web.ebayUserMatch({ user_id: userId });
    const fix = clients.worker.replace({
      workspace_id: W,
      pii_ref,
      channel: 'ebay',
      subject_id: `${account}:KID`,
      source_updated_at: ago(1000),
      fields: address('9'),
    });
    expect(await codeOf(fix)).toBe('buyer_deleted');
    expect((await read(W, pii_ref)).address_line1).toBe(address('8').address_line1);
  });

  it('[DEL-1][ORD-4] a deletion and a correction of one record take their locks in the same order', async () => {
    const W = randomUUID();
    const { pii_ref } = await order(W, 'LOCKS', address('3'));
    // A correction in progress: it holds the record, and then rewrites its fields.
    const c = await ownerPool.connect();
    let deleted;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [W]);
      await c.query('SELECT 1 FROM vault.records WHERE pii_ref = $1 FOR UPDATE', [pii_ref]);
      deleted = clients.deletion.delete({
        workspace_id: W,
        run_id: randomUUID(),
        trigger: 'erasure',
        scope: { type: 'refs', pii_refs: [pii_ref] },
      });
      await new Promise((r) => setTimeout(r, 300));
      await c.query(`SET LOCAL lock_timeout = '500ms'`);
      await c.query('DELETE FROM vault.record_fields WHERE pii_ref = $1', [pii_ref]);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await deleted).counts.records).toBe(1);
  });

  it('[DEL-1][DP-6] a correction leaves no old value or index in the heap', async () => {
    const W = randomUUID();
    const { pii_ref } = await order(W, 'HEAP2', address('61'), { source_updated_at: ago(DAY) });
    const old = await oldBytes(W, pii_ref);
    expect(await inHeap(old)).toBe(old.length);
    await clients.worker.replace({
      workspace_id: W,
      pii_ref,
      subject_id: `${account}:HEAP2`,
      source_updated_at: ago(1000),
      fields: address('62', { city: 'Elsewhere', country: 'IE', postcode: 'D02 1AA' }),
    });
    expect(await inHeap(old)).toBe(0);
  });

  it('[DEL-1][AT-10] a write sent while a notice is being recorded waits for it, and is refused', async () => {
    const W = randomUUID();
    const userId = `PIIMARK-order-${randomUUID().slice(0, 8)}`;
    const { pii_ref } = await order(W, 'V04', address('71', { channel_buyer_id: userId }), {
      source_updated_at: ago(DAY),
    });
    let reached: () => void = () => undefined;
    const atJournal = new Promise<void>((r) => (reached = r));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    // A vault whose notice stops with its lock held, before its entries are written.
    const slow = new Vault({
      pool: appPool,
      keyring,
      journal: {
        append: async () => {
          reached();
          await gate;
        },
      },
    });
    const notice = slow.ebayUserMatch({ user_id: userId }, { caller: 'web' });
    await atJournal;
    const stored = order(W, 'V04-2', address('72', { channel_buyer_id: userId }));
    const fixed = clients.worker.replace({
      workspace_id: W,
      pii_ref,
      channel: 'ebay',
      subject_id: `${account}:V04`,
      source_updated_at: ago(1000),
      fields: address('73', { channel_buyer_id: userId }),
    });
    const codes = Promise.all([codeOf(stored), codeOf(fixed)]);
    await new Promise((r) => setTimeout(r, 400));
    release();
    expect(await codes).toEqual(['buyer_deleted', 'buyer_deleted']);
    expect((await notice).workspaces).toEqual([
      { workspace_id: W, matches: [expect.objectContaining({ pii_ref })] },
    ]);
  });

  it('[DEL-1][AT-10] a username with no placed date is refused', async () => {
    const username = `PIIMARK-undated-${randomUUID().slice(0, 8)}`;
    await clients.web.ebayUserMatch({ username });
    const undated = order(randomUUID(), 'V18', contact('718', { channel_username: username }));
    expect(await codeOf(undated)).toBe('buyer_deleted');
  });

  it('[ORD-4] two corrections at once: the older one never lands on the newer', async () => {
    const W = randomUUID();
    const { pii_ref } = await order(W, 'V24', address('81'), { source_updated_at: ago(2 * DAY) });
    const c = await ownerPool.connect();
    let late;
    try {
      // A newer correction in progress: it holds the record and has moved its update time.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [W]);
      await c.query('UPDATE vault.records SET source_updated_at = $2 WHERE pii_ref = $1', [
        pii_ref,
        ago(1000),
      ]);
      late = clients.worker.replace({
        workspace_id: W,
        pii_ref,
        subject_id: `${account}:V24`,
        source_updated_at: ago(DAY),
        fields: address('82'),
      });
      await new Promise((r) => setTimeout(r, 300));
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(await late).toEqual({ changed: false });
    expect(await read(W, pii_ref)).toEqual(address('81'));
  });

  it('[EBAY-2][AT-10] the vault itself answers 503 busy while a write holds the notice lock', async () => {
    const c = await ownerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock_shared(8711, 1)');
      const err: unknown = await clients.web
        .ebayUserMatch({ user_id: `PIIMARK-busy-${randomUUID().slice(0, 8)}` })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VaultError);
      expect(err).toMatchObject({ status: 503, code: 'busy' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('[ORD-4][SEC-12] a correction never touches the canary', async () => {
    const W = randomUUID();
    await order(W, 'CAN', contact('713'));
    const [canary] = await raw(ownerPool, W, 'SELECT pii_ref FROM vault.records WHERE canary');
    expect(
      await clients.worker.replace({
        workspace_id: W,
        pii_ref: String(canary?.pii_ref),
        subject_id: 'canary',
        source_updated_at: ago(0),
        fields: address('7'),
      }),
    ).toEqual({ changed: false });
  });

  it('[DP-4][DEL-1] only the worker may move an expiry', async () => {
    const W = randomUUID();
    const { pii_ref } = await ingest(W, `${account}:EXPIRY-WEB`, contact('651'));
    const refused = await clients.web
      .setExpiry({
        workspace_id: W,
        pii_refs: [pii_ref],
        delete_after: new Date(Date.now() + 80 * 86_400_000).toISOString(),
        reason: 'dispatch',
      })
      .catch((e: unknown) => e);
    expect((refused as VaultError).status).toBe(403);
  });

  it('[AT-10] an eBay notice matches by user ID first: a reused username never reaches another buyer (ADR-068)', async () => {
    const W = randomUUID();
    const oldUser = `PIIMARK-old-${randomUUID().slice(0, 8)}`;
    const newUser = `PIIMARK-new-${randomUUID().slice(0, 8)}`;
    // The old holder of the name, with an ID; the notice is for a new user who took the name.
    const old = await ingest(
      W,
      `${account}:OLD-HOLDER`,
      contact('611', { channel_buyer_id: oldUser, channel_username: 'shared-name' }),
    );
    const mine = await ingest(
      W,
      `${account}:NEW-USER`,
      contact('612', { channel_buyer_id: newUser, channel_username: 'shared-name' }),
    );
    const res = await clients.web.ebayUserMatch({ user_id: newUser, username: 'shared-name' });
    const refs = res.workspaces
      .filter((w) => w.workspace_id === W)
      .flatMap((w) => w.matches.map((m) => m.pii_ref));
    expect(refs).toEqual([mine.pii_ref]);
    expect(refs).not.toContain(old.pii_ref);
  });

  it('[DEL-1] an expiry change is journalled off-site with IDs and the date only (ADR-068)', async () => {
    const W = randomUUID();
    const { pii_ref } = await ingest(W, `${account}:JOURNAL`, contact('701'));
    const date = new Date(Date.now() + 25 * 86_400_000).toISOString();
    const set = () =>
      clients.worker.setExpiry({
        workspace_id: W,
        pii_refs: [pii_ref],
        delete_after: date,
        reason: 'dispatch',
      });
    expect(await set()).toEqual({ updated: 1 });
    // The same date again changes nothing and journals nothing.
    expect(await set()).toEqual({ updated: 0 });
    const lines = journalLines().filter((l) => l.type === 'expiry' && l.pii_ref === pii_ref);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ workspace_id: W, delete_after: date, reason: 'dispatch' });
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(
      ['at', 'delete_after', 'pii_ref', 'reason', 'type', 'workspace_id'].sort(),
    );
    expect(scanTextForMarkers(journalLines().map((l) => JSON.stringify(l)))).toEqual([]);
  });

  it('[ORD-4] the orphan sweep lists order records by ID only, for the worker token alone (FA-10)', async () => {
    const W = randomUUID();
    const refs = new Set<string>();
    for (const n of ['1', '2', '3']) {
      refs.add((await ingest(W, `${account}:SWEEP-${n}`, contact(`80${n}`))).pii_ref);
    }
    const before = new Date(Date.now() + 1000).toISOString();
    const first = await clients.worker.subjects({
      workspace_id: W,
      subject_type: 'order',
      created_before: before,
      limit: 2,
    });
    expect(first.records).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await clients.worker.subjects({
      workspace_id: W,
      subject_type: 'order',
      created_before: before,
      after: first.next ?? undefined,
      limit: 2,
    });
    const listed = [...first.records, ...second.records];
    expect(new Set(listed.map((r) => r.pii_ref))).toEqual(refs);
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(['pii_ref', 'subject_id']);
    const none = await clients.worker.subjects({
      workspace_id: W,
      subject_type: 'order',
      created_before: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(none.records).toEqual([]);
    const refused = await clients.web
      .subjects({ workspace_id: W, subject_type: 'order', created_before: before })
      .catch((e: unknown) => e);
    expect((refused as VaultError).status).toBe(403);
  });

  it('[DP-4] the vault holds the only db-pii credentials: web and worker cannot reach it', async () => {
    // The compose config test proves web and worker get no db-pii secret or network; here the
    // vault_app role itself can neither change keys nor rewrite the access log.
    await expect(raw(appPool, A, 'DELETE FROM vault.access_log')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      raw(appPool, A, 'UPDATE vault.workspace_keys SET kek_version = 2'),
    ).rejects.toThrow(/permission denied/);
  });

  it('[DP-8] the vault log holds no PII after ingest, read, mask, search and match', () => {
    expect(scanTextForMarkers(logs)).toEqual([]);
  });
});
