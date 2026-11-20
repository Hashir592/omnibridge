import { createHash, randomBytes } from 'node:crypto';
import type { OAuthProvider, TenantContext } from '@omnibridge/core';
import type { Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** How long a consent round trip may take. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

const STATE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

const hash = (state: string) => createHash('sha256').update(state).digest();

/**
 * The workspace a state belongs to, or undefined for anything not shaped like one of ours. The
 * public OAuth return opens that workspace's transaction with it; the state itself is the secret.
 */
export function oauthStateWorkspace(state: string): string | undefined {
  return STATE.exec(state)?.[1];
}

export interface TakenOAuthState {
  channelAccountId: string;
  userId: string;
  provider: OAuthProvider;
}

/**
 * Single-use OAuth states (INT-2, app.oauth_states): `<workspace id>.<32 random bytes>`, stored as
 * a SHA-256 hash, valid for 10 minutes.
 */
export class OAuthStateRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async create(
    ctx: TenantContext,
    input: { channelAccountId: string; userId: string; provider: OAuthProvider },
    now: Date,
  ): Promise<string> {
    const state = `${ctx.workspaceId}.${randomBytes(32).toString('base64url')}`;
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      // Old rows go as new ones arrive: a day past expiry, nothing in them is needed.
      await trx
        .deleteFrom('app.oauth_states')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('expires_at', '<', new Date(now.getTime() - 86_400_000))
        .execute();
      await trx
        .insertInto('app.oauth_states')
        .values({
          workspace_id: ctx.workspaceId,
          state_hash: hash(state),
          channel_account_id: input.channelAccountId,
          user_id: input.userId,
          provider: input.provider,
          created_at: now,
          expires_at: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
        })
        .execute();
    });
    return state;
  }

  /** Takes a live state once; undefined when it is unknown, used, expired or of another workspace. */
  async take(
    ctx: TenantContext,
    state: string,
    provider: OAuthProvider,
    now: Date,
  ): Promise<TakenOAuthState | undefined> {
    if (oauthStateWorkspace(state) !== ctx.workspaceId) return undefined;
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.oauth_states')
        .set({ used_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('state_hash', '=', hash(state))
        .where('provider', '=', provider)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .returning(['channel_account_id', 'user_id', 'provider'])
        .executeTakeFirst(),
    );
    return row === undefined
      ? undefined
      : { channelAccountId: row.channel_account_id, userId: row.user_id, provider: row.provider };
  }
}
