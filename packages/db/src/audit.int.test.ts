import { randomUUID } from 'node:crypto';
import { AuditValueRejected, type TenantContext } from '@omnibridge/core';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditLog,
  AuditReasonRequired,
  createMainDb,
  isAuditCursor,
  MembershipRepository,
  migrateMain,
  Tenancy,
  UserRepository,
  WorkspaceRepository,
  type AuditCursor,
  type MainDbHandle,
} from './index.ts';

const ROLES = ['ob_owner', 'ob_app', 'ob_platform'] as const;
const SIX_YEARS_AGO_AND_A_DAY = "now() - interval '6 years 1 day'";

describe('append-only audit log (AUD-1, AUD-3, AUD-4)', () => {
  let cluster: RoleCluster;
  let main: MainDbHandle;
  let tenancy: Tenancy;
  let audit: AuditLog;
  const pools: pg.Pool[] = [];
  const raw = (role: string) => {
    const pool = new pg.Pool({ ...cluster.connection(role), max: 2 });
    pools.push(pool);
    return pool;
  };

  const A = randomUUID();
  const B = randomUUID();
  const adminA = randomUUID();
  const otherA = randomUUID();
  const ctxA = (): TenantContext => ({ workspaceId: A, companyIds: [], userId: adminA });
  const ctxB = (): TenantContext => ({ workspaceId: B, companyIds: [] });

  /** Runs SQL as `role` inside a transaction scoped to `workspace`, then rolls it back. */
  async function asRole<T extends pg.QueryResultRow>(
    role: string,
    workspace: string,
    text: string,
    values: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    const client = await raw(role).connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspace]);
      return await client.query<T>(text, values);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  /** Inserts an event as ob_owner with a chosen time: the only way to make an old row. */
  async function insertAged(workspace: string, when: string, action = 'auth.login') {
    const owner = raw('ob_owner');
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspace]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.audit_events (workspace_id, occurred_at, actor_kind, action, entity_type)
         VALUES ($1, ${when}, 'system', $2, 'user') RETURNING id`,
        [workspace, action],
      );
      await client.query('COMMIT');
      return rows[0]?.id ?? '';
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ROLES);
    await migrateMain(cluster.connection('ob_owner'));
    main = createMainDb({ ...cluster.connection('ob_app'), max: 4 });
    tenancy = new Tenancy(main.db);
    audit = new AuditLog(main.db);
    const workspaces = new WorkspaceRepository(main.db);
    const users = new UserRepository(main.db);
    const memberships = new MembershipRepository(main.db);
    for (const [ws, user] of [
      [A, adminA],
      [A, otherA],
      [B, randomUUID()],
    ] as const) {
      await tenancy.run({ workspaceId: ws, companyIds: [], userId: user }, async (ctx) => {
        if ((await workspaces.get(ctx)) === undefined) {
          await workspaces.create(ctx, { name: `Workspace ${ws.slice(0, 4)}` });
        }
        await users.create(ctx, { id: user, email: `${user}@example.test`, name: `User ${user}` });
        await memberships.add(ctx, { userId: user, role: 'admin' });
      });
    }
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    await main.destroy();
    await cluster.container.stop();
  });

  it('[AUD-1] records an event with its user, entity, values, reason and IP', async () => {
    const id = await audit.record(ctxA(), {
      action: 'vat_quarter.unlocked',
      actor: { kind: 'user', userId: adminA },
      entityId: 'q-2026-1',
      before: { period: '2026-Q1', company_id: 'c1' },
      after: { period: '2026-Q1', company_id: 'c2' },
      reason: 'Late Amazon fee to correct',
      ip: '192.0.2.10',
    });
    const page = await audit.list(ctxA(), { action: 'vat_quarter.unlocked' }, { limit: 10 });
    expect(page.items).toEqual([
      expect.objectContaining({
        id,
        actorKind: 'user',
        userId: adminA,
        userName: `User ${adminA}`,
        action: 'vat_quarter.unlocked',
        entityType: 'vat_quarter',
        entityId: 'q-2026-1',
        // Only the field that changed (AUD-1 before/after for edits).
        before: { company_id: 'c1' },
        after: { company_id: 'c2' },
        reason: 'Late Amazon fee to correct',
        ip: '192.0.2.10',
      }),
    ]);
    const occurred = page.items[0]?.occurredAt;
    expect(occurred).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (occurred?.getTime() ?? 0))).toBeLessThan(60_000);
  });

  it('[AUD-1] UPDATE and DELETE on audit_event fail for ob_app', async () => {
    const id = await audit.record(ctxA(), {
      action: 'auth.login',
      actor: { kind: 'user', userId: adminA },
      entityId: adminA,
    });
    await expect(
      asRole('ob_app', A, "UPDATE app.audit_events SET reason = 'x' WHERE id = $1", [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole('ob_app', A, 'DELETE FROM app.audit_events WHERE id = $1', [id]),
    ).rejects.toThrow(/permission denied/);
    await expect(asRole('ob_app', A, 'TRUNCATE app.audit_events')).rejects.toThrow(
      /permission denied/,
    );
    // The purge flag means nothing to ob_app: it still has no DELETE.
    await expect(
      asRole(
        'ob_app',
        A,
        "SELECT set_config('app.audit_purge', 'on', true); DELETE FROM app.audit_events",
      ),
    ).rejects.toThrow(/permission denied|cannot insert multiple commands/);
  });

  it('[AUD-1] even ob_owner cannot edit, delete or truncate an event', async () => {
    const id = await audit.record(ctxA(), {
      action: 'auth.login',
      actor: { kind: 'user', userId: adminA },
    });
    await expect(
      asRole('ob_owner', A, "UPDATE app.audit_events SET reason = 'x' WHERE id = $1", [id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      asRole('ob_owner', A, 'DELETE FROM app.audit_events WHERE id = $1', [id]),
    ).rejects.toThrow(/append-only/);
    await expect(asRole('ob_owner', A, 'TRUNCATE app.audit_events')).rejects.toThrow(/append-only/);
    // Setting the purge flag by hand does not open recent rows.
    const client = await raw('ob_owner').connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [A]);
      await client.query("SELECT set_config('app.audit_purge', 'on', true)");
      await expect(
        client.query('DELETE FROM app.audit_events WHERE id = $1', [id]),
      ).rejects.toThrow(/append-only/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('[AUD-1] ob_app cannot choose the time or id of an event', async () => {
    for (const column of ['occurred_at', 'id']) {
      const value = column === 'occurred_at' ? "now() - interval '7 years'" : 'DEFAULT';
      const literal = column === 'id' ? `'${randomUUID()}'` : value;
      await expect(
        asRole(
          'ob_app',
          A,
          `INSERT INTO app.audit_events (workspace_id, ${column}, actor_kind, action, entity_type)
           VALUES ($1, ${literal}, 'system', 'auth.login', 'user')`,
          [A],
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('[AUD-1] the event commits and rolls back with the change it records', async () => {
    const entityId = randomUUID();
    await expect(
      tenancy.run(ctxA(), async (ctx) => {
        await audit.record(ctx, {
          action: 'user.role_changed',
          actor: { kind: 'user', userId: adminA },
          entityId,
          before: { role: 'member' },
          after: { role: 'admin' },
        });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect((await audit.list(ctxA(), { entityId }, { limit: 10 })).items).toEqual([]);
  });

  it('[AUD-3] PII marker in before/after is rejected', async () => {
    const entityId = randomUUID();
    await expect(
      audit.record(ctxA(), {
        action: 'connection.added',
        actor: { kind: 'user', userId: adminA },
        entityId,
        after: { provider: 'ebay', buyer_name: 'PIIMARK-Jane Doe' },
      }),
    ).rejects.toThrow(AuditValueRejected);
    await expect(
      audit.record(ctxA(), {
        action: 'connection.added',
        actor: { kind: 'user', userId: adminA },
        entityId,
        after: { provider: 'ebay', display_name: 'PIIMARK-jane@example.test' },
      }),
    ).rejects.toThrow(AuditValueRejected);
    await expect(
      audit.record(ctxA(), {
        action: 'auth.login',
        actor: { kind: 'user', userId: adminA },
        entityId,
        reason: 'PIIMARK-typed by mistake',
      }),
    ).rejects.toThrow(AuditValueRejected);
    expect((await audit.list(ctxA(), { entityId }, { limit: 10 })).items).toEqual([]);
    // Nothing anywhere in the table carries the marker.
    const { rows } = await asRole<{ n: string }>(
      'ob_owner',
      A,
      "SELECT count(*) AS n FROM app.audit_events WHERE concat(before, after, reason) LIKE '%PIIMARK-%'",
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('[AUD-1] an event that needs a typed reason is refused without one', async () => {
    await expect(
      audit.record(ctxA(), {
        action: 'vat_quarter.unlocked',
        actor: { kind: 'user', userId: adminA },
        entityId: 'q-2026-2',
      }),
    ).rejects.toThrow(AuditReasonRequired);
    await expect(
      audit.record(ctxA(), {
        action: 'vat_quarter.unlocked',
        actor: { kind: 'user', userId: adminA },
        entityId: 'q-2026-2',
        reason: '   ',
      }),
    ).rejects.toThrow(AuditReasonRequired);
  });

  it('[TEN-1] another workspace never sees the events', async () => {
    const entityId = randomUUID();
    await audit.record(ctxB(), { action: 'auth.login', actor: { kind: 'system' }, entityId });
    expect((await audit.list(ctxA(), { entityId }, { limit: 10 })).items).toEqual([]);
    expect((await audit.list(ctxB(), { entityId }, { limit: 10 })).items).toHaveLength(1);
  });

  it('[AUD-4] filters by user, action, entity and time, and pages by cursor', async () => {
    const entityId = randomUUID();
    for (const [user, action] of [
      [adminA, 'catalogue.changed'],
      [otherA, 'catalogue.changed'],
      [otherA, 'cogs.changed'],
    ] as const) {
      await audit.record(ctxA(), {
        action,
        actor: { kind: 'user', userId: user },
        entityId,
      });
    }
    const byUser = await audit.list(ctxA(), { entityId, userId: otherA }, { limit: 10 });
    expect(byUser.items.map((e) => e.action)).toEqual(['cogs.changed', 'catalogue.changed']);
    const byAction = await audit.list(
      ctxA(),
      { entityId, action: 'catalogue.changed', entityType: 'master_sku' },
      { limit: 10 },
    );
    expect(byAction.items).toHaveLength(2);
    const future = await audit.list(
      ctxA(),
      { entityId, from: new Date(Date.now() + 60_000) },
      { limit: 10 },
    );
    expect(future.items).toEqual([]);
    const past = await audit.list(
      ctxA(),
      { entityId, to: new Date(Date.now() - 60_000) },
      {
        limit: 10,
      },
    );
    expect(past.items).toEqual([]);

    const first = await audit.list(ctxA(), { entityId }, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = await audit.list(
      ctxA(),
      { entityId },
      { limit: 2, after: first.next ?? undefined },
    );
    expect(second.items).toHaveLength(1);
    expect(second.next).toBeNull();
    const ids = [...first.items, ...second.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('[AUD-4] pages events of one transaction, which share a time, without gaps', async () => {
    // now() is the transaction's start, so all five events carry the same occurred_at: the
    // cursor must break the tie by id.
    const entityId = randomUUID();
    await tenancy.run(ctxA(), async (ctx) => {
      for (let i = 0; i < 5; i += 1) {
        await audit.record(ctx, {
          action: 'export.created',
          actor: { kind: 'user', userId: adminA },
          entityId,
          after: { kind: 'orders', row_count: i },
        });
      }
    });
    const seen: string[] = [];
    let after: AuditCursor | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await audit.list(ctxA(), { entityId }, { limit: 2, after });
      seen.push(...page.items.map((e) => e.id));
      if (page.next === null) break;
      expect(isAuditCursor(page.next)).toBe(true);
      after = page.next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    await expect(
      audit.list(ctxA(), {}, { limit: 2, after: { at: '2026-01-01', id: randomUUID() } }),
    ).rejects.toThrow(RangeError);
  });

  it('[AUD-3] retention deletes only events older than 6 years, in its own workspace', async () => {
    const oldA = await insertAged(A, SIX_YEARS_AGO_AND_A_DAY);
    const keptA = await insertAged(A, "now() - interval '5 years 11 months'");
    const oldB = await insertAged(B, SIX_YEARS_AGO_AND_A_DAY);

    const deleted = await audit.purgeExpired(ctxA());
    expect(deleted).toBe(1);
    const left = async (ws: string, id: string) =>
      (
        await asRole<{ n: string }>(
          'ob_owner',
          ws,
          'SELECT count(*) AS n FROM app.audit_events WHERE id = $1',
          [id],
        )
      ).rows[0]?.n;
    expect(await left(A, oldA)).toBe('0');
    expect(await left(A, keptA)).toBe('1');
    expect(await left(B, oldB)).toBe('1');
    // A second run finds nothing more.
    expect(await audit.purgeExpired(ctxA())).toBe(0);
  });
});
