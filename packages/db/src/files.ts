import type { TenantContext } from '@omnibridge/core';
import type { FileMeta, FileMetadataStore, FileState } from '@omnibridge/files';
import type { Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** app.files: metadata for the encrypted files volume (NFR-5), behind forced RLS. */
export class FileRepository implements FileMetadataStore {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async insert(ctx: TenantContext, meta: Omit<FileMeta, 'state'>): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .insertInto('app.files')
        .values({
          id: meta.id,
          workspace_id: ctx.workspaceId,
          content_type: meta.contentType,
          size_bytes: meta.sizeBytes,
          key_version: meta.keyVersion,
          delete_after: meta.deleteAfter,
        })
        .execute(),
    );
  }

  async get(ctx: TenantContext, id: string): Promise<FileMeta | undefined> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.files')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      keyVersion: Number(row.key_version),
      state: row.state,
      deleteAfter: row.delete_after,
    };
  }

  async setState(ctx: TenantContext, id: string, state: FileState): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.files')
        .set({ state, scanned_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        // Only the first verdict counts: a repeated scan job is a no-op, never a trigger error
        // from migration 0006.
        .where('state', '=', 'scanning')
        .execute(),
    );
  }

  async listExpired(ctx: TenantContext, now: Date): Promise<string[]> {
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.files')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('delete_after', '<=', now)
        .execute(),
    );
    return rows.map((row) => row.id);
  }

  async delete(ctx: TenantContext, id: string): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .deleteFrom('app.files')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute(),
    );
  }
}
