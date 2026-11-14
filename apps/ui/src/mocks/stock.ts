/**
 * Stock & Catalogue for the client preview (T-0305). PROPOSED SHAPE (mock only): Master SKUs
 * (CAT-1..4), listings per channel account (CAT-5) and stock (INV-1..9). Synthetic names only.
 * Master SKUs are workspace-wide; listings are filtered to the user's permitted companies
 * (invariant 4), so a child never sees another company's listings.
 */
import { channelAccounts, orders } from './data.ts';
import { DAY, HOUR, ago, rng } from './random.ts';
import type { Channel, ChannelAccount } from './types.ts';

export type VatType = 'standard' | 'reduced' | 'zero' | 'none';
export const VAT_LABEL: Record<VatType, string> = {
  standard: 'Standard 20%',
  reduced: 'Reduced 5%',
  zero: 'Zero-rated 0%',
  none: 'No VAT',
};

/** VAT type as two lines in a table cell: name and rate. */
export const VAT_PARTS: Record<VatType, [string, string]> = {
  standard: ['Standard', '20%'],
  reduced: ['Reduced', '5%'],
  zero: ['Zero-rated', '0%'],
  none: ['No VAT', 'Exempt or outside scope'],
};

export type SkuState = 'in_stock' | 'low' | 'out' | 'oversold' | 'sync_failed' | 'inactive';

export interface SkuRow {
  id: string;
  sku: string;
  title: string;
  manufacturer: string;
  vat: VatType;
  /** CAT-3: a pack of one other Master SKU; it has no stock of its own. */
  bundle: { componentId: string; componentSku: string; pack: number } | null;
  onHand: number | null;
  reserved: number;
  available: number;
  /** Days of cover at the last 30 days' sales rate (Estimate, FC). */
  coverDays: number | null;
  cogsPence: number;
  listings: { total: number; channels: Channel[]; fba: number };
  state: SkuState;
  lastMovementAt: string;
  active: boolean;
}

export interface Listing {
  id: string;
  channelAccountId: string;
  channel: Channel;
  companyId: string;
  externalSku: string;
  externalId: string; // ASIN, eBay item ID or website product ID
  title: string;
  fulfilment: 'MFN' | 'FBA';
  buffer: number;
  bufferOverride: boolean;
  channelQty: number | null; // FBA: units Amazon holds (read only)
  lastPush: { at: string; result: 'sent' | 'failed' | 'held' } | null;
}

export interface UnmappedListing {
  id: string;
  channelAccountId: string;
  channel: Channel;
  companyId: string;
  externalSku: string;
  externalId: string;
  title: string;
  fulfilment: 'MFN' | 'FBA';
  foundAt: string;
  openOrders: number;
  suggestion: { id: string; sku: string; title: string } | null;
}

export interface Movement {
  id: string;
  at: string;
  change: number;
  onHandAfter: number;
  kind: 'order' | 'cancel' | 'dispatch' | 'stock_in' | 'adjust' | 'return' | 'stock_take';
  reason: string;
  source: { type: 'order'; ref: string; orderId: string } | { type: 'user'; name: string };
  pushed: number;
  pushFailed: number;
}

export interface SkuDetail {
  sku: SkuRow;
  description: string;
  barcode: string | null;
  weightGrams: number;
  dimensionsMm: [number, number, number] | null;
  cogsHistory: Array<{ from: string; pence: number; by: string }>;
  reorder: { leadDays: number; safetyDays: number; targetCoverDays: number; suggestUnits: number };
  listings: Listing[];
  bundles: Array<{ id: string; sku: string; pack: number; available: number }>;
  movements: Movement[];
  sold30: number;
}

export type StockView = 'all' | 'low' | 'oversold' | 'sync' | 'bundles' | 'unmapped';

export interface SkuCounts {
  all: number;
  low: number;
  oversold: number;
  sync: number;
  bundles: number;
  unmapped: number;
}

export interface SkuPage {
  items: SkuRow[];
  total: number;
  counts: SkuCounts;
}

export interface UnmappedPage {
  items: UnmappedListing[];
  total: number;
  counts: SkuCounts;
}

const r = rng(20261021);

