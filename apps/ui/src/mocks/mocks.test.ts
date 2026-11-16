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
