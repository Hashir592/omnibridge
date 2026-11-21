import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/**
 * The platform console's reads and writes (T-0504: PLAT-1, PLAT-2, PLAT-3; migration 0033).
 *
 * Every console call is one SECURITY DEFINER function that checks again, in the database, that
 * the caller is a platform admin with MFA confirmed, and refuses (SQLSTATE 42501) otherwise. They
 * return IDs, workspace names, statuses, dates and counts only, never a tenant's orders,
 * customers, finance or messages (PLAT-3).
 */
export type WorkspaceStatus = 'active' | 'suspended' | 'archived';

export interface ConsoleWorkspace {
  id: string;
  name: string;
  status: WorkspaceStatus;
  statusChangedAt: Date | null;
  createdAt: Date;
  modules: { website_connector: boolean };
  users: number;
  channelAccounts: number;
}

export type StatusOutcome =
  | { outcome: 'ok'; previous: WorkspaceStatus }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; previous: WorkspaceStatus };

export type IncidentSeverity = 'info' | 'warning' | 'critical';

export interface IncidentBanner {
  message: string;
  severity: IncidentSeverity;
  setAt: Date;
}

export interface PlatformFlags {
  publicSignup: boolean;
  updatedAt: Date | null;
}

export interface ApiUsageRow {
  workspaceId: string;
  channelAccountId: string;
  provider: string;
  api: string;
  /** The provider's own day, `YYYY-MM-DD`. */
  day: string;
  calls: number;
  cap: number | null;
}

export interface CredentialExpiryRow {
  workspaceId: string;
  channelAccountId: string | null;
  kind: string;
  slot: 'current' | 'next';
  expiresAt: Date;
}

export interface JobRecordKey {
  workspaceId: string;
  type: string;
  idempotencyKey: string;
}

export interface ConsoleJobRecord extends JobRecordKey {
  state: string;
  attempt: number;
  errorCode: string | null;
  updatedAt: Date;
}

export interface DigestCounts {
  jobsFailed: number;
  /** Today's calls on every account. */
  apiCalls: number;
  /** Today's calls on accounts that have a daily cap, and the sum of those caps. */
  apiCappedCalls: number;
  apiCap: number;
  credentialsExpiring: number;
  deletionRuns: number;
  recordsDeleted: number;
}

export interface DigestRecipient {
  userId: string;
  email: string;
  name: string;
}

/** A console action for the platform audit (PLAT-2): IDs, names and counts only. */
export interface ConsoleAudit {
  action: string;
  workspaceId?: string | null;
  params?: Readonly<Record<string, unknown>>;
  ip?: string | null;
}

const num = (v: string | number | null): number => Number(v ?? 0);

