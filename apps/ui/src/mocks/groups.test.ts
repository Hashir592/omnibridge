import { describe, expect, it } from 'vitest';
import { orders } from './data.ts';
import { computeGroups } from './groups.ts';
import { orderPage } from './orderList.ts';
import { SCENARIOS, londonInstant } from './scenarios.ts';

// T-0306 mock grouping follows client change C3.1 (ORD-9). The real tests (AT-26) belong to M10;
// these prove the mock data shows every case the client asked to see.
const refOf = (id: string) => orders.find((o) => o.id === id)?.ref ?? id;
const groups = computeGroups(orders);
const groupWith = (id: string) => groups.find((g) => g.memberIds.includes(id));

describe('same-buyer groups in the mock data', () => {
  it('[ORD-9] 23:59 and 00:01 on adjacent London days form one group', () => {
    expect(groupWith('ord_0490')?.memberIds.sort()).toEqual(['ord_0490', 'ord_0491']);
  });

  it('[ORD-9] case and spacing differences in the name and postcode still match', () => {
    const second = SCENARIOS.find((s) => s.replaces === 'ord_0491');
    expect(second?.buyer.name).not.toBe('Maya Marsden');
    expect(groupWith('ord_0491')).toBeDefined();
  });

  it('[ORD-9] 10:00 and 22:00 on the same London day form one group', () => {
    expect(groupWith('ord_0492')?.memberIds.sort()).toEqual(['ord_0492', 'ord_0493']);
  });

  it('[ORD-9] a three-order group warns about different ship-by dates and services', () => {
    const g = groupWith('ord_0494');
    expect(g?.memberIds).toHaveLength(3);
    expect(g?.warnings.join(' ')).toMatch(/Ship by the earliest: \d{2}\/\d{2}\/\d{4}/);
    expect(g?.warnings).toContain('One order paid for Next Day');
    expect(g?.warnings).toContain(`Address shortened on ${refOf('ord_0496')}`);
  });

  it('[ORD-9] the same address with a different name is not grouped', () => {
    expect(groupWith('ord_0497')).toBeUndefined();
    expect(groupWith('ord_0498')).toBeUndefined();
  });

  it('[ORD-9] the same buyer on two different eBay accounts is not grouped', () => {
    expect(groupWith('ord_0499')).toBeUndefined();
    expect(groupWith('ord_0500')).toBeUndefined();
  });

  it('[ORD-9] the list keeps a group together and counts members a filter hides', () => {
    const page = orderPage(orders, new URLSearchParams({ q: refOf('ord_0495') }));
    const row = page.items.find((o) => o.id === 'ord_0495');
    expect(row?.group?.hidden).toBe(2);
    const all = orderPage(orders, new URLSearchParams({ view: 'awaiting', limit: '100' }));
    const idx = all.items.map((o) => o.id);
    const at = ['ord_0494', 'ord_0495', 'ord_0496']
      .map((id) => idx.indexOf(id))
      .sort((a, b) => a - b);
    expect(at).toEqual([at[0], (at[0] ?? 0) + 1, (at[0] ?? 0) + 2]); // adjacent rows
    expect(at[0]).toBeGreaterThanOrEqual(0);
  });

  it('[ORD-9] a page never splits a group', () => {
    for (let cursor = 0; cursor < 120; cursor += 20) {
      const page = orderPage(
        orders,
        new URLSearchParams({ view: 'awaiting', limit: '20', cursor: String(cursor) }),
      );
      const first = page.items[0];
      const last = page.items[page.items.length - 1];
      if (first?.group) expect(first.group.index).toBe(0);
      if (last?.group) expect(last.group.last).toBe(true);
    }
  });

  it('[ORD-9] London days come from the time-zone rules, not the server clock', () => {
    // 25/10/2026: the clocks go back at 02:00, so 00:01 is still BST and 03:00 is GMT.
    const day = Date.parse('2026-10-25T12:00:00Z');
    expect(new Date(londonInstant(0, 0, 1, day)).toISOString()).toBe('2026-10-24T23:01:00.000Z');
    expect(new Date(londonInstant(0, 3, 0, day)).toISOString()).toBe('2026-10-25T03:00:00.000Z');
    const summer = londonInstant(0, 23, 59, Date.parse('2026-07-01T12:00:00Z'));
    expect(new Date(summer).toISOString()).toBe('2026-07-01T22:59:00.000Z');
  });
});
