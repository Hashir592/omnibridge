import { randomUUID } from 'node:crypto';
import {
  createMainDb,
  createQueues,
  JobRecordRepository,
  migrateMain,
  Tenancy,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { defineJob, JobQueue } from '@omnibridge/queue';
import {
  PII_MARKER,
  scanDatabaseForMarkers,
  scanTextForMarkers,
  startRoleCluster,
  type RoleCluster,
} from '@omnibridge/testkit';
import { VaultClient } from '@omnibridge/vault-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startTestVault, type TestVault } from '../../pii-vault/src/testing.ts';
import { createWorkerBoss } from './heartbeat.ts';

// AT-9 harness for T-0402 (invariants 7 and 7a): a full ingest → queue → read cycle across the
// PII boundary leaves no marker in db-main (app and pgboss schemas, job records) or in any log.

const piiJob = defineJob({
  type: 'test.pii_label',
  payload: z.object({ pii_ref: z.uuid() }).strict(),
});

describe('PII boundary marker scan [AT-9][DP-8]', () => {
  let main: RoleCluster;
  let pii: RoleCluster;
  let db: MainDbHandle;
  let vault: TestVault;
  let queue: JobQueue;
  let stopBoss: () => Promise<void>;
  const logs: string[] = [];
  const logger = createLogger({
    service: 'test',
    version: '0',
    destination: { write: (line: string) => (logs.push(line), true) },
  });
  const ws = randomUUID();

  beforeAll(async () => {
    [main, pii] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']),
      startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']),
    ]);
    await migrateMain(main.connection('ob_owner'));
    await createQueues(main.connection('ob_owner'), [piiJob]);
    vault = await startTestVault({
      owner: pii.connection('vault_owner'),
      app: pii.connection('vault_app'),
      logger,
    });
    db = createMainDb({ ...main.connection('ob_app'), max: 4 });
    await new Tenancy(db.db).run({ workspaceId: ws, companyIds: [] }, (ctx) =>
      new WorkspaceRepository(db.db).create(ctx, { name: 'Boundary test' }),
    );
    const boss = createWorkerBoss(main.connection('ob_app'), { monitorIntervalSeconds: 1 });
    boss.on('error', () => undefined);
    await boss.start();
    stopBoss = () => boss.stop({ graceful: false, close: true });
    queue = new JobQueue({
      boss,
      records: new JobRecordRepository(db.db),
      tenancy: new Tenancy(db.db),
      logger,
    });
  }, 300_000);

  afterAll(async () => {
    await stopBoss();
    await vault.close();
    await db.destroy();
    await Promise.all([main.container.stop(), pii.container.stop()]);
  }, 120_000);

  it('[AT-9][DP-8] ingest, queue and read leave no marker in db-main, the job tables or the logs', async () => {
    const web = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.web });
    const worker = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens.worker });
    // Web: inbound PII goes to the vault inside the request; only the pii_ref goes on (7a).
    const { pii_ref } = await web.ingest({
      workspace_id: ws,
      kind: 'buyer_contact',
      channel_account_id: randomUUID(),
      subject_type: 'order',
      subject_id: 'boundary-order-1',
      fields: {
        name: `${PII_MARKER}Ada Boundary`,
        address_line1: `${PII_MARKER}1 Marker Lane`,
        postcode: 'PI1 1MK',
        email: `${PII_MARKER}ada@example.test`,
      },
    });
    const done = new Promise<number>((resolve) => {
      void queue.work(
        piiJob,
        async (job) => {
          const full = await worker.readFull({
            workspaceId: job.ctx.workspaceId,
            piiRef: job.payload.pii_ref,
            purpose: 'label',
          });
          // A label would be made from `full` here; the job result holds a count only.
          resolve(Object.keys(full.fields).length);
          return { labels: 1 };
        },
        { pollingIntervalSeconds: 0.5 },
      );
    });
    await queue.send(piiJob, {
      ctx: { workspaceId: ws, companyIds: [] },
      idempotencyKey: `label:${pii_ref}`,
      payload: { pii_ref },
    });
    expect(await done).toBe(4);
    const masked = await web.mask(ws, [pii_ref]);
    expect(masked.records[0]?.fields.name).toBe('P. B***');

    expect(await scanDatabaseForMarkers(main)).toEqual([]);
    expect(scanTextForMarkers(logs)).toEqual([]);
    // The scan is not vacuous: a marker planted in a job's key is found in both job tables.
    await queue.send(piiJob, {
      ctx: { workspaceId: ws, companyIds: [] },
      idempotencyKey: `${PII_MARKER}planted`,
      payload: { pii_ref },
    });
    const planted = (await scanDatabaseForMarkers(main)).map((h) => h.table);
    expect(planted).toContain('app.job_records');
    expect(planted.some((t) => t.startsWith('pgboss.'))).toBe(true);
  }, 120_000);
});