/** Web's side: the console routes, as ob_app (through its ob_auth group). */
export class PlatformConsole {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  async workspaces(userId: string): Promise<ConsoleWorkspace[]> {
    const { rows } = await sql<{
      id: string;
      name: string;
      status: WorkspaceStatus;
      status_changed_at: Date | null;
      created_at: Date;
      modules: Record<string, unknown>;
      users: string;
      channel_accounts: string;
    }>`SELECT * FROM app.console_workspaces(${userId}::uuid)`.execute(this.#db);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      statusChangedAt: r.status_changed_at,
      createdAt: r.created_at,
      modules: { website_connector: r.modules.website_connector === true },
      users: num(r.users),
      channelAccounts: num(r.channel_accounts),
    }));
  }

  /**
   * Moves a workspace to `to`. With `within`, it joins that context's open transaction, so the
   * caller's audit rows and jobs commit with it.
   */
  async setWorkspaceStatus(
    userId: string,
    workspaceId: string,
    to: WorkspaceStatus,
    now: Date,
    within?: TenantContext,
  ): Promise<StatusOutcome> {
    const { rows } = await this.#run(within, (db) =>
      sql<{ outcome: StatusOutcome['outcome']; previous: WorkspaceStatus }>`
        SELECT * FROM app.console_workspace_status(${userId}::uuid, ${workspaceId}::uuid, ${to},
                                                   ${now})`.execute(db),
    );
    const row = rows[0];
    if (row === undefined || row.outcome === 'not_found') return { outcome: 'not_found' };
    return { outcome: row.outcome, previous: row.previous };
  }

  async setModule(
    userId: string,
    workspaceId: string,
    module: 'website_connector',
    on: boolean,
    within?: TenantContext,
  ): Promise<'ok' | 'not_found' | 'archived'> {
    const { rows } = await this.#run(within, (db) =>
      sql<{ outcome: 'ok' | 'not_found' | 'archived' }>`
        SELECT app.console_set_module(${userId}::uuid, ${workspaceId}::uuid, ${module}, ${on})
          AS outcome`.execute(db),
    );
    return rows[0]?.outcome ?? 'not_found';
  }

  async flags(userId: string): Promise<PlatformFlags> {
    const row = (await this.#settings(userId)).find((s) => s.key === 'public_signup');
    return { publicSignup: row?.value === true, updatedAt: row?.updated_at ?? null };
  }

  /** Sets the flag and writes its audit row in one transaction. */
  async setPublicSignup(
    userId: string,
    on: boolean,
    now: Date,
    audit: ConsoleAudit,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await sql`SELECT app.console_set_setting(${userId}::uuid, 'public_signup',
                                               ${JSON.stringify(on)}::jsonb, ${now})`.execute(trx);
      await this.#audit(trx, userId, audit, now);
    });
  }

  /** Sets the banner, or clears it with null, and writes its audit row in one transaction. */
  async setIncidentBanner(
    userId: string,
    banner: { message: string; severity: IncidentSeverity } | null,
    now: Date,
    audit: ConsoleAudit,
  ): Promise<void> {
    const value = banner === null ? null : JSON.stringify(banner);
    await this.#db.transaction().execute(async (trx) => {
      await sql`SELECT app.console_set_setting(${userId}::uuid, 'incident_banner',
                                               ${value}::jsonb, ${now})`.execute(trx);
      await this.#audit(trx, userId, audit, now);
    });
  }

  /** The banner every signed-in user sees, or null. */
  async incidentBanner(): Promise<IncidentBanner | null> {
    const { rows } = await sql<{ message: string; severity: IncidentSeverity; set_at: Date }>`
      SELECT * FROM app.incident_banner()`.execute(this.#db);
    const row = rows[0];
    return row === undefined
      ? null
      : { message: row.message, severity: row.severity, setAt: row.set_at };
  }

  /** A console action (PLAT-2): IDs, names of flags and modules, and counts only. */
  async audit(
    userId: string,
    event: ConsoleAudit,
    now: Date,
    within?: TenantContext,
  ): Promise<void> {
    await this.#run(within, (db) => this.#audit(db, userId, event, now));
  }

  async #audit(db: Kysely<MainDb>, userId: string, event: ConsoleAudit, now: Date) {
    await sql`
      SELECT app.console_audit(${userId}::uuid, ${event.action},
                               ${event.workspaceId ?? null}::uuid,
                               ${JSON.stringify(event.params ?? {})}::jsonb,
                               ${event.ip ?? null}::inet, ${now})`.execute(db);
  }

  /** On the pool, or inside the open transaction `within` is bound to. */
  #run<T>(within: TenantContext | undefined, fn: (db: Kysely<MainDb>) => Promise<T>): Promise<T> {
    return within === undefined ? fn(this.#db) : withTenantTransaction(this.#db, within, fn);
  }

  /** Usage rows between two provider days, inclusive (`YYYY-MM-DD`). */
  async apiUsage(userId: string, from: string, to: string): Promise<ApiUsageRow[]> {
    const { rows } = await sql<{
      workspace_id: string;
      channel_account_id: string;
      provider: string;
      api: string;
      day: string;
      calls: string;
      cap: string | null;
    }>`
      SELECT workspace_id, channel_account_id, provider, api, to_char(day, 'YYYY-MM-DD') AS day,
             calls, cap
        FROM app.console_api_usage(${userId}::uuid, ${from}::date, ${to}::date)`.execute(this.#db);
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      channelAccountId: r.channel_account_id,
      provider: r.provider,
      api: r.api,
      day: r.day,
      calls: num(r.calls),
      cap: r.cap === null ? null : Number(r.cap),
    }));
  }

  /** The maintenance switch (SAFE-3): on, every outbound write of every workspace waits. */
  async maintenance(userId: string): Promise<{ on: boolean; updatedAt: Date | null }> {
    const row = (await this.#settings(userId)).find((s) => s.key === 'maintenance');
    return { on: row?.value === true, updatedAt: row?.updated_at ?? null };
  }

  /** Sets the maintenance switch and writes its audit row in one transaction. */
  async setMaintenance(userId: string, on: boolean, now: Date, audit: ConsoleAudit): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await sql`SELECT app.console_set_setting(${userId}::uuid, 'maintenance',
                                               ${JSON.stringify(on)}::jsonb, ${now})`.execute(trx);
      await this.#audit(trx, userId, audit, now);
    });
  }

  /** RL-5: usage rows since `from`, each with the time its last call was counted. */
  async liveUsage(userId: string, from: string): Promise<(ApiUsageRow & { updatedAt: Date })[]> {
    const { rows } = await sql<{
      workspace_id: string;
      channel_account_id: string;
      provider: string;
      api: string;
      day: string;
      calls: string;
      cap: string | null;
      updated_at: Date;
    }>`
      SELECT workspace_id, channel_account_id, provider, api, to_char(day, 'YYYY-MM-DD') AS day,
             calls, cap, updated_at
        FROM app.console_api_usage_live(${userId}::uuid, ${from}::date)`.execute(this.#db);
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      channelAccountId: r.channel_account_id,
      provider: r.provider,
      api: r.api,
      day: r.day,
      calls: num(r.calls),
      cap: r.cap === null ? null : Number(r.cap),
      updatedAt: r.updated_at,
    }));
  }

  /** EBAY-8: eBay's app-wide daily budget per API, since `from`. */
  async ebayBudget(
    userId: string,
    from: string,
  ): Promise<{ api: string; day: string; calls: number; cap: number }[]> {
    const { rows } = await sql<{ api: string; day: string; calls: string; cap: string }>`
      SELECT api, to_char(day, 'YYYY-MM-DD') AS day, calls, cap
        FROM app.console_ebay_budget(${userId}::uuid, ${from}::date)`.execute(this.#db);
    return rows.map((r) => ({ api: r.api, day: r.day, calls: num(r.calls), cap: Number(r.cap) }));
  }

  async credentialExpiry(userId: string, until: Date): Promise<CredentialExpiryRow[]> {
    const { rows } = await sql<{
      workspace_id: string;
      channel_account_id: string | null;
      kind: string;
      slot: 'current' | 'next';
      expires_at: Date;
    }>`SELECT * FROM app.console_credential_expiry(${userId}::uuid, ${until})`.execute(this.#db);
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      channelAccountId: r.channel_account_id,
      kind: r.kind,
      slot: r.slot,
      expiresAt: r.expires_at,
    }));
  }

  /** The job records behind dead-lettered jobs: state, attempt and error code (at most 500). */
  async jobRecords(userId: string, keys: readonly JobRecordKey[]): Promise<ConsoleJobRecord[]> {
    if (keys.length === 0) return [];
    const json = JSON.stringify(
      keys.map((k) => ({ w: k.workspaceId, t: k.type, k: k.idempotencyKey })),
    );
    const { rows } = await sql<{
      workspace_id: string;
      type: string;
      idempotency_key: string;
      state: string;
      attempt: string;
      error_code: string | null;
      updated_at: Date;
    }>`SELECT * FROM app.console_job_records(${userId}::uuid, ${json}::jsonb)`.execute(this.#db);
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      type: r.type,
      idempotencyKey: r.idempotency_key,
      state: r.state,
      attempt: num(r.attempt),
      errorCode: r.error_code,
      updatedAt: r.updated_at,
    }));
  }

  async #settings(userId: string) {
    const { rows } = await sql<{ key: string; value: unknown; updated_at: Date }>`
      SELECT * FROM app.console_settings(${userId}::uuid)`.execute(this.#db);
    return rows;
  }
}

