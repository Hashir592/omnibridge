import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileRepository } from './files.ts';
import { migrateMain } from './migrate.ts';
import { Tenancy } from './tenant.ts';
import { WorkspaceRepository } from './workspaces.ts';
import type { MainDb } from './schema.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;
const A: TenantContext = { workspaceId: randomUUID(), companyIds: [] };

describe('file scan states (SEC-2)', () => {
  let cluster: RoleCluster;
  let db: Kysely<MainDb>;
  let files: FileRepository;

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    db = new Kysely<MainDb>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ ...cluster.connection('ob_app'), max: 2 }),
      }),
    });
    files = new FileRepository(db);
    await new Tenancy(db).run(A, (ctx) =>
      new WorkspaceRepository(db).create(ctx, { name: 'File test' }),
    );
  });

  afterAll(async () => {
    await db.destroy();
    await cluster.container.stop();
  });

  const newFile = async () => {
    const id = randomUUID();
    await files.insert(A, {
      id,
      contentType: 'application/pdf',
      sizeBytes: 10,
      keyVersion: 1,
      deleteAfter: null,
    });
    return id;
  };

  it('[SEC-2] as ob_app, a scanned file never moves back, so infected never becomes clean', async () => {
    // Raw SQL as ob_app, as a bug or an injection would write it: the trigger refuses.
    const rawSet = (id: string, state: string) =>
      db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.workspace_id', ${A.workspaceId}, true)`.execute(trx);
        await sql`UPDATE app.files SET state = ${state} WHERE id = ${id}`.execute(trx);
      });

    const infected = await newFile();
    await files.setState(A, infected, 'infected');
    await expect(rawSet(infected, 'clean')).rejects.toThrow(/cannot move from infected to clean/);
    await expect(rawSet(infected, 'scanning')).rejects.toThrow(/cannot move/);

    const failed = await newFile();
    await files.setState(A, failed, 'scan_failed');
    await expect(rawSet(failed, 'clean')).rejects.toThrow(/cannot move/);

    const clean = await newFile();
    await files.setState(A, clean, 'clean');
    await expect(rawSet(clean, 'infected')).rejects.toThrow(/cannot move/);
    expect((await files.get(A, clean))?.state).toBe('clean');
    expect((await files.get(A, infected))?.state).toBe('infected');
  });

  it('[SEC-2] a repeated scan verdict is a no-op: only the first verdict counts', async () => {
    const id = await newFile();
    await files.setState(A, id, 'clean');
    await files.setState(A, id, 'scan_failed'); // a second scan job: no error, no change
    expect((await files.get(A, id))?.state).toBe('clean');
  });

  it('[SEC-2] as ob_app, a file cannot be inserted already clean', async () => {
    const insertClean = db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.workspace_id', ${A.workspaceId}, true)`.execute(trx);
      // Raw SQL: the schema type already refuses a state on insert; this proves the database does.
      await sql`INSERT INTO app.files (id, workspace_id, content_type, size_bytes, key_version, state)
        VALUES (${randomUUID()}, ${A.workspaceId}, 'application/pdf', 10, 1, 'clean')`.execute(trx);
    });
    await expect(insertClean).rejects.toThrow(/must start in state scanning/);
  });
});
