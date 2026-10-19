/** Rows-per-page choices for long lists (Hashir, 19/10/2026); 50 is the default. */
export const PAGE_SIZES = [20, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** Page numbers to show: always first and last, the current page and its neighbours. */
export function pageList(page: number, count: number): Array<number | 'gap'> {
  const want = new Set([1, count, page - 1, page, page + 1].filter((p) => p >= 1 && p <= count));
  const sorted = [...want].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && p - prev > 1) out.push('gap');
    out.push(p);
  });
  return out;
}