/** The worker's side (ob_worker): retention, the daily digest and workspace closure. */
export class PlatformHousekeeping {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** ADR-071 4a: hard-deletes the workspace's notifications resolved before `cutoff`. */
  async purgeNotifications(ctx: TenantContext, cutoff: Date): Promise<number> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ n: string }>`
        SELECT app.notification_purge_resolved(${cutoff}) AS n`.execute(trx);
      return num(rows[0]?.n ?? 0);
    });
  }

  /** The same for platform notices, which have no workspace. */
  async purgePlatformNotices(cutoff: Date): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT app.platform_notice_purge_resolved(${cutoff}) AS n`.execute(this.#db);
    return num(rows[0]?.n ?? 0);
  }

  /** OPS-6: counts since `since`, and credentials expiring before `until`. */
  async digestCounts(since: Date, until: Date): Promise<DigestCounts> {
    const { rows } = await sql<{
      jobs_failed: string;
      api_calls: string;
      api_capped_calls: string;
      api_cap: string;
      credentials_expiring: string;
      deletion_runs: string;
      records_deleted: string;
    }>`SELECT * FROM app.platform_digest_counts(${since}, ${until})`.execute(this.#db);
    const r = rows[0];
    return {
      jobsFailed: num(r?.jobs_failed ?? 0),
      apiCalls: num(r?.api_calls ?? 0),
      apiCappedCalls: num(r?.api_capped_calls ?? 0),
      apiCap: num(r?.api_cap ?? 0),
      credentialsExpiring: num(r?.credentials_expiring ?? 0),
      deletionRuns: num(r?.deletion_runs ?? 0),
      recordsDeleted: num(r?.records_deleted ?? 0),
    };
  }

  /** Platform admins not yet sent the digest of `day` (`YYYY-MM-DD`). */
  async digestRecipients(day: string): Promise<DigestRecipient[]> {
    const { rows } = await sql<{ user_id: string; email: string; name: string }>`
      SELECT * FROM app.platform_digest_recipients(${day}::date)`.execute(this.#db);
    return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name }));
  }

  async digestSent(day: string, userId: string, now: Date): Promise<void> {
    await sql`SELECT app.platform_digest_sent(${day}::date, ${userId}::uuid, ${now})`.execute(
      this.#db,
    );
  }

  /**
   * ADR-058b at closure: deletes the terms of each person who belongs to no workspace any more,
   * in the closure's own transaction; returns how many people that was.
   */
  async deleteUnattachedTerms(ctx: TenantContext, userIds: readonly string[]): Promise<number> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      let people = 0;
      for (const userId of userIds) {
        const { rows } = await sql<{ n: string | null }>`
          SELECT app.user_terms_delete_if_unattached(${userId}::uuid) AS n`.execute(trx);
        if (rows[0]?.n != null) people += 1;
      }
      return people;
    });
  }

  /** Removes every membership of the (archived) workspace; returns the people removed. */
  async closeMembers(ctx: TenantContext): Promise<string[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ user_id: string }>`
        SELECT user_id FROM app.workspace_close_members() AS user_id`.execute(trx);
      return rows.map((r) => r.user_id);
    });
  }
}
