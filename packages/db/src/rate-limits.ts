import type { TenantContext } from '@omnibridge/core';
import type { AmazonBucketStore, BucketTake } from '@omnibridge/governor-amazon';
import type { EbayBudgetStore } from '@omnibridge/governor-ebay';
import { sql, type Kysely } from 'kysely';
import type { MainDb } from './schema.ts';
import { withTenantTransaction } from './tenant.ts';

/**
 * SP-API token buckets (RL-1, AMZ-9, app.amazon_rate_buckets): created full on first use; a take
 * refills by the time passed and spends one token in one guarded UPDATE, so two workers can never
 * spend the same token. The stored rate wins over the default plan once Amazon has told us one.
 */
export class AmazonBucketRepository implements AmazonBucketStore {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  take(
    ctx: TenantContext,
    input: { channelAccountId: string; operation: string; rate: number; burst: number; now: Date },
  ): Promise<BucketTake> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      await sql`
        INSERT INTO app.amazon_rate_buckets (workspace_id, channel_account_id, operation, rate,
                                             burst, tokens, refilled_at)
        VALUES (${ctx.workspaceId}, ${input.channelAccountId}, ${input.operation}, ${input.rate},
                ${input.burst}, ${input.burst}, ${input.now})
        ON CONFLICT (workspace_id, channel_account_id, operation) DO NOTHING`.execute(trx);
      const level = sql<number>`least(burst, tokens + rate * greatest(0,
        extract(epoch FROM (${input.now}::timestamptz - refilled_at))))`;
      const { rows } = await sql<{ tokens: number }>`
        UPDATE app.amazon_rate_buckets
           SET tokens = ${level} - 1, refilled_at = greatest(refilled_at, ${input.now}::timestamptz)
         WHERE workspace_id = ${ctx.workspaceId} AND channel_account_id = ${input.channelAccountId}
           AND operation = ${input.operation} AND ${level} >= 1
        RETURNING tokens`.execute(trx);
      if (rows.length > 0) return { ok: true };
      const { rows: now } = await sql<{ level: number; rate: number }>`
        SELECT ${level} AS level, rate FROM app.amazon_rate_buckets
         WHERE workspace_id = ${ctx.workspaceId} AND channel_account_id = ${input.channelAccountId}
           AND operation = ${input.operation}`.execute(trx);
      const row = now[0];
      if (row === undefined) return { ok: false, waitMs: 1_000 };
      return { ok: false, waitMs: Math.max(1, Math.ceil(((1 - row.level) / row.rate) * 1000)) };
    });
  }

  async setRate(
    ctx: TenantContext,
    input: { channelAccountId: string; operation: string; rate: number; now: Date },
  ): Promise<void> {
    await withTenantTransaction(this.#db, ctx, (trx) =>
      trx
        .updateTable('app.amazon_rate_buckets')
        .set({ rate: input.rate })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('channel_account_id', '=', input.channelAccountId)
        .where('operation', '=', input.operation)
        .execute(),
    );
  }
}

/**
 * eBay's app-wide daily budget (RL-2, EBAY-8) through app.ebay_budget_reserve: one guarded UPDATE
 * per reservation, and the calls added to the account's usage row in the same call (RL-5).
 */
export class EbayBudgetRepository implements EbayBudgetStore {
  readonly #db: Kysely<MainDb>;

  constructor(db: Kysely<MainDb>) {
    this.#db = db;
  }

  reserve(
    ctx: TenantContext,
    input: {
      channelAccountId: string;
      api: string;
      day: string;
      n: number;
      cap: number;
      percent: 80 | 95;
      now: Date;
    },
  ): Promise<{ reserved: boolean; calls: number; cap: number }> {
    return withTenantTransaction(this.#db, ctx, async (trx) => {
      const { rows } = await sql<{ reserved: boolean; calls: string; cap: string }>`
        SELECT reserved, calls, cap FROM app.ebay_budget_reserve(
          ${input.channelAccountId}::uuid, ${input.api}, ${input.day}::date, ${input.n}::bigint,
          ${input.cap}::bigint, ${input.percent}::int, ${input.now}::timestamptz)`.execute(trx);
      const row = rows[0];
      if (row === undefined) return { reserved: false, calls: 0, cap: input.cap };
      return { reserved: row.reserved, calls: Number(row.calls), cap: Number(row.cap) };
    });
  }
}
