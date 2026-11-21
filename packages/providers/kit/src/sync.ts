import type { Notifier, Provider, TenantContext, TenantRunner } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import type { AccessToken, Page } from './adapters.ts';
import { applyRun, pollSince, type CursorState, type SyncItem } from './cursor.ts';
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

/** The most pages one run reads; the rest wait for the next run (the cursor has moved on). */
const MAX_PAGES = 50;

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
    read(
      ctx: TenantContext,
      channelAccountId: string,
      provider: Provider,
    ): Promise<Secret | undefined>;
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
  /** The rate governors (T-0702); left out, nothing waits. */
  governor?: ProviderGovernor;
  now?: () => Date;
}

/** One "updated since" stream of one provider (INT-8). */
export interface SyncStream<T extends SyncItem> {
  readonly stream: string;
  readonly provider: Provider;
  /** The API name usage is counted under (RL-5). */
  readonly api: string;
  /** The API name of the token call (eBay counts it as identity); `auth` when left out. */
  readonly authApi?: string;
  /** How far back the first poll of an account reads. */
  readonly lookbackMs: number;
  authenticate(credential: Secret): Promise<AccessToken>;
  fetchPage(token: AccessToken, since: Date, page?: string): Promise<Page<T>>;
  /** Stores the new changes in the cursor's transaction. Must upsert by external ID. */
  sink(ctx: TenantContext, channelAccountId: string, items: readonly T[]): Promise<void>;
}

export type SyncResult =
  | { skipped: 'disconnected' }
  | { fetched: number; fresh: number; cursorAt: string | null; more?: true };

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
  const input = (api: string) => ({
    workspaceId: job.workspaceId,
    channelAccountId: accountId,
    provider: stream.provider,
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
      held = new RateLimited(stream.provider, {
        retryAfterMs: Math.max(0, decision.retryAt.getTime() - now().getTime()),
        daily: stream.provider === 'ebay',
      });
      throw held;
    }
    // eBay's reservation already wrote the usage row (RL-5): never count it twice.
    if (!decision.usageRecorded) count(api);
  };
  const fetchPage = (access: AccessToken, since: Date, page: string | undefined) =>
    ports.governor === undefined
      ? stream.fetchPage(access, since, page)
      : ports.governor.run(input(stream.api), () => stream.fetchPage(access, since, page));
  // An object, not a let: it changes inside the token closure. `issued` is set before the call,
  // so a refresh that fails is never tried a second time in the same run.
  const auth = { refreshed: false, issued: false };
  const token = async () => {
    const got = await ports.tokens.get(accountId, async () => {
      auth.issued = true;
      await governed(stream.authApi ?? 'auth');
      return stream.authenticate(credential);
    });
    auth.refreshed ||= got.refreshed;
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
    // A run that stopped at the page cap goes on from where it stopped, with the same since.
    const resume = cursor.resume ?? null;
    const since =
      resume === null ? pollSince(cursor, now(), stream.lookbackMs) : new Date(resume.since);
    const items: T[] = [];
    let page: string | undefined = resume?.page;
    for (let n = 0; n < MAX_PAGES; n += 1) {
      let result: Page<T>;
      try {
        const access = await token();
        await governed(stream.api);
        result = await fetchPage(access, since, page);
      } catch (err) {
        // One 401 with a cached token: it may just have expired early. Renew once and retry.
        if (!(err instanceof AuthFailed) || err.revoked || auth.issued) throw err;
        ports.tokens.invalidate(accountId);
        const access = await token();
        await governed(stream.api);
        result = await fetchPage(access, since, page);
      }
      items.push(...result.items);
      page = result.next;
      if (page === undefined) break;
    }
    const { fresh, next } = applyRun(cursor, items, { since, nextPage: page });
    await ports.tenancy.runWorkspace(actor, async (ctx) => {
      await stream.sink(ctx, accountId, fresh);
      await ports.cursors.save(ctx, accountId, stream.stream, next, now());
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
    });
    return {
      fetched: items.length,
      fresh: fresh.length,
      cursorAt: next.cursorAt?.toISOString() ?? null,
      ...(page === undefined ? {} : { more: true as const }),
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
      } else if (isProviderError(err) && err !== held) {
        // A provider failure only: a db-main error after a good call is not the account's fault.
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
