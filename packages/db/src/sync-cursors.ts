import type { TenantContext } from '@omnibridge/core';
import type { Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** The stored form of a provider-kit CursorState (INT-8). */
export interface StoredCursor {
  cursorAt: Date | null;
  overlap: { id: string; at: string }[];
}

/**
 * Incremental sync cursors per account and stream (INT-8, app.sync_cursors). A poll reads one,
 * fetches with no transaction open, then saves the next one with the records it produced.
 */
export class SyncCursorRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async get(ctx: TenantContext, channelAccountId: string, stream: string): Promise<StoredCursor> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.sync_cursors')
        .select(['cursor_at', 'overlap'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('channel_account_id', '=', channelAccountId)
        .where('stream', '=', stream)
        .executeTakeFirst(),
    );
    return row === undefined
      ? { cursorAt: null, overlap: [] }
      : { cursorAt: row.cursor_at, overlap: row.overlap };
  }

  /** Stores the cursor after a successful poll. */
  async save(
    ctx: TenantContext,
    channelAccountId: string,
    stream: string,
    cursor: StoredCursor,
    at: Date,
  ): Promise<void> {
    const overlap = JSON.stringify(cursor.overlap);
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .insertInto('app.sync_cursors')
        .values({
          workspace_id: ctx.workspaceId,
          channel_account_id: channelAccountId,
          stream,
          cursor_at: cursor.cursorAt,
          overlap,
          last_run_at: at,
          last_success_at: at,
          updated_at: at,
        })
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'channel_account_id', 'stream']).doUpdateSet({
            cursor_at: cursor.cursorAt,
            overlap,
            last_run_at: at,
            last_success_at: at,
            updated_at: at,
          }),
        )
        .execute(),
    );
  }
}
