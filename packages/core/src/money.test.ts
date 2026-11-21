import { describe, expect, it } from 'vitest';
import {
  bundleAvailable,
  divHalfUp,
  formatPounds,
  parsePounds,
  pence,
  timesPack,
} from './money.ts';

describe('money (FIN-1)', () => {
  it('[FIN-1] wraps integer pence as a bigint', () => {
    const price = pence(1299n);
    expect(typeof price).toBe('bigint');
    expect(price).toBe(1299n);
  });

  it('[FIN-1] parses pounds to pence exactly, never through a float', () => {
    expect(parsePounds('12.34')).toBe(1234n);
    expect(parsePounds('0.1')).toBe(10n);
    expect(parsePounds('7')).toBe(700n);
    expect(parsePounds(' 1,234.50 ')).toBe(123450n);
    expect(parsePounds('£2.05')).toBe(205n);
    // 0.1 + 0.2 in floats is 0.30000000000000004; here it is exact.
    expect((parsePounds('0.1') ?? 0n) + (parsePounds('0.2') ?? 0n)).toBe(30n);
    for (const bad of ['', '-1', '1.234', 'abc', '1e3', '12.3.4', '1,23', '99999999999']) {
      expect(parsePounds(bad), bad).toBeUndefined();
    }
  });

  it('[FIN-1] formats pence as pounds', () => {
    expect(formatPounds(pence(1234n))).toBe('12.34');
    expect(formatPounds(pence(5n))).toBe('0.05');
    expect(formatPounds(pence(0n))).toBe('0.00');
  });

  it('[FIN-1] rounds half up, in integers, only where it is asked for', () => {
    expect(divHalfUp(5n, 2n)).toBe(3n);
    expect(divHalfUp(4n, 2n)).toBe(2n);
    expect(divHalfUp(7n, 3n)).toBe(2n);
    // 20% VAT on 1.99 is 39.8p: rounds to 40p.
    expect(divHalfUp(199n * 2000n, 10_000n)).toBe(40n);
    expect(() => divHalfUp(1n, 0n)).toThrow();
    expect(() => divHalfUp(-1n, 2n)).toThrow();
  });

  it('[CAT-3][AT-5] a bundle of 3 shows floor(available / 3); its COGS is the component COGS times the pack size', () => {
    expect(bundleAvailable(10, 3)).toBe(3);
    expect(bundleAvailable(2, 3)).toBe(0);
    expect(bundleAvailable(0, 3)).toBe(0);
    expect(bundleAvailable(-4, 3)).toBe(0);
    expect(timesPack(pence(250n), 3)).toBe(750n);
    expect(() => bundleAvailable(9, 1)).toThrow();
  });
});
