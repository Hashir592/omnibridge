/**
 * MSW mock of the M09 stock routes (T-0901), for the T-0317 screens. It follows the contract in
 * packages/contract/src/routes/stock.ts: one stock number per plain SKU, targets per listing
 * (INV-2, INV-10), writes only when a target changes, a version per SKU for the allocation form
 * (C7.2), client_ref replays, all-or-nothing stock-take imports and the change log (INV-5).
 * It shares SKU and listing ids with the catalogue mock, so a mapping made there shows here.
 * Pushes settle about a second later: sent, or held for the paused eBay account. Synthetic only.
 */
import { HttpResponse, http } from 'msw/http';
import type {
  AllocationPush,
  CsvImportReport,
  Movement,
  MovementKind,
  StockBuffer,
  StockDetail,
  StockListing,
  StockRow,
} from '../auth/api.ts';
import { catalogueState, type CatalogueSku } from './catalogue.ts';
import { channelAccounts, companies, orders } from './data.ts';
import { uid } from './ids.ts';
import { HOUR, ago, rng } from './random.ts';
import { channelOn, currentSession } from './session.ts';
import { skuDetail, skus as previewSkus } from './stock.ts';

interface SkuStock {
  onHand: number;
  reserved: number;
  version: number;
  lastMovementAt: string | null;
}

interface ListingStock {
  bufferOverride: number | null;
  mode: 'auto' | 'manual';
  manual: { qty: number; sold: number; set_at: string; set_by: string | null } | null;
  lastSent: number | null;
  /** FBA: units Amazon holds; otherwise what the channel last showed. */
  channelQty: number | null;
  lastPush: { at: string; result: 'pending' | 'sent' | 'held' | 'failed' } | null;
}

/** The demo admin's user id (GET /auth/session answers usr_<persona>). */
const ME = 'usr_admin';
/** "eBay · kestrel-home" is paused in the connections mock, so its writes are held. */
const HELD_ACCOUNT = 'ca_5';

let stock = new Map<string, SkuStock>();
let listingStock = new Map<string, ListingStock>();
let accountBuffers = new Map<string, number>();
let movements: Movement[] = [];
let replays = new Map<string, Movement>();

export function resetStockMock(): void {
  stock = new Map();
  listingStock = new Map();
  accountBuffers = new Map(channelAccounts.map((a) => [a.id, a.channel === 'ebay' ? 1 : 0]));
  movements = [];
  replays = new Map();
  const all = new Set(companies.map((c) => c.id));
  const r = rng(20261122);
  for (const s of previewSkus) {
    if (s.bundle) continue;
    stock.set(uid(s.id), {
      onHand: s.onHand ?? 0,
      reserved: s.reserved,
      version: 1,
      lastMovementAt: s.lastMovementAt,
    });
  }
  // INV-6: one SKU is oversold, so the Oversold view and its alert have something to show.
  const third = stock.get(uid(previewSkus[2]?.id ?? ''));
  if (third) third.reserved = third.onHand + 3;
  for (const s of previewSkus) {
    const d = skuDetail(all, s.id);
    for (const l of d?.listings ?? []) {
      listingStock.set(uid(l.id), {
        bufferOverride: l.bufferOverride ? l.buffer : null,
        mode: 'auto',
        manual: null,
        lastSent: l.fulfilment === 'FBA' ? null : l.channelQty,
        channelQty: l.channelQty,
        lastPush: l.lastPush,
      });
    }
  }
  // C7: the first SKU is on manual allocation, so the form has something to show.
  const first = catalogueState().skus[0];
  if (first) {
    for (const l of listingsOf(first.id)) {
      const ls = listingStock.get(l.id);
      if (!ls || l.fulfilment === 'fba') continue;
      ls.mode = 'manual';
      ls.manual = { qty: r.int(5, 40), sold: r.int(0, 4), set_at: ago(3 * 24 * HOUR), set_by: ME };
    }
    settle(first.id, false);
  }
  // A few movements per plain SKU, newest first.
  for (const s of catalogueState().skus) {
    const st = stock.get(s.id);
    if (!st) continue;
    let onHand = st.onHand;
    for (let i = 0; i < 6; i++) {
      const kind = r.pick(['reserve', 'dispatch', 'dispatch', 'stock_in', 'adjust'] as const);
      const qty = kind === 'stock_in' ? r.int(24, 120) : r.int(1, 3);
      const change =
        kind === 'stock_in' ? qty : kind === 'dispatch' || kind === 'adjust' ? -qty : 0;
      const order = r.pick(orders);
      movements.push({
        id: crypto.randomUUID(),
        at: ago(i * 9 * HOUR + r.int(10, 300) * 60_000),
        sku_id: s.id,
        sku: s.sku,
        kind,
        on_hand_change: change,
        reserved_change: kind === 'reserve' ? qty : kind === 'dispatch' ? -qty : 0,
        on_hand_after: onHand,
        reason: kind === 'adjust' ? 'damaged' : null,
        note: kind === 'adjust' ? 'Box crushed in the store room' : null,
        supplier: kind === 'stock_in' ? 'Marlow Supply' : null,
        source:
          kind === 'stock_in' || kind === 'adjust'
            ? { type: 'user', user_id: ME }
            : { type: 'order', ref: `${order.companyId}|${order.ref}` },
        pushes: { pending: 0, sent: change === 0 ? 0 : r.int(1, 3), held: 0, failed: 0 },
      });
      onHand -= change;
    }
  }
  movements.sort((a, b) => b.at.localeCompare(a.at));
}

