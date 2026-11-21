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

  it('[INT-2] every provider call passes the governor first', async () => {
    const h = harness(new Date('2026-11-21T12:00:00.000Z'));
    const order: string[] = [];
    h.ports.governor = {
      beforeCall: (input) => {
        order.push(`governor:${input.api}`);
        return Promise.resolve();
      },
    };
    const s = stream(() => {
      order.push('fetch');
      return [];
    }, []);
    await runIncrementalSync(h.ports, s, job);
    expect(order).toEqual(['governor:auth', 'governor:sell.fulfillment', 'fetch']);
  });
});
