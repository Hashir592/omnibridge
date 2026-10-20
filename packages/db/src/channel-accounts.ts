import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import type { Kysely } from 'kysely';
import { tenancyError } from './errors.ts';
import type { ChannelProvider, MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export interface NewChannelAccount {
  /** Chosen by the caller only for seed data with fixed ids. */
  id?: string;
  companyId: string;
  provider: ChannelProvider;
  displayName: string;
}

export interface ChannelAccount {
  id: string;
  companyId: string;
  provider: ChannelProvider;
  displayName: string;
  /** Once true, the company is fixed (TEN-3). */
  hasOrders: boolean;
  archived: boolean;
}

/**
 * app.channel_accounts (TEN-3, TEN-10). Each account belongs to one company. Connection details
 * and credentials arrive in M07.
 */
export class ChannelAccountRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Throws WorkspaceLimitReached when max_channel_accounts is set and reached (TEN-10). */
  async create(ctx: TenantContext, input: NewChannelAccount): Promise<string> {
    const id = input.id ?? randomUUID();
    await this.#write(ctx, (db) =>
      db
        .insertInto('app.channel_accounts')
        .values({
          id,
          workspace_id: ctx.workspaceId,
          company_id: input.companyId,
          provider: input.provider,
          display_name: input.displayName,
        })
        .execute(),
    );
    return id;
  }

  async list(ctx: TenantContext): Promise<ChannelAccount[]> {
    const rows = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.channel_accounts')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    );
    return rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      provider: row.provider,
      displayName: row.display_name,
      hasOrders: row.orders_seen_at !== null,
      archived: row.archived_at !== null,
    }));
  }

  /** Throws ChannelAccountCompanyLocked once the account has orders (TEN-3). */
  async moveToCompany(ctx: TenantContext, id: string, companyId: string): Promise<void> {
    await this.#write(ctx, (db) =>
      db
        .updateTable('app.channel_accounts')
        .set({ company_id: companyId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute(),
    );
  }

  /** Records that the account has orders (M10 calls this with its first order). */
  async markOrdersSeen(ctx: TenantContext, id: string): Promise<void> {
    await this.#write(ctx, (db) =>
      db
        .updateTable('app.channel_accounts')
        .set({ orders_seen_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('orders_seen_at', 'is', null)
        .execute(),
    );
  }

  /** Archiving is how an account with orders leaves its company (TEN-3). */
  async archive(ctx: TenantContext, id: string): Promise<void> {
    await this.#write(ctx, (db) =>
      db
        .updateTable('app.channel_accounts')
        .set({ archived_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('archived_at', 'is', null)
        .execute(),
    );
  }

  async #write(ctx: TenantContext, fn: (db: Kysely<MainDb>) => Promise<unknown>): Promise<void> {
    try {
      await withTenantTransaction(this.#db, ctx, fn);
    } catch (err) {
      throw tenancyError(err);
    }
  }
}
