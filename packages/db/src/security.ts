import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/**
 * What the security alerts read in one workspace (T-0503, SEC-12): counts and IDs from the audit
 * log and, through the 0032 definers, from the per-person auth events. Never a value of a record.
 */
export class SecuritySignals {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Exports (any kind, AUD-4 and DEL-5 included) per user since `since`. */
  async exportCounts(
    ctx: TenantContext,
    since: Date,
  ): Promise<{ userId: string; count: number }[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ user_id: string; n: string }>`
        SELECT user_id, count(*) AS n FROM app.audit_events
         WHERE workspace_id = ${ctx.workspaceId}
           AND action IN ('export.created', 'audit_log.exported')
           AND occurred_at >= ${since} AND user_id IS NOT NULL
         GROUP BY user_id ORDER BY user_id`.execute(trx);
      return rows.map((r) => ({ userId: r.user_id, count: Number(r.n) }));
    });
  }

  /**
   * Sign-ins since `since` from a network the user has not signed in from in the `lookbackDays`
   * before it (an IPv4 address, or an IPv6 /64). A user with no earlier sign-in here at all is
   * never reported: a first sign-in is not unusual (S1, 19 Nov 2026).
   */
  async newNetworkLogins(
    ctx: TenantContext,
    since: Date,
    lookbackDays: number,
  ): Promise<{ eventId: string; userId: string; at: Date }[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ id: string; user_id: string; occurred_at: Date }>`
        WITH logins AS (
          SELECT id, user_id, occurred_at,
                 CASE family(ip) WHEN 6 THEN set_masklen(ip, 64) ELSE set_masklen(ip, 32) END::cidr
                   AS net
            FROM app.audit_events
           WHERE workspace_id = ${ctx.workspaceId} AND action = 'auth.login'
             AND ip IS NOT NULL AND user_id IS NOT NULL
             -- Only what the comparison can use: the window and its look-back.
             AND occurred_at >= ${since}::timestamptz - make_interval(days => ${lookbackDays}))
        SELECT l.id, l.user_id, l.occurred_at
          FROM logins l
         WHERE l.occurred_at >= ${since}
           AND EXISTS (SELECT 1 FROM app.audit_events e
                        WHERE e.workspace_id = ${ctx.workspaceId} AND e.action = 'auth.login'
                          AND e.user_id = l.user_id
                          AND (e.occurred_at, e.id) < (l.occurred_at, l.id))
           AND NOT EXISTS (SELECT 1 FROM logins e
                            WHERE e.user_id = l.user_id
                              AND (e.occurred_at, e.id) < (l.occurred_at, l.id)
                              AND e.occurred_at >= l.occurred_at - make_interval(days => ${lookbackDays})
                              AND e.net = l.net)
         ORDER BY l.occurred_at, l.id`.execute(trx);
      return rows.map((r) => ({ eventId: r.id, userId: r.user_id, at: r.occurred_at }));
    });
  }

  /** Failed sign-ins per member since `since` (0032 definer; the worker only). */
  async loginFailures(
    ctx: TenantContext,
    since: Date,
  ): Promise<{ userId: string; failures: number }[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ user_id: string; failures: string }>`
        SELECT user_id, failures FROM app.security_login_failures(${since})`.execute(trx);
      return rows.map((r) => ({ userId: r.user_id, failures: Number(r.failures) }));
    });
  }

  /** Lockouts of members since `since` (0032 definer; the worker only). */
  async locks(
    ctx: TenantContext,
    since: Date,
  ): Promise<{ eventId: string; userId: string; at: Date }[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ event_id: string; user_id: string; occurred_at: Date }>`
        SELECT event_id, user_id, occurred_at FROM app.security_locks(${since})`.execute(trx);
      return rows.map((r) => ({ eventId: r.event_id, userId: r.user_id, at: r.occurred_at }));
    });
  }
}

/**
 * What the platform-level security rule reads (T-0507, SEC-12, ADR-076): console entries from a
 * new network, and failed sign-ins and lockouts of platform admins. No workspace: the worker's
 * own role calls the 0035 definers directly. IDs, times and counts only.
 */
export class PlatformSecuritySignals {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Console entries since `since` from a network unseen in `lookbackDays`; never a first one. */
  async newNetworkConsoleEntries(
    since: Date,
    lookbackDays: number,
  ): Promise<{ eventId: string; userId: string; at: Date }[]> {
    const { rows } = await sql<{ event_id: string; user_id: string; occurred_at: Date }>`
      SELECT event_id, user_id, occurred_at
        FROM app.security_platform_console_entries(${since}, ${lookbackDays}::int)`.execute(
      this.#db,
    );
    return rows.map((r) => ({ eventId: r.event_id, userId: r.user_id, at: r.occurred_at }));
  }

  /** Failed sign-ins per platform admin since `since`. */
  async loginFailures(since: Date): Promise<{ userId: string; failures: number }[]> {
    const { rows } = await sql<{ user_id: string; failures: string }>`
      SELECT user_id, failures FROM app.security_platform_login_failures(${since})`.execute(
      this.#db,
    );
    return rows.map((r) => ({ userId: r.user_id, failures: Number(r.failures) }));
  }

  /** Lockouts of platform admins since `since`, one per lock. */
  async locks(since: Date): Promise<{ eventId: string; userId: string; at: Date }[]> {
    const { rows } = await sql<{ event_id: string; user_id: string; occurred_at: Date }>`
      SELECT event_id, user_id, occurred_at FROM app.security_platform_locks(${since})`.execute(
      this.#db,
    );
    return rows.map((r) => ({ eventId: r.event_id, userId: r.user_id, at: r.occurred_at }));
  }
}