const MAKERS = ['Brightwell', 'Calder & Finch', 'Otterly', 'Penrose Works', 'Marlow Supply'];
const MATERIALS = ['Bamboo', 'Oak', 'Enamel', 'Linen', 'Stoneware', 'Copper', 'Cotton', 'Steel'];
const THINGS: Array<[string, string, VatType]> = [
  ['chopping board', 'CB', 'standard'],
  ['storage jar', 'SJ', 'standard'],
  ['tea towel set', 'TT', 'standard'],
  ['plant pot', 'PP', 'standard'],
  ['coat hook', 'CH', 'standard'],
  ['serving tray', 'ST', 'standard'],
  ['baby bib', 'BB', 'zero'],
  ['children’s cup', 'CC', 'zero'],
  ['loose leaf tea', 'LT', 'zero'],
  ['energy saving bulb', 'EB', 'reduced'],
  ['gift voucher', 'GV', 'none'],
  ['oven glove', 'OG', 'standard'],
];
const SIZES = ['small', 'medium', 'large'];

const permittedAccount = (allowed: Set<string>) => (a: ChannelAccount) => allowed.has(a.companyId);

function makeSkus(n: number): { rows: SkuRow[]; listings: Map<string, Listing[]> } {
  const rows: SkuRow[] = [];
  const listings = new Map<string, Listing[]>();
  for (let i = 0; i < n; i++) {
    const [thing, code, vat] = r.pick(THINGS);
    const material = r.pick(MATERIALS);
    const size = r.pick(SIZES);
    const sku = `${code}-${material.slice(0, 3).toUpperCase()}-${size[0]?.toUpperCase() ?? 'M'}${String(100 + i)}`;
    const onHand = r.chance(0.07) ? 0 : r.int(0, 420);
    const reserved = Math.min(r.int(0, 18), onHand + (r.chance(0.04) ? 3 : 0));
    const available = onHand - reserved;
    const sold30 = r.int(4, 160);
    const coverDays = sold30 > 0 ? Math.floor((Math.max(available, 0) / sold30) * 30) : null;
    r.next(); // keeps the seeded sequence stable
    const active = i % 37 !== 5;
    const ls: Listing[] = [];
    for (const a of channelAccounts) {
      if (!r.chance(a.channel === 'website' ? 0.5 : 0.62)) continue;
      const fba = a.channel === 'amazon' && r.chance(0.18);
      const buffer = fba ? 0 : r.chance(0.2) ? 2 : a.channel === 'ebay' ? 1 : 0;
      const failed = !fba && r.chance(0.025);
      const held = !fba && !failed && a.channel === 'ebay' && r.chance(0.03);
      ls.push({
        id: `lst_${String(i)}_${a.id}`,
        channelAccountId: a.id,
        channel: a.channel,
        companyId: a.companyId,
        externalSku: r.chance(0.85) ? sku : `${sku}-${a.channel.toUpperCase().slice(0, 2)}`,
        externalId:
          a.channel === 'amazon'
            ? `B0${String(r.int(10_000_000, 99_999_999))}`
            : a.channel === 'ebay'
              ? String(r.int(100_000_000_000, 399_999_999_999))
              : `wp-${String(r.int(1000, 9999))}`,
        title: `${material} ${thing}, ${size}`,
        fulfilment: fba ? 'FBA' : 'MFN',
        buffer,
        bufferOverride: buffer === 2,
        channelQty: fba ? r.int(0, 140) : Math.max(0, available - buffer),
        lastPush: fba
          ? null
          : { at: ago(r.int(2, 600) * 60_000), result: failed ? 'failed' : held ? 'held' : 'sent' },
      });
    }
    if (ls.length === 0) ls.push(makeFallbackListing(i, sku, `${material} ${thing}, ${size}`));
    listings.set(`sku_${String(i)}`, ls);
    const syncFailed = ls.some((l) => l.lastPush?.result === 'failed');
    rows.push({
      id: `sku_${String(i)}`,
      sku,
      title: `${material} ${thing}, ${size}`,
      manufacturer: r.pick(MAKERS),
      vat,
      bundle: null,
      onHand,
      reserved,
      available,
      coverDays,
      cogsPence: r.int(90, 1400),
      listings: summarise(ls),
      state: !active
        ? 'inactive'
        : available < 0
          ? 'oversold'
          : syncFailed
            ? 'sync_failed'
            : available === 0
              ? 'out'
              : coverDays !== null && coverDays < 14
                ? 'low'
                : 'in_stock',
      lastMovementAt: ago(r.int(1, 72 * 60) * 60_000),
      active,
    });
  }
  // CAT-3: a few 2- and 3-packs of single SKUs.
  for (let b = 0; b < 14; b++) {
    const base = rows[b * 9];
    if (!base) continue;
    const pack = b % 3 === 0 ? 2 : 3;
    const id = `sku_b${String(b)}`;
    const available = Math.floor(Math.max(base.available, 0) / pack);
    const ls = (listings.get(base.id) ?? []).slice(0, 2).map((l) => ({
      ...l,
      id: `${l.id}_b${String(pack)}`,
      externalSku: `${base.sku}-${String(pack)}PK`,
      title: `${base.title}, pack of ${String(pack)}`,
      fulfilment: 'MFN' as const,
      channelQty: Math.max(0, Math.floor((base.available - l.buffer) / pack)),
    }));
    listings.set(id, ls);
    rows.push({
      ...base,
      id,
      sku: `${base.sku}-${String(pack)}PK`,
      title: `${base.title}, pack of ${String(pack)}`,
      bundle: { componentId: base.id, componentSku: base.sku, pack },
      onHand: null,
      reserved: 0,
      available,
      coverDays: base.coverDays,
      cogsPence: base.cogsPence * pack,
      listings: summarise(ls),
      state: available === 0 ? 'out' : base.state === 'oversold' ? 'out' : 'in_stock',
    });
  }
  return { rows, listings };
}