const byId = (id: string) => catalogueState().skus.find((s) => s.id === id);

/** Mapped listings of a SKU that the workspace's modules show (WEB-1). */
function listingsOf(skuId: string) {
  return catalogueState().listings.filter(
    (l) => l.master_sku?.id === skuId && (l.provider !== 'website' || channelOn('website')),
  );
}

/** The plain SKU whose stock a SKU uses: itself, or a bundle's component. */
function baseOf(s: CatalogueSku): { stock: SkuStock | undefined; pack: number } {
  if (s.bundle) return { stock: stock.get(s.bundle.componentId), pack: s.bundle.packSize };
  return { stock: stock.get(s.id), pack: 1 };
}

function availableOf(s: CatalogueSku): number {
  const { stock: st, pack } = baseOf(s);
  if (!st) return 0;
  const a = st.onHand - st.reserved;
  return pack === 1 ? a : Math.floor(Math.max(0, a) / pack);
}

function bufferOf(listingId: string, accountId: string): number {
  return listingStock.get(listingId)?.bufferOverride ?? accountBuffers.get(accountId) ?? 0;
}

/** INV-2 / INV-10: the quantity a listing should show; null for FBA (INV-9). */
function targetOf(
  s: CatalogueSku,
  l: { id: string; channel_account_id: string; fulfilment: string | null },
) {
  if (l.fulfilment === 'fba') return { target: null, capped: false };
  const { stock: st, pack } = baseOf(s);
  const avail = st ? st.onHand - st.reserved : 0;
  const cap = Math.max(0, Math.floor((avail - bufferOf(l.id, l.channel_account_id)) / pack));
  const ls = listingStock.get(l.id);
  if (ls?.mode === 'manual' && ls.manual) {
    const left = ls.manual.qty - ls.manual.sold;
    return { target: Math.max(0, Math.min(left, cap)), capped: left > cap };
  }
  return { target: cap, capped: false };
}

/** SKUs whose listings move when this SKU's stock moves: itself and its bundles. */
function affected(skuId: string): CatalogueSku[] {
  const s = byId(skuId);
  if (!s) return [];
  return [s, ...catalogueState().skus.filter((b) => b.bundle?.componentId === skuId)];
}

/**
 * Recomputes targets after a change and queues a write where the target moved (INV-4). Returns
 * one push per listing looked at, for an allocation answer and the movement's counts.
 */
function settle(skuId: string, async = true, only?: Set<string>): AllocationPush[] {
  const out: AllocationPush[] = [];
  for (const s of affected(skuId)) {
    for (const l of listingsOf(s.id)) {
      if (only && !only.has(l.id)) continue;
      const ls = listingStock.get(l.id);
      const { target } = targetOf(s, l);
      if (!ls || target === null) continue;
      if (target === ls.lastSent) {
        out.push({ listing_id: l.id, result: 'unchanged' });
        continue;
      }
      const held = l.channel_account_id === HELD_ACCOUNT;
      out.push({ listing_id: l.id, result: held ? 'held' : 'queued' });
      ls.lastPush = { at: new Date().toISOString(), result: held ? 'held' : 'pending' };
      if (held) continue;
      const done = () => {
        ls.lastSent = target;
        ls.channelQty = target;
        ls.lastPush = { at: new Date().toISOString(), result: 'sent' };
      };
      if (async) setTimeout(done, 1200);
      else done();
    }
  }
  return out;
}

