import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  createMainDb,
  CredentialRepository,
  FileRepository,
  migrateMain,
  rewrapAllDataKeys,
  Tenancy,
  withTenantTransaction,
  WorkspaceRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import { EncryptedLocalFileStore, FileKeyStore } from '@omnibridge/files';
import { WorkspaceDirectory } from '@omnibridge/db/platform';
import { createLogger } from '@omnibridge/logger';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rotateKeys } from './key-rotation.ts';

const logger = createLogger({ service: 'test', version: '0', destination: { write: () => 0 } });
const v1 = generateKekLine(1);
const v2 = generateKekLine(2);
const ring = (...lines: string[]) => parseKeyring('secrets', lines.join('\n'));

describe('all-workspace KEK re-wrap job (F-03, PS-015 (2), R2-02, SEC-6)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let platform: MainDbHandle;
  let root = '';
  const workspaces = [randomUUID(), randomUUID()];

  const credentials = (...lines: string[]) =>
    new CredentialRepository({ keyring: ring(...lines), logger });

  /** The job as rewrap-keys.ts runs it, with one keyring for the database and the volume. */
  const job = (lines: string[], faults: { data?: boolean; files?: boolean } = {}) => {
    const repo = credentials(...lines);
    const keys = new FileKeyStore(root, ring(...lines));
    return rotateKeys({
      kekVersion: ring(...lines).activeVersion,
      dataKeys: () =>
        rewrapAllDataKeys({
          db: main.db,
          directory: new WorkspaceDirectory(platform.db),
          // A fault stands for a re-wrap that silently did nothing.
          credentials: faults.data
            ? {
                rewrapDataKeys: () => Promise.resolve(0),
                countDataKeys: repo.countDataKeys.bind(repo),
              }
            : repo,
        }),
      fileKeys: faults.files
        ? {
            rewrapAll: () => Promise.resolve(0),
            countStale: () => keys.countStale(),
            countNewer: () => keys.countNewer(),
          }
        : keys,
      logger,
    });
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 2 });
    platform = createMainDb({ ...cluster.connection('ob_platform'), max: 1 });
    root = mkdtempSync(join(tmpdir(), 'ob-rewrap-'));
    const tenancy = new Tenancy(main.db);
    const repo = credentials(v1);
    const store = new EncryptedLocalFileStore({
      root,
      keys: new FileKeyStore(root, ring(v1)),
      metadata: new FileRepository(main.db),
    });
    for (const workspaceId of workspaces) {
      await tenancy.run({ workspaceId, companyIds: [] }, async (ctx) => {
        await new WorkspaceRepository(main.db).create(ctx, { name: 'Rewrap test' });
        await withTenantTransaction(main.db, ctx, (trx) =>
          repo.store(trx, ctx, { kind: 'evri.api_key' }, 'current', new Secret('x')),
        );
        await store.put(ctx, {
          body: Buffer.from('%PDF-1.7\n'),
          contentType: 'application/pdf',
          sizeBytes: 9,
        });
      });
    }
  });

  afterAll(async () => {
    await platform.destroy();
    await main.destroy();
    await cluster.container.stop();
  });

  it('[TEN-1] re-wrap job: rotation is reported done only when no data or file key remains under the old KEK', async () => {
    // Nothing re-wrapped: not done, and the counts say how many keys are left.
    const nothing = await job([v1, v2], { data: true, files: true });
    expect(nothing).toMatchObject({
      done: false,
      dataKeys: { workspaces: 2, rewrapped: 0, stale: 2 },
      fileKeys: { rewrapped: 0, stale: 2 },
    });

    // File keys not re-wrapped (the database part did run): still not done.
    const noFiles = await job([v1, v2], { files: true });
    expect(noFiles).toMatchObject({
      done: false,
      dataKeys: { rewrapped: 2, stale: 0, newer: 0 },
      fileKeys: { rewrapped: 0, stale: 2 },
    });

    // The full job: done only now, with nothing left under v1.
    const full = await job([v1, v2]);
    expect(full).toEqual({
      done: true,
      kekVersion: 2,
      dataKeys: { workspaces: 2, rewrapped: 0, stale: 0, newer: 0 },
      fileKeys: { rewrapped: 2, stale: 0, newer: 0 },
    });

    // An old one-line keyring mid-rollout skips the newer keys, counts them, and is not done.
    const old = await job([v1]);
    expect(old).toMatchObject({
      done: false,
      dataKeys: { rewrapped: 0, stale: 0, newer: 2 },
      fileKeys: { rewrapped: 0, stale: 0, newer: 2 },
    });

    // A repeat run under the new keyring changes nothing and stays done.
    expect(await job([v1, v2])).toMatchObject({ done: true, fileKeys: { rewrapped: 0 } });
  });

  it('[TEN-1] the workspace list is read only as ob_platform', async () => {
    // As ob_app, RLS would show no workspace at all and the job would wrongly report done.
    await expect(new WorkspaceDirectory(main.db).listIds()).rejects.toThrow(/ob_platform/);
    expect([...(await new WorkspaceDirectory(platform.db).listIds())].sort()).toEqual(
      [...workspaces].sort(),
    );
  });
});
