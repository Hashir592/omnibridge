import { getResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { handlers, piiViewLog } from './handlers.ts';
import type { HomeSummary } from './home.ts';
import { setPersona } from './session.ts';
import { createLabels, defaultWeightGrams, ruleFor } from './shipping.ts';
import type { OrderDetail, OrderPage, OrderRow } from './types.ts';

// The mock API stands in for the server in the mock-ups, so it must already behave the way the
// server will: masking in lists, permission filtering, and the PII view log.

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await getResponse(handlers, new Request(`http://localhost${path}`));
  if (!res) throw new Error(`no mock handler for ${path}`);
  return { status: res.status, body: await res.json() };
}

const page = async (path: string) => (await get(path)).body as OrderPage;
const home = async (path: string) => (await get(path)).body as HomeSummary;

afterEach(() => {
  setPersona('admin');
});

describe('mock orders API', () => {
  it('[ORD-5] list rows carry only a masked ship-to, never buyer details', async () => {
    const body = await page('/api/mock/orders?limit=100');
    expect(body.items).toHaveLength(100);
    for (const row of body.items) {
      expect(row).not.toHaveProperty('buyer');
      expect(row.shipToMasked).toMatch(/^[A-Z]\. [A-Z]\*\*\*, [A-Z]{1,2}\d{1,2}$/);
    }
  });

  it('[ORD-5] logs every full view of buyer details with the user and order', async () => {
    const before = piiViewLog.length;
    const res = await get('/api/mock/orders/ord_0001');
    const status = res.status;
    const body = res.body as OrderDetail;
    expect(status).toBe(200);
    expect(body.buyer.name).not.toBe('');
    expect(piiViewLog).toHaveLength(before + 1);
    expect(piiViewLog.at(-1)).toMatchObject({ user: 'Sam Admin', orderId: 'ord_0001' });
  });

  it('[TEN-5] Combined means the permitted companies only', async () => {
    const admin = await page('/api/mock/orders?limit=100&company=all');
    setPersona('packer');
    const packer = await page('/api/mock/orders?limit=100&company=all');
    expect(packer.total).toBeLessThan(admin.total);
    expect(packer.items.some((o: OrderRow) => o.companyId === 'co_3')).toBe(false);
  });

  it('[PERM-3] a child cannot open an order of a company they were not given', async () => {
    const body = await page('/api/mock/orders?limit=100&company=co_3');
    const hidden = body.items[0];
    expect(hidden).toBeDefined();
    setPersona('packer');
    const before = piiViewLog.length;
    const { status } = await get(`/api/mock/orders/${hidden?.id ?? ''}`);
    expect(status).toBe(404);
    expect(piiViewLog).toHaveLength(before);
    const filtered = await page('/api/mock/orders?company=co_3');
    expect(filtered.total).toBe(0);
  });

  it('[NFR-8] pages hold 20, 50 or 100 rows and fall back to 50', async () => {
    for (const [limit, want] of [
      ['20', 20],
      ['100', 100],
      ['7', 50],
      ['', 50],
    ] as const) {
      const body = await page(`/api/mock/orders?limit=${limit}`);
      // A page runs past the limit only to finish the same-buyer group its limit row is in (C3).
      // The mock data moves with today's date, so whether a group straddles the cut varies.
      const cutGroup = body.items[want - 1]?.group?.id;
      const extra = body.items.slice(want);
      expect(body.items.length).toBeGreaterThanOrEqual(want);
      expect(extra.every((o) => cutGroup !== undefined && o.group?.id === cutGroup)).toBe(true);
    }
  });

  // C3.3: "Pagination never splits a group: a page may run over 50 rows to keep a group whole."
  // These hold on any date, unlike the check above, whose cut may or may not land in a group.
  const walk = async (limit: number) => {
    const pages: Array<OrderPage['items']> = [];
    let cursor: number | null = 0;
    let total = 0;
    while (cursor !== null) {
      const body = await page(`/api/mock/orders?limit=${String(limit)}&cursor=${String(cursor)}`);
      pages.push(body.items);
      total = body.total;
      cursor = body.nextCursor;
    }
    return { pages, total };
  };

  it('[NFR-8] paging never splits a same-buyer group and never loses or repeats a row', async () => {
    for (const limit of [20, 50, 100]) {
      const { pages, total } = await walk(limit);
      const ids = pages.flat().map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(total);
      const pageOfGroup = new Map<string, number>();
      pages.forEach((items, n) => {
        for (const o of items) {
          const g = o.group?.id;
          if (g === undefined) continue;
          expect({ g, page: pageOfGroup.get(g) ?? n }).toEqual({ g, page: n });
          pageOfGroup.set(g, n);
        }
      });
    }
  });

  it('[NFR-8] a page cut inside a same-buyer group runs on to finish it', async () => {
    const all = (await walk(100)).pages.flat();
    const k = all.findIndex(
      (o, i) => i >= 19 && o.group?.id !== undefined && all[i + 1]?.group?.id === o.group.id,
    );
    expect(k).toBeGreaterThan(-1);
    // A 20-row page whose 20th row is all[k]: the cut falls inside that group.
    const body = await page(`/api/mock/orders?limit=20&cursor=${String(k - 19)}`);
    const group = all[k]?.group?.id;
    expect(body.items.length).toBeGreaterThan(20);
    expect(body.items.slice(20).every((o) => o.group?.id === group)).toBe(true);
    expect(all[k - 19 + body.items.length]?.group?.id).not.toBe(group);
  });
});

