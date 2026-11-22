import { pence, type Pence } from './money.ts';

/**
 * Splits `total` pence across parts in proportion to `weights` by the largest-remainder method
 * (FA-12 rule 1): each part gets its floor, then the pence left over go one each to the parts
 * with the largest remainders, ties broken by position (line order). The parts always sum to
 * `total`. With no weight at all the split is even, earliest first.
 */
export function allocateLargestRemainder(total: bigint, weights: readonly bigint[]): Pence[] {
  if (total < 0n) throw new RangeError('allocation total must not be negative');
  if (weights.some((w) => w < 0n)) throw new RangeError('allocation weights must not be negative');
  if (weights.length === 0) {
    if (total === 0n) return [];
    throw new RangeError('cannot allocate pence across no parts');
  }
  let scaled: readonly bigint[] = weights;
  let whole = weights.reduce((a, b) => a + b, 0n);
  if (whole === 0n) {
    scaled = weights.map(() => 1n);
    whole = BigInt(weights.length);
  }
  const parts = scaled.map((w) => (total * w) / whole);
  const remainders = scaled.map((w, index) => ({ index, rem: (total * w) % whole }));
  let left = total - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const { index } of remainders) {
    if (left === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts.map((part) => pence(part));
}