function makeFallbackListing(i: number, sku: string, title: string): Listing {
  const a = channelAccounts[0] as ChannelAccount;
  return {
    id: `lst_${String(i)}_fb`,
    channelAccountId: a.id,
    channel: a.channel,
    companyId: a.companyId,
    externalSku: sku,
    externalId: `B0${String(10_000_000 + i)}`,
    title,
    fulfilment: 'MFN',
    buffer: 0,
    bufferOverride: false,
    channelQty: 0,
    lastPush: { at: ago(3 * HOUR), result: 'sent' },
  };
}

function summarise(ls: Listing[]): SkuRow['listings'] {
  return {
    total: ls.length,
    channels: [...new Set(ls.map((l) => l.channel))],
    fba: ls.filter((l) => l.fulfilment === 'FBA').length,
  };
}

const { rows: SKUS, listings: LISTINGS } = makeSkus(186);
export const skus = SKUS;

const UNMAPPED: UnmappedListing[] = Array.from({ length: 23 }, (_, i) => {
  const a = r.pick(channelAccounts);
  const base = r.pick(SKUS);
  const close = r.chance(0.6);
  return {
    id: `unm_${String(i)}`,
    channelAccountId: a.id,
    channel: a.channel,
    companyId: a.companyId,
    externalSku: close ? base.sku.toLowerCase() : `LEGACY-${String(r.int(1000, 9999))}`,
    externalId:
      a.channel === 'amazon'
        ? `B0${String(r.int(10_000_000, 99_999_999))}`
        : String(r.int(100_000_000_000, 399_999_999_999)),
    title: close ? `${base.title} (old listing)` : `${r.pick(MATERIALS)} ${r.pick(THINGS)[0]}`,
    fulfilment: a.channel === 'amazon' && r.chance(0.2) ? 'FBA' : 'MFN',
    foundAt: ago(r.int(1, 20) * DAY),
    openOrders: r.chance(0.3) ? r.int(1, 4) : 0,
    suggestion: close ? { id: base.id, sku: base.sku, title: base.title } : null,
  };
});

function visible(allowed: Set<string>, id: string): Listing[] {
  return (LISTINGS.get(id) ?? []).filter((l) => allowed.has(l.companyId));
}

function scoped(allowed: Set<string>, company: string | null): Set<string> {
  if (!company || company === 'all') return allowed;
  return new Set([...allowed].filter((c) => c === company));
}

/** SKU rows as the user may see them: listing counts cover permitted companies only. */
function scopedRows(companies: Set<string>): SkuRow[] {
  return SKUS.map((s) => {
    const ls = visible(companies, s.id);
    return { ...s, listings: summarise(ls) };
  });
}

function stockCounts(rows: SkuRow[], companies: Set<string>): SkuCounts {
  return {
    all: rows.length,
    low: rows.filter((s) => s.state === 'low' || s.state === 'out').length,
    oversold: rows.filter((s) => s.state === 'oversold').length,
    sync: rows.filter((s) => s.state === 'sync_failed').length,
    bundles: rows.filter((s) => s.bundle).length,
    unmapped: UNMAPPED.filter((u) => companies.has(u.companyId)).length,
  };
}

