import { createHash, randomBytes } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import type { Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export type BulkAction = 'stock_push' | 'tracking_resend' | 'ads_change';
export type BulkParams = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** SAFE-1: how long a preview's confirmation stays good. */
export const BULK_TOKEN_TTL_MS = 10 * 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest();

export type BulkTake =
  | { outcome: 'ok'; action: BulkAction; accountIds: string[]; params: BulkParams }
  | { outcome: 'not_found' }
  | { outcome: 'conflict' };

/**
 * Bulk-write confirmations (SAFE-1, app.bulk_confirmations): the preview stores what will run (the
 * action, the sorted accounts and the params) under a random token's hash; the confirm takes it
 * once, as the same user, before it expires, and runs exactly that.
 */
export class BulkConfirmationRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async issue(
    ctx: TenantContext,
    input: { userId: string; action: BulkAction; accountIds: readonly string[]; params: BulkParams },
    now: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + BULK_TOKEN_TTL_MS);
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await trx
        .deleteFrom('app.bulk_confirmations')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('expires_at', '<', new Date(now.getTime() - 86_400_000))
        .execute();
      await trx
        .insertInto('app.bulk_confirmations')
        .values({
          workspace_id: ctx.workspaceId,
          token_hash: hash(token),
          user_id: input.userId,
          action: input.action,
          account_ids: [...input.accountIds].sort(),
          params: JSON.stringify(input.params),
          created_at: now,
          expires_at: expiresAt,
        })
        .execute();
    });
    return { token, expiresAt };
  }

  /** Uses the token once: not_found for a token this workspace never issued, conflict otherwise. */
  take(ctx: TenantContext, token: string, userId: string, now: Date): Promise<BulkTake> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .selectFrom('app.bulk_confirmations')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('token_hash', '=', hash(token))
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return { outcome: 'not_found' };
      if (row.used_at !== null || row.expires_at <= now || row.user_id !== userId) {
        return { outcome: 'conflict' };
      }
      await trx
        .updateTable('app.bulk_confirmations')
        .set({ used_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('token_hash', '=', row.token_hash)
        .execute();
      return {
        outcome: 'ok',
        action: row.action,
        accountIds: row.account_ids,
        params: row.params,
      };
    });
  }
}
