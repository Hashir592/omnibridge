import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
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
import { Vault } from './vault.ts';

// T-0402: the PII store and its capability-scoped API, against a real db-pii with the real roles.

const token = () => randomBytes(32).toString('base64url');

describe('pii-vault core [DP-4][DP-5][DP-6][DP-7]', () => {
  let cluster: RoleCluster;
  let appPool: pg.Pool;
  let ownerPool: pg.Pool;
  let close: () => Promise<void>;
  let baseUrl = '';
  const logs: string[] = [];
  const tokens = { web: token(), worker: token(), deletion: token() };
  const clients = {} as Record<keyof typeof tokens, VaultClient>;
  const A = randomUUID();
  const B = randomUUID();
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
    const logger = createLogger({
      service: 'pii-vault',
      version: 'test',
      destination: { write: (line: string) => (logs.push(line), true) },
    });
    const vault = new Vault({ pool: appPool, keyring: parseKeyring('pii', generateKekLine(1)) });
    const app = buildVaultApp({
      logger,
      version: 'test',
      dbPii: () => Promise.resolve(true),
      vault,
      tokens: new ServiceTokens(tokens),
      deletion: new DeletionService({
        pool: appPool,
        journal: new DeletionJournal(mkdtempSync(join(tmpdir(), 'ob-journal-'))),
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
    await Promise.all([appPool.end(), ownerPool.end()]);
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
