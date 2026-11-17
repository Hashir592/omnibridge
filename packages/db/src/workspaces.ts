import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export interface NewWorkspace {
  name: string;
  /** TEN-10: enforced only when set. */
  maxChannelAccounts?: number | null;
  maxUsers?: number | null;
}

export interface Workspace {
  id: string;
  name: string;
  plan: 'free_internal';
  maxChannelAccounts: number | null;
  maxUsers: number | null;
  /** Workspace settings (TEN-6). */
  timezone: string;
  currency: 'GBP';
  defaultVatRateBp: number;
  /** Fixed and read-only (TEN-6, section 7.3). */
  piiRetentionDays: number;
  createdAt: Date;
}

/** The module toggles a workspace can have (PLAT-2, ADR-059). */
export type WorkspaceModule = 'website_connector';

/**
 * Turns a module of a workspace on or off. Platform tooling only (the dev seed as ob_ops, the
 * console in M05): web's role has no grant, so a workspace admin cannot switch a module on.
 * False when there is no such workspace.
 */
export async function setWorkspaceModule(
  db: Kysely<MainDb>,
  workspaceId: string,
  module: WorkspaceModule,
  on: boolean,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    SELECT app.workspace_set_module(${workspaceId}::uuid, ${module}, ${on}) AS ok`.execute(db);
  return rows[0]?.ok === true;
}

const numberOrNull = (value: string | null) => (value === null ? null : Number(value));

/** app.workspaces (TEN-6, TEN-10), behind forced RLS: a context sees its own workspace only. */
export class WorkspaceRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Creates the workspace `ctx.workspaceId`; the RLS check allows no other id. */
  async create(ctx: TenantContext, input: NewWorkspace): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .insertInto('app.workspaces')
        .values({
          id: ctx.workspaceId,
          name: input.name,
          max_channel_accounts: input.maxChannelAccounts ?? null,
          max_users: input.maxUsers ?? null,
        })
        .execute(),
    );
  }

  async get(ctx: TenantContext): Promise<Workspace | undefined> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.workspaces')
        .selectAll()
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirst(),
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      name: row.name,
      plan: row.plan,
      maxChannelAccounts: numberOrNull(row.max_channel_accounts),
      maxUsers: numberOrNull(row.max_users),
      timezone: row.timezone,
      currency: row.currency,
      defaultVatRateBp: Number(row.default_vat_rate_bp),
      piiRetentionDays: Number(row.pii_retention_days),
      createdAt: row.created_at,
    };
  }
}
