/**
 * Stock rules the screens share (T-0317), free of React so they are unit tested. Quantities are
 * whole units. The server computes the real targets; the form uses the same formula only to
 * preview what a typed allocation will do before it is saved (INV-2, INV-10).
 */
import type {
  AdjustReason,
  AllocationPush,
  Movement,
  MovementKind,
  StockDetail,
  StockFilter,
  StockListing,
  StockMode,
  StockRow,
} from '../../auth/api.ts';

/** The list views, as the URL names them (notification links use oversold and sync). */
export type StockView = 'all' | 'oversold' | 'sync' | 'manual' | 'bundles';

export function filterOf(view: StockView): StockFilter | undefined {
  if (view === 'oversold') return 'oversold';
  if (view === 'sync') return 'sync_failed';
  if (view === 'manual') return 'manual';
  if (view === 'bundles') return 'bundles';
  return undefined;
}

export type StockState = 'oversold' | 'sync_failed' | 'out' | 'in_stock' | 'inactive';

/** One status per row: the most urgent first (INV-6, INV-8). */
export function stateOf(
  r: Pick<StockRow, 'active' | 'oversold' | 'sync_failed' | 'available'>,
): StockState {
  if (!r.active) return 'inactive';
  if (r.oversold) return 'oversold';
  if (r.sync_failed) return 'sync_failed';
  if (r.available <= 0) return 'out';
  return 'in_stock';
}

/**
 * INV-10 target preview: auto shows max(0, floor((available − buffer) ÷ pack)); manual shows the
 * lower of (allocation − sold since set) and that, so a manual number never shows more than you
 * have. `available` is the plain SKU's (a bundle's component's) on hand minus reserved.
 */
export function previewTarget(input: {
  available: number;
  buffer: number;
  pack: number;
  mode: StockMode;
  qty: number;
  sold: number;
}): { target: number; capped: boolean } {
  const cap = Math.max(0, Math.floor((input.available - input.buffer) / input.pack));
  if (input.mode === 'auto') return { target: cap, capped: false };
  const left = input.qty - input.sold;
  return { target: Math.max(0, Math.min(left, cap)), capped: left > cap };
}

/** A form row: one merchant-fulfilled listing of this SKU or of one of its bundles. */
export interface AllocRow {
  listing: StockListing;
  /** 1 for the SKU's own listings, the pack size for a bundle's. */
  pack: number;
  /** Set for a bundle's listing: which bundle it belongs to. */
  bundleSku: string | null;
  mode: StockMode;
  /** As typed. */
  qty: string;
}

export const wholeUnits = (text: string): number | null =>
  /^\s*\d{1,7}\s*$/.test(text) ? Number(text) : null;

/** C7.2: switching a listing to manual starts from what it shows now, so nothing moves. */
export function startingQty(l: StockListing): number {
  return l.manual?.qty ?? l.last_sent_qty ?? l.channel_qty ?? l.target ?? 0;
}

/** The rows of the form, from the SKU's listings and its bundles' (FBA never: INV-9). */
export function formRows(
  own: StockListing[],
  bundles: Array<{ sku: string; pack: number; listings: StockListing[] }>,
  allManual: boolean,
): AllocRow[] {
  const row = (l: StockListing, pack: number, bundleSku: string | null): AllocRow => {
    const mode: StockMode = allManual ? 'manual' : l.mode;
    return { listing: l, pack, bundleSku, mode, qty: String(startingQty(l)) };
  };
  return [
    ...own.filter((l) => l.fulfilment !== 'fba').map((l) => row(l, 1, null)),
    ...bundles.flatMap((b) =>
      b.listings.filter((l) => l.fulfilment !== 'fba').map((l) => row(l, b.pack, b.sku)),
    ),
  ];
}

/** "Allocated 240 · Available 186": manual units in component units (a bundle's × pack). */
export function allocatedOf(rows: AllocRow[]): number {
  return rows.reduce(
    (sum, r) => (r.mode === 'manual' ? sum + (wholeUnits(r.qty) ?? 0) * r.pack : sum),
    0,
  );
}

export const OVER_ALLOCATED = 'More allocated than you have. Listings will be capped by stock.';
export const VERSION_CONFLICT =
  'Stock or settings changed while you were editing. Review and save again.';

/** The save body: every row named, manual ones with their number (C7.2). Null if any is bad. */
export function allocationBody(
  version: number,
  rows: AllocRow[],
): {
  version: number;
  listings: Array<{ listing_id: string; mode: StockMode; manual_qty?: number }>;
} | null {
  const listings: Array<{ listing_id: string; mode: StockMode; manual_qty?: number }> = [];
  for (const r of rows) {
    if (r.mode === 'auto') {
      listings.push({ listing_id: r.listing.id, mode: 'auto' });
      continue;
    }
    const n = wholeUnits(r.qty);
    if (n === null) return null;
    listings.push({ listing_id: r.listing.id, mode: 'manual', manual_qty: n });
  }
  return listings.length > 0 ? { version, listings } : null;
}

