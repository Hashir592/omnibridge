/**
 * The quantity OmniBridge sends to a merchant-fulfilled listing (INV-2, replaced by INV-10 and
 * C7.1 for manual listings). Pure and integer-only, so the engine, the screens and the tests use
 * the same rule.
 */
export type StockMode = 'auto' | 'manual';

export interface TargetInput {
  /** The component's available: on hand minus reserved (INV-1); may be below 0 (INV-6). */
  available: number;
  /** The buffer in force: the listing's own, else its account's (INV-2). */
  buffer: number;
  /** 1 for a plain SKU; a bundle's pack size (CAT-3). */
  packSize: number;
  mode: StockMode;
  /** INV-10, manual mode only: the number typed and the units sold on the listing since. */
  manualQty?: number;
  manualSold?: number;
}

/** What is left of a manual allocation: never below 0 (C7.1). */
export function remainingAllocation(manualQty: number, manualSold: number): number {
  return Math.max(0, manualQty - manualSold);
}

/**
 * Auto: max(0, floor((available - buffer) / pack)). Manual: the lower of what is left of the
 * allocation and that stock figure, so a manual number can limit a channel but never show more
 * than real stock; `cappedByStock` is the "Capped by stock" badge.
 */
export function listingTarget(input: TargetInput): { target: number; cappedByStock: boolean } {
  const pack = Math.max(1, Math.trunc(input.packSize));
  const byStock = Math.max(0, Math.floor((input.available - input.buffer) / pack));
  if (input.mode !== 'manual') return { target: byStock, cappedByStock: false };
  const left = remainingAllocation(input.manualQty ?? 0, input.manualSold ?? 0);
  return { target: Math.min(left, byStock), cappedByStock: byStock < left };
}
