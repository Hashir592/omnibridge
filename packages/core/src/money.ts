/**
 * Money is integer pence held as a bigint (invariant 12, FIN-1). This is the type only; the full
 * money module (arithmetic, half-up rounding, VAT per rate group) arrives in M08.
 */
export type Pence = bigint & { readonly __brand: 'Pence' };

export function pence(value: bigint): Pence {
  return value as Pence;
}