/** The product-level label: Auto, Manual or Mixed (a listing switched on its own). */
export function syncLabel(mode: StockDetail['sync_mode']): string {
  return { auto: 'Auto', manual: 'Manual', mixed: 'Mixed' }[mode];
}

export function pushText(r: AllocationPush['result']): string {
  return {
    queued: 'New quantity on its way',
    unchanged: 'No change needed',
    held: 'Held: sends when the account resumes',
  }[r];
}

export const KIND_LABEL: Record<MovementKind, string> = {
  reserve: 'Reserved by order',
  release: 'Released',
  dispatch: 'Dispatched',
  return: 'Returned to stock',
  stock_in: 'Stock in',
  adjust: 'Adjustment',
  stock_take: 'Stock-take',
  allocation: 'Allocation change',
};

export const REASON_LABEL: Record<AdjustReason, string> = {
  damaged: 'Damaged',
  count_correction: 'Count correction',
  lost: 'Lost',
  other: 'Other',
};

/** "+5", "−2" or "0" (a real minus sign). */
export function signed(n: number): string {
  if (n > 0) return `+${String(n)}`;
  if (n < 0) return `−${String(-n)}`;
  return '0';
}

/** Who moved it, in plain words (an order the user cannot see is "another company"). */
export function sourceText(m: Movement['source'], me: string | undefined): string {
  if (m.type === 'order') return m.ref === null ? 'Order of another company' : `Order ${m.ref}`;
  if (m.type === 'system') return 'OmniBridge';
  if (m.user_id !== null && m.user_id === me) return 'You';
  return m.name ?? 'A removed user';
}

/** The pushes a movement queued, by their result now (INV-5). */
export function pushesText(p: Movement['pushes']): {
  text: string;
  tone: 'ok' | 'wait' | 'bad' | 'none';
} {
  const total = p.pending + p.sent + p.held + p.failed;
  if (total === 0) return { text: 'No change to push', tone: 'none' };
  if (p.failed > 0) return { text: `${String(p.failed)} of ${String(total)} failed`, tone: 'bad' };
  if (p.held > 0) return { text: `${String(p.held)} of ${String(total)} held`, tone: 'wait' };
  if (p.pending > 0)
    return { text: `${String(p.pending)} of ${String(total)} sending`, tone: 'wait' };
  return { text: `${String(p.sent)} sent`, tone: 'ok' };
}

export type FormResult<T> = { ok: true; body: T } | { ok: false; errors: Record<string, string> };

/** INV-3 stock-in: a whole number of 1 or more; supplier and notes optional. */
export function stockInBody(
  f: { quantity: string; supplier: string; notes: string },
  clientRef: string,
): FormResult<{ quantity: number; supplier?: string; notes?: string; client_ref: string }> {
  const n = wholeUnits(f.quantity);
  if (n === null || n < 1 || n > 1_000_000)
    return { ok: false, errors: { quantity: 'Enter a whole number from 1' } };
  return {
    ok: true,
    body: {
      quantity: n,
      ...(f.supplier.trim() ? { supplier: f.supplier.trim() } : {}),
      ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
      client_ref: clientRef,
    },
  };
}

/** INV-3 adjustment: a non-zero change, a reason, and text when the reason is Other. */
export function adjustBody(
  f: { delta: string; reason: AdjustReason | null; text: string },
  onHand: number,
  clientRef: string,
): FormResult<{ delta: number; reason: AdjustReason; text?: string; client_ref: string }> {
  const errors: Record<string, string> = {};
  const m = /^\s*([+\-−]?)\s*(\d{1,7})\s*$/.exec(f.delta);
  const delta = m ? (m[1] === '-' || m[1] === '−' ? -1 : 1) * Number(m[2]) : null;
  if (delta === null || delta === 0)
    errors.delta = 'Enter a whole number that is not 0, for example -2 or 5';
  else if (onHand + delta < 0) errors.delta = `On hand cannot go below 0 (now ${String(onHand)})`;
  if (!f.reason) errors.reason = 'Choose a reason';
  else if (f.reason === 'other' && !f.text.trim()) errors.text = 'Say what happened';
  if (Object.keys(errors).length > 0 || delta === null || !f.reason) return { ok: false, errors };
  return {
    ok: true,
    body: {
      delta,
      reason: f.reason,
      ...(f.text.trim() ? { text: f.text.trim() } : {}),
      client_ref: clientRef,
    },
  };
}
