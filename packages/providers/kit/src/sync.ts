import type { Notifier, Provider, TenantContext, TenantRunner } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import type { AccessToken, Page } from './adapters.ts';
import { applyPoll, pollSince, type CursorState, type SyncItem } from './cursor.ts';
import { AuthFailed, ProviderParserError, providerErrorCode } from './errors.ts';
import { parserRecordKind } from './parser.ts';
import type { AccessTokenCache } from './tokens.ts';

/** The most pages one run reads; the rest wait for the next run (the cursor has moved on). */
const MAX_PAGES = 50;

/**
 * What a provider call reports to before it is sent (INT-2). T-0702 plugs in the Amazon and eBay
 * governors and the carrier cap; until then nothing waits.
 */
export interface CallGovernor {
  beforeCall(input: {
    workspaceId: string;
    channelAccountId: string;
    provider: Provider;
    api: string;
    urgent: boolean;
  }): Promise<void>;
}

/** The db repositories the sync uses, each taking the tenant context of a short transaction. */
export interface SyncPorts {
  tenancy: Pick<TenantRunner, 'runWorkspace'>;
  accounts: {
    get(
      ctx: TenantContext,
      id: string,
      now: Date,
    ): Promise<{ provider: Provider; companyId: string; status: string } | undefined>;
  };
  credentials: {
    read(ctx: TenantContext, channelAccountId: string, provider: Provider): Promise<Secret | undefined>;
  };
  cursors: {
    get(ctx: TenantContext, channelAccountId: string, stream: string): Promise<CursorState>;
    save(
      ctx: TenantContext,
      channelAccountId: string,
      stream: string,
      cursor: CursorState,
      at: Date,
    ): Promise<void>;
  };
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
  governor?: CallGovernor;
  now?: () => Date;
}

/** One "updated since" stream of one provider (INT-8). */
export interface SyncStream<T extends SyncItem> {
  readonly stream: string;
  readonly provider: Provider;
  /** The API name usage is counted under (RL-5). */
  readonly api: string;
  /** How far back the first poll of an account reads. */
  readonly lookbackMs: number;
  authenticate(credential: Secret): Promise<AccessToken>;
  fetchPage(token: AccessToken, since: Date, page?: string): Promise<Page<T>>;
  /** Stores the new changes in the cursor's transaction. Must upsert by external ID. */
  sink(ctx: TenantContext, channelAccountId: string, items: readonly T[]): Promise<void>;
}

export type SyncResult =
  | { skipped: 'disconnected' }
  | { fetched: number; fresh: number; cursorAt: string | null };

/**
 * One incremental poll of one account (INT-1, INT-2, INT-5, INT-8): short transactions only, never
 * one open across a provider call (invariant 3). Reads the cursor and the stored credential; gets
 * an access token; reads every page from the cursor minus the overlap, each call through the
 * governor; drops the changes already handled; then stores the new ones, the cursor, the health
 * and the usage together. Failures are recorded as health and notices, then rethrown for the job.
 */
export async function runIncrementalSync<T extends SyncItem>(
  ports: SyncPorts,
  stream: SyncStream<T>,
  job: { workspaceId: string; channelAccountId: string },
): Promise<SyncResult> {
  const now = ports.now ?? (() => new Date());
  const actor = { workspaceId: job.workspaceId };
  const accountId = job.channelAccountId;
  const start = await ports.tenancy.runWorkspace(actor, async (ctx) => {
    const account = await ports.accounts.get(ctx, accountId, now());
    if (account === undefined || account.status === 'disconnected') return undefined;
    const credential = await ports.credentials.read(ctx, accountId, stream.provider);
    if (credential === undefined) return undefined;
    const cursor = await ports.cursors.get(ctx, accountId, stream.stream);
    return { account, credential, cursor };
  });
  if (start === undefined) return { skipped: 'disconnected' };
  const { account, credential, cursor } = start;

  const calls = new Map<string, number>();
  const count = (api: string) => calls.set(api, (calls.get(api) ?? 0) + 1);
  const governed = async (api: string) => {
    await ports.governor?.beforeCall({
      workspaceId: job.workspaceId,
      channelAccountId: accountId,
      provider: stream.provider,
      api,
      urgent: false,
    });
    count(api);
  };
  let tokenRefreshed = false;
  const token = async () => {
    const got = await ports.tokens.get(accountId, async () => {
      await governed('auth');
      return stream.authenticate(credential);
    });
    tokenRefreshed ||= got.refreshed;
    return got.token;
  };
  const recordCalls = async (ctx: TenantContext) => {
    for (const [api, n] of calls) {
      await ports.health.recordCalls(
        ctx,
        { channelAccountId: accountId, provider: stream.provider, api, calls: n },
        now(),
      );
    }
  };

  try {
    const since = pollSince(cursor, now(), stream.lookbackMs);
    const items: T[] = [];
    let page: string | undefined;
    for (let n = 0; n < MAX_PAGES; n += 1) {
      let result: Page<T>;
      try {
        const access = await token();
        await governed(stream.api);
        result = await stream.fetchPage(access, since, page);
      } catch (err) {
        // One 401 with a cached token: it may just have expired early. Renew once and retry.
        if (!(err instanceof AuthFailed) || err.revoked || tokenRefreshed) throw err;
        ports.tokens.invalidate(accountId);
        const access = await token();
        await governed(stream.api);
        result = await stream.fetchPage(access, since, page);
      }
      items.push(...result.items);
      page = result.next;
      if (page === undefined) break;
    }
    const { fresh, next } = applyPoll(cursor, items);
    await ports.tenancy.runWorkspace(actor, async (ctx) => {
      await stream.sink(ctx, accountId, fresh);
      await ports.cursors.save(ctx, accountId, stream.stream, next, now());
      const { reauthCleared } = await ports.health.recordSuccess(ctx, accountId, now(), {
        tokenRefreshed,
      });
      if (reauthCleared) {
        await ports.notifier.resolve(ctx, 'channel.auth_lost', {
          kind: 'channel_account',
          id: accountId,
        });
      }
      await recordCalls(ctx);
    });
    return {
      fetched: items.length,
      fresh: fresh.length,
      cursorAt: next.cursorAt?.toISOString() ?? null,
    };
  } catch (err) {
    await ports.tenancy.runWorkspace(actor, async (ctx) => {
      if (err instanceof AuthFailed) {
        ports.tokens.invalidate(accountId);
        const { marked } = await ports.health.recordAuthFailure(ctx, accountId, now(), {
          revoked: err.revoked,
        });
        if (marked) {
          // AMZ-12, EBAY-5: one critical notice to the workspace's admins, resolved on success.
          await ports.notifier.raise(ctx, {
            type: 'channel.auth_lost',
            record: { kind: 'channel_account', id: accountId },
            signal: err.revoked ? 'native' : 'derived',
            companyId: account.companyId,
            channelAccountId: accountId,
          });
        }
      } else {
        await ports.health.recordError(ctx, accountId, providerErrorCode(err), now());
      }
      await recordCalls(ctx);
    });
    if (err instanceof ProviderParserError) {
      // INT-5: one platform notice per parser and version (repeats update it); the path is logged
      // by the caller, never a value.
      await ports.notifier.raisePlatform(null, {
        type: 'platform.report_failure',
        record: {
          kind: parserRecordKind({ provider: err.provider, name: err.parser }),
          id: String(err.version),
        },
      });
    }
    throw err;
  }
}
