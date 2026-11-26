import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@omnibridge/logger';
import type { Pool } from '@omnibridge/pii-db';
import { PII_MARKER, startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { VaultClient, VaultError, type DeleteRequest } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeletionJournal, DeletionService } from './deletion.ts';
import { startTestVault, type TestVault } from './testing.ts';

// T-0403: the one deletion service (DEL-1, DEL-2, DEL-3, AT-8, invariant 10) against a real
// db-pii. The worker's half (db-main tombstones, run log, triggers) is in apps/worker.

const DAY = 86_400_000;

describe('deletion service in the vault [DEL-1][DEL-2][DEL-3][AT-8]', () => {
  let cluster: RoleCluster;
  let vault: TestVault;
  let owner: pg.Pool;
  let clock = new Date('2026-11-01T12:00:00.000Z');
  const journalDir = mkdtempSync(join(tmpdir(), 'ob-journal-'));
  const clients = {} as Record<'web' | 'worker' | 'deletion', VaultClient>;
  const ws = randomUUID();
  const account = randomUUID();
  const otherAccount = randomUUID();

  const ingest = async (
    subjectId: string,
    opts: { channel?: string; deleteAfter?: Date; workspace?: string } = {},
  ) =>
    (
      await clients.worker.ingest({
        workspace_id: opts.workspace ?? ws,
        kind: 'buyer_contact',
        channel_account_id: opts.channel ?? account,
        subject_type: 'order',
        subject_id: subjectId,
        ...(opts.deleteAfter === undefined ? {} : { delete_after: opts.deleteAfter.toISOString() }),
        fields: {
          name: `${PII_MARKER}Del ${subjectId}`,
          postcode: 'DE1 1LE',
          address_line1: `${PII_MARKER}1 Gone Road`,
        },
      })
    ).pii_ref;
  const del = (
    scope: DeleteRequest['scope'],
    trigger: DeleteRequest['trigger'],
    runId = randomUUID(),
    workspace = ws,
  ) => clients.deletion.delete({ workspace_id: workspace, run_id: runId, trigger, scope });
  /** Rows of a table as the db-pii owner (the most privileged app role), in one workspace. */
  const ownerRows = async (table: string, workspace = ws) => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
      const res = await c.query<Record<string, unknown>>(`SELECT * FROM vault.${table}`);
      await c.query('COMMIT');
      return res.rows;
    } finally {
      c.release();
    }
  };
  const exists = async (piiRef: string) =>
    (await ownerRows('records')).some((r) => r.pii_ref === piiRef);

  beforeAll(async () => {
    cluster = await startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']);
    vault = await startTestVault({
      owner: cluster.connection('vault_owner'),
      app: cluster.connection('vault_app'),
      logger: createLogger({
        service: 'pii-vault',
        version: 'test',
        destination: { write: () => true },
      }),
      journalDir,
      now: () => clock,
    });
    owner = new pg.Pool({ ...cluster.connection('vault_owner'), max: 2 });
    for (const caller of ['web', 'worker', 'deletion'] as const) {
      clients[caller] = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens[caller] });
    }
  }, 300_000);

  afterAll(async () => {
    await vault.close();
    await owner.end();
    await cluster.container.stop();
  });

  it('[DEL-1] only the deletion token may delete', async () => {
    const ref = await ingest('o-token');
    for (const caller of ['web', 'worker'] as const) {
      const err: unknown = await clients[caller]
        .delete({
          workspace_id: ws,
          run_id: randomUUID(),
          trigger: 'erasure',
          scope: { type: 'refs', pii_refs: [ref] },
        })
        .catch((e: unknown) => e);
      expect((err as VaultError).status).toBe(403);
    }
    expect(await exists(ref)).toBe(true);
  });

  it('[DEL-1] a trigger may use only its own scope', async () => {
    const err: unknown = await del({ type: 'workspace' }, 'cancellation').catch((e: unknown) => e);
    expect((err as VaultError).status).toBe(422);
  });

  it('[DEL-1][DEL-2] cancellation deletes only that order, for good: even the owner finds no row', async () => {
    const gone = await ingest('o-cancel');
    const kept = await ingest('o-keep');
    const run = await del(
      { type: 'subjects', subject_type: 'order', subject_ids: ['o-cancel'] },
      'cancellation',
    );
    expect(run.deleted).toEqual([{ pii_ref: gone, channel_account_id: account }]);
    expect(run.counts).toEqual({ records: 1, fields: 3, index: 3 });
    expect(await exists(kept)).toBe(true);
    for (const table of ['records', 'record_fields', 'blind_index']) {
      expect((await ownerRows(table)).filter((r) => r.pii_ref === gone)).toEqual([]);
    }
  });

  it('[DEL-2] tombstones land in db-pii and the off-site journal, IDs only; VACUUM ran', async () => {
    const ref = await ingest('o-tomb');
    const runId = randomUUID();
    await del({ type: 'refs', pii_refs: [ref] }, 'erasure', runId);
    const tombs = (await ownerRows('tombstones')).filter((t) => t.pii_ref === ref);
    expect(tombs).toMatchObject([{ run_id: runId, channel_account_id: account }]);
    const journal = readdirSync(journalDir)
      .map((f) => readFileSync(join(journalDir, f), 'utf8'))
      .join('');
    expect(journal).toContain(`"pii_ref":"${ref}"`);
    expect(journal).toContain(`"run_id":"${runId}"`);
    expect(journal).not.toContain(PII_MARKER);
    const vacuumed = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_user_tables
        WHERE schemaname = 'vault' AND relname IN ('records', 'record_fields', 'blind_index')
          AND vacuum_count > 0`,
    );
    expect(vacuumed.rows[0]?.n).toBe('3');
  });

  it('[DEL-3] a repeat deletes nothing twice, logs zero and still reports what the run deleted', async () => {
    const ref = await ingest('o-again');
    const runId = randomUUID();
    const first = await del({ type: 'refs', pii_refs: [ref] }, 'erasure', runId);
    const again = await del({ type: 'refs', pii_refs: [ref] }, 'erasure', runId);
    expect(first.counts.records).toBe(1);
    expect(again.counts).toEqual({ records: 0, fields: 0, index: 0 });
    expect(again.deleted.map((d) => d.pii_ref)).toEqual([ref]);
    const runs = (await ownerRows('deletion_runs')).filter((r) => r.run_id === runId);
    expect(runs.map((r) => r.records)).toEqual(['1', '0']);
    expect(JSON.stringify(runs)).not.toContain(PII_MARKER);
  });

  it('[DEL-1] channel account revocation deletes that account only', async () => {
    const a = await ingest('o-acc-a');
    const b = await ingest('o-acc-b', { channel: otherAccount });
    const run = await del(
      { type: 'channel_account', channel_account_id: account },
      'amazon_revocation',
    );
    expect(run.deleted.map((d) => d.pii_ref)).toContain(a);
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(true);
    const termination = await del(
      { type: 'channel_account', channel_account_id: otherAccount },
      'ebay_termination',
    );
    expect(termination.deleted.map((d) => d.pii_ref)).toEqual([b]);
  });

  it('[AT-8] expiry deletes at day 25 after delivery and not at day 24', async () => {
    const delivered = new Date('2026-11-02T09:00:00.000Z');
    const ref = await ingest('o-expiry', { deleteAfter: new Date(delivered.getTime() + 25 * DAY) });
    const later = await ingest('o-later', {
      deleteAfter: new Date(delivered.getTime() + 40 * DAY),
    });
    clock = new Date(delivered.getTime() + 24 * DAY);
    expect((await del({ type: 'expiry' }, 'expiry')).counts.records).toBe(0);
    expect(await exists(ref)).toBe(true);
    clock = new Date(delivered.getTime() + 25 * DAY);
    const run = await del({ type: 'expiry' }, 'expiry');
    expect(run.deleted.map((d) => d.pii_ref)).toEqual([ref]);
    expect(await exists(ref)).toBe(false);
    expect(await exists(later)).toBe(true);
  });

  it('[DEL-1] workspace closure deletes every record and the keys, and touches no other workspace', async () => {
    const closing = randomUUID();
    const other = randomUUID();
    await ingest('c-1', { workspace: closing });
    await ingest('c-2', { workspace: closing });
    const survivor = await ingest('c-3', { workspace: other });
    const run = await del({ type: 'workspace' }, 'workspace_closure', randomUUID(), closing);
    // The two records and the workspace's canary (SEC-12).
    expect(run.deleted).toHaveLength(3);
    expect(await ownerRows('records', closing)).toEqual([]);
    expect(await ownerRows('workspace_keys', closing)).toEqual([]);
    expect(
      (await ownerRows('records', other)).filter((r) => r.canary !== true).map((r) => r.pii_ref),
    ).toEqual([survivor]);
    // ADR-065 (F-M04h-04): closure leaves a marker; ingest for the closed workspace answers 409
    // and makes no new keys, and reads find nothing.
    expect(await ownerRows('closed_workspaces', closing)).toHaveLength(1);
    const refused = await ingest('c-4', { workspace: closing }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(VaultError);
    expect((refused as VaultError).status).toBe(409);
    expect(await ownerRows('workspace_keys', closing)).toEqual([]);
    expect(await clients.web.mask(closing, [survivor])).toEqual({ records: [] });
    expect(await ownerRows('workspace_keys', closing)).toEqual([]);
    // The other workspace is not closed.
    expect(await ownerRows('closed_workspaces', other)).toEqual([]);
    await ingest('c-5', { workspace: other });
  });

  it('[DEL-1] an ingest that lands during closure is caught: the run says more and finishes next call (ADR-065)', async () => {
    const closing = randomUUID();
    const first = await ingest('race-1', { workspace: closing });
    const appPool = new pg.Pool({ ...cluster.connection('vault_app'), max: 2 });
    let connects = 0;
    let late = '';
    // The real pool, except that an ingest commits after closure has read its targets.
    const racing = {
      connect: async () => {
        connects += 1;
        if (connects === 2) late = await ingest('race-2', { workspace: closing });
        return appPool.connect();
      },
      query: (text: string, values?: unknown[]) => appPool.query(text, values),
    } as unknown as Pool;
    const service = new DeletionService({ pool: racing, journal: new DeletionJournal(journalDir) });
    const request = {
      workspace_id: closing,
      run_id: randomUUID(),
      trigger: 'workspace_closure' as const,
      scope: { type: 'workspace' as const },
    };
    const one = await service.delete(request);
    expect(one.more).toBe(true);
    expect(await ownerRows('workspace_keys', closing)).toHaveLength(2);
    expect(await ownerRows('closed_workspaces', closing)).toEqual([]);
    const two = await service.delete(request);
    expect(two.more).toBe(false);
    const refs = two.deleted.map((d) => d.pii_ref);
    expect(refs).toEqual(expect.arrayContaining([first, late]));
    expect(refs).toHaveLength(3); // and the canary
    expect(await ownerRows('records', closing)).toEqual([]);
    expect(await ownerRows('workspace_keys', closing)).toEqual([]);
    expect(await ownerRows('closed_workspaces', closing)).toHaveLength(1);
    await appPool.end();
  });

  /** A journal that stops after a run's lines are written, until released. */
  const pausedJournal = () => {
    let reached: () => void = () => undefined;
    const written = new Promise<void>((r) => (reached = r));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    class Paused extends DeletionJournal {
      override async append(lines: readonly Record<string, string | null>[]): Promise<void> {
        await super.append(lines);
        reached();
        await gate;
      }
    }
    return {
      journal: new Paused(journalDir),
      written,
      release: () => {
        release();
      },
    };
  };
  const journalled = () =>
    readdirSync(journalDir)
      .flatMap((f) => readFileSync(join(journalDir, f), 'utf8').split('\n'))
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, string>);

  it('[DEL-1][ORD-4] an expiry run never deletes a record that its order has just stored again', async () => {
    const W = randomUUID();
    const past = new Date(clock.getTime() - 60_000);
    const live = new Date(clock.getTime() + 30 * DAY);
    const old = await ingest('o-again-live', { workspace: W, deleteAfter: past });
    const appPool = new pg.Pool({ ...cluster.connection('vault_app'), max: 2 });
    const p = pausedJournal();
    const service = new DeletionService({ pool: appPool, journal: p.journal, now: () => clock });
    const run = service.delete({
      workspace_id: W,
      run_id: randomUUID(),
      trigger: 'expiry',
      scope: { type: 'expiry' },
    });
    await p.written;
    // Its order is stored again while the run stands between its journal and its delete.
    const again = ingest('o-again-live', { workspace: W, deleteAfter: live });
    await new Promise((r) => setTimeout(r, 400));
    p.release();
    const [ref] = await Promise.all([again, run]);
    expect((await ownerRows('records', W)).filter((r) => r.canary === false)).toMatchObject([
      { pii_ref: ref, delete_after: live },
    ]);
    // The journal never names the record that is kept.
    expect(journalled().filter((l) => l.pii_ref === ref && l.type === undefined)).toEqual([]);
    expect(journalled().filter((l) => l.pii_ref === old && l.type === undefined)).toHaveLength(1);
    await appPool.end();
  });

  it('[DEL-1][ORD-4] an expiry run that meets a record being re-dated leaves it alone, and does not journal it', async () => {
    const W = randomUUID();
    const ref = await ingest('o-redated', {
      workspace: W,
      deleteAfter: new Date(clock.getTime() - 60_000),
    });
    const c = await owner.connect();
    let run;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.workspace_id', $1, true)`, [W]);
      await c.query('UPDATE vault.records SET delete_after = $2 WHERE pii_ref = $1', [
        ref,
        new Date(clock.getTime() + DAY),
      ]);
      run = del({ type: 'expiry' }, 'expiry', randomUUID(), W);
      await new Promise((r) => setTimeout(r, 300));
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect((await run).counts.records).toBe(0);
    expect((await ownerRows('records', W)).filter((r) => r.pii_ref === ref)).toHaveLength(1);
    expect(journalled().filter((l) => l.pii_ref === ref && l.type === undefined)).toEqual([]);
  });

  it('[DEL-2] a retry of the same run VACUUMs even though it finds nothing left to delete (F-M04h-03)', async () => {
    const appPool = new pg.Pool({ ...cluster.connection('vault_app'), max: 2 });
    const vacuums: string[] = [];
    let failNext = true;
    // The real pool, except that the first VACUUM fails after the delete has committed.
    const flaky = {
      connect: () => appPool.connect(),
      query: async (text: string, values?: unknown[]) => {
        if (text.startsWith('VACUUM')) {
          vacuums.push(text);
          if (failNext) {
            failNext = false;
            throw new Error('vacuum interrupted');
          }
        }
        return appPool.query(text, values);
      },
    } as unknown as Pool;
    const service = new DeletionService({ pool: flaky, journal: new DeletionJournal(journalDir) });
    const ref = await ingest('o-vacuum');
    const request = {
      workspace_id: ws,
      run_id: randomUUID(),
      trigger: 'erasure' as const,
      scope: { type: 'refs' as const, pii_refs: [ref] },
    };
    await expect(service.delete(request)).rejects.toThrow(/vacuum interrupted/);
    expect(await exists(ref)).toBe(false);
    const retry = await service.delete(request);
    expect(retry.counts.records).toBe(0);
    expect(retry.deleted.map((d) => d.pii_ref)).toEqual([ref]);
    expect(vacuums).toHaveLength(2);
    // A run that never deleted anything has no tombstones and needs no VACUUM.
    await service.delete({
      ...request,
      run_id: randomUUID(),
      scope: { type: 'refs', pii_refs: [randomUUID()] },
    });
    expect(vacuums).toHaveLength(2);
    await appPool.end();
  });
});
