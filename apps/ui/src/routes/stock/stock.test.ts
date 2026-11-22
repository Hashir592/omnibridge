import { describe, expect, it } from 'vitest';
import type { StockListing } from '../../auth/api.ts';
import {
  OVER_ALLOCATED,
  VERSION_CONFLICT,
  adjustBody,
  allocatedOf,
  allocationBody,
  filterOf,
  formRows,
  previewTarget,
  pushesText,
  signed,
  sourceText,
  startingQty,
  stateOf,
  stockInBody,
  type AllocRow,
} from './rules.ts';

const REF = '7f1c2a3b-4d5e-4f60-8a71-0000000000aa';

function listing(over: Partial<StockListing> = {}): StockListing {
  return {
    id: '5a1e9d3c-7f20-4e8a-b1c4-000000000001',
    channel_account_id: '5a1e9d3c-7f20-4e8a-b1c4-0000000000a1',
    channel_account_name: null,
    provider: 'ebay',
    external_sku: 'BB-BAM-M100',
    external_id: '284519003117',
    title: null,
    fulfilment: null,
    buffer: 0,
    buffer_override: false,
    target: 40,
    capped_by_stock: false,
    last_sent_qty: 38,
    channel_qty: 37,
    mode: 'auto',
    manual: null,
    sync_failed: false,
    last_push: null,
    ...over,
  };
}

const row = (over: Partial<AllocRow> = {}): AllocRow => ({
  listing: listing(),
  pack: 1,
  bundleSku: null,
  mode: 'manual',
  qty: '10',
  ...over,
});

describe('targets (INV-2, INV-10)', () => {
  it('[AT-27] manual numbers limit a channel but never show more than real stock', () => {
    const t = (available: number, mode: 'auto' | 'manual', qty: number, sold: number) =>
      previewTarget({ available, buffer: 0, pack: 1, mode, qty, sold });
    // 1. Available 186: A = 120, B = 10, C stays on Auto.
    expect(t(186, 'manual', 120, 0)).toEqual({ target: 120, capped: false });
    expect(t(186, 'manual', 10, 0)).toEqual({ target: 10, capped: false });
    expect(t(186, 'auto', 0, 0).target).toBe(186);
    // 2. Sell 5 on B: B = 5, A = 120, C follows available 181.
    expect(t(181, 'manual', 10, 5).target).toBe(5);
    expect(t(181, 'manual', 120, 0).target).toBe(120);
    expect(t(181, 'auto', 0, 0).target).toBe(181);
    // 3. Available 50 by adjustment: A is capped to 50 with the badge.
    expect(t(50, 'manual', 120, 0)).toEqual({ target: 50, capped: true });
    // 4. Back to Auto: every listing gets max(0, available − buffer).
    expect(t(50, 'auto', 0, 0).target).toBe(50);
  });

  it('[INV-10] bundles divide by the pack size and round down; nothing goes below 0', () => {
    expect(
      previewTarget({ available: 11, buffer: 1, pack: 3, mode: 'auto', qty: 0, sold: 0 }).target,
    ).toBe(3);
    expect(
      previewTarget({ available: -4, buffer: 0, pack: 1, mode: 'auto', qty: 0, sold: 0 }).target,
    ).toBe(0);
    expect(
      previewTarget({ available: 20, buffer: 0, pack: 1, mode: 'manual', qty: 3, sold: 5 }).target,
    ).toBe(0);
  });
});

