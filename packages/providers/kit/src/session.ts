import type { Notifier, Provider, TenantContext } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import type { AccessToken } from './adapters.ts';
import {
  AuthFailed,
  isProviderError,
  ProviderParserError,
  providerErrorCode,
  RateLimited,
} from './errors.ts';
import type { ProviderGovernor } from './governor.ts';
import { parserRecordKind } from './parser.ts';
import type { AccessTokenCache } from './tokens.ts';

/** What a run of provider reads records: account health, notices, tokens and the governors. */
export interface CallSessionPorts {
  health: {
    recordSuccess(
      ctx: TenantContext,
      id: string,
      at: Date,
      options?: { tokenRefreshed?: boolean },
    ): Promise<{ reauthCleared: boolean }>;
    recordAuthFailure(
      ctx: TenantContext,
      id: string,
      at: Date,
      options: { revoked: boolean },
    ): Promise<{ failures: number; marked: boolean }>;
    recordError(ctx: TenantContext, id: string, code: string, at: Date): Promise<void>;
    recordCalls(
      ctx: TenantContext,
      input: { channelAccountId: string; provider: Provider; api: string; calls: number },
      at: Date,
    ): Promise<void>;
  };
  notifier: Pick<Notifier, 'raise' | 'resolve' | 'raisePlatform'>;
  tokens: AccessTokenCache;
  /** The rate governors (T-0702); left out, nothing waits. */
  governor?: ProviderGovernor;
  now?: () => Date;
}

export interface CallSession {
  /**
   * One provider call under `api`: the access token (issued under the auth API when needed), the
   * governor's admission, then the call through the governor's `run`. One 401 with a cached token
   * may just be an early expiry: the token is renewed once and the call tried again.
   */
  call<R>(api: string, fn: (access: AccessToken) => Promise<R>): Promise<R>;
  /** Adds the calls counted so far to today's usage rows (RL-5); `clear` starts the count again. */
  recordCalls(ctx: TenantContext, options?: { clear: true }): Promise<void>;
  /** The run succeeded: health, a cleared re-authorisation notice, and the usage. */
  succeeded(ctx: TenantContext): Promise<void>;
  /**
   * The run failed: an auth failure marks the account and raises one critical notice (AMZ-12,
   * EBAY-5); another provider failure is recorded as the account's error, unless it was the
   * governor's own wait (not the account's fault, INT-4); then the usage.
   */
  failed(ctx: TenantContext, err: unknown): Promise<void>;
  /** INT-5: a parser failure is the platform's notice, one per parser and version, never a value. */
  reportParser(err: unknown): Promise<void>;
}

/**
 * The call plumbing one run of reads shares (ADR-079 2): `runIncrementalSync` and `runListingScan`
 * both use it, so a fix to the token, governor or usage handling reaches both.
 */
export function callSession(
  ports: CallSessionPorts,
  s: {
    workspaceId: string;
    channelAccountId: string;
    companyId: string;
    provider: Provider;
    /** The API name of the token call (eBay counts it as identity); `auth` when left out. */
    authApi?: string;
    credential: Secret;
    authenticate(credential: Secret): Promise<AccessToken>;
  },
): CallSession {
  const now = ports.now ?? (() => new Date());
  const accountId = s.channelAccountId;
  const calls = new Map<string, number>();
  const input = (api: string) => ({
    workspaceId: s.workspaceId,
    channelAccountId: accountId,
    provider: s.provider,
    api,
    urgent: false,
  });
  // A governor's own wait: retried like a rate limit, but not the account's fault (INT-4).
  let held: RateLimited | undefined;
  const governed = async (api: string) => {
    const decision = (await ports.governor?.admit(input(api))) ?? {
      ok: true,
      usageRecorded: false,
    };
    if (!decision.ok) {
      // INT-2: told to wait (an empty Amazon bucket, eBay's budget): nothing is sent this run.
      held = new RateLimited(s.provider, {
        retryAfterMs: Math.max(0, decision.retryAt.getTime() - now().getTime()),
        daily: s.provider === 'ebay',
      });
      throw held;
    }
    // eBay's reservation already wrote the usage row (RL-5): never count it twice.
    if (!decision.usageRecorded) calls.set(api, (calls.get(api) ?? 0) + 1);
  };
  // An object, not a let: it changes inside the token closure. `issued` is set before the call,
  // so a refresh that fails is never tried a second time in the same run.
  const auth = { refreshed: false, issued: false };
  const token = async () => {
    const got = await ports.tokens.get(accountId, async () => {
      auth.issued = true;
      await governed(s.authApi ?? 'auth');
      return s.authenticate(s.credential);
    });
    auth.refreshed ||= got.refreshed;
    return got.token;
  };
  const once = async <R>(api: string, fn: (access: AccessToken) => Promise<R>): Promise<R> => {
    const access = await token();
    await governed(api);
    return ports.governor === undefined
      ? fn(access)
      : ports.governor.run(input(api), () => fn(access));
  };
  const recordCalls = async (ctx: TenantContext, options?: { clear: true }) => {
    for (const [api, n] of calls) {
      await ports.health.recordCalls(
        ctx,
        { channelAccountId: accountId, provider: s.provider, api, calls: n },
        now(),
      );
    }
    if (options?.clear === true) calls.clear();
  };

  return {
    async call(api, fn) {
      try {
        return await once(api, fn);
      } catch (err) {
        if (!(err instanceof AuthFailed) || err.revoked || auth.issued) throw err;
        ports.tokens.invalidate(accountId);
        return once(api, fn);
      }
    },
    recordCalls,
    async succeeded(ctx) {
      const { reauthCleared } = await ports.health.recordSuccess(ctx, accountId, now(), {
        tokenRefreshed: auth.refreshed,
      });
      if (reauthCleared) {
        await ports.notifier.resolve(ctx, 'channel.auth_lost', {
          kind: 'channel_account',
          id: accountId,
        });
      }
      await recordCalls(ctx);
    },
    async failed(ctx, err) {
      if (err instanceof AuthFailed) {
        ports.tokens.invalidate(accountId);
        const { marked } = await ports.health.recordAuthFailure(ctx, accountId, now(), {
          revoked: err.revoked,
        });
        if (marked) {
          await ports.notifier.raise(ctx, {
            type: 'channel.auth_lost',
            record: { kind: 'channel_account', id: accountId },
            signal: err.revoked ? 'native' : 'derived',
            companyId: s.companyId,
            channelAccountId: accountId,
          });
        }
      } else if (isProviderError(err) && err !== held) {
        // A provider failure only: a db-main error after a good call is not the account's fault.
        await ports.health.recordError(ctx, accountId, providerErrorCode(err), now());
      }
      await recordCalls(ctx);
    },
    async reportParser(err) {
      if (!(err instanceof ProviderParserError)) return;
      await ports.notifier.raisePlatform(null, {
        type: 'platform.report_failure',
        record: {
          kind: parserRecordKind({ provider: err.provider, name: err.parser }),
          id: String(err.version),
        },
      });
    },
  };
}
