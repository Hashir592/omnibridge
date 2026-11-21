import { randomUUID } from 'node:crypto';
import {
  emailDefaultOnTypes,
  isUuid,
  type CheckedRaise,
  type NotificationParams,
  type NotificationRecord,
  type NotificationSeverity,
  type NotificationSignal,
  type NotificationState,
  type NotificationStore,
  type RaiseResult,
  type TenantContext,
} from '@omnibridge/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/**
 * Notifications (T-0501, NTF-1, NTF-2, NTF-5; migration 0030). The store behind core's Notifier,
 * and the reads behind the bell: who sees a row is decided here and by RLS (PERM-3). Rows hold
 * IDs, counts and codes only (invariant 7).
 */

/** Whose bell: the signed-in member and their ticked tabs (`all` for an admin). */
export interface NotificationViewer {
  userId: string;
  tabs: readonly string[] | 'all';
}

export interface Notification {
  id: string;
  type: string;
  severity: NotificationSeverity;
  signal: NotificationSignal | null;
  /** Null for a platform notice. */
  tab: string | null;
  companyId: string | null;
  channelAccountId: string | null;
  record: NotificationRecord;
  params: NotificationParams;
  state: NotificationState;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export interface NotificationFilter {
  state?: NotificationState | undefined;
  severity?: NotificationSeverity | undefined;
}

/** Where a page ends: the last row's exact update time (microseconds, UTC) and id. */
export interface NotificationCursor {
  at: string;
  id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function isNotificationCursor(cursor: NotificationCursor): boolean {
  return CURSOR_AT.test(cursor.at) && isUuid(cursor.id);
}

interface Row {
  id: string;
  type: string;
  severity: NotificationSeverity;
  signal: NotificationSignal | null;
  tab: string | null;
  company_id: string | null;
  channel_account_id: string | null;
  record_kind: string;
  record_id: string;
  params: NotificationParams;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  read: boolean;
  cursor_at: string;
}

const toNotification = (r: Row): Notification => ({
  id: r.id,
  type: r.type,
  severity: r.severity,
  signal: r.signal,
  tab: r.tab,
  companyId: r.company_id,
  channelAccountId: r.channel_account_id,
  record: { kind: r.record_kind, id: r.record_id },
  params: r.params,
  state: r.resolved_at !== null ? 'resolved' : r.read ? 'read' : 'unread',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  resolvedAt: r.resolved_at,
});

type Page = { items: Notification[]; next: NotificationCursor | null };

function pageOf(rows: Row[], limit: number): Page {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toNotification),
    next: rows.length > limit && last !== undefined ? { at: last.cursor_at, id: last.id } : null,
  };
}