function bump(skuId: string): void {
  const s = byId(skuId);
  const base = s?.bundle ? s.bundle.componentId : skuId;
  for (const x of affected(base)) {
    const st = stock.get(x.id);
    if (st) st.version += 1;
  }
  const own = stock.get(skuId);
  if (own && base !== skuId) own.version += 1;
  bundleVersions.set(skuId, (bundleVersions.get(skuId) ?? 1) + 1);
  for (const x of affected(base)) bundleVersions.set(x.id, (bundleVersions.get(x.id) ?? 1) + 1);
}
/** Bundles have no stock row, so their form version lives here. */
const bundleVersions = new Map<string, number>();
const versionOf = (s: CatalogueSku) =>
  s.bundle ? (bundleVersions.get(s.id) ?? 1) : (stock.get(s.id)?.version ?? 1);

function toListing(s: CatalogueSku, l: ReturnType<typeof listingsOf>[number]): StockListing {
  const ls = listingStock.get(l.id);
  const { target, capped } = targetOf(s, l);
  return {
    id: l.id,
    channel_account_id: l.channel_account_id,
    provider: l.provider,
    external_sku: l.external_sku,
    external_id: l.external_id,
    title: l.title,
    fulfilment: l.fulfilment,
    buffer: l.fulfilment === 'fba' ? 0 : bufferOf(l.id, l.channel_account_id),
    buffer_override: ls?.bufferOverride !== null && ls?.bufferOverride !== undefined,
    target,
    capped_by_stock: capped,
    last_sent_qty: ls?.lastSent ?? null,
    channel_qty: ls?.channelQty ?? null,
    mode: ls?.mode ?? 'auto',
    manual: ls?.manual ?? null,
    sync_failed: ls?.lastPush?.result === 'failed',
    last_push: ls?.lastPush ?? null,
  };
}

function toRow(s: CatalogueSku): StockRow {
  const { stock: st } = baseOf(s);
  const ls = listingsOf(s.id).map((l) => toListing(s, l));
  const mfn = ls.filter((l) => l.fulfilment !== 'fba');
  const manual = mfn.filter((l) => l.mode === 'manual').length;
  const available = availableOf(s);
  const c = s.bundle ? byId(s.bundle.componentId) : undefined;
  return {
    sku_id: s.id,
    sku: s.sku,
    title: s.title,
    active: s.active,
    bundle:
      s.bundle && c
        ? { component_id: c.id, component_sku: c.sku, pack_size: s.bundle.packSize }
        : null,
    on_hand: s.bundle ? null : (st?.onHand ?? 0),
    reserved: s.bundle ? 0 : (st?.reserved ?? 0),
    available,
    oversold: available < 0,
    sync_failed: ls.some((l) => l.sync_failed),
    sync_mode: manual === 0 ? 'auto' : manual === mfn.length ? 'manual' : 'mixed',
    listing_count: ls.length,
    fba_count: ls.length - mfn.length,
    last_movement_at: st?.lastMovementAt ?? null,
  };
}

function toDetail(s: CatalogueSku): StockDetail {
  const listings = listingsOf(s.id).map((l) => toListing(s, l));
  const manual = listings.filter((l) => l.fulfilment !== 'fba' && l.mode === 'manual');
  return {
    ...toRow(s),
    version: versionOf(s),
    listings,
    allocation: {
      allocated: manual.reduce((a, l) => a + (l.manual?.qty ?? 0), 0),
      available: availableOf(s),
    },
    bundles: catalogueState()
      .skus.filter((b) => b.bundle?.componentId === s.id)
      .map((b) => ({
        id: b.id,
        sku: b.sku,
        pack_size: b.bundle?.packSize ?? 2,
        available: availableOf(b),
      })),
  };
}

/** An order's ref shows only when the user holds its company (ARCHITECTURE 6.1). */
function visible(m: Movement): Movement {
  if (m.source.type !== 'order' || m.source.ref === null) return m;
  const [company, ref] = m.source.ref.split('|');
  const held = currentSession().companies.some((c) => c.id === company);
  return { ...m, source: { type: 'order', ref: held ? (ref ?? null) : null } };
}

