import type { Provider, TenantContext, TenantRunner } from '@omnibridge/core';
import type { Secret } from '@omnibridge/crypto';
import type { AccessToken, Page, SetAside, SetAsideReason } from './adapters.ts';
import { applyPart, applyRun, pollSince, type CursorState, type SyncItem } from './cursor.ts';
import { callSession, type CallSessionPorts } from './session.ts';

/** The most pages one run reads; the rest wait for the next run (the cursor has moved on). */
const MAX_PAGES = 50;
/** Changes stored in one transaction: another user of the same rows waits for this many at most. */
const CHUNK = 25;
/** A run reads pages for this long at most, so that there is time to store them. */
const MAX_READ_MS = 4 * 60_000;
/** A run starts no further transaction after this; sync.poll expires after 10 minutes. */
const MAX_RUN_MS = 8 * 60_000;

/** The db repositories the sync uses, each taking the tenant context of a short transaction. */
export interface SyncPorts extends CallSessionPorts {
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
      /** The run failed after storing a part: remembered, but no success of the stream. */
      options?: { failed: true },
    ): Promise<void>;
  };
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
  /**
   * Runs before each of the sink's transactions, for its items, with no transaction open
   * (invariant 3): M10's vault-first step (FA-10) stores buyer details in pii-vault here and
   * returns the items with their `pii_ref` and without the details. Left out, items pass through.
   */
  prepare?(
    job: { workspaceId: string; channelAccountId: string },
    items: readonly T[],
  ): Promise<readonly T[]>;
  /** Stores a few new changes in a short transaction. Must upsert by external ID. */
  sink(ctx: TenantContext, channelAccountId: string, items: readonly T[]): Promise<void>;
}

export type SyncResult =
  | { skipped: 'disconnected' }
  | { fetched: number; fresh: number; cursorAt: string | null; more?: true };

/**
 * One incremental poll of one account (INT-1, INT-2, INT-5, INT-8): short transactions only, never
 * one open across a provider call (invariant 3). Reads the cursor and the stored credential; gets
 * an access token; reads every page from the cursor minus the overlap, each call through the
 * governor; drops the changes already handled; then stores the new ones a few at a time, the last
 * of them with the cursor, the health and the usage (F-M10-end-10). A run that comes near its job's
 * expiry stops, and one that fails part way keeps what it stored; the next reads the same pages and
 * goes on. Failures are recorded as health and notices, then rethrown for the job.
 */
export async function runIncrementalSync<T extends SyncItem>(
  ports: SyncPorts,
  stream: SyncStream<T>,
  job: { workspaceId: string; channelAccountId: string },
): Promise<SyncResult> {
  const now = ports.now ?? (() => new Date());
  const startedAt = now().getTime();
  const elapsed = () => now().getTime() - startedAt;
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

  const session = callSession(ports, {
    workspaceId: job.workspaceId,
    channelAccountId: accountId,
    companyId: account.companyId,
    provider: stream.provider,
    ...(stream.authApi === undefined ? {} : { authApi: stream.authApi }),
    credential,
    authenticate: (c) => stream.authenticate(c),
  });

  const items: T[] = [];
  const stored: T[] = [];
  // F-M10-end-14, -17, S5-20261124-07: what the pages could not take, counted, never fatal.
  const setAside: SetAside[] = [];
  const recordSuccess = async (ctx: TenantContext, next: CursorState) => {
    await ports.cursors.save(ctx, accountId, stream.stream, next, now());
    await session.succeeded(ctx);
    await noticeSetAside(ctx);
  };
  /**
   * One notice per account, updated in place (NTF-5), with the counts by reason: IDs and counts
   * only. An unreadable one is also the platform's parser problem (INT-5).
   */
  const noticeSetAside = async (ctx: TenantContext) => {
    if (setAside.length === 0) return;
    const count = (reason: SetAsideReason) => setAside.filter((x) => x.reason === reason).length;
    await ports.notifier.raise(ctx, {
      type: 'orders.set_aside',
      record: { kind: 'channel_account', id: accountId },
      companyId: account.companyId,
      channelAccountId: accountId,
      params: {
        count: setAside.length,
        notGbp: count('not_gbp'),
        noLines: count('no_lines'),
        idTooLong: count('id_too_long'),
        unreadable: count('unreadable'),
      },
    });
    if (count('unreadable') > 0) {
      await ports.notifier.raisePlatform(ctx, {
        type: 'platform.report_failure',
        record: { kind: 'order_unreadable', id: accountId },
      });
    }
  };

  // A run that stopped at the page cap, or part way, goes on from where it stopped, with the same since.
  const resume = cursor.resume ?? null;
  const since =
    resume === null ? pollSince(cursor, now(), stream.lookbackMs) : new Date(resume.since);
  try {
    let page: string | undefined = resume === null || resume.page === '' ? undefined : resume.page;
    for (let n = 0; n < MAX_PAGES; n += 1) {
      const result: Page<T> = await session.call(stream.api, (access) =>
        stream.fetchPage(access, since, page),
      );
      items.push(...result.items);
      setAside.push(...(result.setAside ?? []));
      page = result.next;
      if (page === undefined || elapsed() >= MAX_READ_MS) break;
    }
    const { fresh, next } = applyRun(cursor, items, { since, nextPage: page });
    while (stored.length < fresh.length) {
      const part = fresh.slice(stored.length, stored.length + CHUNK);
      if (stored.length > 0 && elapsed() >= MAX_RUN_MS) {
        await ports.tenancy.runWorkspace(actor, (ctx) =>
          recordSuccess(ctx, applyPart(cursor, items, stored, since)),
        );
        return {
          fetched: items.length,
          fresh: stored.length,
          cursorAt: cursor.cursorAt?.toISOString() ?? null,
          more: true as const,
        };
      }
      const ready = stream.prepare === undefined ? part : await stream.prepare(job, part);
      const last = stored.length + part.length === fresh.length;
      await ports.tenancy.runWorkspace(actor, async (ctx) => {
        await stream.sink(ctx, accountId, ready);
        if (last) await recordSuccess(ctx, next);
      });
      stored.push(...part);
    }
    if (fresh.length === 0) {
      await ports.tenancy.runWorkspace(actor, (ctx) => recordSuccess(ctx, next));
    }
    return {
      fetched: items.length,
      fresh: fresh.length,
      cursorAt: next.cursorAt?.toISOString() ?? null,
      ...(page === undefined ? {} : { more: true as const }),
    };
  } catch (err) {
    await ports.tenancy.runWorkspace(actor, async (ctx) => {
      if (stored.length > 0) {
        const part = applyPart(cursor, items, stored, since);
        await ports.cursors.save(ctx, accountId, stream.stream, part, now(), { failed: true });
      }
      await session.failed(ctx, err);
    });
    // INT-5: the path is logged by the caller, never a value.
    await session.reportParser(err);
    throw err;
  }
}
