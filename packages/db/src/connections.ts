import { providerDay, type ProviderMode, type TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { ChannelProvider, MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** INT-4. */
export type ConnectionStatus = 'active' | 'needs_reauth' | 'paused' | 'error' | 'disconnected';

/** AMZ-12: this many auth failures within the window mark the account Needs re-authorisation. */
export const AUTH_FAILURE_LIMIT = 3;
export const AUTH_FAILURE_WINDOW_MS = 60 * 60_000;

export interface ApiUsageToday {
  api: string;
  calls: number;
  cap: number | null;
}

export interface Connection {
  id: string;
  provider: ChannelProvider;
  displayName: string;
  companyId: string;
  status: ConnectionStatus;
  lastSuccessAt: Date | null;
  lastTokenRefreshAt: Date | null;
  authFailures: number;
  needsReauthAt: Date | null;
  lastError: { code: string; at: Date } | null;
  pausedAt: Date | null;
  usageToday: ApiUsageToday[];
}

export interface ConnectionDetail extends Connection {
  streams: { stream: string; cursorAt: Date | null; lastSuccessAt: Date | null }[];
  credentials: { kind: string; slot: 'current' | 'next'; expiresAt: Date | null }[];
}

interface Row {
  id: string;
  provider: ChannelProvider;
  display_name: string;
  company_id: string;
  archived_at: Date | null;
  last_success_at: Date | null;
  last_token_refresh_at: Date | null;
  auth_failures: string;
  needs_reauth_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  paused_at: Date | null;
  connected: boolean;
}

/**
 * Worked out in this order (contract ConnectionStatus): disconnected (archived, or no active token
 * in this environment), needs_reauth, paused (SAFE-2), error (the last call failed after the last
 * success), active.
 */
export function connectionStatus(row: {
  archived: boolean;
  connected: boolean;
  needsReauthAt: Date | null;
  pausedAt: Date | null;
  lastErrorAt: Date | null;
  lastSuccessAt: Date | null;
}): ConnectionStatus {
  if (row.archived || !row.connected) return 'disconnected';
  if (row.needsReauthAt !== null) return 'needs_reauth';
  if (row.pausedAt !== null) return 'paused';
  if (
    row.lastErrorAt !== null &&
    (row.lastSuccessAt === null || row.lastErrorAt > row.lastSuccessAt)
  ) {
    return 'error';
  }
  return 'active';
}

/**
 * Channel and carrier accounts as the Connections page shows them (INT-4), and the health the
 * provider calls record: successes, auth failures (AMZ-12, EBAY-5), errors and API usage (RL-5).
 * Every call runs in the caller's tenant context; RLS keeps it to that workspace and its companies.
 */
export class ConnectionRepository {
  readonly #db: Kysely<MainDb>;
  readonly #environment: ProviderMode;

  constructor(db: Kysely<MainDb>, options: { environment?: ProviderMode } = {}) {
    this.#db = db;
    this.#environment = options.environment ?? 'mock';
  }

  async list(ctx: TenantContext, now: Date): Promise<Connection[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const rows = await this.#rows(trx, ctx);
      const usage = await this.#usage(trx, ctx, rows, now);
      return rows.map((row) => this.#view(row, usage.get(row.id) ?? []));
    });
  }

  async get(ctx: TenantContext, id: string, now: Date): Promise<ConnectionDetail | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const rows = await this.#rows(trx, ctx, id);
      const row = rows[0];
      if (row === undefined) return undefined;
      const usage = await this.#usage(trx, ctx, rows, now);
      const streams = await trx
        .selectFrom('app.sync_cursors')
        .select(['stream', 'cursor_at', 'last_success_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('channel_account_id', '=', id)
        .orderBy('stream')
        .execute();
      const credentials = await trx
        .selectFrom('app.credentials')
        .select(['kind', 'slot', 'expires_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('channel_account_id', '=', id)
        .where('is_active', '=', true)
        .where('environment', '=', this.#environment)
        .orderBy('kind')
        .orderBy('slot')
        .execute();
      return {
        ...this.#view(row, usage.get(id) ?? []),
        streams: streams.map((s) => ({
          stream: s.stream,
          cursorAt: s.cursor_at,
          lastSuccessAt: s.last_success_at,
        })),
        credentials: credentials.map((c) => ({
          kind: c.kind,
          slot: c.slot,
          expiresAt: c.expires_at,
        })),
      };
    });
  }

  /**
   * A call worked. Clears the auth failures and Needs re-authorisation; true when the account was
   * marked Needs re-authorisation, so the caller resolves the notice.
   */
  async recordSuccess(
    ctx: TenantContext,
    id: string,
    at: Date,
    options: { tokenRefreshed?: boolean } = {},
  ): Promise<{ reauthCleared: boolean }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const before = await trx
        .selectFrom('app.channel_accounts')
        .select('needs_reauth_at')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (before === undefined) return { reauthCleared: false };
      await trx
        .updateTable('app.channel_accounts')
        .set({
          last_success_at: at,
          auth_failures: 0,
          auth_failures_since: null,
          needs_reauth_at: null,
          ...(options.tokenRefreshed === true ? { last_token_refresh_at: at } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return { reauthCleared: before.needs_reauth_at !== null };
    });
  }

  /**
   * An auth failure (AMZ-12, EBAY-5). Revoked (invalid_grant, a revocation) marks the account at
   * once; otherwise the third failure within an hour does. `marked` is true only for the call that
   * marked it, so the caller raises one notice.
   */
  async recordAuthFailure(
    ctx: TenantContext,
    id: string,
    at: Date,
    options: { revoked: boolean },
  ): Promise<{ failures: number; marked: boolean }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const windowStart = new Date(at.getTime() - AUTH_FAILURE_WINDOW_MS);
      const row = await trx
        .updateTable('app.channel_accounts')
        .set({
          auth_failures: sql<number>`CASE WHEN auth_failures_since IS NULL
            OR auth_failures_since <= ${windowStart} THEN 1 ELSE auth_failures + 1 END`,
          auth_failures_since: sql<Date>`CASE WHEN auth_failures_since IS NULL
            OR auth_failures_since <= ${windowStart} THEN ${at}::timestamptz
            ELSE auth_failures_since END`,
          last_error_code: 'provider.auth_failed',
          last_error_at: at,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returning('auth_failures')
        .executeTakeFirst();
      if (row === undefined) return { failures: 0, marked: false };
      const failures = Number(row.auth_failures);
      if (!options.revoked && failures < AUTH_FAILURE_LIMIT) return { failures, marked: false };
      const marked = await trx
        .updateTable('app.channel_accounts')
        .set({ needs_reauth_at: at })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('needs_reauth_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return { failures, marked: marked !== undefined };
    });
  }

  /** Any other failed call: a stable code only, never a provider message or a value. */
  async recordError(ctx: TenantContext, id: string, code: string, at: Date): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.channel_accounts')
        .set({ last_error_code: code, last_error_at: at })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute(),
    );
  }

  /**
   * Adds calls to today's usage row of one API (RL-5), in the provider's own day. eBay's calls are
   * counted by the eBay governor's reservation instead (T-0702), never here as well.
   */
  async recordCalls(
    ctx: TenantContext,
    input: { channelAccountId: string; provider: ChannelProvider; api: string; calls: number },
    at: Date,
  ): Promise<void> {
    if (input.calls <= 0) return;
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .insertInto('app.api_usage_daily')
        .values({
          workspace_id: ctx.workspaceId,
          channel_account_id: input.channelAccountId,
          provider: input.provider,
          api: input.api,
          day: providerDay(input.provider, at),
          calls: input.calls,
          updated_at: at,
        })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'channel_account_id', 'provider', 'api', 'day'])
            .doUpdateSet((eb) => ({
              calls: sql<number>`${eb.ref('app.api_usage_daily.calls')} + ${input.calls}`,
              updated_at: at,
            })),
        )
        .execute(),
    );
  }

  async #rows(trx: Kysely<MainDb>, ctx: TenantContext, id?: string): Promise<Row[]> {
    let query = trx
      .selectFrom('app.channel_accounts as a')
      .select([
        'a.id',
        'a.provider',
        'a.display_name',
        'a.company_id',
        'a.archived_at',
        'a.last_success_at',
        'a.last_token_refresh_at',
        'a.auth_failures',
        'a.needs_reauth_at',
        'a.last_error_code',
        'a.last_error_at',
        'a.paused_at',
      ])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('app.credentials as c')
              .select('c.id')
              .whereRef('c.workspace_id', '=', 'a.workspace_id')
              .whereRef('c.channel_account_id', '=', 'a.id')
              .where('c.slot', '=', 'current')
              .where('c.is_active', '=', true)
              .where('c.environment', '=', this.#environment),
          )
          .as('connected'),
      )
      .where('a.workspace_id', '=', ctx.workspaceId);
    if (id !== undefined) query = query.where('a.id', '=', id);
    const rows = await query.orderBy('a.created_at').orderBy('a.id').execute();
    return rows.map((r) => ({ ...r, connected: r.connected === true }));
  }

  async #usage(
    trx: Kysely<MainDb>,
    ctx: TenantContext,
    rows: readonly Row[],
    now: Date,
  ): Promise<Map<string, ApiUsageToday[]>> {
    const out = new Map<string, ApiUsageToday[]>();
    if (rows.length === 0) return out;
    const days = [...new Set(rows.map((r) => providerDay(r.provider, now)))];
    const usage = await trx
      .selectFrom('app.api_usage_daily')
      .select(['channel_account_id', 'provider', 'api', 'calls', 'cap'])
      // pg reads a date as a Date; the provider's day is compared as YYYY-MM-DD text.
      .select(sql<string>`day::text`.as('day'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where(
        'channel_account_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('day', 'in', days)
      .orderBy('api')
      .execute();
    for (const u of usage) {
      // Each provider counts in its own day (eBay: US Pacific).
      if (u.day !== providerDay(u.provider, now)) continue;
      const list = out.get(u.channel_account_id) ?? [];
      list.push({ api: u.api, calls: Number(u.calls), cap: u.cap === null ? null : Number(u.cap) });
      out.set(u.channel_account_id, list);
    }
    return out;
  }

  #view(row: Row, usage: ApiUsageToday[]): Connection {
    return {
      id: row.id,
      provider: row.provider,
      displayName: row.display_name,
      companyId: row.company_id,
      status: connectionStatus({
        archived: row.archived_at !== null,
        connected: row.connected,
        needsReauthAt: row.needs_reauth_at,
        pausedAt: row.paused_at,
        lastErrorAt: row.last_error_at,
        lastSuccessAt: row.last_success_at,
      }),
      lastSuccessAt: row.last_success_at,
      lastTokenRefreshAt: row.last_token_refresh_at,
      authFailures: Number(row.auth_failures),
      needsReauthAt: row.needs_reauth_at,
      lastError:
        row.last_error_code === null || row.last_error_at === null
          ? null
          : { code: row.last_error_code, at: row.last_error_at },
      pausedAt: row.paused_at,
      usageToday: usage,
    };
  }
}
