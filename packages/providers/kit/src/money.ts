import { z } from 'zod';

/*
 * Channel money (FIN-1, invariant 12): amounts arrive as decimal strings and become integer pence
 * here, by text, never through a float. Only GBP is accepted (TEN-6); a parser that meets another
 * currency fails, which raises the parser notice once (INT-5).
 */

const AMOUNT = /^-?(\d{1,9})(?:\.(\d{1,2}))?$/;

/** "12.34" or "-1.5" to pence (1234, 150): a discount may arrive negative; its size is kept. */
export function penceFromAmount(text: string): number {
  const m = AMOUNT.exec(text.trim());
  if (m === null) throw new RangeError('not a money amount');
  const [, whole = '0', fraction = ''] = m;
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}

/** A money string in a parser schema, turned into pence. */
export const PenceAmount = z
  .string()
  .regex(AMOUNT, 'money amount')
  .transform((v) => penceFromAmount(v));

/** eBay's `{ value, currency }` amount, GBP only, as pence. */
export const GbpAmount = z
  .object({ value: z.string().regex(AMOUNT, 'money amount'), currency: z.literal('GBP') })
  .transform((a) => penceFromAmount(a.value));