const CURSOR_SQL = (col: string) =>
  sql<string>`to_char(${sql.ref(col)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The rows a member may see: a child only those of a ticked tab (RLS adds the companies). */
function visible(viewer: NotificationViewer) {
  return viewer.tabs === 'all'
    ? sql<boolean>`true`
    : sql<boolean>`n.tab = ANY (${[...viewer.tabs]}::text[])`;
}

const READ_SQL = sql<boolean>`(r.version IS NOT NULL AND r.version >= n.version)`;

function stateSql(state: NotificationState | undefined) {
  switch (state) {
    case undefined:
      return sql<boolean>`true`;
    case 'resolved':
      return sql<boolean>`n.resolved_at IS NOT NULL`;
    case 'read':
      return sql<boolean>`n.resolved_at IS NULL AND ${READ_SQL}`;
    case 'unread':
      return sql<boolean>`n.resolved_at IS NULL AND NOT ${READ_SQL}`;
  }
}

interface RaiseRow {
  id: string;
  version: string;
  created: boolean;
  escalated: boolean;
  reopened: boolean;
}

const toResult = (r: RaiseRow): RaiseResult => ({
  id: r.id,
  version: Number(r.version),
  created: r.created,
  escalated: r.escalated,
  reopened: r.reopened,
});

export class NotificationRepository implements NotificationStore {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /**
   * NTF-5: one row per (type, record) in the workspace, updated in place. A severity rise or a
   * reopen bumps the version, so the notification is unread again for everyone.
   */
  async raise(ctx: TenantContext, raise: CheckedRaise, now: Date): Promise<RaiseResult> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<RaiseRow>`
        INSERT INTO app.notifications AS n
               (workspace_id, id, type, severity, signal, tab, company_id, channel_account_id,
                record_kind, record_id, params, created_at, updated_at)
        VALUES (${ctx.workspaceId}, ${randomUUID()}, ${raise.type.code}, ${raise.severity},
                ${raise.signal}, ${raise.type.tab ?? null}, ${raise.companyId},
                ${raise.channelAccountId}, ${raise.record.kind}, ${raise.record.id},
                ${JSON.stringify(raise.params)}::jsonb, ${now}, ${now})
        ON CONFLICT (workspace_id, type, record_kind, record_id) DO UPDATE
          SET severity = excluded.severity,
              signal = excluded.signal,
              company_id = excluded.company_id,
              channel_account_id = excluded.channel_account_id,
              params = excluded.params,
              updated_at = excluded.updated_at,
              resolved_at = NULL,
              version = n.version + CASE
                WHEN n.resolved_at IS NOT NULL
                  OR app.notification_severity_rank(excluded.severity)
                     > app.notification_severity_rank(n.severity) THEN 1
                ELSE 0 END
        RETURNING new.id, new.version, old.id IS NULL AS created,
                  (old.id IS NOT NULL AND app.notification_severity_rank(new.severity)
                                          > app.notification_severity_rank(old.severity))
                    AS escalated,
                  coalesce(old.resolved_at IS NOT NULL, false) AS reopened`.execute(trx);
      const row = rows[0];
      if (row === undefined) throw new Error('notification raise returned no row');
      return toResult(row);
    });
  }

  /** NTF-1: the condition cleared. False when no open notification matched. */
  async resolve(
    ctx: TenantContext,
    type: string,
    record: NotificationRecord,
    now: Date,
  ): Promise<boolean> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const res = await trx
        .updateTable('app.notifications')
        .set({ resolved_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('type', '=', type)
        .where('record_kind', '=', record.kind)
        .where('record_id', '=', record.id)
        .where('resolved_at', 'is', null)
        .executeTakeFirst();
      return res.numUpdatedRows > 0n;
    });
  }

  /** One page, newest change first. */
  async list(
    ctx: TenantContext,
    viewer: NotificationViewer,
    filter: NotificationFilter,
    page: { limit: number; after?: NotificationCursor | undefined },
  ): Promise<Page> {
    const after = page.after;
    if (after !== undefined && !isNotificationCursor(after)) {
      throw new RangeError('The notification cursor is not valid');
    }
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<Row>`
        SELECT n.id, n.type, n.severity, n.signal, n.tab, n.company_id, n.channel_account_id,
               n.record_kind, n.record_id, n.params, n.created_at, n.updated_at, n.resolved_at,
               ${READ_SQL} AS read, ${CURSOR_SQL('n.updated_at')} AS cursor_at
          FROM app.notifications n
          LEFT JOIN app.notification_reads r
            ON r.workspace_id = n.workspace_id AND r.notification_id = n.id
           AND r.user_id = ${viewer.userId}
         WHERE n.workspace_id = ${ctx.workspaceId}
           AND ${visible(viewer)}
           AND ${stateSql(filter.state)}
           AND (${filter.severity ?? null}::text IS NULL OR n.severity = ${filter.severity ?? null})
           AND (${after?.at ?? null}::timestamptz IS NULL
                OR (n.updated_at, n.id) < (${after?.at ?? null}::timestamptz,
                                           ${after?.id ?? null}::uuid))
         ORDER BY n.updated_at DESC, n.id DESC
         LIMIT ${page.limit + 1}`.execute(trx);
      return pageOf(rows, page.limit);
    });
  }

  /** Open notifications this member has not read at their current version. */
  async unreadCount(ctx: TenantContext, viewer: NotificationViewer): Promise<number> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n
          FROM app.notifications n
          LEFT JOIN app.notification_reads r
            ON r.workspace_id = n.workspace_id AND r.notification_id = n.id
           AND r.user_id = ${viewer.userId}
         WHERE n.workspace_id = ${ctx.workspaceId}
           AND ${visible(viewer)}
           AND ${stateSql('unread')}`.execute(trx);
      return Number(rows[0]?.n ?? 0);
    });
  }

  /**
   * Marks one notification (`id`), or with null every open one, read at its current version.
   * Only rows the member can see; returns how many were marked (0: not found or not visible).
   */
  async markRead(
    ctx: TenantContext,
    viewer: NotificationViewer,
    id: string | null,
    now: Date,
  ): Promise<number> {
    return withTenantTransaction(this.#db, ctx, async (trx) =>
      this.#mark(trx, ctx, viewer, id, now),
    );
  }

  async #mark(
    trx: Transaction<MainDb>,
    ctx: TenantContext,
    viewer: NotificationViewer,
    id: string | null,
    now: Date,
  ): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      WITH marked AS (
        INSERT INTO app.notification_reads AS r (workspace_id, notification_id, user_id, version,
                                                 read_at)
        SELECT n.workspace_id, n.id, ${viewer.userId}, n.version, ${now}
          FROM app.notifications n
         WHERE n.workspace_id = ${ctx.workspaceId}
           AND ${visible(viewer)}
           AND (${id}::uuid IS NULL OR n.id = ${id}::uuid)
           AND (${id}::uuid IS NOT NULL OR n.resolved_at IS NULL)
        ON CONFLICT (workspace_id, notification_id, user_id) DO UPDATE
          SET version = excluded.version, read_at = excluded.read_at
        RETURNING 1)
      SELECT count(*) AS n FROM marked`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  }

  // Platform-level notices (NTF-2): only through the 0030 definer functions.

  async raisePlatform(
    ctx: TenantContext | null,
    raise: CheckedRaise,
    now: Date,
  ): Promise<RaiseResult> {
    const run = async (db: Kysely<MainDb>) => {
      const { rows } = await sql<RaiseRow>`
        SELECT id, version, created, escalated, reopened
          FROM app.platform_notice_raise(${raise.type.code}, ${raise.severity}, ${raise.signal},
                                         ${raise.record.kind}, ${raise.record.id},
                                         ${JSON.stringify(raise.params)}::jsonb, ${now})`.execute(
        db,
      );
      const row = rows[0];
      if (row === undefined) throw new Error('platform notice raise returned no row');
      return toResult(row);
    };
    return ctx === null ? run(this.#db) : withTenantTransaction(this.#db, ctx, run);
  }

  async resolvePlatform(
    ctx: TenantContext | null,
    type: string,
    record: NotificationRecord,
    now: Date,
  ): Promise<boolean> {
    const run = async (db: Kysely<MainDb>) => {
      const { rows } = await sql<{ done: boolean }>`
        SELECT app.platform_notice_resolve(${type}, ${record.kind}, ${record.id}, ${now}) AS done`.execute(
        db,
      );
      return rows[0]?.done === true;
    };
    return ctx === null ? run(this.#db) : withTenantTransaction(this.#db, ctx, run);
  }

  /** A platform admin's notices; nothing for anyone else (checked in the database). */
  async listPlatform(
    userId: string,
    filter: NotificationFilter,
    page: { limit: number; after?: NotificationCursor | undefined },
  ): Promise<Page> {
    const after = page.after;
    if (after !== undefined && !isNotificationCursor(after)) {
      throw new RangeError('The notification cursor is not valid');
    }
    const { rows } = await sql<Row>`
      SELECT id, type, severity, signal, NULL::text AS tab, NULL::uuid AS company_id,
             NULL::uuid AS channel_account_id, record_kind, record_id, params, created_at,
             updated_at, resolved_at, read, ${CURSOR_SQL('updated_at')} AS cursor_at
        FROM app.platform_notice_list(${userId}, ${filter.state ?? null}, ${filter.severity ?? null},
                                      ${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid,
                                      ${page.limit + 1})`.execute(this.#db);
    return pageOf(rows, page.limit);
  }

  async platformUnreadCount(userId: string): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT app.platform_notice_unread_count(${userId}) AS n`.execute(this.#db);
    return Number(rows[0]?.n ?? 0);
  }

  /** One notice (`id`) or, with null, every open one; returns how many were marked. */
  async markPlatformRead(userId: string, id: string | null, now: Date): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT app.platform_notice_mark_read(${userId}, ${id}::uuid, ${now}) AS n`.execute(this.#db);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Open platform notices of a type and record kind, by record ID (0035 definer; the worker); with
   * `raisedBefore`, only older ones.
   */
  async openPlatformRecordIds(type: string, kind: string, raisedBefore?: Date): Promise<string[]> {
    const { rows } = await (
      raisedBefore === undefined
        ? sql<{ id: string }>`
          SELECT app.platform_notice_open_records(${type}, ${kind}) AS id`
        : sql<{ id: string }>`
          SELECT app.platform_notice_open_records_before(${type}, ${kind}, ${raisedBefore}) AS id`
    ).execute(this.#db);
    return rows.map((r) => r.id);
  }

  /** Open notices of a type and record kind; with `raisedBefore`, only those raised before it. */
  async openRecordIds(
    ctx: TenantContext,
    type: string,
    kind: string,
    raisedBefore?: Date,
  ): Promise<string[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      let q = trx
        .selectFrom('app.notifications')
        .select('record_id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('type', '=', type)
        .where('record_kind', '=', kind)
        .where('resolved_at', 'is', null);
      if (raisedBefore !== undefined) q = q.where('created_at', '<', raisedBefore);
      return (await q.execute()).map((r) => r.record_id);
    });
  }

  // Email (T-0502: NTF-3, NTF-4). One job per recipient; a sent record per notification version.

  /** Who gets an email about this notification now (0031 definer: admins always for critical). */
  async emailRecipients(ctx: TenantContext, id: string): Promise<string[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ user_id: string }>`
        SELECT user_id
          FROM app.notification_email_recipients(${id}::uuid, ${emailDefaultOnTypes()}::text[])`.execute(
        trx,
      );
      return rows.map((r) => r.user_id);
    });
  }

  /** The user's own choices; a type with no row takes its default. */
  async emailPreferences(ctx: TenantContext, userId: string): Promise<Map<string, boolean>> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ type: string; email: boolean }>`
        SELECT type, email FROM app.notification_email_prefs
         WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${userId}`.execute(trx);
      return new Map(rows.map((r) => [r.type, r.email]));
    });
  }

  async setEmailPreferences(
    ctx: TenantContext,
    userId: string,
    prefs: readonly { type: string; email: boolean }[],
    now: Date,
  ): Promise<void> {
    if (prefs.length === 0) return;
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`
        INSERT INTO app.notification_email_prefs (workspace_id, user_id, type, email, updated_at)
        SELECT ${ctx.workspaceId}, ${userId}, p.type, p.email, ${now}
          FROM unnest(${prefs.map((p) => p.type)}::text[], ${prefs.map((p) => p.email)}::boolean[])
               AS p(type, email)
        ON CONFLICT (workspace_id, user_id, type) DO UPDATE
          SET email = excluded.email, updated_at = excluded.updated_at`.execute(trx);
    });
  }

  /**
   * What an email job needs, read just before it sends: the notification as it is now, the
   * recipient's address, whether they still get it, and whether it was already sent.
   */
  async emailJob(
    ctx: TenantContext,
    input: { notificationId: string; userId: string; version: number },
  ): Promise<EmailJobView | undefined> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{
        type: string;
        severity: NotificationSeverity;
        version: string;
        resolved: boolean;
        company_name: string | null;
        email: string;
        name: string;
        recipient: boolean;
        sent: boolean;
      }>`
        SELECT n.type, n.severity, n.version, n.resolved_at IS NOT NULL AS resolved,
               c.trading_name AS company_name, u.email, u.name,
               EXISTS (SELECT 1
                         FROM app.notification_email_recipients(n.id, ${emailDefaultOnTypes()}::text[]) x
                        WHERE x.user_id = u.id) AS recipient,
               EXISTS (SELECT 1 FROM app.notification_emails e
                        WHERE e.workspace_id = n.workspace_id AND e.notification_id = n.id
                          AND e.user_id = u.id AND e.version = ${input.version}) AS sent
          FROM app.notifications n
          JOIN app.users u ON u.id = ${input.userId}::uuid
          LEFT JOIN app.companies c ON c.workspace_id = n.workspace_id AND c.id = n.company_id
         WHERE n.workspace_id = ${ctx.workspaceId} AND n.id = ${input.notificationId}::uuid`.execute(
        trx,
      );
      const r = rows[0];
      if (r === undefined) return undefined;
      return {
        type: r.type,
        severity: r.severity,
        version: Number(r.version),
        resolved: r.resolved,
        companyName: r.company_name,
        email: r.email,
        name: r.name,
        recipient: r.recipient,
        sent: r.sent,
      };
    });
  }

  async recordEmailSent(
    ctx: TenantContext,
    input: { notificationId: string; userId: string; version: number },
    now: Date,
  ): Promise<void> {
    await withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`
        INSERT INTO app.notification_emails (workspace_id, notification_id, user_id, version, sent_at)
        VALUES (${ctx.workspaceId}, ${input.notificationId}, ${input.userId}, ${input.version},
                ${now})
        ON CONFLICT DO NOTHING`.execute(trx);
    });
  }

  /** Critical platform notices still to email, one row per notice and platform admin (worker). */
  async pendingPlatformEmails(limit: number): Promise<PlatformEmail[]> {
    const { rows } = await sql<{
      notification_id: string;
      version: string;
      type: string;
      severity: NotificationSeverity;
      user_id: string;
      email: string;
      name: string;
    }>`SELECT * FROM app.platform_notice_pending_emails(${limit})`.execute(this.#db);
    return rows.map((r) => ({
      notificationId: r.notification_id,
      version: Number(r.version),
      type: r.type,
      severity: r.severity,
      userId: r.user_id,
      email: r.email,
      name: r.name,
    }));
  }

  async platformEmailSent(input: PlatformEmail, now: Date): Promise<void> {
    await sql`
      SELECT app.platform_notice_email_sent(${input.notificationId}::uuid, ${input.userId}::uuid,
                                            ${input.version}, ${now})`.execute(this.#db);
  }
}

export interface EmailJobView {
  type: string;
  severity: NotificationSeverity;
  version: number;
  resolved: boolean;
  /** The company's trading name (business data, never buyer PII); null when workspace-wide. */
  companyName: string | null;
  email: string;
  name: string;
  /** Still a recipient now (preference, ticks, role). */
  recipient: boolean;
  /** Already sent for this version. */
  sent: boolean;
}

export interface PlatformEmail {
  notificationId: string;
  version: number;
  type: string;
  severity: NotificationSeverity;
  userId: string;
  email: string;
  name: string;
}