describe('allocation form (C7.2)', () => {
  it('[INV-10] switching to Manual starts every merchant-fulfilled listing from what it shows now', () => {
    const fba = listing({ id: 'fba', fulfilment: 'fba', target: null });
    const rows = formRows([listing(), fba], [], true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'manual', qty: '38', pack: 1 });
    expect(
      startingQty(
        listing({ manual: { qty: 12, sold: 2, set_at: '2026-11-20T10:00:00Z', set_by: null } }),
      ),
    ).toBe(12);
  });

  it('[INV-10] the save names every listing, with a number for each manual one', () => {
    const body = allocationBody(7, [
      row({ qty: '120' }),
      row({ listing: listing({ id: 'b' }), mode: 'auto', qty: '' }),
    ]);
    expect(body).toEqual({
      version: 7,
      listings: [
        { listing_id: listing().id, mode: 'manual', manual_qty: 120 },
        { listing_id: 'b', mode: 'auto' },
      ],
    });
    expect(allocationBody(7, [row({ qty: 'x' })])).toBeNull();
    expect(allocationBody(7, [row({ qty: '-1' })])).toBeNull();
  });

  it('[INV-10] counts a bundle allocation in component units and warns in the agreed words', () => {
    expect(
      allocatedOf([row({ qty: '120' }), row({ qty: '10', pack: 3 }), row({ mode: 'auto' })]),
    ).toBe(150);
    expect(OVER_ALLOCATED).toBe('More allocated than you have. Listings will be capped by stock.');
    expect(VERSION_CONFLICT).toBe(
      'Stock or settings changed while you were editing. Review and save again.',
    );
  });
});

describe('movements by hand (INV-3)', () => {
  it('[INV-3] an adjustment needs a non-zero change, a reason, and text for Other', () => {
    expect(adjustBody({ delta: '0', reason: 'lost', text: '' }, 10, REF).ok).toBe(false);
    expect(adjustBody({ delta: '-11', reason: 'lost', text: '' }, 10, REF)).toMatchObject({
      ok: false,
      errors: { delta: 'On hand cannot go below 0 (now 10)' },
    });
    expect(adjustBody({ delta: '2', reason: 'other', text: ' ' }, 10, REF)).toMatchObject({
      ok: false,
      errors: { text: 'Say what happened' },
    });
    expect(adjustBody({ delta: '−2', reason: 'damaged', text: '' }, 10, REF)).toEqual({
      ok: true,
      body: { delta: -2, reason: 'damaged', client_ref: REF },
    });
  });

  it('[INV-3] a stock-in is 1 or more units and carries its client_ref for a safe resend', () => {
    expect(stockInBody({ quantity: '0', supplier: '', notes: '' }, REF).ok).toBe(false);
    expect(stockInBody({ quantity: '24', supplier: ' Marlow ', notes: '' }, REF)).toEqual({
      ok: true,
      body: { quantity: 24, supplier: 'Marlow', client_ref: REF },
    });
  });
});

describe('list and change log', () => {
  it('[INV-6] [INV-8] shows the most urgent state and maps views to the server filter', () => {
    const base = { active: true, oversold: false, sync_failed: false, available: 5 };
    expect(stateOf({ ...base, oversold: true, sync_failed: true, available: -2 })).toBe('oversold');
    expect(stateOf({ ...base, sync_failed: true })).toBe('sync_failed');
    expect(stateOf({ ...base, available: 0 })).toBe('out');
    expect(stateOf({ ...base, active: false, oversold: true })).toBe('inactive');
    expect(filterOf('sync')).toBe('sync_failed');
    expect(filterOf('all')).toBeUndefined();
  });

  it('[INV-5] names the source and the pushes; an order of another company stays hidden', () => {
    expect(sourceText({ type: 'order', ref: null }, 'u1')).toBe('Order of another company');
    expect(sourceText({ type: 'order', ref: '204-1' }, 'u1')).toBe('Order 204-1');
    expect(sourceText({ type: 'user', user_id: 'u1', name: null }, 'u1')).toBe('You');
    expect(sourceText({ type: 'user', user_id: 'u2', name: null }, 'u1')).toBe('A team member');
    expect(pushesText({ pending: 0, sent: 0, held: 0, failed: 0 }).tone).toBe('none');
    expect(pushesText({ pending: 0, sent: 2, held: 0, failed: 1 }).text).toBe('1 of 3 failed');
    expect(pushesText({ pending: 0, sent: 3, held: 0, failed: 0 }).text).toBe('3 sent');
    expect(signed(-3)).toBe('−3');
  });
});
