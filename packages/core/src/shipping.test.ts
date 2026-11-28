import { describe, expect, it } from 'vitest';
import { clientUid, labelCostShares } from './shipping.ts';

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

describe('shipping money and references (SHP-9, SHP-7, EVRI-3)', () => {
  it('[SHP-9][AT-26] a label cost splits equally, the remainder pence to the earliest orders', () => {
    expect(labelCostShares(1000n, 3)).toEqual([334n, 333n, 333n]);
    expect(labelCostShares(1001n, 3)).toEqual([334n, 334n, 333n]);
    expect(labelCostShares(999n, 3)).toEqual([333n, 333n, 333n]);
    expect(labelCostShares(5n, 1)).toEqual([5n]);
    expect(labelCostShares(0n, 4)).toEqual([0n, 0n, 0n, 0n]);
  });

  it('[SHP-9][FIN-1] property: shares always add up to the cost, differ by at most a penny, earliest first', () => {
    const next = rng(20261128);
    for (let run = 0; run < 2000; run += 1) {
      const cost = BigInt(next(100_000));
      const members = 1 + next(20);
      const shares = labelCostShares(cost, members);
      expect(shares).toHaveLength(members);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(cost);
      const top = shares[0] ?? 0n;
      for (const [i, share] of shares.entries()) {
        expect(share >= 0n && top - share <= 1n).toBe(true);
        if (i > 0) expect(share <= (shares[i - 1] ?? 0n)).toBe(true);
      }
    }
  });

  it('[SHP-9] a split needs between 1 and 20 members', () => {
    expect(() => labelCostShares(100n, 0)).toThrow(RangeError);
    expect(() => labelCostShares(100n, 21)).toThrow(RangeError);
    expect(() => labelCostShares(-1n, 2)).toThrow(RangeError);
  });

  it('[EVRI-3] the client UID is {orderRef}-{parcelNo}, at most 255 characters', () => {
    expect(clientUid('W18400', 1)).toBe('W18400-1');
    expect(clientUid('12-34567-89012', 3)).toBe('12-34567-89012-3');
    expect(clientUid('x'.repeat(300), 2)).toHaveLength(255);
    expect(clientUid('x'.repeat(300), 2).endsWith('-2')).toBe(true);
  });
});
