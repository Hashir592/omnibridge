import type { RaiseInput, TenantContext } from '@omnibridge/core';
import { Secret } from '@omnibridge/crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CursorState } from './cursor.ts';
import { AuthFailed } from './errors.ts';
import { defineParser } from './parser.ts';
import { runIncrementalSync, type SyncPorts, type SyncStream } from './sync.ts';
import { AccessTokenCache } from './tokens.ts';

const WS = '00000000-0000-4000-8000-000000000001';
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
const COMPANY = '00000000-0000-4000-8000-0000000000cc';

interface Item {
  externalId: string;
  updatedAt: Date;
}

/** In-memory ports with the same contracts as the db repositories. */
function harness(now: Date) {
  let cursor: CursorState = { cursorAt: null, overlap: [] };
  const raised: RaiseInput[] = [];
  const platform: RaiseInput[] = [];
  const resolved: string[] = [];
  const health = { failures: 0, marked: false, successes: 0, errors: [] as string[] };
  const calls: number[] = [];
  const ctx: TenantContext = { workspaceId: WS, companyIds: [COMPANY] };
  const ports: SyncPorts = {
    tenancy: { runWorkspace: (_actor, fn) => fn(ctx) },
    accounts: {
      get: () => Promise.resolve({ provider: 'ebay', companyId: COMPANY, status: 'active' }),
    },
    credentials: { read: () => Promise.resolve(new Secret('TOKENMARK-refresh')) },
    cursors: {
      get: () => Promise.resolve(cursor),
      save: (_c, _a, _s, next) => {
        cursor = next;
        return Promise.resolve();
      },
    },
    health: {
      recordSuccess: () => {
        health.successes += 1;
        const cleared = health.marked;
        health.marked = false;
        health.failures = 0;
        return Promise.resolve({ reauthCleared: cleared });
      },
      recordAuthFailure: (_c, _id, _at, { revoked }) => {
        health.failures += 1;
        const marked = !health.marked && (revoked || health.failures >= 3);
        if (marked) health.marked = true;
        return Promise.resolve({ failures: health.failures, marked });
      },
      recordError: (_c, _id, code) => {
        health.errors.push(code);
        return Promise.resolve();
      },
      recordCalls: (_c, input) => {
        calls.push(input.calls);
        return Promise.resolve();
      },
    },
    notifier: {
      raise: (_c, input) => {
        raised.push(input);
        return Promise.resolve({
          id: 'n',
          version: 1,
          created: true,
          escalated: false,
          reopened: false,
        });
      },
      resolve: (_c, type) => {
        resolved.push(type);
        return Promise.resolve(true);
      },
      raisePlatform: (_c, input) => {
        platform.push(input);
        return Promise.resolve({
          id: 'p',
          version: 1,
          created: true,
          escalated: false,
          reopened: false,
        });
      },
    },
    tokens: new AccessTokenCache(() => now.getTime()),
    now: () => now,
  };
  return { ports, raised, platform, resolved, health, calls, cursor: () => cursor };
}

function stream(pages: () => Item[] | Error, sink: Item[]): SyncStream<Item> {
  return {
    stream: 'ebay.orders',
    provider: 'ebay',
    api: 'sell.fulfillment',
    lookbackMs: 86_400_000,
    authenticate: () =>
      Promise.resolve({ token: new Secret('access'), expiresAt: new Date(Date.now() + 7_200_000) }),
    fetchPage: () => {
      const out = pages();
      return out instanceof Error
        ? Promise.reject(out)
        : Promise.resolve({ items: out, next: undefined });
    },
    sink: (_ctx, _account, items) => {
      sink.push(...items);
      return Promise.resolve();
    },
  };
}

const job = { workspaceId: WS, channelAccountId: ACCOUNT };
const item = (id: string, iso: string): Item => ({ externalId: id, updatedAt: new Date(iso) });

