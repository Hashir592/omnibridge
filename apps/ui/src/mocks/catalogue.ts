/**
 * MSW mock of the M08 catalogue routes (T-0801), for the T-0316 screens. It follows the contract
 * in packages/contract/src/routes/catalogue.ts and answers as the server does (CAT-1 to CAT-6):
 * workspace-shared, numbered pages, 409 refusals with the server's plain detail, and all-or-nothing
 * CSV imports. Seeded from the stock mock so SKU codes match across screens. Synthetic data only.
 */
import { HttpResponse, http } from 'msw/http';
import type {
  CatalogueListing,
  CogsEntry,
  CsvImportReport,
  MasterSku,
  MasterSkuCreate,
  MasterSkuSummary,
  MasterSkuUpdate,
  VatRate,
  VatType,
} from '../auth/api.ts';
import { todayLondon } from '../lib/dates.ts';
import { companies } from './data.ts';
import { uid } from './ids.ts';
import { DAY, ago } from './random.ts';
import { channelOn, currentSession } from './session.ts';
import { skuDetail, skuPage, skus, type UnmappedPage, type VatType as MockVat } from './stock.ts';

const VAT_OF: Record<MockVat, VatType> = {
  standard: 'standard',
  reduced: 'reduced',
  zero: 'zero',
  none: 'no_vat',
};

const dayAgo = (days: number) => todayLondon(new Date(Date.now() - days * DAY));

export interface CatalogueSku {
  id: string;
  sku: string;
  title: string;
  shortDescription: string;
  barcode: string | null;
  manufacturer: string | null;
  weightG: number;
  dimensions: MasterSku['dimensions'];
  imageUrl: string | null;
  purchaseVatRateBp: number | null;
  reorder: MasterSku['reorder'];
  active: boolean;
  bundle: { componentId: string; packSize: number } | null;
  vat: Array<{ vat_type: VatType; effective_from: string }>;
  cogs: CogsEntry[];
  createdAt: string;
  updatedAt: string;
}

let rates: VatRate[] = [];
let catalogue: CatalogueSku[] = [];
let listings: CatalogueListing[] = [];

export function resetCatalogueMock(): void {
  const all = new Set(companies.map((c) => c.id));
  rates = [
    { vat_type: 'standard', rate_bp: 2000, effective_from: '2011-01-04' },
    { vat_type: 'reduced', rate_bp: 500, effective_from: '1997-09-01' },
    { vat_type: 'zero', rate_bp: 0, effective_from: '1973-04-01' },
    { vat_type: 'no_vat', rate_bp: 0, effective_from: '1973-04-01' },
  ];
  catalogue = [];
  listings = [];
  for (const s of skus) {
    const d = skuDetail(all, s.id);
    if (!d) continue;
    const id = uid(s.id);
    catalogue.push({
      id,
      sku: s.sku,
      title: s.title,
      shortDescription: d.description,
      barcode: d.barcode,
      manufacturer: s.manufacturer,
      weightG: d.weightGrams,
      dimensions: d.dimensionsMm
        ? {
            length_mm: d.dimensionsMm[0],
            width_mm: d.dimensionsMm[1],
            height_mm: d.dimensionsMm[2],
          }
        : null,
      imageUrl: null,
      purchaseVatRateBp: null,
      reorder: {
        lead_time_days: d.reorder.leadDays,
        safety_days: d.reorder.safetyDays,
        target_cover_days: d.reorder.targetCoverDays,
      },
      active: s.active,
      bundle: s.bundle ? { componentId: uid(s.bundle.componentId), packSize: s.bundle.pack } : null,
      vat: s.bundle ? [] : [{ vat_type: VAT_OF[s.vat], effective_from: dayAgo(400) }],
      cogs: s.bundle
        ? []
        : d.cogsHistory.map((c, i) => ({
            cogs_pence: Math.max(1, c.pence),
            effective_from: dayAgo([12, 96, 260][i] ?? 300),
            created_at: c.from,
          })),
      createdAt: ago(400 * DAY),
      updatedAt: s.lastMovementAt,
    });
    for (const l of d.listings) {
      listings.push({
        id: uid(l.id),
        channel_account_id: l.channelAccountId,
        provider: l.channel,
        external_sku: l.externalSku,
        external_id: l.externalId,
        title: l.title,
        fulfilment: l.channel === 'amazon' ? (l.fulfilment === 'FBA' ? 'fba' : 'mfn') : null,
        inventory_api: l.channel === 'ebay' ? true : null,
        master_sku: { id, sku: s.sku },
        mapped_at: ago(30 * DAY),
        discovered_at: ago(60 * DAY),
      });
    }
  }
  const unmapped = skuPage(all, new URLSearchParams('view=unmapped&limit=100')) as UnmappedPage;
  for (const u of unmapped.items) {
    listings.push({
      id: uid(u.id),
      channel_account_id: u.channelAccountId,
      provider: u.channel,
      external_sku: u.externalSku,
      external_id: u.externalId,
      title: u.title,
      fulfilment: u.channel === 'amazon' ? (u.fulfilment === 'FBA' ? 'fba' : 'mfn') : null,
      inventory_api: u.channel === 'ebay' ? true : null,
      master_sku: null,
      mapped_at: null,
      discovered_at: u.foundAt,
    });
  }
}
resetCatalogueMock();

