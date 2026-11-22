import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder } from './allocate.ts';
import { pence, type Pence } from './money.ts';
import { computeOrderVat, computeRefundVat, type VatLineInput } from './vat.ts';

/** A small seeded generator (mulberry32), so property runs are repeatable without a dependency. */
function rng(seed: number): (max: number) => number {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

const p = (n: number): Pence => pence(BigInt(n));
const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
const std = (gross: number): VatLineInput => ({
  lineGross: p(gross),
  rateBp: 2000,
  vatType: 'standard',
});
const zero = (gross: number): VatLineInput => ({ lineGross: p(gross), rateBp: 0, vatType: 'zero' });

const RATES: readonly VatLineInput['vatType'][] = ['standard', 'reduced', 'zero', 'no_vat', null];
const BP = { standard: 2000, reduced: 500, zero: 0, no_vat: 0 } as const;

function randomLines(next: (max: number) => number): VatLineInput[] {
  return Array.from({ length: 1 + next(6) }, () => {
    const vatType = RATES[next(RATES.length)] ?? null;
    return { lineGross: p(next(50_000)), rateBp: vatType === null ? 2000 : BP[vatType], vatType };
  });
}

describe('largest-remainder allocation (FA-12)', () => {
  it('[VAT-3] gives remainder pence to the largest remainders, ties by line order', () => {
    expect(allocateLargestRemainder(p(100), [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateLargestRemainder(p(595), [1n, 1n, 1n])).toEqual([199n, 198n, 198n]);
    expect(allocateLargestRemainder(p(10), [3n, 7n])).toEqual([3n, 7n]);
    expect(allocateLargestRemainder(p(0), [5n, 5n])).toEqual([0n, 0n]);
    // No weight at all: split evenly, earliest first.
    expect(allocateLargestRemainder(p(5), [0n, 0n])).toEqual([3n, 2n]);
  });

  it('[VAT-3][FIN-1] property: the parts always sum to the whole and never go negative', () => {
    const next = rng(20261122);
    for (let run = 0; run < 2000; run++) {
      const weights = Array.from({ length: 1 + next(8) }, () => BigInt(next(100_000)));
      const total = p(next(1_000_000));
      const parts = allocateLargestRemainder(total, weights);
      expect(sum(parts)).toBe(total);
      for (const part of parts) expect(part >= 0n).toBe(true);
    }
  });
});

describe('sales VAT per order (VAT-1 to VAT-4)', () => {
  it('[AT-15][VAT-3] £12 standard + £6 zero + £3 shipping gives £2.33 and £0', () => {
    const vat = computeOrderVat({
      lines: [std(1200), zero(600)],
      discount: p(0),
      shipping: p(300),
    });
    const [standard, zeroGroup] = vat.groups;
    expect(standard).toMatchObject({
      vatType: 'standard',
      rateBp: 2000,
      shipping: 200n,
      gross: 1400n,
      vat: 233n,
      net: 1167n,
    });
    expect(zeroGroup).toMatchObject({
      vatType: 'zero',
      rateBp: 0,
      shipping: 100n,
      gross: 700n,
      vat: 0n,
    });
    expect(vat.vat).toBe(233n);
  });

  it('[VAT-4][AT-15] zero-rated and No VAT are separate groups with VAT 0', () => {
    const vat = computeOrderVat({
      lines: [zero(500), { lineGross: p(500), rateBp: 0, vatType: 'no_vat' }],
      discount: p(0),
      shipping: p(0),
    });
    expect(vat.groups.map((g) => [g.vatType, g.vat])).toEqual([
      ['zero', 0n],
      ['no_vat', 0n],
    ]);
  });

  it('[VAT-3] discount comes off each group pro-rata to goods; one rate takes all shipping', () => {
    const vat = computeOrderVat({
      lines: [std(1000), std(500)],
      discount: p(300),
      shipping: p(399),
    });
    expect(vat.groups).toHaveLength(1);
    expect(vat.groups[0]).toMatchObject({
      discount: 300n,
      shipping: 399n,
      gross: 1599n,
      vat: 267n,
    });
  });

  it('[VAT-3] VAT is rounded once on the group, and line VAT is a share of it (FA-12)', () => {
    // Three £0.10 lines: per-line rounding would give 3 × 2p = 6p; the group gives 30 / 6 = 5p.
    const vat = computeOrderVat({
      lines: [std(10), std(10), std(10)],
      discount: p(0),
      shipping: p(0),
    });
    expect(vat.vat).toBe(5n);
    expect(vat.lines.map((l) => l.vat)).toEqual([2n, 2n, 1n]);
  });

  it('[VAT-2] an unmapped line counts at the default rate and marks its group provisional (FA-11)', () => {
    const vat = computeOrderVat({
      lines: [std(1200), { lineGross: p(600), rateBp: 2000, vatType: null }],
      discount: p(0),
      shipping: p(0),
    });
    expect(vat.groups).toHaveLength(1);
    expect(vat.groups[0]).toMatchObject({ rateBp: 2000, provisional: true, vat: 300n });
  });

  it('[VAT-3][FIN-1] property: groups and lines sum to the order, VAT never exceeds gross', () => {
    const next = rng(77);
    for (let run = 0; run < 1500; run++) {
      const lines = randomLines(next);
      const goods = sum(lines.map((l) => l.lineGross));
      const discount = p(goods === 0n ? 0 : next(Number(goods) + 1));
      const shipping = p(next(2_000));
      const vat = computeOrderVat({ lines, discount, shipping });
      expect(sum(vat.groups.map((g) => g.gross))).toBe(goods - discount + shipping);
      expect(sum(vat.lines.map((l) => l.gross))).toBe(goods - discount + shipping);
      expect(sum(vat.lines.map((l) => l.vat))).toBe(vat.vat);
      expect(sum(vat.groups.map((g) => g.vat))).toBe(vat.vat);
      for (const g of vat.groups) {
        expect(g.vat <= g.gross).toBe(true);
        expect(g.net).toBe(g.gross - g.vat);
        if (g.rateBp === 0) expect(g.vat).toBe(0n);
      }
    }
  });

  it('[VAT-3] refuses a discount larger than the goods', () => {
    expect(() => computeOrderVat({ lines: [std(100)], discount: p(101), shipping: p(0) })).toThrow(
      RangeError,
    );
  });
});

describe('refund VAT (VAT-5, FA-12 cap)', () => {
  it('[AT-16][VAT-5] a £6 refund on a £12 standard line reduces VAT by £1.00', () => {
    const order = computeOrderVat({ lines: [std(1200)], discount: p(0), shipping: p(0) });
    const refund = computeRefundVat({
      order,
      refunded: [],
      refund: { amount: p(600), lines: [{ line: 0, amount: p(600) }] },
    });
    expect(refund.vat).toBe(100n);
    expect(refund.groups[0]).toMatchObject({
      vatType: 'standard',
      rateBp: 2000,
      gross: 600n,
      vat: 100n,
    });
  });

  it('[VAT-5] two £7 refunds on a £14 group give back 233p in total, never 234p', () => {
    const order = computeOrderVat({ lines: [std(1400)], discount: p(0), shipping: p(0) });
    const first = computeRefundVat({ order, refunded: [], refund: { amount: p(700) } });
    const second = computeRefundVat({ order, refunded: [first], refund: { amount: p(700) } });
    expect(first.vat).toBe(117n);
    expect(second.vat).toBe(116n);
    expect(first.vat + second.vat).toBe(order.vat);
  });

  it('[VAT-5] a refund without line detail splits across the rate groups pro-rata to gross', () => {
    const order = computeOrderVat({
      lines: [std(1200), zero(600)],
      discount: p(0),
      shipping: p(300),
    });
    const refund = computeRefundVat({ order, refunded: [], refund: { amount: p(1050) } });
    // Gross 1400 : 700, so 700 and 350.
    expect(refund.groups.map((g) => [g.vatType, g.gross, g.vat])).toEqual([
      ['standard', 700n, 117n],
      ['zero', 350n, 0n],
    ]);
  });

  it("[VAT-5] a refund tied to lines uses those lines' rates only", () => {
    const order = computeOrderVat({
      lines: [std(1200), zero(600)],
      discount: p(0),
      shipping: p(0),
    });
    const refund = computeRefundVat({
      order,
      refunded: [],
      refund: { amount: p(600), lines: [{ line: 1, amount: p(600) }] },
    });
    expect(refund.vat).toBe(0n);
    expect(refund.groups.map((g) => g.vatType)).toEqual(['zero']);
  });

  it('[VAT-5][FIN-1] property: refunds never give back more VAT than was charged on a group', () => {
    const next = rng(5);
    for (let run = 0; run < 1500; run++) {
      const lines = randomLines(next);
      const order = computeOrderVat({ lines, discount: p(0), shipping: p(next(1_000)) });
      const refunded: ReturnType<typeof computeRefundVat>[] = [];
      let left: bigint = order.gross;
      while (left > 0n && refunded.length < 6) {
        const amount = p(1 + next(Number(left)));
        refunded.push(computeRefundVat({ order, refunded, refund: { amount } }));
        left -= amount;
      }
      for (const group of order.groups) {
        const back = sum(
          refunded.flatMap((r) => r.groups.filter((g) => g.key === group.key).map((g) => g.vat)),
        );
        expect(back <= group.vat).toBe(true);
        // A refund of the whole order gives back exactly the VAT charged.
        if (left === 0n) expect(back).toBe(group.vat);
      }
    }
  });
});
