import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pagedOf, pageQuery, pageResult, PAGE_LIMITS, TOTAL_COUNT_CAP } from './pages.ts';

describe('numbered-page lists (CAP-7, ADR-040)', () => {
  it('[CAP-7] page-based list: limit 20/50/100 accepted, 201 rejected, default 50', () => {
    expect(PAGE_LIMITS).toEqual([20, 50, 100]);
    expect(pageQuery.parse({})).toEqual({ page: 1, limit: 50 });
    for (const limit of ['20', '50', '100']) {
      expect(pageQuery.parse({ page: '3', limit }).limit).toBe(Number(limit));
    }
    for (const limit of ['201', '200', '25', '0', '-1', 'x']) {
      expect(pageQuery.safeParse({ limit }).success, limit).toBe(false);
    }
    for (const page of ['0', '-2', '1.5', 'x']) {
      expect(pageQuery.safeParse({ page }).success, page).toBe(false);
    }
    // Filters are added the same way as on the cursor query.
    expect(pageQuery.extend({ q: z.string() }).parse({ q: 'abc' })).toEqual({
      page: 1,
      limit: 50,
      q: 'abc',
    });
  });

  it('[CAP-7] total capped at 10,000 with totalCapped=true (unit, fake count)', async () => {
    expect(TOTAL_COUNT_CAP).toBe(10_000);
    let askedFor = 0;
    const fakeCount = (n: number) => (upTo: number) => {
      askedFor = upTo;
      return Promise.resolve(Math.min(n, upTo));
    };

    const small = await pageResult({
      items: ['a', 'b'],
      page: 1,
      limit: 50,
      countUpTo: fakeCount(2),
    });
    expect(small).toEqual({ items: ['a', 'b'], page: 1, limit: 50, total: 2, totalCapped: false });
    // The count stops one past the cap, so a huge table is never counted in full.
    expect(askedFor).toBe(10_001);

    const exact = await pageResult({
      items: [],
      page: 200,
      limit: 50,
      countUpTo: fakeCount(10_000),
    });
    expect(exact).toMatchObject({ total: 10_000, totalCapped: false });

    const huge = await pageResult({
      items: [],
      page: 9,
      limit: 100,
      countUpTo: fakeCount(2_500_000),
    });
    expect(huge).toMatchObject({ total: 10_000, totalCapped: true });

    const schema = pagedOf(z.string());
    expect(schema.parse(huge)).toEqual(huge);
  });
});