/** The live catalogue state, for the stock mock (the arrays are replaced on reset). */
export function catalogueState() {
  return { skus: catalogue, listings };
}

const problem = (status: number, code: string, detail?: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: 'Error', status, code, ...(detail ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const invalid = (path: string, message: string) =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'validation_failed',
      errors: [{ location: 'body', path, message }],
    },
    { status: 400 },
  );

const hasTab = () => currentSession().tabs.includes('stock');
const byId = (id: string) => catalogue.find((s) => s.id === id);

/** WEB-1: with the website connector off, website listings are not there at all. */
const live = () => listings.filter((l) => l.provider !== 'website' || channelOn('website'));

/** Today's row of a dated history (rows may hold a future date). */
function current<T extends { effective_from: string }>(rows: T[]): T | undefined {
  const today = todayLondon();
  return rows
    .filter((r) => r.effective_from <= today)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
}

function vatTypeOf(s: CatalogueSku): VatType {
  const base = s.bundle ? byId(s.bundle.componentId) : s;
  return (base && current(base.vat)?.vat_type) ?? 'standard';
}

function cogsOf(s: CatalogueSku): number | null {
  if (s.bundle) {
    const c = byId(s.bundle.componentId);
    const p = c ? current(c.cogs)?.cogs_pence : undefined;
    return p === undefined ? null : p * s.bundle.packSize;
  }
  return current(s.cogs)?.cogs_pence ?? null;
}

function summary(s: CatalogueSku): MasterSkuSummary {
  const c = s.bundle ? byId(s.bundle.componentId) : undefined;
  return {
    id: s.id,
    sku: s.sku,
    title: s.title,
    vat_type: vatTypeOf(s),
    cogs_pence: cogsOf(s),
    active: s.active,
    bundle:
      s.bundle && c
        ? { component_id: c.id, component_sku: c.sku, pack_size: s.bundle.packSize }
        : null,
    listing_count: live().filter((l) => l.master_sku?.id === s.id).length,
    updated_at: s.updatedAt,
  };
}

function detail(s: CatalogueSku): MasterSku {
  const base = s.bundle ? byId(s.bundle.componentId) : s;
  const newest = <T extends { effective_from: string }>(rows: T[]) =>
    [...rows].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return {
    ...summary(s),
    short_description: s.shortDescription,
    barcode: s.barcode,
    manufacturer: s.manufacturer,
    weight_g: s.weightG,
    dimensions: s.dimensions,
    image_url: s.imageUrl,
    purchase_vat_rate_bp: s.purchaseVatRateBp,
    reorder: s.reorder,
    vat_history: newest(base?.vat ?? []),
    cogs_history: s.bundle ? [] : newest(s.cogs),
    listings: live()
      .filter((l) => l.master_sku?.id === s.id)
      .map((l) => ({
        id: l.id,
        channel_account_id: l.channel_account_id,
        provider: l.provider,
        external_sku: l.external_sku,
        external_id: l.external_id,
        title: l.title,
      })),
    created_at: s.createdAt,
  };
}

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

