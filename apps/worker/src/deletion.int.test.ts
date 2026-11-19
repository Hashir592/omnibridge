import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMainDb,
  createQueues,
  DeletionLog,
  ErasureRequestRepository,
  JobRecordRepository,
  migrateMain,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import {
  JobQueue,
  piiDeleteJob,
  piiExpiryJob,
  requestDeletion,
  type DeletionRequest,
} from '@omnibridge/queue';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  scanTextForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient } from '@omnibridge/vault-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import { piiDeleteHandler, piiExpiryHandler, sweepPiiExpiry } from './deletion.ts';
import { createWorkerBoss } from './heartbeat.ts';

// T-0403: every DEL-1 trigger through its one entry point (requestDeletion), the queue, the
// worker handler and the vault, with the db-main half (run log, tombstones) checked at the end.

const DAY = 86_400_000;

describe('deletion jobs, every trigger [DEL-1][DEL-2][DEL-3][AT-8]', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let vault: TestVault;
  let queue: JobQueue;
  let stopBoss: () => Promise<void>;
  let clock = new Date('2026-11-10T10:00:00.000Z');
  const journalDir = mkdtempSync(join(tmpdir(), 'ob-journal-'));
  const logs: string[] = [];
  const logger = createLogger({
    service: 'test',
    version: '0',
    destination: { write: (line: string) => (logs.push(line), true) },
  });
  const ws = randomUUID();
  const account = randomUUID();
  const other = randomUUID();
  const ctx = { workspaceId: ws, companyIds: [] };
  let worker: VaultClient;
  let log: DeletionLog;

  const ingest = async (subjectId: string, opts: { channel?: string; deleteAfter?: Date } = {}) =>
    (
      await worker.ingest({
        workspace_id: ws,
        kind: 'buyer_contact',
        channel_account_id: opts.channel ?? account,
        subject_type: 'order',
        subject_id: subjectId,
        ...(opts.deleteAfter === undefined ? {} : { delete_after: opts.deleteAfter.toISOString() }),
        fields: { name: `${PII_MARKER}Buyer ${subjectId}`, postcode: 'TR1 1GG' },
      })
    ).pii_ref;
  /** Runs one request through the entry point and waits for its job to finish. */
  const run = async (request: DeletionRequest) => {
    const { id } = await requestDeletion(queue, ctx, request);
    return waitFor(id);
  };
  const waitFor = async (jobId: string) => {
    const records = new JobRecordRepository(db.db);
    for (let i = 0; i < 120; i += 1) {
      const job = await new Tenancy(db.db).run(ctx, (c) => records.get(c, jobId));
      if (job?.state === 'completed') return job.result as { records: number };
      if (job?.state === 'failed') throw new Error(`job failed: ${job.errorCode ?? '?'}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('job did not finish');
  };
  const alive = async (piiRef: string) =>
    (await worker.mask(ws, [piiRef])).records.some((r) => r.pii_ref === piiRef);

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_worker']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    await createQueues(main.connection('ob_owner'), [piiDeleteJob, piiExpiryJob]);
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
      journalDir,
      now: () => clock,
    });
    worker = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.worker });
    db = createMainDb({ ...main.connection('ob_worker'), max: 4 });
    log = new DeletionLog(db.db);
    await new Tenancy(db.db).run(ctx, (c) =>
      new WorkspaceRepository(db.db).create(c, { name: 'Deletion test' }),
    );
    const boss = createWorkerBoss(main.connection('ob_worker'), { monitorIntervalSeconds: 1 });
    boss.on('error', () => undefined);
    await boss.start();
    stopBoss = () => boss.stop({ graceful: false, close: true });
    queue = new JobQueue({
      boss,
      records: new JobRecordRepository(db.db),
      tenancy: new Tenancy(db.db),
      logger,
    });
    const deps = {
      vault: new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.deletion }),
      log,
      erasures: new ErasureRequestRepository(db.db),
      logger,
      now: () => clock,
    };
    const tuning = { pollingIntervalSeconds: 0.5 };
    await queue.work(piiDeleteJob, piiDeleteHandler(deps), tuning);
    await queue.work(piiExpiryJob, piiExpiryHandler(deps), tuning);
  }, 300_000);

  afterAll(async () => {
    await stopBoss();
    await vault.close();
    await db.destroy();
    await Promise.all([main.container.stop(), pii.container.stop()]);
  }, 120_000);

  it('[DEL-1] cancellation deletes only the cancelled order', async () => {
    const gone = await ingest('w-cancel');
    const kept = await ingest('w-keep');
    const result = await run({
      trigger: 'cancellation',
      scope: { type: 'subjects', subject_type: 'order', subject_ids: ['w-cancel'] },
      idempotencyKey: 'order:w-cancel',
    });
    expect(result.records).toBe(1);
    expect(await alive(gone)).toBe(false);
    expect(await alive(kept)).toBe(true);
  });

  it('[DEL-1] erasure and the eBay deletion notice delete the refs a search found, nothing else', async () => {
    const erase = await ingest('w-erase');
    const ebay = await ingest('w-ebay');
    const bystander = await ingest('w-bystander');
    await run({
      trigger: 'erasure',
      scope: { type: 'refs', pii_refs: [erase] },
      idempotencyKey: 'req-1',
    });
    await run({
      trigger: 'ebay_account_deletion',
      scope: { type: 'refs', pii_refs: [ebay] },
      idempotencyKey: 'notice-1',
    });
    expect(await alive(erase)).toBe(false);
    expect(await alive(ebay)).toBe(false);
    expect(await alive(bystander)).toBe(true);
  });

  it('[DEL-1] Amazon revocation and eBay termination delete their account only', async () => {
    const onAmazon = await ingest('w-amz');
    const onEbay = await ingest('w-ebay-term', { channel: other });
    await run({
      trigger: 'amazon_revocation',
      scope: { type: 'channel_account', channel_account_id: account },
      idempotencyKey: `revoked:${account}`,
    });
    expect(await alive(onAmazon)).toBe(false);
    expect(await alive(onEbay)).toBe(true);
    await run({
      trigger: 'ebay_termination',
      scope: { type: 'channel_account', channel_account_id: other },
      idempotencyKey: `terminated:${other}`,
    });
    expect(await alive(onEbay)).toBe(false);
  });

  it('[DEL-1] the entry point refuses a scope that does not fit the trigger', async () => {
    await expect(
      requestDeletion(queue, ctx, {
        trigger: 'cancellation',
        scope: { type: 'workspace' },
        idempotencyKey: 'bad',
      }),
    ).rejects.toThrow(/cannot use a workspace scope/);
  });

  it('[AT-8] the hourly sweep deletes at day 25 after delivery, not at day 24', async () => {
    const delivered = new Date('2026-11-10T09:00:00.000Z');
    const ref = await ingest('w-expiry', { deleteAfter: new Date(delivered.getTime() + 25 * DAY) });
    clock = new Date(delivered.getTime() + 24 * DAY);
    const day24 = await queue.send(piiExpiryJob, {
      ctx,
      idempotencyKey: 'pii.expiry:day24',
      payload: {},
    });
    expect((await waitFor(day24.id)).records).toBe(0);
    expect(await alive(ref)).toBe(true);
    clock = new Date(delivered.getTime() + 25 * DAY);
    const day25 = await queue.send(piiExpiryJob, {
      ctx,
      idempotencyKey: 'pii.expiry:day25',
      payload: {},
    });
    expect((await waitFor(day25.id)).records).toBe(1);
    expect(await alive(ref)).toBe(false);
    // The sweep sends one job per workspace per hour; a second sweep that hour sends none new.
    const first = await sweepPiiExpiry({
      directory: { listIds: () => Promise.resolve([ws]) },
      queue,
      now: clock,
    });
    expect(first).toBe(1);
  });

  // Before the closure test: after it, the vault refuses ingest for this workspace (ADR-065).
  it('[DEL-3] a repeated request is the same run: nothing is deleted twice', async () => {
    const ref = await ingest('w-twice');
    const request: DeletionRequest = {
      trigger: 'erasure',
      scope: { type: 'refs', pii_refs: [ref] },
      idempotencyKey: 'req-twice',
    };
    const first = await requestDeletion(queue, ctx, request);
    await waitFor(first.id);
    const again = await requestDeletion(queue, ctx, request);
    expect(again).toEqual({ id: first.id, created: false });
    const runs = await new Tenancy(db.db).run(ctx, (c) => log.runs(c));
    expect(runs.filter((r) => r.trigger === 'erasure' && r.recordsDeleted === 1)).toHaveLength(2);
  });

  it('[DEL-1] workspace closure deletes every record left', async () => {
    const last = await ingest('w-last');
    const result = await run({
      trigger: 'workspace_closure',
      scope: { type: 'workspace' },
      idempotencyKey: ws,
    });
    expect(result.records).toBeGreaterThanOrEqual(1);
    expect(await alive(last)).toBe(false);
  });

  it('[DEL-2] every deleted ref is tombstoned in db-main, db-pii and the journal', async () => {
    const dbMain = await new Tenancy(db.db).run(ctx, (c) => log.tombstones(c));
    expect(dbMain.length).toBeGreaterThanOrEqual(8);
    const journal = readdirSync(journalDir)
      .map((f) => readFileSync(join(journalDir, f), 'utf8'))
      .join('');
    for (const ref of dbMain) expect(journal).toContain(ref);
  });

  it('[DEL-3] the run log holds triggers, counts and IDs, and no value anywhere in db-main or the logs', async () => {
    const runs = await new Tenancy(db.db).run(ctx, (c) => log.runs(c));
    expect(new Set(runs.map((r) => r.trigger))).toEqual(
      new Set([
        'cancellation',
        'erasure',
        'ebay_account_deletion',
        'amazon_revocation',
        'ebay_termination',
        'expiry',
        'workspace_closure',
      ]),
    );
    const cert = await new Tenancy(db.db).run(ctx, (c) => log.certificate(c, account));
    expect(cert.runs.map((r) => r.trigger)).toEqual(['amazon_revocation']);
    expect(cert.recordsDeleted).toBeGreaterThanOrEqual(1);
    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
  });
});
