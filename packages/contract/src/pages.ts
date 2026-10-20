import { z } from 'zod';
import { PAGE_LIMIT_DEFAULT } from './pagination.ts';

/** Page sizes a numbered-page list offers (ADR-040). Anything else is a 400. */
export const PAGE_LIMITS = [20, 50, 100] as const;

/**
 * `total` is exact up to this many rows; beyond it the list reports "10,000+" (`totalCapped`), so
 * a count never scans a huge table and p95 stays under 1 s at design capacity (CAP-7, ADR-040).
 */
export const TOTAL_COUNT_CAP = 10_000;

/**
 * Query for numbered-page list routes: `page` from 1 and `limit` 20, 50 or 100 (default 50).
 * Cursor pagination (`listQuery`) stays for exports and jobs. Add filters with `.extend({...})`.
 */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number, from 1'),
  limit: z.coerce
    .number()
    .refine((n) => (PAGE_LIMITS as readonly number[]).includes(n), {
      message: `limit must be one of ${PAGE_LIMITS.join(', ')}`,
    })
    .default(PAGE_LIMIT_DEFAULT)
    .describe(`Rows per page: ${PAGE_LIMITS.join(', ')} (default ${String(PAGE_LIMIT_DEFAULT)})`),
});

export type PageQuery = z.infer<typeof pageQuery>;

/** Response of a numbered-page list route. */
export function pagedOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    limit: z.number().int(),
    /** Exact up to TOTAL_COUNT_CAP; equal to the cap when `totalCapped` is true. */
    total: z.number().int().min(0),
    totalCapped: z.boolean(),
  });
}

/** Rows to skip for a page. Queries must sort on an indexed key (ADR-040). */
export function pageOffset(query: PageQuery): number {
  return (query.page - 1) * query.limit;
}

/**
 * Builds the response. `countUpTo(n)` must count matching rows but stop at n, for example
 * `SELECT count(*) FROM (SELECT 1 FROM ... WHERE ... LIMIT n) t`.
 */
export async function pageResult<T>(input: {
  items: T[];
  page: number;
  limit: number;
  countUpTo: (n: number) => Promise<number>;
}): Promise<{ items: T[]; page: number; limit: number; total: number; totalCapped: boolean }> {
  const counted = await input.countUpTo(TOTAL_COUNT_CAP + 1);
  const totalCapped = counted > TOTAL_COUNT_CAP;
  return {
    items: input.items,
    page: input.page,
    limit: input.limit,
    total: totalCapped ? TOTAL_COUNT_CAP : counted,
    totalCapped,
  };
}