export function skuPage(allowed: Set<string>, p: URLSearchParams): SkuPage | UnmappedPage {
  const companies = scoped(allowed, p.get('company'));
  const rows = scopedRows(companies);
  const counts = stockCounts(rows, companies);
  const view = (p.get('view') ?? 'all') as StockView;
  const q = (p.get('q') ?? '').trim().toLowerCase();
  const vat = (p.get('vat') ?? '').split(',').filter(Boolean);
  const channel = (p.get('channel') ?? '').split(',').filter(Boolean);
  const limit = [20, 50, 100].includes(Number(p.get('limit'))) ? Number(p.get('limit')) : 50;
  const cursor = Number(p.get('cursor') ?? 0);

  if (view === 'unmapped') {
    const items = UNMAPPED.filter(
      (u) =>
        companies.has(u.companyId) &&
        (!q || u.externalSku.toLowerCase().includes(q) || u.title.toLowerCase().includes(q)) &&
        (channel.length === 0 || channel.includes(u.channelAccountId)),
    );
    return { items: items.slice(cursor, cursor + limit), total: items.length, counts };
  }

  const items = rows.filter((s) => {
    if (view === 'low' && s.state !== 'low' && s.state !== 'out') return false;
    if (view === 'oversold' && s.state !== 'oversold') return false;
    if (view === 'sync' && s.state !== 'sync_failed') return false;
    if (view === 'bundles' && !s.bundle) return false;
    if (vat.length && !vat.includes(s.vat)) return false;
    if (
      channel.length &&
      !visible(companies, s.id).some((l) => channel.includes(l.channelAccountId))
    )
      return false;
    if (q && !s.sku.toLowerCase().includes(q) && !s.title.toLowerCase().includes(q)) return false;
    return true;
  });
  if (view === 'low') items.sort((a, b) => (a.coverDays ?? 0) - (b.coverDays ?? 0));
  return { items: items.slice(cursor, cursor + limit), total: items.length, counts };
}

export function skuDetail(allowed: Set<string>, id: string): SkuDetail | null {
  const s = SKUS.find((x) => x.id === id);
  if (!s) return null;
  const d = rng(id.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 7) >>> 0);
  const ls = visible(allowed, s.id);
  const sold30 = s.coverDays && s.available > 0 ? Math.round((s.available * 30) / s.coverDays) : 24;
  const movements: Movement[] = [];
  let onHand = s.onHand ?? 0;
  for (let i = 0; i < 14; i++) {
    const kind = d.pick([
      'order',
      'order',
      'dispatch',
      'dispatch',
      'stock_in',
      'adjust',
      'cancel',
    ] as const);
    const qty = kind === 'stock_in' ? d.int(24, 120) : d.int(1, 3);
    const change =
      kind === 'stock_in' ? qty : kind === 'dispatch' ? -qty : kind === 'adjust' ? -1 : 0;
    const order = d.pick(orders);
    movements.push({
      id: `mv_${String(i)}`,
      at: ago(i * 7 * HOUR + d.int(10, 300) * 60_000),
      change,
      onHandAfter: onHand,
      kind,
      reason: {
        order: 'Order placed: 1 reserved',
        cancel: 'Order cancelled: 1 released',
        dispatch: 'Order dispatched',
        stock_in: 'Stock in: delivery from supplier',
        adjust: 'Damaged',
        return: 'Refund, returned to stock',
        stock_take: 'Stock-take import',
      }[kind],
      source:
        kind === 'stock_in' || kind === 'adjust'
          ? { type: 'user', name: d.pick(['Sam Admin', 'Pat Packer']) }
          : { type: 'order', ref: order.ref, orderId: order.id },
      pushed: change === 0 && kind !== 'order' && kind !== 'cancel' ? 0 : ls.length,
      pushFailed: s.state === 'sync_failed' && i === 0 ? 1 : 0,
    });
    onHand -= change;
  }
  return {
    sku: { ...s, listings: summarise(ls) },
    description: s.title.split(',')[0] ?? s.title,
    barcode: d.chance(0.8) ? `50${String(d.int(10_000_000_000, 99_999_999_999))}` : null,
    weightGrams: d.int(80, 2400),
    dimensionsMm: d.chance(0.7) ? [d.int(80, 400), d.int(60, 300), d.int(20, 200)] : null,
    cogsHistory: [
      { from: ago(12 * DAY), pence: s.cogsPence, by: 'Sam Admin' },
      { from: ago(96 * DAY), pence: s.cogsPence - d.int(5, 60), by: 'Sam Admin' },
      { from: ago(260 * DAY), pence: s.cogsPence - d.int(70, 120), by: 'CSV import' },
    ],
    reorder: {
      leadDays: d.int(7, 28),
      safetyDays: 7,
      targetCoverDays: 45,
      suggestUnits: Math.max(0, Math.round((sold30 / 30) * 45) - Math.max(s.available, 0)),
    },
    listings: ls,
    bundles: SKUS.filter((b) => b.bundle?.componentId === s.id).map((b) => ({
      id: b.id,
      sku: b.sku,
      pack: b.bundle?.pack ?? 1,
      available: b.available,
    })),
    movements: s.bundle ? [] : movements,
    sold30,
  };
}

export const permittedAccounts = (allowed: Set<string>) =>
  channelAccounts.filter(permittedAccount(allowed));
