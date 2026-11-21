/**
 * Money is integer pence held as a bigint (invariant 12, FIN-1). No float ever carries money:
 * pounds are parsed and printed as text, and the only rounding is half-up in integers, used only
 * where the PRD says (VAT per rate group, M10 and M16).
 */
export type Pence = bigint & { readonly __brand: 'Pence' };

export function pence(value: bigint): Pence {
  return value as Pence;
}

/** Pounds as a person types them: digits, optional thousands commas, up to two decimals. */
const POUNDS = /^(?:\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?$/;

/** "12.34", "£1,234.5" or "7" to pence; undefined for anything else (negative, 3 decimals, 1e3). */
export function parsePounds(text: string): Pence | undefined {
  const trimmed = text.trim().replace(/^£/, '');
  const m = POUNDS.exec(trimmed);
  if (m === null) return undefined;
  const [whole = '0', fraction = ''] = trimmed.replaceAll(',', '').split('.');
  return pence(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}

/** Pence as pounds with two decimals, for CSV exports. */
export function formatPounds(value: Pence): string {
  const sign = value < 0n ? '-' : '';
  const abs: bigint = value < 0n ? 0n - value : value;
  return `${sign}${String(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
}

/** numerator / denominator rounded half up (FIN-1), for non-negative integers only. */
export function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) {
    throw new RangeError('divHalfUp takes a non-negative numerator and a positive denominator');
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** CAT-3: a bundle's COGS is its component's times the pack size. */
export function timesPack(componentCogs: Pence, packSize: number): Pence {
  return pence(componentCogs * BigInt(packSize));
}

/** CAT-3, AT-5: a bundle has no stock of its own; it shows floor(component available / pack). */
export function bundleAvailable(componentAvailable: number, packSize: number): number {
  if (!Number.isInteger(packSize) || packSize < 2) throw new RangeError('pack size is at least 2');
  return componentAvailable <= 0 ? 0 : Math.floor(componentAvailable / packSize);
}