const problem = (status: number, code: string, detail?: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Error', status, code, ...(detail ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
const BUNDLE_REFUSED = 'A bundle has no stock of its own: move its component instead.';
const hasTab = () => currentSession().tabs.includes('stock');

function paged<T>(rows: T[], p: URLSearchParams) {
  const limit = [20, 50, 100].includes(Number(p.get('limit'))) ? Number(p.get('limit')) : 50;
  const page = Math.max(1, Number(p.get('page') ?? 1) || 1);
  return {
    items: rows.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total: rows.length,
    totalCapped: false,
  };
}

function filterMovements(p: URLSearchParams): Movement[] {
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(iso));
  return movements
    .filter(
      (m) =>
        (!p.get('sku_id') || m.sku_id === p.get('sku_id')) &&
        (!p.get('kind') || m.kind === p.get('kind')) &&
        (!p.get('source') || m.source.type === p.get('source')) &&
        (!p.get('from') || day(m.at) >= (p.get('from') ?? '')) &&
        (!p.get('to') || day(m.at) <= (p.get('to') ?? '')),
    )
    .map(visible);
}

/** Books a movement on a plain SKU, settles its listings and logs it (INV-3, INV-5). */
function book(
  s: CatalogueSku,
  kind: MovementKind,
  change: number,
  extra: Pick<Movement, 'reason' | 'note' | 'supplier'>,
): Movement {
  const st = stock.get(s.id);
  if (!st) throw new Error('no stock row');
  st.onHand += change;
  const at = new Date().toISOString();
  st.lastMovementAt = at;
  bump(s.id);
  const pushes = settle(s.id);
  const m: Movement = {
    id: crypto.randomUUID(),
    at,
    sku_id: s.id,
    sku: s.sku,
    kind,
    on_hand_change: change,
    reserved_change: 0,
    on_hand_after: st.onHand,
    ...extra,
    source: { type: 'user', user_id: ME },
    pushes: {
      pending: pushes.filter((x) => x.result === 'queued').length,
      sent: 0,
      held: pushes.filter((x) => x.result === 'held').length,
      failed: 0,
    },
  };
  movements.unshift(m);
  return m;
}

function csvRows(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((h) => h.trim().toLowerCase());
  return {
    header,
    rows: lines.slice(1).flatMap((raw, i) => {
      if (!raw.trim()) return [];
      const parts = raw.split(',').map((x) => x.trim());
      return [
        { line: i + 2, cells: Object.fromEntries(header.map((h, j) => [h, parts[j] ?? ''])) },
      ];
    }),
  };
}

