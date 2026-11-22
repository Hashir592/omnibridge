import { allocateLargestRemainder } from './allocate.ts';
import { divHalfUp, pence, type Pence } from './money.ts';

/*
 * Output VAT on sales (VAT-1 to VAT-6, invariant 12, FA-12). Pure integer pence; prices from
 * channels are VAT-inclusive (VAT-2). The only rounding is half-up, once per rate group (VAT-3);
 * every other split is a largest-remainder allocation, so parts always sum to the whole.
 */

export type SaleVatType = 'standard' | 'reduced' | 'zero' | 'no_vat';

export interface VatLineInput {
  /** Quantity × unit price, VAT-inclusive. */
  lineGross: Pence;
  /** The snapshot rate, or the workspace default while provisional. Basis points. */
  rateBp: number;
  /** The snapshot VAT type; null while the line is unmapped and so provisional (FA-11). */
  vatType: SaleVatType | null;
}

export interface VatGroup {
  /** Stable group key: the rate, except that 0% splits zero-rated from No VAT (VAT-4). */
  key: string;
  /** Null when only provisional lines are in the group. */
  vatType: SaleVatType | null;
  rateBp: number;
  provisional: boolean;
  goods: Pence;
  discount: Pence;
  shipping: Pence;
  gross: Pence;
  vat: Pence;
  net: Pence;
}

export interface VatLine {
  groupKey: string;
  discount: Pence;
  shipping: Pence;
  gross: Pence;
  vat: Pence;
}

export interface OrderVat {
  groups: VatGroup[];
  /** One per input line, in input order. */
  lines: VatLine[];
  gross: Pence;
  vat: Pence;
}

function groupKey(line: VatLineInput): string {
  if (!Number.isInteger(line.rateBp) || line.rateBp < 0 || line.rateBp > 10_000) {
    throw new RangeError('VAT rate must be whole basis points from 0 to 10000');
  }
  return line.rateBp > 0 ? `rate:${String(line.rateBp)}` : `zero:${line.vatType ?? 'provisional'}`;
}

const total = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/** VAT inside a VAT-inclusive gross at `rateBp`, rounded half up (VAT-3 step 4). */
export function vatInGross(gross: bigint, rateBp: number): Pence {
  return pence(rateBp === 0 ? 0n : divHalfUp(gross * BigInt(rateBp), 10_000n + BigInt(rateBp)));
}

/**
 * VAT-3: group the lines by rate; take the discount off each group and add the shipping, both
 * pro-rata to goods value; VAT once per group; net = gross − VAT. Line figures are allocations of
 * their group's (FA-12 rule 2), never rounded per line.
 */
export function computeOrderVat(input: {
  lines: readonly VatLineInput[];
  discount: Pence;
  shipping: Pence;
}): OrderVat {
  const { lines, discount, shipping } = input;
  if (discount < 0n || shipping < 0n)
    throw new RangeError('discount and shipping are not negative');
  if (lines.some((l) => l.lineGross < 0n)) throw new RangeError('line gross must not be negative');
  const goods = total(lines.map((l) => l.lineGross));
  if (discount > goods) throw new RangeError('discount is larger than the goods value');
  if (lines.length === 0) {
    if (discount !== 0n || shipping !== 0n) throw new RangeError('an order with no lines');
    return { groups: [], lines: [], gross: pence(0n), vat: pence(0n) };
  }

  // Groups in order of their first line, so ties always resolve by line order.
  const keys = lines.map(groupKey);
  const order = [...new Set(keys)];
  const members = order.map((key) => keys.flatMap((k, i) => (k === key ? [i] : [])));
  const groupGoods = members.map((idx) => total(idx.map((i) => lines[i]?.lineGross ?? 0n)));
  const groupDiscount = allocateLargestRemainder(discount, groupGoods);
  const groupShipping = allocateLargestRemainder(shipping, groupGoods);

  const outLines: VatLine[] = new Array<VatLine>(lines.length);
  const groups = order.map((key, g): VatGroup => {
    const idx = members[g] ?? [];
    const groupLines = idx.map((i) => lines[i] as VatLineInput);
    const first = groupLines[0] as VatLineInput;
    const typed = groupLines.find((l) => l.vatType !== null);
    const gross = (groupGoods[g] ?? 0n) - (groupDiscount[g] ?? 0n) + (groupShipping[g] ?? 0n);
    const vat = vatInGross(gross, first.rateBp);

    const weights = groupLines.map((l) => l.lineGross);
    const lineDiscount = allocateLargestRemainder(groupDiscount[g] ?? 0n, weights);
    const lineShipping = allocateLargestRemainder(groupShipping[g] ?? 0n, weights);
    const lineGross = groupLines.map(
      (l, j) => l.lineGross - (lineDiscount[j] ?? 0n) + (lineShipping[j] ?? 0n),
    );
    const lineVat = allocateLargestRemainder(vat, lineGross);
    idx.forEach((i, j) => {
      outLines[i] = {
        groupKey: key,
        discount: lineDiscount[j] ?? pence(0n),
        shipping: lineShipping[j] ?? pence(0n),
        gross: pence(lineGross[j] ?? 0n),
        vat: lineVat[j] ?? pence(0n),
      };
    });

    return {
      key,
      vatType: typed?.vatType ?? null,
      rateBp: first.rateBp,
      provisional: groupLines.some((l) => l.vatType === null),
      goods: pence(groupGoods[g] ?? 0n),
      discount: groupDiscount[g] ?? pence(0n),
      shipping: groupShipping[g] ?? pence(0n),
      gross: pence(gross),
      vat,
      net: pence(gross - vat),
    };
  });

  return {
    groups,
    lines: outLines,
    gross: pence(total(groups.map((g) => g.gross))),
    vat: pence(total(groups.map((g) => g.vat))),
  };
}

