import type { TenantContext } from '@omnibridge/core';
import { describe, expect, it } from 'vitest';
import { EBAY_DAILY_CAPS, EBAY_THRESHOLDS, EbayGovernor, type EbayBudgetStore } from './budget.ts';

const ctx: TenantContext = { workspaceId: '00000000-0000-4000-8000-000000000001', companyIds: [] };
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';

/** The store's guarded UPDATE, in memory: calls + n <= cap x percent / 100. */
function memoryStore(): EbayBudgetStore & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    calls,
    reserve: (_ctx, input) => {
      const key = `${input.api}|${input.day}`;
      const used = calls.get(key) ?? 0;
      if ((used + input.n) * 100 > input.cap * input.percent) {
        return Promise.resolve({ reserved: false, calls: used, cap: input.cap });
      }
      calls.set(key, used + input.n);
      return Promise.resolve({ reserved: true, calls: used + input.n, cap: input.cap });
    },
  };
}

describe('eBay governor (RL-2, EBAY-8)', () => {
  it('[RL-2] non-urgent work stops at 80% of the daily cap and urgent work at 95%; eBay itself is never reached', async () => {
    expect(EBAY_THRESHOLDS).toEqual({ nonUrgentPercent: 80, hardPercent: 95 });
    const store = memoryStore();
    const governor = new EbayGovernor(
      store,
      { 'sell.inventory': 100 },
      () => new Date('2026-11-21T12:00:00.000Z'),
    );
    const reserve = (urgent: boolean) =>
      governor.reserve(ctx, { channelAccountId: ACCOUNT, api: 'sell.inventory', urgent });
    for (let i = 0; i < 80; i += 1) expect((await reserve(false)).ok).toBe(true);
    const stopped = await reserve(false);
    expect(stopped).toMatchObject({ ok: false, calls: 80, cap: 100 });
    for (let i = 0; i < 15; i += 1) expect((await reserve(true)).ok).toBe(true);
    expect(await reserve(true)).toMatchObject({ ok: false, calls: 95, cap: 100 });
  });

  it('[EBAY-8] the call that crosses 80% says so, once, so one platform notice is raised', async () => {
    const governor = new EbayGovernor(
      memoryStore(),
      { 'sell.inventory': 10 },
      () => new Date('2026-11-21T12:00:00.000Z'),
    );
    const crossed: boolean[] = [];
    for (let i = 0; i < 9; i += 1) {
      const r = await governor.reserve(ctx, {
        channelAccountId: ACCOUNT,
        api: 'sell.inventory',
        urgent: true,
      });
      crossed.push(r.ok && r.crossedNonUrgent);
    }
    expect(crossed).toEqual([false, false, false, false, false, false, false, true, false]);
  });

  it("[RL-2] the day is eBay's US Pacific day; an unknown API is refused rather than sent uncounted", async () => {
    const store = memoryStore();
    // 06:00 UTC on 21 Nov is still 20 Nov in California.
    const governor = new EbayGovernor(
      store,
      EBAY_DAILY_CAPS,
      () => new Date('2026-11-21T06:00:00.000Z'),
    );
    await governor.reserve(ctx, {
      channelAccountId: ACCOUNT,
      api: 'sell.fulfillment',
      urgent: false,
    });
    expect([...store.calls.keys()]).toEqual(['sell.fulfillment|2026-11-20']);
    await expect(
      governor.reserve(ctx, { channelAccountId: ACCOUNT, api: 'trading.revise', urgent: false }),
    ).rejects.toThrow(/no daily cap/);
  });
});
