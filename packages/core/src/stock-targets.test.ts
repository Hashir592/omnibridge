import { describe, expect, it } from 'vitest';
import { listingTarget, remainingAllocation } from './stock-targets.ts';

describe('stock targets (INV-2, INV-10, C7.1)', () => {
  it('[INV-2] auto: max(0, available - buffer); a bundle floors (available - buffer) / pack', () => {
    expect(listingTarget({ available: 186, buffer: 0, packSize: 1, mode: 'auto' })).toEqual({
      target: 186,
      cappedByStock: false,
    });
    expect(listingTarget({ available: 10, buffer: 3, packSize: 1, mode: 'auto' }).target).toBe(7);
    expect(listingTarget({ available: 2, buffer: 3, packSize: 1, mode: 'auto' }).target).toBe(0);
    // Oversold (INV-6): a negative available never sends a negative quantity.
    expect(listingTarget({ available: -4, buffer: 0, packSize: 1, mode: 'auto' }).target).toBe(0);
    // CAT-3: a 3-pack of 11 available with buffer 1 shows floor(10 / 3) = 3.
    expect(listingTarget({ available: 11, buffer: 1, packSize: 3, mode: 'auto' }).target).toBe(3);
  });

  it('[INV-10] manual: max(0, min(manual_qty - manual_sold, available - buffer)), capped by stock', () => {
    const manual = (manualQty: number, manualSold: number, available: number, buffer = 0) =>
      listingTarget({ available, buffer, packSize: 1, mode: 'manual', manualQty, manualSold });
    expect(manual(120, 0, 186)).toEqual({ target: 120, cappedByStock: false });
    expect(manual(10, 5, 181)).toEqual({ target: 5, cappedByStock: false });
    // A manual number limits a channel but never shows more than real stock (the min).
    expect(manual(120, 0, 50)).toEqual({ target: 50, cappedByStock: true });
    // The buffer caps it too, with the buffer in force now (C7.3 "Buffer changed").
    expect(manual(120, 0, 50, 5)).toEqual({ target: 45, cappedByStock: true });
    // Used up: 0, not negative; and 0 typed stops selling on that listing.
    expect(manual(10, 12, 100)).toEqual({ target: 0, cappedByStock: false });
    expect(manual(0, 0, 100)).toEqual({ target: 0, cappedByStock: false });
  });

  it('[INV-10] a manual bundle listing: its own number, stock part divided by the pack and floored', () => {
    expect(
      listingTarget({
        available: 30,
        buffer: 0,
        packSize: 3,
        mode: 'manual',
        manualQty: 20,
        manualSold: 0,
      }),
    ).toEqual({ target: 10, cappedByStock: true });
  });

  it('[INV-10] remaining allocation never goes below zero', () => {
    expect(remainingAllocation(10, 4)).toBe(6);
    expect(remainingAllocation(10, 14)).toBe(0);
  });
});
