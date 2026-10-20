import { isIP } from 'node:net';
import {
  AUDIT_EVENTS,
  auditDiff,
  AuditValueRejected,
  isUuid,
  PII_MARKER,
  type AuditAction,
  type AuditValues,
  type TenantContext,
} from '@omnibridge/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AuditActorKind, MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/** Who did it: a signed-in user, a platform operator, or the system (a job). */
export type AuditActor =
  { kind: 'user'; userId: string } | { kind: 'platform'; userId: string } | { kind: 'system' };

export interface NewAuditEvent {
  action: AuditAction;
  actor: AuditActor;
  /** The entity's id; its type comes from the catalogue. */
  entityId?: string | null;
  /** Raw values: only the catalogue's fields are allowed, and only changes are kept (AUD-3). */
  before?: Readonly<Record<string, unknown>> | null;
  after?: Readonly<Record<string, unknown>> | null;
  /** The typed reason, where the catalogue requires one (AUD-1). */
  reason?: string;
  /** The caller's address, for events from a request. */
  ip?: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: Date;
  actorKind: AuditActorKind;
  userId: string | null;
  /** The user's current name, when they are still a member this context can see. */
  userName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: AuditValues | null;
  after: AuditValues | null;
  reason: string | null;
  ip: string | null;
}

export interface AuditFilter {
  userId?: string;
  action?: AuditAction;
  entityType?: string;
  entityId?: string;
  /** Inclusive lower bound on occurred_at. */
  from?: Date;
  /** Exclusive upper bound on occurred_at. */
  to?: Date;
}

/** The catalogue requires a typed reason for this event (AUD-1). */
export class AuditReasonRequired extends Error {
  constructor(action: string) {
    super(`Audit event ${action} needs a typed reason`);
    this.name = 'AuditReasonRequired';
  }
}

/**
 * Where a page of the list ends: the last event's exact time (microseconds, UTC) and id. It names
 * only an event of the caller's own workspace, never a position shared with other workspaces.
 */
export interface AuditCursor {
  at: string;
  id: string;
}

const MAX_REASON = 500;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** True when `cursor` has the shape `list` hands out. */
export function isAuditCursor(cursor: AuditCursor): boolean {
  return CURSOR_AT.test(cursor.at) && isUuid(cursor.id);
}

type Row = {
  id: string;
  cursor_at: string;
  occurred_at: Date;
  actor_kind: AuditActorKind;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: AuditValues | null;
  after: AuditValues | null;
  reason: string | null;
  ip: string | null;
};

function toEvent(row: Row): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorKind: row.actor_kind,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before,
    after: row.after,
    reason: row.reason,
    ip: row.ip,
  };
}

/**
 * app.audit_events (AUD-1 to AUD-4): written once, never edited or deleted. Record an event with
 * the same context as the change it describes: with a context from `Tenancy` it joins that
 * transaction, so the event and the change commit or roll back together.
 */
export class AuditLog {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /**
   * Writes one event and returns its id. Throws AuditValueRejected for a field outside the
   * catalogue or a value that carries PII (AUD-3), and AuditReasonRequired when the catalogue
   * needs a typed reason. Before/after values are never logged anywhere else.
   */
  async record(ctx: TenantContext, event: NewAuditEvent): Promise<string> {
    const spec = AUDIT_EVENTS[event.action];
    const { before, after } = auditDiff(event.action, event.before ?? null, event.after ?? null);
    const reason = event.reason?.trim() ?? '';
    if (spec.reasonRequired && reason === '') throw new AuditReasonRequired(event.action);
    if (reason.length > MAX_REASON) {
      throw new AuditValueRejected(event.action, 'reason', 'is too long');
    }
    if (reason.includes(PII_MARKER)) {
      throw new AuditValueRejected(event.action, 'reason', 'carries PII');
    }
    if (event.ip !== undefined && isIP(event.ip) === 0) {
      throw new AuditValueRejected(event.action, 'ip', 'is not an IP address');
    }
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .insertInto('app.audit_events')
        .values({
          workspace_id: ctx.workspaceId,
          actor_kind: event.actor.kind,
          user_id: event.actor.kind === 'system' ? null : event.actor.userId,
          action: event.action,
          entity_type: spec.entityType,
          entity_id: event.entityId ?? null,
          before: before === null ? null : JSON.stringify(before),
          after: after === null ? null : JSON.stringify(after),
          reason: reason === '' ? null : reason,
          ip: event.ip ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  /**
   * One page of events, newest first. `after` is the `next` value of the previous page; `next`
   * is null on the last page.
   */
  async list(
    ctx: TenantContext,
    filter: AuditFilter,
    page: { limit: number; after?: AuditCursor | undefined },
  ): Promise<{ items: AuditEvent[]; next: AuditCursor | null }> {
    const after = page.after;
    if (after !== undefined && !isAuditCursor(after)) {
      throw new RangeError('The audit cursor is not valid');
    }
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      let query = this.#select(trx, filter);
      if (after !== undefined) {
        query = query.where(
          sql<boolean>`(e.occurred_at, e.id) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        );
      }
      const rows = await query.limit(page.limit + 1).execute();
      const items = rows.slice(0, page.limit);
      const last = items.at(-1);
      return {
        items: items.map(toEvent),
        next:
          rows.length > page.limit && last !== undefined
            ? { at: last.cursor_at, id: last.id }
            : null,
      };
    });
  }

  /**
   * Retention (AUD-3): deletes the context's events older than 6 years, through the one
   * SECURITY DEFINER function allowed to (migration 0010). Returns how many went.
   */
  async purgeExpired(ctx: TenantContext): Promise<number> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{
        deleted: string;
      }>`SELECT app.purge_audit_events() AS deleted`.execute(trx);
      return Number(rows[0]?.deleted ?? 0);
    });
  }

  #select(trx: Transaction<MainDb>, filter: AuditFilter) {
    let query = trx
      .selectFrom('app.audit_events as e')
      .leftJoin('app.users as u', 'u.id', 'e.user_id')
      .select([
        'e.id',
        // The exact time as text: a JS Date keeps milliseconds only, and the cursor needs all six
        // digits to page without skipping or repeating events.
        sql<string>`to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'cursor_at',
        ),
        'e.occurred_at',
        'e.actor_kind',
        'e.user_id',
        'u.name as user_name',
        'e.action',
        'e.entity_type',
        'e.entity_id',
        'e.before',
        'e.after',
        'e.reason',
        sql<string | null>`host(e.ip)`.as('ip'),
      ])
      .orderBy('e.occurred_at', 'desc')
      .orderBy('e.id', 'desc');
    if (filter.userId !== undefined) query = query.where('e.user_id', '=', filter.userId);
    if (filter.action !== undefined) query = query.where('e.action', '=', filter.action);
    if (filter.entityType !== undefined) {
      query = query.where('e.entity_type', '=', filter.entityType);
    }
    if (filter.entityId !== undefined) query = query.where('e.entity_id', '=', filter.entityId);
    if (filter.from !== undefined) query = query.where('e.occurred_at', '>=', filter.from);
    if (filter.to !== undefined) query = query.where('e.occurred_at', '<', filter.to);
    return query;
  }
}