/** The server's CSV reader in small: a header row naming the columns, then data rows. */
function readCsv(text: string, columns: readonly string[]) {
  const records = parseCsv(text.replace(/^﻿/, ''));
  const header = (records[0] ?? []).map((h) => h.trim().toLowerCase());
  for (const c of columns) {
    if (!header.includes(c)) return { error: { line: 1, code: 'column_missing', column: c } };
  }
  const rows: Array<{ line: number; cells: Record<string, string> }> = [];
  records.slice(1).forEach((parts, i) => {
    if (parts.every((p) => !p.trim())) return;
    const cells: Record<string, string> = {};
    header.forEach((h, j) => (cells[h] = (parts[j] ?? '').trim()));
    rows.push({ line: i + 2, cells });
  });
  return { rows };
}

/** RFC 4180 records: quoted cells may hold commas, quotes ("") and line breaks. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

const report = (rows: number, errors: CsvImportReport['errors'], applied: boolean) =>
  HttpResponse.json<CsvImportReport>({
    rows,
    valid: rows - new Set(errors.map((e) => e.line)).size,
    applied,
    errors,
  });

function csvDate(text: string): string | null {
  const uk = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const iso = uk ? `${uk[3] ?? ''}-${uk[2] ?? ''}-${uk[1] ?? ''}` : text;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso)) ? iso : null;
}

function pounds(text: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

export const catalogueHandlers = [
  http.get('*/api/catalogue/skus', ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const p = new URL(request.url).searchParams;
    const q = (p.get('q') ?? '').toLowerCase();
    const rows = catalogue
      .filter(
        (s) =>
          (!q ||
            s.sku.toLowerCase().includes(q) ||
            s.title.toLowerCase().includes(q) ||
            (s.barcode ?? '').includes(q)) &&
          (p.get('active') === null || String(s.active) === p.get('active')) &&
          (p.get('bundles') === null || String(s.bundle !== null) === p.get('bundles')),
      )
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map(summary);
    return HttpResponse.json(paged(rows, p));
  }),
  http.get('*/api/catalogue/skus/:id', ({ params }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.id));
    return s ? HttpResponse.json(detail(s)) : problem(404, 'not_found');
  }),
  http.post('*/api/catalogue/skus', async ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const b = (await request.json()) as MasterSkuCreate;
    if (!b.bundle && !b.vat_type) return invalid('vat_type', 'Choose a VAT type');
    if (catalogue.some((s) => s.sku === b.sku))
      return problem(409, 'conflict', 'This SKU code is already used in this workspace.');
    const component = b.bundle ? byId(b.bundle.component_id) : undefined;
    if (b.bundle && !component) return problem(404, 'not_found');
    if (component?.bundle)
      return problem(
        409,
        'conflict',
        'A bundle contains units of one plain SKU, not another bundle.',
      );
    const now = new Date().toISOString();
    const s: CatalogueSku = {
      id: crypto.randomUUID(),
      sku: b.sku,
      title: b.title,
      shortDescription: b.short_description,
      barcode: b.barcode ?? null,
      manufacturer: b.manufacturer ?? null,
      weightG: b.weight_g,
      dimensions: b.dimensions ?? null,
      imageUrl: b.image_url ?? null,
      purchaseVatRateBp: b.purchase_vat_rate_bp ?? null,
      reorder: b.reorder ?? { lead_time_days: 14, safety_days: 7, target_cover_days: 45 },
      active: b.active ?? true,
      bundle: b.bundle
        ? { componentId: b.bundle.component_id, packSize: b.bundle.pack_size }
        : null,
      vat: b.vat_type ? [{ vat_type: b.vat_type, effective_from: todayLondon() }] : [],
      cogs:
        b.cogs_pence === undefined
          ? []
          : [
              {
                cogs_pence: b.cogs_pence,
                effective_from: b.cogs_effective_from ?? todayLondon(),
                created_at: now,
              },
            ],
      createdAt: now,
      updatedAt: now,
    };
    catalogue.push(s);
    return HttpResponse.json(detail(s), { status: 201 });
  }),
  http.patch('*/api/catalogue/skus/:id', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.id));
    if (!s) return problem(404, 'not_found');
    const b = (await request.json()) as MasterSkuUpdate;
    if (b.vat && s.bundle)
      return problem(
        409,
        'conflict',
        "A bundle's VAT type and COGS come from its component and cannot be set.",
      );
    if (b.title !== undefined) s.title = b.title;
    if (b.short_description !== undefined) s.shortDescription = b.short_description;
    if (b.barcode !== undefined) s.barcode = b.barcode;
    if (b.manufacturer !== undefined) s.manufacturer = b.manufacturer;
    if (b.weight_g !== undefined) s.weightG = b.weight_g;
    if (b.dimensions !== undefined) s.dimensions = b.dimensions;
    if (b.image_url !== undefined) s.imageUrl = b.image_url;
    if (b.active !== undefined) s.active = b.active;
    if (b.reorder !== undefined) s.reorder = b.reorder;
    if (b.purchase_vat_rate_bp !== undefined) s.purchaseVatRateBp = b.purchase_vat_rate_bp;
    if (b.vat) {
      const vat = b.vat;
      s.vat = [...s.vat.filter((v) => v.effective_from !== vat.effective_from), vat];
    }
    s.updatedAt = new Date().toISOString();
    return HttpResponse.json(detail(s));
  }),
  http.get('*/api/catalogue/manufacturers', () => {
    if (!hasTab()) return problem(403, 'forbidden');
    const names = new Set(catalogue.flatMap((s) => (s.manufacturer ? [s.manufacturer] : [])));
    return HttpResponse.json({ items: [...names].sort() });
  }),
  http.get('*/api/catalogue/vat-rates', () => {
    if (!hasTab()) return problem(403, 'forbidden');
    return HttpResponse.json({ items: rates });
  }),
  http.post('*/api/catalogue/vat-rates', async ({ request }) => {
    if (!currentSession().user.isAdmin) return problem(403, 'forbidden');
    const b = (await request.json()) as VatRate;
    if ((b.vat_type === 'zero' || b.vat_type === 'no_vat') && b.rate_bp !== 0)
      return problem(409, 'conflict', 'Zero-rated and No VAT are always 0%.');
    if (rates.some((r) => r.vat_type === b.vat_type && r.effective_from === b.effective_from))
      return problem(409, 'conflict', 'This VAT type already has a rate from that date.');
    rates.push(b);
    return HttpResponse.json(b, { status: 201 });
  }),
  http.get('*/api/catalogue/skus/:id/cogs', ({ params }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.id));
    return s ? HttpResponse.json({ items: detail(s).cogs_history }) : problem(404, 'not_found');
  }),
  http.post('*/api/catalogue/skus/:id/cogs', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const s = byId(String(params.id));
    if (!s) return problem(404, 'not_found');
    if (s.bundle)
      return problem(
        409,
        'conflict',
        "A bundle's VAT type and COGS come from its component and cannot be set.",
      );
    const b = (await request.json()) as { cogs_pence: number; effective_from: string };
    const entry: CogsEntry = { ...b, created_at: new Date().toISOString() };
    s.cogs = [...s.cogs.filter((c) => c.effective_from !== b.effective_from), entry];
    return HttpResponse.json(entry, { status: 201 });
  }),
  http.post('*/api/catalogue/cogs/import', async ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const { csv, dry_run } = (await request.json()) as { csv: string; dry_run: boolean };
    const read = readCsv(csv, ['sku', 'cogs', 'effective_from']);
    if ('error' in read) return report(0, [read.error], false);
    const rows = read.rows;
    const errors: CsvImportReport['errors'] = [];
    const seen = new Set<string>();
    const good: Array<{ s: CatalogueSku; pence: number; day: string }> = [];
    for (const { line, cells } of rows) {
      const s = catalogue.find((x) => x.sku === cells.sku);
      const pence = pounds(cells.cogs ?? '');
      const day = csvDate(cells.effective_from ?? '');
      if (!s) errors.push({ line, code: 'sku_unknown', column: 'sku' });
      else if (s.bundle) errors.push({ line, code: 'bundle_cogs', column: 'sku' });
      if (pence === null) errors.push({ line, code: 'cogs_invalid', column: 'cogs' });
      if (day === null) errors.push({ line, code: 'date_invalid', column: 'effective_from' });
      const key = `${cells.sku ?? ''}|${day ?? ''}`;
      if (seen.has(key)) errors.push({ line, code: 'duplicate', column: null });
      seen.add(key);
      if (s && !s.bundle && pence !== null && day !== null) good.push({ s, pence, day });
    }
    const apply = !dry_run && errors.length === 0 && rows.length > 0;
    if (apply) {
      const at = new Date().toISOString();
      for (const g of good)
        g.s.cogs = [
          ...g.s.cogs.filter((c) => c.effective_from !== g.day),
          { cogs_pence: g.pence, effective_from: g.day, created_at: at },
        ];
    }
    return report(rows.length, errors, apply);
  }),
  http.get('*/api/catalogue/listings', ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const p = new URL(request.url).searchParams;
    const q = (p.get('q') ?? '').toLowerCase();
    const rows = live()
      .filter(
        (l) =>
          (p.get('mapped') === null || String(l.master_sku !== null) === p.get('mapped')) &&
          (!p.get('channel_account_id') || l.channel_account_id === p.get('channel_account_id')) &&
          (!q ||
            l.external_sku.toLowerCase().includes(q) ||
            l.external_id.toLowerCase().includes(q) ||
            (l.title ?? '').toLowerCase().includes(q)),
      )
      .sort((a, b) => b.discovered_at.localeCompare(a.discovered_at));
    return HttpResponse.json(paged(rows, p));
  }),
  http.put('*/api/catalogue/listings/:id/mapping', async ({ params, request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const l = listings.find((x) => x.id === params.id);
    const { master_sku_id } = (await request.json()) as { master_sku_id: string };
    const s = byId(master_sku_id);
    if (!l || !s) return problem(404, 'not_found');
    if (l.master_sku && l.master_sku.id !== s.id)
      return problem(409, 'conflict', 'This listing is mapped to another SKU. Unmap it first.');
    l.master_sku = { id: s.id, sku: s.sku };
    l.mapped_at = new Date().toISOString();
    return HttpResponse.json(l);
  }),
  http.delete('*/api/catalogue/listings/:id/mapping', ({ params }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const l = listings.find((x) => x.id === params.id);
    if (!l) return problem(404, 'not_found');
    l.master_sku = null;
    l.mapped_at = null;
    return HttpResponse.json(l);
  }),
  http.post('*/api/catalogue/mappings/import', async ({ request }) => {
    if (!hasTab()) return problem(403, 'forbidden');
    const { csv, dry_run } = (await request.json()) as { csv: string; dry_run: boolean };
    const read = readCsv(csv, ['listing_id', 'sku']);
    if ('error' in read) return report(0, [read.error], false);
    const rows = read.rows;
    const errors: CsvImportReport['errors'] = [];
    const seen = new Set<string>();
    const good: Array<{ l: CatalogueListing; s: CatalogueSku | null }> = [];
    for (const { line, cells } of rows) {
      const l = listings.find((x) => x.id === cells.listing_id);
      const s = cells.sku ? catalogue.find((x) => x.sku === cells.sku) : null;
      if (!l) errors.push({ line, code: 'listing_unknown', column: 'listing_id' });
      if (s === undefined) errors.push({ line, code: 'sku_unknown', column: 'sku' });
      if (seen.has(cells.listing_id ?? '')) errors.push({ line, code: 'duplicate', column: null });
      seen.add(cells.listing_id ?? '');
      if (l && s !== undefined) good.push({ l, s });
    }
    const apply = !dry_run && errors.length === 0 && rows.length > 0;
    if (apply) {
      const at = new Date().toISOString();
      for (const { l, s } of good) {
        l.master_sku = s ? { id: s.id, sku: s.sku } : null;
        l.mapped_at = s ? at : null;
      }
    }
    return report(rows.length, errors, apply);
  }),
  http.get('*/api/catalogue/mappings/export', () => {
    if (!hasTab()) return problem(403, 'forbidden');
    const names = new Map(currentSession().channelAccounts.map((a) => [a.id, a.name]));
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const lines = [
      'listing_id,account,provider,external_sku,external_id,title,sku',
      ...live().map((l) =>
        [
          l.id,
          names.get(l.channel_account_id) ?? 'another company',
          l.provider,
          l.external_sku,
          l.external_id,
          l.title ?? '',
          l.master_sku?.sku ?? '',
        ]
          .map(cell)
          .join(','),
      ),
    ];
    return new HttpResponse(`﻿${lines.join('\n')}\n`, {
      headers: { 'content-type': 'text/csv; charset=utf-8' },
    });
  }),
];
