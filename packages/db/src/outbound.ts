import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@omnibridge/core';
import { sql, type Kysely } from 'kysely';
import type { ChannelProvider, MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

export type OutboundState = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
export type PauseReason = 'kill_switch' | 'maintenance';

export interface OutboundWrite {
  id: string;
  channelAccountId: string;
  provider: ChannelProvider;
  operation: string;
  urgent: boolean;
  payload: Record<string, unknown>;
  state: OutboundState;
  pausedReason: PauseReason | null;
  attempts: number;
  dispatchSeq: number;
  claimedAt: Date | null;
}

export interface NewOutboundWrite {
  channelAccountId: string;
  provider: ChannelProvider;
  operation: string;
  urgent: boolean;
  idempotencyKey: string;
  /** IDs, SKUs, numbers and pii_ref values only (invariant 7a). */
  payload: Record<string, unknown>;
}

/**
 * Automated provider writes (T-0702, app.outbound_writes): the intent row of invariant 3. A write
 * is inserted in its caller's transaction, then a job sends it; the switches are read just before
 * the send (invariant 20). Every call runs in the caller's tenant context.
 */
export class OutboundWriteRepository {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  /** Once per idempotency key: a repeat answers the first write's id. */
  insert(
    ctx: TenantContext,
    input: NewOutboundWrite,
    at: Date,
  ): Promise<{ id: string; created: boolean }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const id = randomUUID();
      const inserted = await trx
        .insertInto('app.outbound_writes')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          channel_account_id: input.channelAccountId,
          provider: input.provider,
          operation: input.operation,
          urgent: input.urgent,
          idempotency_key: input.idempotencyKey,
          payload: JSON.stringify(input.payload),
          created_at: at,
          updated_at: at,
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'idempotency_key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted !== undefined) return { id, created: true };
      const existing = await trx
        .selectFrom('app.outbound_writes')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirstOrThrow();
      return { id: existing.id, created: false };
    });
  }

  async get(ctx: TenantContext, id: string): Promise<OutboundWrite | undefined> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .selectFrom('app.outbound_writes')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (row === undefined) return undefined;
    return {
      id: row.id,
      channelAccountId: row.channel_account_id,
      provider: row.provider,
      operation: row.operation,
      urgent: row.urgent,
      payload: row.payload,
      state: row.state,
      pausedReason: row.paused_reason,
      attempts: Number(row.attempts),
      dispatchSeq: Number(row.dispatch_seq),
      claimedAt: row.claimed_at,
    };
  }

  /**
   * The two switches as they are now (SAFE-2, SAFE-3), read just before a send (invariant 20):
   * the platform's maintenance switch, and this account's kill switch.
   */
  gate(
    ctx: TenantContext,
    channelAccountId: string,
  ): Promise<{ maintenance: boolean; paused: boolean }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ maintenance: boolean }>`
        SELECT maintenance FROM app.maintenance_state()`.execute(trx);
      const account = await trx
        .selectFrom('app.channel_accounts')
        .select('paused_at')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', channelAccountId)
        .executeTakeFirst();
      return {
        maintenance: rows[0]?.maintenance === true,
        // An account this context cannot see is treated as paused: nothing is sent blind.
        paused: account === undefined || account.paused_at !== null,
      };
    });
  }

  /** Held by a switch: it waits, pending, and costs no attempt (SAFE-2, SAFE-3). */
  async pause(ctx: TenantContext, id: string, reason: PauseReason, at: Date): Promise<void> {
    await this.#update(ctx, id, {
      state: 'pending',
      paused_reason: reason,
      claimed_at: null,
      updated_at: at,
    });
  }

  /** The writes a switch is holding, oldest first. */
  pausedIds(
    ctx: TenantContext,
    filter: { channelAccountId?: string; reason: PauseReason },
  ): Promise<{ id: string; channelAccountId: string }[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      let q = trx
        .selectFrom('app.outbound_writes')
        .select(['id', 'channel_account_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('state', '=', 'pending')
        .where('paused_reason', '=', filter.reason);
      if (filter.channelAccountId !== undefined) {
        q = q.where('channel_account_id', '=', filter.channelAccountId);
      }
      const rows = await q.orderBy('created_at').orderBy('id').execute();
      return rows.map((r) => ({ id: r.id, channelAccountId: r.channel_account_id }));
    });
  }

  /** Released from a pause, to be sent again: answers the next dispatch number. */
  unpause(ctx: TenantContext, id: string, at: Date): Promise<number> {
    return this.#nextDispatch(ctx, id, at, { paused_reason: null, next_attempt_at: null });
  }

  /** Another dispatch of the same write (recovery): answers the next dispatch number. */
  redispatch(ctx: TenantContext, id: string, at: Date): Promise<number> {
    return this.#nextDispatch(ctx, id, at, { state: 'pending', claimed_at: null });
  }

  /** Takes it for sending; false when another worker has it or it is no longer pending. */
  async claim(ctx: TenantContext, id: string, at: Date): Promise<boolean> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.outbound_writes')
        .set({ state: 'sending', claimed_at: at, paused_reason: null, updated_at: at })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('state', '=', 'pending')
        .returning('id')
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  /**
   * Back to pending until `until`: a governor's wait (no attempt) or a failed send that may work
   * later (one attempt). Answers the next dispatch number and the attempts so far.
   */
  defer(
    ctx: TenantContext,
    id: string,
    input: { until: Date; attempted: boolean; at: Date; errorCode?: string },
  ): Promise<{ dispatchSeq: number; attempts: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const row = await trx
        .updateTable('app.outbound_writes')
        .set({
          state: 'pending',
          claimed_at: null,
          next_attempt_at: input.until,
          attempts: sql<number>`attempts + ${input.attempted ? 1 : 0}`,
          dispatch_seq: sql<number>`dispatch_seq + 1`,
          ...(input.errorCode === undefined ? {} : { last_error_code: input.errorCode }),
          updated_at: input.at,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returning(['dispatch_seq', 'attempts'])
        .executeTakeFirstOrThrow();
      return { dispatchSeq: Number(row.dispatch_seq), attempts: Number(row.attempts) };
    });
  }

  async sent(
    ctx: TenantContext,
    id: string,
    result: Record<string, unknown>,
    at: Date,
  ): Promise<void> {
    await this.#update(ctx, id, {
      state: 'sent',
      attempts: sql<number>`attempts + 1`,
      result: JSON.stringify(result),
      sent_at: at,
      claimed_at: null,
      updated_at: at,
    });
  }

  async fail(
    ctx: TenantContext,
    id: string,
    input: { code: string; attempted: boolean; at: Date },
  ): Promise<void> {
    await this.#update(ctx, id, {
      state: 'failed',
      attempts: sql<number>`attempts + ${input.attempted ? 1 : 0}`,
      last_error_code: input.code,
      claimed_at: null,
      updated_at: input.at,
    });
  }

  /**
   * The recovery sweep's work: writes a worker took but never finished (its claim is older than
   * `staleBefore`), and writes a switch held that is now off.
   */
  recoverable(
    ctx: TenantContext,
    input: { staleBefore: Date; maintenance: boolean },
  ): Promise<{ id: string; channelAccountId: string }[]> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.outbound_writes as w')
        .innerJoin('app.channel_accounts as a', (j) =>
          j.onRef('a.workspace_id', '=', 'w.workspace_id').onRef('a.id', '=', 'w.channel_account_id'),
        )
        .select(['w.id', 'w.channel_account_id'])
        .where('w.workspace_id', '=', ctx.workspaceId)
        .where((eb) =>
          eb.or([
            eb.and([eb('w.state', '=', 'sending'), eb('w.claimed_at', '<', input.staleBefore)]),
            eb.and([
              eb('w.state', '=', 'pending'),
              eb('w.paused_reason', '=', 'kill_switch'),
              eb('a.paused_at', 'is', null),
            ]),
            ...(input.maintenance
              ? []
              : [
                  eb.and([
                    eb('w.state', '=', 'pending'),
                    eb('w.paused_reason', '=', 'maintenance'),
                  ]),
                ]),
          ]),
        )
        .orderBy('w.created_at')
        .limit(1000)
        .execute();
      return rows.map((r) => ({ id: r.id, channelAccountId: r.channel_account_id }));
    });
  }

  async #nextDispatch(
    ctx: TenantContext,
    id: string,
    at: Date,
    extra: Record<string, unknown>,
  ): Promise<number> {
    const row = await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.outbound_writes')
        .set({ ...extra, dispatch_seq: sql<number>`dispatch_seq + 1`, updated_at: at })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returning('dispatch_seq')
        .executeTakeFirstOrThrow(),
    );
    return Number(row.dispatch_seq);
  }

  async #update(ctx: TenantContext, id: string, set: Record<string, unknown>): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.outbound_writes')
        .set(set)
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute(),
    );
  }
}
