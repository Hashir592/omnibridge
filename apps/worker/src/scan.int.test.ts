import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TenantContext } from '@omnibridge/core';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import {
  createQueues,
  FileRepository,
  JobRecordRepository,
  migrateMain,
  Tenancy,
  WorkspaceRepository,
  type MainDb,
} from '@omnibridge/db';
import {
  acceptUpload,
  EncryptedLocalFileStore,
  FileKeyStore,
  FileNotReadable,
} from '@omnibridge/files';
import { createLogger } from '@omnibridge/logger';
import { filesScanJob, JobQueue } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerBoss } from './heartbeat.ts';
import { scanFileHandler } from './scan.ts';

/** Same image and digest as the clamd service in infra/compose/compose.dev.yaml. */
const CLAMD_IMAGE =
  'clamav/clamav:1.5.4@sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6';

/**
 * A minimal PDF whose one stream object is the EICAR anti-virus test string. ClamAV extracts PDF
 * streams and scans each one, and EICAR is detected only at the start of a scanned object, so the
 * file passes the PDF magic-byte check and is still found. The string is assembled at run time so
 * no source file on a developer's machine holds it (their own scanner would quarantine it).
 */
const eicarPdf = () => {
  const eicar = [
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
    'EICAR-STANDARD-ANTIVIRUS-',
    'TEST-FILE!$H+H*',
  ].join('');
  return Buffer.from(
    [
      '%PDF-1.4',
      `1 0 obj << /Length ${String(eicar.length)} >>`,
      'stream',
      eicar,
      'endstream',
      'endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
      '',
    ].join('\n'),
  );
};
const cleanPdf = () => Buffer.from('%PDF-1.7\n% SECRETMARK-clean-synthetic-invoice\n%%EOF\n');

describe('upload scanning against clamd (SEC-2, NFR-5)', () => {
  let cluster: RoleCluster;
  let clamd: StartedTestContainer;
  let db: Kysely<MainDb>;
  let boss: PgBoss;
  let store: EncryptedLocalFileStore;
  let queue: JobQueue;
  const root = mkdtempSync(join(tmpdir(), 'ob-files-'));
  const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
  const ws: TenantContext = { workspaceId: randomUUID(), companyIds: [] };

  beforeAll(async () => {
    [cluster, clamd] = await Promise.all([
      startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app', 'ob_platform']),
      new GenericContainer(CLAMD_IMAGE)
        .withEnvironment({ CLAMAV_NO_FRESHCLAMD: 'true', CLAMAV_NO_MILTERD: 'true' })
        .withExposedPorts(3310)
        .withWaitStrategy(Wait.forLogMessage(/socket found, clamd started/i))
        .withStartupTimeout(280_000)
        .start(),
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    await createQueues(cluster.connection('ob_owner'), [filesScanJob]);
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 4 }),
      }),
    });
    await new Tenancy(db).run(ws, (ctx) =>
      new WorkspaceRepository(db).create(ctx, { name: 'Scan test' }),
    );
    const keyring = parseKeyring('secrets', generateKekLine(1));
    store = new EncryptedLocalFileStore({
      root,
      keys: new FileKeyStore(root, keyring),
      metadata: new FileRepository(db),
    });
    boss = createWorkerBoss(cluster.connection('ob_app'), { monitorIntervalSeconds: 1 });
    boss.on('error', () => undefined);
    await boss.start();
    queue = new JobQueue({
      boss,
      records: new JobRecordRepository(db),
      tenancy: new Tenancy(db),
      logger,
    });
    await queue.work(
      filesScanJob,
      scanFileHandler({
        files: store,
        clamd: { host: clamd.getHost(), port: clamd.getMappedPort(3310) },
        logger,
      }),
      { pollingIntervalSeconds: 0.5 },
    );
  }, 300_000);

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await db.destroy();
    await Promise.all([cluster.container.stop(), clamd.stop()]);
  });

  const stateOf = async (id: string) => (await new FileRepository(db).get(ws, id))?.state;

  it('[SEC-2] EICAR upload is marked infected and never served', async () => {
    const id = await acceptUpload({ store, queue }, ws, {
      bytes: eicarPdf(),
      filename: 'invoice.pdf',
      declaredType: 'application/pdf',
    });
    // Not readable while scanning ...
    await expect(store.get(ws, id)).rejects.toThrow(FileNotReadable);
    await expect.poll(() => stateOf(id), { timeout: 120_000 }).toBe('infected');
    // ... nor after: an infected file is never served, and no link is ever issued for it.
    await expect(store.get(ws, id)).rejects.toThrow(FileNotReadable);
  });

  it('[NFR-5] stored file bytes are not plaintext on disk', async () => {
    const body = cleanPdf();
    const id = await acceptUpload({ store, queue }, ws, {
      bytes: body,
      filename: 'invoice.pdf',
      declaredType: 'application/pdf',
    });
    await expect.poll(() => stateOf(id), { timeout: 120_000 }).toBe('clean');

    const onDisk = readFileSync(join(root, ws.workspaceId, `${id}.bin`));
    expect(onDisk.includes(Buffer.from('SECRETMARK'))).toBe(false);
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);
    // The data key on the volume is wrapped, never raw.
    const keyFiles = readdirSync(join(root, ws.workspaceId, 'keys'));
    expect(keyFiles).toEqual(['v1.json']);

    const file = await store.get(ws, id);
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
    expect(file.meta).toMatchObject({ contentType: 'application/pdf', sizeBytes: body.length });
  });

  it('[SEC-2] another workspace cannot read or scan the file', async () => {
    const id = await acceptUpload({ store, queue }, ws, {
      bytes: cleanPdf(),
      filename: 'a.pdf',
      declaredType: 'application/pdf',
    });
    await expect.poll(() => stateOf(id), { timeout: 120_000 }).toBe('clean');
    const other: TenantContext = { workspaceId: randomUUID(), companyIds: [] };
    await expect(store.get(other, id)).rejects.toThrow(FileNotReadable);
  });
});
