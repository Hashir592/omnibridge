import { z } from 'zod';

/** Rows a list route returns when the client sends no `limit` (CAP-7). */
export const PAGE_LIMIT_DEFAULT = 50;
/** The most rows one page may hold; a larger `limit` is a 400 `validation_failed`. */
export const PAGE_LIMIT_MAX = 200;

/**
 * Query for every list route: an opaque `cursor` from the previous page and a `limit`.
 * Add filters with `listQuery.extend({...})`.
 */
export const listQuery = z.object({
  cursor: z.string().min(1).max(512).optional().describe('next_cursor from the previous page'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT)
    .describe(
      `Rows per page (default ${String(PAGE_LIMIT_DEFAULT)}, max ${String(PAGE_LIMIT_MAX)})`,
    ),
});

/** Response of every list route. `next_cursor` is null on the last page. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}