export interface RefundVatGroup {
  key: string;
  vatType: SaleVatType | null;
  rateBp: number;
  gross: Pence;
  vat: Pence;
}

export interface RefundVat {
  groups: RefundVatGroup[];
  gross: Pence;
  vat: Pence;
}

/**
 * VAT-5 with the FA-12 cap. A refund tied to lines takes those lines' groups; one without line
 * detail splits across the groups pro-rata to the gross each still has unrefunded (the original
 * gross when nothing was refunded yet). Each part's VAT is at the group's original rate, capped
 * so the VAT given back on a group never exceeds the VAT charged on it; the refund that clears a
 * group's gross takes exactly the VAT left (rule 3). `refunded` holds the earlier refunds.
 */
export function computeRefundVat(input: {
  order: OrderVat;
  refunded: readonly RefundVat[];
  refund: { amount: Pence; lines?: readonly { line: number; amount: Pence }[] };
}): RefundVat {
  const { order, refunded, refund } = input;
  if (refund.amount < 0n) throw new RangeError('a refund amount is not negative');
  const before = (key: string, field: 'gross' | 'vat'): bigint =>
    total(refunded.flatMap((r) => r.groups.filter((g) => g.key === key).map((g) => g[field])));
  const remainingGross = order.groups.map((g) => {
    const left = g.gross - before(g.key, 'gross');
    return left > 0n ? left : 0n;
  });

  let parts: bigint[];
  if (refund.lines !== undefined && refund.lines.length > 0) {
    parts = order.groups.map((g) =>
      total(
        refund.lines?.filter((l) => order.lines[l.line]?.groupKey === g.key).map((l) => l.amount) ??
          [],
      ),
    );
  } else {
    parts = allocateLargestRemainder(refund.amount, remainingGross);
  }

  const groups: RefundVatGroup[] = [];
  order.groups.forEach((g, i) => {
    const left = remainingGross[i] ?? 0n;
    const gross = (parts[i] ?? 0n) > left ? left : (parts[i] ?? 0n);
    if (gross <= 0n) return;
    const vatLeft = g.vat - before(g.key, 'vat');
    const atRate = vatInGross(gross, g.rateBp);
    const vat = gross === left ? vatLeft : atRate < vatLeft ? atRate : vatLeft;
    groups.push({
      key: g.key,
      vatType: g.vatType,
      rateBp: g.rateBp,
      gross: pence(gross),
      vat: pence(vat > 0n ? vat : 0n),
    });
  });

  return {
    groups,
    gross: pence(total(groups.map((g) => g.gross))),
    vat: pence(total(groups.map((g) => g.vat))),
  };
}
