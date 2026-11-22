/**
 * Forecasting for the client preview (T-0305). PROPOSED SHAPE (mock only), FC-1..3.
 * Statistical formulas only (FC-3): blended velocity = 0.5 × v7 + 0.3 × v30 + 0.2 × v90.
 * Bundle sales are already counted as component units, so bundles are not listed.
 */
import { rng } from './random.ts';
import { uid } from './ids.ts';
import { skus } from './stock.ts';

export interface ForecastRow {
  id: string;
  sku: string;
  title: string;
  available: number;
  v7: number;
  v30: number;
  v90: number;
  blended: number;
  coverDays: number | null;
  leadDays: number;
  safetyDays: number;
  targetCoverDays: number;
  reorderPoint: number;
  suggestQty: number;
  urgency: 'now' | 'soon' | 'ok' | 'no_sales';
}

const r = rng(4_9);
const round1 = (n: number) => Math.round(n * 10) / 10;

const ROWS: ForecastRow[] = skus
  .filter((s) => !s.bundle && s.active)
  .map((s) => {
    const base = 0.3 + r.next() * 6;
    const v7 = round1(base * (0.7 + r.next() * 0.7));
    const v30 = round1(base);
    const v90 = round1(base * (0.8 + r.next() * 0.4));
    const blended = round1(0.5 * v7 + 0.3 * v30 + 0.2 * v90);
    const leadDays = r.pick([7, 10, 14, 21, 28]);
    const safetyDays = 7;
    const targetCoverDays = 45;
    const available = Math.max(0, s.available);
    const coverDays = blended > 0 ? Math.floor(available / blended) : null;
    const reorderPoint = Math.ceil(blended * (leadDays + safetyDays));
    const suggestQty = Math.max(0, Math.ceil(blended * targetCoverDays - available));
    const urgency: ForecastRow['urgency'] =
      coverDays === null
        ? 'no_sales'
        : coverDays < leadDays + safetyDays
          ? 'now'
          : coverDays < leadDays + safetyDays + 14
            ? 'soon'
            : 'ok';
    return {
      id: uid(s.id),
      sku: s.sku,
      title: s.title,
      available,
      v7,
      v30,
      v90,
      blended,
      coverDays,
      leadDays,
      safetyDays,
      targetCoverDays,
      reorderPoint,
      suggestQty,
      urgency,
    };
  });

const ORDER = { now: 0, soon: 1, ok: 2, no_sales: 3 };

export function forecastPage(p: URLSearchParams) {
  const view = p.get('view') ?? 'reorder';
  const q = (p.get('q') ?? '').trim().toLowerCase();
  const items = ROWS.filter(
    (f) =>
      (view === 'now'
        ? f.urgency === 'now'
        : view === 'reorder'
          ? f.urgency === 'now' || f.urgency === 'soon'
          : true) &&
      (!q || f.sku.toLowerCase().includes(q) || f.title.toLowerCase().includes(q)),
  ).sort((a, b) => ORDER[a.urgency] - ORDER[b.urgency] || (a.coverDays ?? 0) - (b.coverDays ?? 0));
  const limit = [20, 50, 100].includes(Number(p.get('limit'))) ? Number(p.get('limit')) : 50;
  const cursor = Number(p.get('cursor') ?? 0);
  return {
    items: items.slice(cursor, cursor + limit),
    total: items.length,
    counts: {
      now: ROWS.filter((f) => f.urgency === 'now').length,
      reorder: ROWS.filter((f) => f.urgency === 'now' || f.urgency === 'soon').length,
      all: ROWS.length,
    },
  };
}

export type ForecastPage = ReturnType<typeof forecastPage>;