describe('incremental sync: job, governor, parser and cursor (INT-1, INT-5, INT-8)', () => {
  it('[INT-8] a re-poll inside the overlap hands the sink each change once', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    const sink: Item[] = [];
    const answer = [item('A', '2026-11-21T11:58:00.000Z'), item('B', '2026-11-21T11:59:00.000Z')];
    const s = stream(() => answer, sink);
    await runIncrementalSync(h.ports, s, job);
    await runIncrementalSync(h.ports, s, job);
    expect(sink.map((i) => i.externalId)).toEqual(['A', 'B']);
    expect(h.cursor().cursorAt).toEqual(new Date('2026-11-21T11:59:00.000Z'));
  });

  it('[INT-5] a missing field raises one parser notice and fails the run without a crash or a stored cursor', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    const parser = defineParser('ebay', 'orders', 2, z.object({ orderId: z.string() }));
    const s = stream(() => {
      try {
        parser.parse({ lineItems: [] });
        return [];
      } catch (err) {
        return err as Error;
      }
    }, []);
    await expect(runIncrementalSync(h.ports, s, job)).rejects.toMatchObject({
      name: 'ProviderParserError',
      path: 'orderId',
    });
    await expect(runIncrementalSync(h.ports, s, job)).rejects.toMatchObject({
      name: 'ProviderParserError',
    });
    // The same parser and version: one notice, raised again only as an update of the same record.
    expect(h.platform).toEqual([
      { type: 'platform.report_failure', record: { kind: 'parser_ebay_orders', id: '2' } },
      { type: 'platform.report_failure', record: { kind: 'parser_ebay_orders', id: '2' } },
    ]);
    expect(h.health.errors).toEqual(['provider.parser_failed', 'provider.parser_failed']);
    expect(h.cursor()).toEqual({ cursorAt: null, overlap: [] });
  });

  it('[INT-4] three auth failures raise one "authorisation lost" notice; the next success resolves it', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    let fail = true;
    const s = stream(() => (fail ? new AuthFailed('ebay', false) : []), []);
    for (let i = 0; i < 3; i += 1) {
      await expect(runIncrementalSync(h.ports, s, job)).rejects.toBeInstanceOf(AuthFailed);
    }
    expect(h.raised).toEqual([
      {
        type: 'channel.auth_lost',
        record: { kind: 'channel_account', id: ACCOUNT },
        signal: 'derived',
        companyId: COMPANY,
        channelAccountId: ACCOUNT,
      },
    ]);
    fail = false;
    await runIncrementalSync(h.ports, s, job);
    expect(h.resolved).toEqual(['channel.auth_lost']);
  });

  it('[INT-4] a revoked token marks the account at once', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    const s = stream(() => new AuthFailed('ebay', true), []);
    await expect(runIncrementalSync(h.ports, s, job)).rejects.toBeInstanceOf(AuthFailed);
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0]?.signal).toBe('native');
  });

  it('[INT-1] a disconnected account is skipped without a call', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    h.ports.credentials.read = () => Promise.resolve(undefined);
    let fetched = false;
    const s = stream(() => {
      fetched = true;
      return [];
    }, []);
    expect(await runIncrementalSync(h.ports, s, job)).toEqual({ skipped: 'disconnected' });
    expect(fetched).toBe(false);
  });

  // ---- F-M10-end-10: short transactions, the cursor after the last one ---------------------------

  const many = (n: number, at = '2026-11-21T11:00:00.000Z'): Item[] =>
    Array.from({ length: n }, (_, i) => ({
      externalId: `N${String(i).padStart(5, '0')}`,
      updatedAt: new Date(Date.parse(at) + i),
    }));
  /** Ports that note what each transaction did, in order. */
  const noted = (h: ReturnType<typeof harness>) => {
    const log: string[] = [];
    let open = 0;
    const { runWorkspace } = h.ports.tenancy;
    h.ports.tenancy = {
      runWorkspace: async (actor, fn) => {
        open += 1;
        try {
          return await runWorkspace(actor, fn);
        } finally {
          open -= 1;
        }
      },
    };
    const cursors = h.ports.cursors;
    const save: typeof cursors.save = (...args) => kept.save(...args);
    const kept = { ...cursors };
    h.ports.cursors = {
      ...cursors,
      save: (ctx, a, s, next, at) => {
        log.push(next.cursorAt === null ? 'save:same' : `save:${next.cursorAt.toISOString()}`);
        return save(ctx, a, s, next, at);
      },
    };
    return { log, open: () => open };
  };

  it('[INT-8][CAP-5] a run is stored in short transactions, each prepared just before it; the cursor moves after the last', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    const { log, open } = noted(h);
    const s: SyncStream<Item> = {
      ...stream(() => many(120), []),
      prepare: (_job, items) => {
        expect(open()).toBe(0);
        log.push(`prepare:${String(items.length)}`);
        return Promise.resolve(items);
      },
      sink: (_ctx, _account, items) => {
        expect(open()).toBe(1);
        log.push(`sink:${String(items.length)}:${items[0]?.externalId ?? ''}`);
        return Promise.resolve();
      },
    };
    expect(await runIncrementalSync(h.ports, s, job)).toMatchObject({ fetched: 120, fresh: 120 });
    const chunks = log.filter((l) => l.startsWith('sink'));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(Number(c.split(':')[1])).toBeLessThanOrEqual(50);
    for (const c of chunks.slice(0, -1)) expect(Number(c.split(':')[1])).toBeGreaterThanOrEqual(25);
    expect(chunks.map((c) => Number(c.split(':')[1])).reduce((a, b) => a + b, 0)).toBe(120);
    // prepare, sink, prepare, sink, … and one cursor, with the last.
    expect(log.map((l) => l.split(':')[0])).toEqual([
      ...chunks.flatMap(() => ['prepare', 'sink']),
      'save',
    ]);
    expect(log.at(-1)).toBe('save:2026-11-21T11:00:00.119Z');
    expect(h.health.successes).toBe(1);
    // A run with nothing new still saves its cursor and its health, in one transaction.
    log.length = 0;
    await runIncrementalSync(h.ports, s, job);
    expect(log).toEqual(['save:2026-11-21T11:00:00.119Z']);
    expect(h.health.successes).toBe(2);
  });

  it('[INT-8][CAP-6] a run that comes near its job expiry stops, and the next goes on from what is stored', async () => {
    let at = Date.parse('2026-11-21T12:00:00.000Z');
    const h = harness(new Date(at));
    h.ports.now = () => new Date(at);
    const stored: string[] = [];
    let perChunk = 200_000;
    const s: SyncStream<Item> = {
      ...stream(() => many(400), []),
      sink: (_ctx, _account, items) => {
        stored.push(...items.map((i) => i.externalId));
        at += perChunk;
        return Promise.resolve();
      },
    };
    const first = await runIncrementalSync(h.ports, s, job);
    expect(first).toMatchObject({ more: true });
    // Never near the 600 s at which the job expires, and something was stored.
    expect(at - Date.parse('2026-11-21T12:00:00.000Z')).toBeLessThanOrEqual(800_000);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(400);
    // The cursor has not moved: nothing unread is skipped.
    expect(h.cursor().cursorAt).toBeNull();
    const done = stored.length;
    for (let i = 0; i < 20 && h.cursor().cursorAt === null; i += 1) {
      await runIncrementalSync(h.ports, s, job);
    }
    expect(stored.slice(0, done + 1)).toEqual(
      many(400)
        .slice(0, done + 1)
        .map((i) => i.externalId),
    );
    expect(stored).toHaveLength(400);
    expect(new Set(stored).size).toBe(400);
    expect(h.cursor().cursorAt).toEqual(new Date('2026-11-21T11:00:00.399Z'));
    perChunk = 0;
  });

  it('[INT-8] a run that fails part way keeps what it stored, and does not store it again', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    const stored: string[] = [];
    let broken = true;
    const s: SyncStream<Item> = {
      ...stream(() => many(120), []),
      sink: (_ctx, _account, items) => {
        if (broken && items.some((i) => i.externalId === 'N00100')) {
          return Promise.reject(new Error('a bad order'));
        }
        stored.push(...items.map((i) => i.externalId));
        return Promise.resolve();
      },
    };
    await expect(runIncrementalSync(h.ports, s, job)).rejects.toThrow('a bad order');
    const kept = stored.length;
    expect(kept).toBeGreaterThanOrEqual(75);
    expect(h.cursor().cursorAt).toBeNull();
    expect(h.health.successes).toBe(0);
    broken = false;
    await runIncrementalSync(h.ports, s, job);
    expect(stored).toHaveLength(120);
    expect(new Set(stored).size).toBe(120);
    expect(h.cursor().cursorAt).toEqual(new Date('2026-11-21T11:00:00.119Z'));
  });

  it('[INT-8][CAP-6] slow pages stop the reading in time to store them, and the next run reads on', async () => {
    let at = Date.parse('2026-11-21T12:00:00.000Z');
    const h = harness(new Date(at));
    h.ports.now = () => new Date(at);
    const stored: string[] = [];
    const all = many(300);
    const asked: (string | undefined)[] = [];
    const s: SyncStream<Item> = {
      ...stream(() => [], []),
      fetchPage: (_token, _since, page) => {
        at += 70_000;
        asked.push(page);
        const n = page === undefined ? 0 : Number(page);
        const items = all.slice(n * 30, (n + 1) * 30);
        return Promise.resolve({ items, next: n < 9 ? String(n + 1) : undefined });
      },
      sink: (_ctx, _account, items) => {
        stored.push(...items.map((i) => i.externalId));
        return Promise.resolve();
      },
    };
    expect(await runIncrementalSync(h.ports, s, job)).toMatchObject({ more: true });
    expect(asked.length).toBeLessThan(7);
    expect(stored).toHaveLength(asked.length * 30);
    expect(h.cursor().resume?.page).toBe(String(asked.length));
    for (let i = 0; i < 10 && h.cursor().cursorAt === null; i += 1) {
      await runIncrementalSync(h.ports, s, job);
    }
    expect(stored).toEqual(all.map((i) => i.externalId));
    expect(asked).toEqual([undefined, '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('[INT-2] every provider call passes the governor first', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    const order: string[] = [];
    h.ports.governor = {
      admit: (input) => {
        order.push(`governor:${input.api}`);
        return Promise.resolve({ ok: true, usageRecorded: false });
      },
      run: (_input, fn) => fn(),
    };
    const s = stream(() => {
      order.push('fetch');
      return [];
    }, []);
    await runIncrementalSync(h.ports, s, job);
    expect(order).toEqual(['governor:auth', 'governor:sell.fulfillment', 'fetch']);
  });
  it('[INT-2] a governor that says wait stops the run before anything is sent, as a rate limit, and is not an account error', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    let fetched = false;
    h.ports.governor = {
      admit: () => Promise.resolve({ ok: false, retryAt: new Date('2026-11-21T13:00:00.000Z') }),
      run: (_input, fn) => fn(),
    };
    const s = stream(() => {
      fetched = true;
      return [];
    }, []);
    await expect(runIncrementalSync(h.ports, s, job)).rejects.toMatchObject({
      name: 'RateLimited',
      retryAfterMs: 3_600_000,
      daily: true,
    });
    expect(fetched).toBe(false);
    // Our own budget, not the account's fault: Connections does not show it as an error.
    expect(h.health.errors).toEqual([]);
  });
});