export const stockHandlers = [
  http.get('*/api/stock', ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const p = new URL(request.url).searchParams;
    const q = (p.get('q') ?? '').toLowerCase();
    const f = p.get('filter');
    const rows = catalogueState()
      .skus.filter(
        (s) => !q || s.sku.toLowerCase().includes(q) || s.title.toLowerCase().includes(q),
      )
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map(toRow)
      .filter(
        (r) =>
          !f ||
          (f === 'oversold' && r.oversold) ||
          (f === 'sync_failed' && r.sync_failed) ||
          (f === 'manual' && r.sync_mode !== 'auto') ||
          (f === 'bundles' && r.bundle !== null),
      );
    return HttpResponse.json(paged(rows, p));
  }),
  http.get('*/api/stock/movements/export', ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const rows = filterMovements(new URL(request.url).searchParams);
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const text = [
      'at,sku,kind,on_hand_change,reserved_change,on_hand_after,reason,note,supplier,source',
      ...rows.map((m) =>
        [
          m.at,
          m.sku,
          m.kind,
          String(m.on_hand_change),
          String(m.reserved_change),
          String(m.on_hand_after),
          m.reason ?? '',
          m.note ?? '',
          m.supplier ?? '',
          m.source.type === 'order' ? (m.source.ref ?? 'another company') : m.source.type,
        ]
          .map(cell)
          .join(','),
      ),
    ].join('\n');
    return new HttpResponse(`﻿${text}\n`, {
      headers: { 'content-type': 'text/csv; charset=utf-8' },
    });
  }),
  http.get('*/api/stock/movements', ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const p = new URL(request.url).searchParams;
    return HttpResponse.json(paged(filterMovements(p), p));
  }),
  http.get('*/api/stock/buffers', () => {
    if (!hasTab()) return problem(403, 'forbidden');
    const allowed = new Set(currentSession().companies.map((c) => c.id));
    const items: StockBuffer[] = channelAccounts
      .filter((a) => allowed.has(a.companyId) && channelOn(a.channel))
      .map((a) => ({
        channel_account_id: a.id,
        provider: a.channel,
        display_name: a.name,
        buffer: accountBuffers.get(a.id) ?? 0,
      }));
    return HttpResponse.json({ items });
  }),
  http.put('*/api/stock/buffers/:accountId', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const a = channelAccounts.find((x) => x.id === params.accountId);
    if (!a) return problem(404, 'not_found');
    const { buffer } = (await request.json()) as { buffer: number };
    accountBuffers.set(a.id, buffer);
    for (const s of catalogueState().skus) {
      if (listingsOf(s.id).some((l) => l.channel_account_id === a.id)) {
        bump(s.id);
        settle(s.id);
      }
    }
    return HttpResponse.json<StockBuffer>({
      channel_account_id: a.id,
      provider: a.channel,
      display_name: a.name,
      buffer,
    });
  }),
  http.put('*/api/stock/listings/:listingId/buffer', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const l = catalogueState().listings.find((x) => x.id === params.listingId);
    const ls = listingStock.get(String(params.listingId));
    const s = l?.master_sku ? byId(l.master_sku.id) : undefined;
    if (!l || !ls || !s) return problem(404, 'not_found');
    if (l.fulfilment === 'fba')
      return problem(
        409,
        'conflict',
        'Fulfilled by Amazon: OmniBridge does not manage this stock.',
      );
    const { buffer } = (await request.json()) as { buffer: number | null };
    ls.bufferOverride = buffer;
    bump(s.id);
    settle(s.id, true, new Set([l.id]));
    return HttpResponse.json(toListing(s, l));
  }),
  http.post('*/api/stock/stock-take/import', async ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const { csv, dry_run } = (await request.json()) as { csv: string; dry_run: boolean };
    const { header, rows } = csvRows(csv);
    for (const c of ['sku', 'on_hand'])
      if (!header.includes(c))
        return HttpResponse.json<CsvImportReport>({
          rows: 0,
          valid: 0,
          applied: false,
          errors: [{ line: 1, code: 'column_missing', column: c }],
        });
    const errors: CsvImportReport['errors'] = [];
    const seen = new Set<string>();
    const good: Array<{ s: CatalogueSku; count: number }> = [];
    for (const { line, cells } of rows) {
      const s = catalogueState().skus.find((x) => x.sku === cells.sku);
      const count = /^\d+$/.test(cells.on_hand ?? '') ? Number(cells.on_hand) : null;
      if (!s) errors.push({ line, code: 'sku_unknown', column: 'sku' });
      else if (s.bundle) errors.push({ line, code: 'bundle_stock', column: 'sku' });
      if (count === null) errors.push({ line, code: 'quantity_invalid', column: 'on_hand' });
      if (seen.has(cells.sku ?? '')) errors.push({ line, code: 'duplicate', column: null });
      seen.add(cells.sku ?? '');
      if (s && !s.bundle && count !== null) good.push({ s, count });
    }
    const apply = !dry_run && errors.length === 0 && rows.length > 0;
    if (apply) {
      for (const { s, count } of good) {
        const st = stock.get(s.id);
        if (st && st.onHand !== count)
          book(s, 'stock_take', count - st.onHand, { reason: null, note: null, supplier: null });
      }
    }
    return HttpResponse.json<CsvImportReport>({
      rows: rows.length,
      valid: rows.length - new Set(errors.map((e) => e.line)).size,
      applied: apply,
      errors,
    });
  }),
  http.get('*/api/stock/:skuId', ({ params }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.skuId));
    return s ? HttpResponse.json(toDetail(s)) : problem(404, 'not_found');
  }),
  http.post('*/api/stock/:skuId/stock-in', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.skuId));
    if (!s) return problem(404, 'not_found');
    if (s.bundle) return problem(409, 'conflict', BUNDLE_REFUSED);
    const b = (await request.json()) as {
      quantity: number;
      supplier?: string;
      notes?: string;
      client_ref: string;
    };
    const again = replays.get(b.client_ref);
    if (again) return HttpResponse.json(again, { status: 201 });
    const m = book(s, 'stock_in', b.quantity, {
      reason: null,
      note: b.notes ?? null,
      supplier: b.supplier ?? null,
    });
    replays.set(b.client_ref, m);
    return HttpResponse.json(m, { status: 201 });
  }),
  http.post('*/api/stock/:skuId/adjustments', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.skuId));
    if (!s) return problem(404, 'not_found');
    if (s.bundle) return problem(409, 'conflict', BUNDLE_REFUSED);
    const b = (await request.json()) as {
      delta: number;
      reason: Movement['reason'];
      text?: string;
      client_ref: string;
    };
    if (b.reason === 'other' && !b.text) return problem(409, 'conflict', 'Say what happened.');
    const again = replays.get(b.client_ref);
    if (again) return HttpResponse.json(again, { status: 201 });
    const m = book(s, 'adjust', b.delta, {
      reason: b.reason,
      note: b.text ?? null,
      supplier: null,
    });
    replays.set(b.client_ref, m);
    return HttpResponse.json(m, { status: 201 });
  }),
  http.put('*/api/stock/:skuId/allocation', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.skuId));
    if (!s) return problem(404, 'not_found');
    const b = (await request.json()) as {
      version: number;
      listings: Array<{ listing_id: string; mode: 'auto' | 'manual'; manual_qty?: number }>;
    };
    if (b.version !== versionOf(s))
      return problem(
        409,
        'version_conflict',
        'Stock or settings changed while you were editing. Review and save again.',
      );
    // Bundle listings of this SKU may be named too (the product switch covers them, C7.3).
    const covered = new Map(
      affected(s.id).flatMap((x) => listingsOf(x.id).map((l) => [l.id, { s: x, l }] as const)),
    );
    for (const x of b.listings) {
      const hit = covered.get(x.listing_id);
      if (!hit) return problem(409, 'conflict', 'That listing is not one of this SKU’s.');
      if (hit.l.fulfilment === 'fba')
        return problem(
          409,
          'conflict',
          'Fulfilled by Amazon: OmniBridge does not manage this stock.',
        );
      if (x.mode === 'manual' && x.manual_qty === undefined)
        return problem(409, 'conflict', 'Enter the quantity this listing should show.');
    }
    const at = new Date().toISOString();
    const touched = new Set<string>();
    for (const x of b.listings) {
      const ls = listingStock.get(x.listing_id);
      if (!ls) continue;
      touched.add(x.listing_id);
      if (x.mode === 'auto') {
        ls.mode = 'auto';
        ls.manual = null;
      } else {
        const qty = x.manual_qty ?? 0;
        const keepSold = ls.mode === 'manual' && ls.manual?.qty === qty;
        ls.mode = 'manual';
        ls.manual = { qty, sold: keepSold ? (ls.manual?.sold ?? 0) : 0, set_at: at, set_by: ME };
      }
    }
    bump(s.id);
    const pushes = settle(s.bundle ? s.bundle.componentId : s.id, true, touched);
    const st = baseOf(s).stock;
    movements.unshift({
      id: crypto.randomUUID(),
      at,
      sku_id: s.id,
      sku: s.sku,
      kind: 'allocation',
      on_hand_change: 0,
      reserved_change: 0,
      on_hand_after: st?.onHand ?? 0,
      reason: null,
      note: `Allocation saved for ${String(touched.size)} listing${touched.size === 1 ? '' : 's'}`,
      supplier: null,
      source: { type: 'user', user_id: ME },
      pushes: {
        pending: pushes.filter((x) => x.result === 'queued').length,
        sent: 0,
        held: pushes.filter((x) => x.result === 'held').length,
        failed: 0,
      },
    });
    return HttpResponse.json({ stock: toDetail(s), pushes });
  }),
  http.post('*/api/stock/:skuId/allocation/auto', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.skuId));
    if (!s) return problem(404, 'not_found');
    const b = (await request.json()) as { listing_ids?: string[]; include_bundles?: boolean };
    const pool = (b.include_bundles ? affected(s.id) : [s]).flatMap((x) => listingsOf(x.id));
    const ids = new Set(
      pool
        .filter((l) => l.fulfilment !== 'fba' && (!b.listing_ids || b.listing_ids.includes(l.id)))
        .map((l) => l.id),
    );
    for (const id of ids) {
      const ls = listingStock.get(id);
      if (!ls) continue;
      ls.mode = 'auto';
      ls.manual = null;
      // Back to Auto queues one write per listing straight away (C7.2), even if unchanged.
      ls.lastSent = null;
    }
    bump(s.id);
    const pushes = settle(s.bundle ? s.bundle.componentId : s.id, true, ids);
    return HttpResponse.json({ stock: toDetail(s), pushes });
  }),
];

resetStockMock();
