import type { Notifier, Provider, TenantContext, TenantRunner } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import type { z } from 'zod';
import type { AccessToken } from './adapters.ts';
import {
  AuthFailed,
  isProviderError,
  ProviderParserError,
  providerErrorCode,
  ProviderUnavailable,
  RateLimited,
  SlotsFull,
} from './errors.ts';
import { parserRecordKind } from './parser.ts';
import type { SyncPorts } from './sync.ts';
import type { AccessTokenCache } from './tokens.ts';
import type { CallInput, ProviderGovernor } from './governor.ts';

/** A write that keeps failing in ways that may pass is given up after this many attempts. */
export const MAX_SEND_ATTEMPTS = 6;

/** A provider's daily limit is tried again this often, until its day resets. */
const DAILY_LIMIT_WAIT_MS = 60 * 60_000;

/** After the n-th failed attempt: 1, 2, 4, 8 ... minutes, at most an hour. */
/** The longest a write waits before its next attempt, whatever the provider asks (RL-4). */
export const MAX_DEFER_MS = 60 * 60_000;

export function retryDelayMs(attempts: number, maxDelayMs = MAX_DEFER_MS): number {
  return Math.min(maxDelayMs, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** One kind of provider write: its payload schema (IDs and numbers only) and how to send it. */
export interface OutboundOperation<P> {
  readonly operation: string;
  readonly provider: Provider;
  /** The API name governors and usage count the send under. */
  readonly api: string;
  /** The API name of the token call (eBay counts it against identity). */
  readonly authApi?: string;
  readonly payload: z.ZodType<P>;
  /**
   * WEB-5: how long a write that may pass is retried: the n-th wait is 2^(n-1) minutes, at most
   * `maxDelayMs`, and it is given up after `maxAttempts`. Left out, MAX_SEND_ATTEMPTS and
   * MAX_DEFER_MS.
   */
  readonly retry?: { readonly maxAttempts: number; readonly maxDelayMs: number };
  /**
   * WEB-5: a write given up after a provider failure raises this notice on its account (one per
   * account, updated in place), and the next write sent clears it. The given-up write stays in
   * app.outbound_writes as failed, with its code: the dead letter.
   */
  readonly deadLetterAlert?: string;
  authenticate(credential: Secret): Promise<AccessToken>;
  /** `write.id` is the same on every attempt of one write: the receiver's idempotency key. */
  send(token: AccessToken, payload: P, write?: { id: string }): Promise<Record<string, unknown>>;
}

export interface OutboundWriteView {
  id: string;
  channelAccountId: string;
  provider: Provider;
  operation: string;
  urgent: boolean;
  payload: unknown;
  state: string;
  attempts: number;
}

/** db-main app.outbound_writes and the queue, each call in the given tenant context. */
export interface OutboundPorts {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  writes: {
    get(ctx: TenantContext, id: string): Promise<OutboundWriteView | undefined>;
    gate(
      ctx: TenantContext,
      channelAccountId: string,
    ): Promise<{ maintenance: boolean; paused: boolean }>;
    pause(
      ctx: TenantContext,
      id: string,
      reason: 'kill_switch' | 'maintenance',
      at: Date,
    ): Promise<void>;
    claim(ctx: TenantContext, id: string, at: Date): Promise<boolean>;
    defer(
      ctx: TenantContext,
      id: string,
      input: { until: Date; attempted: boolean; at: Date; errorCode?: string },
    ): Promise<{ dispatchSeq: number; attempts: number }>;
    sent(ctx: TenantContext, id: string, result: Record<string, unknown>, at: Date): Promise<void>;
    fail(
      ctx: TenantContext,
      id: string,
      input: { code: string; attempted: boolean; at: Date },
    ): Promise<void>;
  };
  /** Sends the outbound.send job for this dispatch, in the given context's transaction. */
  dispatch(
    ctx: TenantContext,
    write: { id: string; channelAccountId: string },
    dispatchSeq: number,
    startAfter?: Date,
  ): Promise<void>;
  accounts: SyncPorts['accounts'];
  credentials: SyncPorts['credentials'];
  health: SyncPorts['health'];
  notifier: Pick<Notifier, 'raise' | 'resolve' | 'raisePlatform'>;
  tokens: AccessTokenCache;
  governor: ProviderGovernor;
  now?: () => Date;
}

export type OutboundResult =
  | { sent: true }
  | { paused: 'kill_switch' | 'maintenance' }
  | { deferred: 'rate_limit' | 'retry' }
  | { failed: string }
  | { skipped: string };

/** A governor said wait (thrown inside the token call so the path below handles it once). */
class Wait extends Error {
  readonly until: Date;

  constructor(until: Date) {
    super('wait');
    this.until = until;
  }
}

/** An operation's retry limits (WEB-5), or the defaults. */
function limitsOf(op: OutboundOperation<unknown>) {
  return {
    maxAttempts: op.retry?.maxAttempts ?? MAX_SEND_ATTEMPTS,
    maxDelayMs: op.retry?.maxDelayMs ?? MAX_DEFER_MS,
  };
}

/** Kept on retry: the provider may well take it later (or Amazon kept answering 429). */
const retryable = (err: unknown) =>
  err instanceof RateLimited ||
  err instanceof ProviderUnavailable ||
  // The Amazon governor's own error (the kit never imports a governor, RL-3).
  (err instanceof Error && err.name === 'AmazonBackoffSpent');

/**
 * Sends one outbound write (T-0702: SAFE-2, SAFE-3, INT-2), in short transactions only, never one
 * across the provider call (invariant 3):
 *
 * 1. Reads the write and, just before the send (invariant 20), the maintenance switch and the
 *    account's kill switch. Either on: the write waits, pending, with no attempt spent, until the
 *    switch is turned off (the resume dispatches it again).
 * 2. Claims it, so no second worker sends it.
 * 3. Asks the governor (Amazon bucket, eBay budget reserved before the send). Told to wait: back to
 *    pending until then, again with no attempt spent.
 * 4. Sends it through the governor's `run` (Amazon 429 backoff, the carrier cap).
 * 5. Stores the result, the health and the usage; or the failure: retried with backoff when it
 *    may pass, given up after the operation's attempt limit (MAX_SEND_ATTEMPTS unless it sets its
 *    own, WEB-5) or at once when the provider refused it. A write given up after a provider
 *    failure raises the operation's alert, if it has one; the next write sent clears it.
 *
 * A write is sent only for an account of the operation's own provider (WEB-6).
 */
export async function runOutboundSend(
  ports: OutboundPorts,
  operations: Readonly<Record<string, OutboundOperation<unknown>>>,
  job: { workspaceId: string; writeId: string },
): Promise<OutboundResult> {
  const now = ports.now ?? (() => new Date());
  const actor = { workspaceId: job.workspaceId };
  /** WEB-6: refused before anything is read or sent, and never retried. */
  const wrongProvider = async (ctx: TenantContext, id: string): Promise<OutboundResult> => {
    const code = 'outbound.wrong_provider';
    await ports.writes.fail(ctx, id, { code, attempted: false, at: now() });
    return { failed: code };
  };
  /** WEB-5: the given-up write is the dead letter; its account gets the operation's alert. */
  const deadLettered = async (
    ctx: TenantContext,
    op: OutboundOperation<unknown>,
    write: OutboundWriteView,
    companyId: string,
  ) => {
    if (op.deadLetterAlert === undefined) return;
    await ports.notifier.raise(ctx, {
      type: op.deadLetterAlert,
      record: { kind: 'channel_account', id: write.channelAccountId },
      companyId,
      channelAccountId: write.channelAccountId,
    });
  };

  type Ready = {
    write: OutboundWriteView;
    op: OutboundOperation<unknown>;
    payload: unknown;
    credential: Secret;
    companyId: string;
  };
  const start = await ports.tenancy.runWorkspace(
    actor,
    async (ctx): Promise<Ready | OutboundResult> => {
      const write = await ports.writes.get(ctx, job.writeId);
      if (write === undefined) return { skipped: 'gone' };
      if (write.state !== 'pending') return { skipped: write.state };
      const op = operations[write.operation];
      const parsed = op?.payload.safeParse(write.payload);
      if (op === undefined || parsed === undefined || !parsed.success) {
        const code = op === undefined ? 'outbound.unknown_operation' : 'outbound.invalid_payload';
        await ports.writes.fail(ctx, write.id, { code, attempted: false, at: now() });
        return { failed: code };
      }
      // Dead workers' claims count too (recovery), so a write that keeps crashing one stops here.
      if (write.attempts >= limitsOf(op).maxAttempts) {
        const code = 'outbound.attempts_exhausted';
        await ports.writes.fail(ctx, write.id, { code, attempted: false, at: now() });
        const account = await ports.accounts.get(ctx, write.channelAccountId, now());
        if (account !== undefined) await deadLettered(ctx, op, write, account.companyId);
        return { failed: code };
      }
      // WEB-6: an operation is sent only for an account of its own provider.
      if (op.provider !== write.provider) return wrongProvider(ctx, write.id);
      // Invariant 20: the switches as they are now, just before the send.
      const gate = await ports.writes.gate(ctx, write.channelAccountId);
      if (gate.maintenance || gate.paused) {
        const reason = gate.maintenance ? 'maintenance' : 'kill_switch';
        await ports.writes.pause(ctx, write.id, reason, now());
        return { paused: reason };
      }
      const account = await ports.accounts.get(ctx, write.channelAccountId, now());
      const credential =
        account === undefined || account.status === 'disconnected'
          ? undefined
          : await ports.credentials.read(ctx, write.channelAccountId, write.provider);
      if (account === undefined || credential === undefined) {
        await ports.writes.fail(ctx, write.id, {
          code: 'provider.disconnected',
          attempted: false,
          at: now(),
        });
        return { failed: 'provider.disconnected' };
      }
      if (account.provider !== write.provider) return wrongProvider(ctx, write.id);
      if (!(await ports.writes.claim(ctx, write.id, now()))) return { skipped: 'claimed' };
      return { write, op, payload: parsed.data, credential, companyId: account.companyId };
    },
  );
  if (!('write' in start)) return start;
  const { write, op, payload, credential, companyId } = start;
  const limits = limitsOf(op);
  const call = (api: string): CallInput => ({
    workspaceId: job.workspaceId,
    channelAccountId: write.channelAccountId,
    provider: write.provider,
    api,
    urgent: write.urgent,
  });

  const calls = new Map<string, number>();
  const admit = async (api: string) => {
    const decision = await ports.governor.admit(call(api));
    if (!decision.ok) throw new Wait(decision.retryAt);
    if (!decision.usageRecorded) calls.set(api, (calls.get(api) ?? 0) + 1);
  };
  const auth = { refreshed: false, issued: false };
  const token = async () => {
    const got = await ports.tokens.get(write.channelAccountId, async () => {
      auth.issued = true;
      await admit(op.authApi ?? 'auth');
      return op.authenticate(credential);
    });
    auth.refreshed ||= got.refreshed;
    return got.token;
  };
  const send = async () => {
    const access = await token();
    await admit(op.api);
    return ports.governor.run(call(op.api), () => op.send(access, payload, { id: write.id }));
  };
  const recordCalls = async (ctx: TenantContext) => {
    for (const [api, n] of calls) {
      await ports.health.recordCalls(
        ctx,
        { channelAccountId: write.channelAccountId, provider: write.provider, api, calls: n },
        now(),
      );
    }
  };

  let result: Record<string, unknown>;
  try {
    try {
      result = await send();
    } catch (err) {
      // One 401 with a cached token: renew once and try again.
      if (!(err instanceof AuthFailed) || err.revoked || auth.issued) throw err;
      ports.tokens.invalidate(write.channelAccountId);
      result = await send();
    }
  } catch (err) {
    return ports.tenancy.runWorkspace(actor, async (ctx): Promise<OutboundResult> => {
      await recordCalls(ctx);
      // A governor's wait (an empty bucket, eBay's budget, RL-4's full slots): no attempt spent.
      if (err instanceof Wait || err instanceof SlotsFull) {
        const { dispatchSeq } = await ports.writes.defer(ctx, write.id, {
          until: err.until,
          attempted: false,
          at: now(),
        });
        await ports.dispatch(ctx, write, dispatchSeq, err.until);
        return { deferred: 'rate_limit' };
      }
      if (!isProviderError(err)) throw err;
      const code = providerErrorCode(err);
      if (err instanceof AuthFailed) {
        ports.tokens.invalidate(write.channelAccountId);
        const { marked } = await ports.health.recordAuthFailure(
          ctx,
          write.channelAccountId,
          now(),
          {
            revoked: err.revoked,
          },
        );
        if (marked) {
          await ports.notifier.raise(ctx, {
            type: 'channel.auth_lost',
            record: { kind: 'channel_account', id: write.channelAccountId },
            signal: err.revoked ? 'native' : 'derived',
            companyId,
            channelAccountId: write.channelAccountId,
          });
        }
      } else {
        await ports.health.recordError(ctx, write.channelAccountId, code, now());
      }
      if (err instanceof ProviderParserError) {
        await ports.notifier.raisePlatform(null, {
          type: 'platform.report_failure',
          record: {
            kind: parserRecordKind({ provider: err.provider, name: err.parser }),
            id: String(err.version),
          },
        });
      }
      if (err instanceof RateLimited && err.daily) {
        // eBay's own daily limit: nothing passes before its day resets, so no attempt is spent.
        const until = new Date(now().getTime() + (err.retryAfterMs ?? DAILY_LIMIT_WAIT_MS));
        const { dispatchSeq } = await ports.writes.defer(ctx, write.id, {
          until,
          attempted: false,
          at: now(),
          errorCode: code,
        });
        await ports.dispatch(ctx, write, dispatchSeq, until);
        return { deferred: 'rate_limit' };
      }
      const mayPass = retryable(err) || (err instanceof AuthFailed && !err.revoked);
      if (!mayPass || write.attempts + 1 >= limits.maxAttempts) {
        await ports.writes.fail(ctx, write.id, { code, attempted: true, at: now() });
        await deadLettered(ctx, op, write, companyId);
        return { failed: code };
      }
      // A provider's Retry-After is honoured up to the retry ceiling (60 minutes): a week, or a
      // far date, would hold a stock write silently, as a deferral is not a failure (F-M08-end-03).
      const wait =
        err instanceof RateLimited && err.retryAfterMs !== undefined
          ? Math.min(
              limits.maxDelayMs,
              Math.max(err.retryAfterMs, retryDelayMs(write.attempts + 1, limits.maxDelayMs)),
            )
          : retryDelayMs(write.attempts + 1, limits.maxDelayMs);
      const until = new Date(now().getTime() + wait);
      const { dispatchSeq } = await ports.writes.defer(ctx, write.id, {
        until,
        attempted: true,
        at: now(),
        errorCode: code,
      });
      await ports.dispatch(ctx, write, dispatchSeq, until);
      return { deferred: 'retry' };
    });
  }

  await ports.tenancy.runWorkspace(actor, async (ctx) => {
    await ports.writes.sent(ctx, write.id, result, now());
    if (op.deadLetterAlert !== undefined) {
      await ports.notifier.resolve(ctx, op.deadLetterAlert, {
        kind: 'channel_account',
        id: write.channelAccountId,
      });
    }
    const { reauthCleared } = await ports.health.recordSuccess(ctx, write.channelAccountId, now(), {
      tokenRefreshed: auth.refreshed,
    });
    if (reauthCleared) {
      await ports.notifier.resolve(ctx, 'channel.auth_lost', {
        kind: 'channel_account',
        id: write.channelAccountId,
      });
    }
    await recordCalls(ctx);
  });
  return { sent: true };
}