describe('mock home summary', () => {
  it('[HOME-2] a child only gets the tiles and alerts for their tabs', async () => {
    const admin = await home('/api/mock/home?company=all');
    expect(admin.sales).not.toBeNull();
    expect(admin.alerts.some((a) => a.to === '/connections')).toBe(true);

    setPersona('packer');
    const packer = await home('/api/mock/home?company=all');
    expect(packer.sales).toBeNull();
    expect(packer.reminders).toBeNull();
    expect(packer.dispatch).not.toBeNull();
    expect(packer.alerts.every((a) => a.need === 'orders' || a.need === 'shipping')).toBe(true);
    expect(packer.tasks.some((t) => t.to === '/users')).toBe(false);
  });
});

describe('mock shipping rules', () => {
  const base = {
    id: 'ord_x',
    ref: 'W1',
    channel: 'website',
    channelAccountId: 'ca_4',
    companyId: 'co_2',
    placedAt: '2026-10-19T08:00:00Z',
    status: 'awaiting_dispatch',
    itemCount: 2,
    totalPence: 2000,
    shipping: null,
    tracking: 'none',
    flags: [],
    shipToMasked: 'A. B***, G2',
    delivery: 'standard',
  } satisfies Omit<OrderRow, 'shipBy'>;
  const later: OrderRow = { ...base, shipBy: new Date(Date.now() + 5 * 86_400_000).toISOString() };
  const late: OrderRow = { ...base, shipBy: new Date(Date.now() - 3_600_000).toISOString() };

  it('[SHP-2] weight defaults to the SKU weights plus the packaging allowance', () => {
    expect(defaultWeightGrams(later)).toBe(2 * 340 + 150);
  });

  it('[SHP-3] the first matching rule wins', () => {
    expect(ruleFor(late, 2500).serviceId).toBe('dpd-nd'); // weight rule comes first
    expect(ruleFor(late, 800).serviceId).toBe('evri-nd');
    expect(ruleFor(later, 800).serviceId).toBe('evri-48');
  });

  it('[SHP-2] creates one label per order and reports carrier rejections per order', async () => {
    const bad: OrderRow = { ...later, id: 'ord_y', ref: 'W2', flags: ['address_shortened'] };
    const res = await createLabels([later, bad], { ord_x: 'evri-48', ord_y: 'evri-48' });
    expect(res.map((r) => r.ok)).toEqual([true, false]);
    expect(res[0]?.trackingNumber).toMatch(/^H01/);
    expect(res[1]?.error).toMatch(/rejected the address/);
  });
});
