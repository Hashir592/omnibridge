import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKekLine, parseKeyring, Secret } from '@omnibridge/crypto';
import {
  AuthStore,
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
import { PlatformKeys, rewrapPlatformKeys } from './auth/platform-keys.ts';
import { rotateKeys, withPlatformKeys } from './key-rotation.ts';

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
      'ob_ops',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    // rewrap-keys logs in as ob_ops (ADR-051), so it is tested as ob_ops.
    main = createMainDb({ ...cluster.connection('ob_ops'), max: 2 });
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

  it('[USR-4] the platform key that seals TOTP secrets is re-wrapped with the workspace keys', async () => {
    const store = new AuthStore(main.db);
    const key = await new PlatformKeys(store, ring(v1)).current();
    const sealed = key.encrypt('totp secret', {
      workspaceId: 'platform',
      table: 'user_auth',
      column: 'totp_secret',
      rowId: 'u1',
    });
    // A process that still has only v1 sees nothing newer yet; after the move it would.
    expect(await rewrapPlatformKeys(store, ring(v1, v2))).toEqual({
      rewrapped: 1,
      stale: 0,
      newer: 0,
    });
    expect(await rewrapPlatformKeys(store, ring(v1))).toMatchObject({ rewrapped: 0, newer: 1 });
    // The old KEK line can go: the key opens with v2 alone and still opens the old secret.
    const moved = await new PlatformKeys(store, ring(v2)).version(key.version);
    expect(
      moved
        .decrypt(sealed, {
          workspaceId: 'platform',
          table: 'user_auth',
          column: 'totp_secret',
          rowId: 'u1',
        })
        .toString(),
    ).toBe('totp secret');
    // Counted with the workspace keys: a platform key left behind keeps the rotation open.
    expect(
      withPlatformKeys(
        { workspaces: 2, rewrapped: 2, stale: 0, newer: 0 },
        { rewrapped: 0, stale: 1, newer: 0 },
      ),
    ).toEqual({ workspaces: 2, rewrapped: 2, stale: 1, newer: 0 });
  });

  it('[TEN-1] the workspace list is read only as ob_platform', async () => {
    // As ob_ops, RLS would show no workspace at all and the job would wrongly report done.
    await expect(new WorkspaceDirectory(main.db).listIds()).rejects.toThrow(/ob_platform/);
    expect([...(await new WorkspaceDirectory(platform.db).listIds())].sort()).toEqual(
      [...workspaces].sort(),
    );
  });
});
