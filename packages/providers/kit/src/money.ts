import { z } from 'zod';

/*
 * Channel money (FIN-1, invariant 12): amounts arrive as decimal strings and become integer pence
 * here, by text, never through a float. Only GBP is accepted (TEN-6); a parser that meets another
 * currency fails, which raises the parser notice once (INT-5).
 */

const AMOUNT = /^(\d{1,9})(?:\.(\d{1,2}))?$/;
const SIGNED = /^-?\d{1,9}(?:\.\d{1,2})?$/;

/** "12.34" to pence (1234). A minus sign is refused, so a negative amount never turns positive. */
export function penceFromAmount(text: string): number {
  const m = AMOUNT.exec(text.trim());
  if (m === null) throw new RangeError('not a money amount');
  const [, whole = '0', fraction = ''] = m;
  return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}

/** "-1.5" to pence with its sign (-150). */
function signedPence(text: string): number {
  const size = penceFromAmount(text.replace('-', ''));
  return text.startsWith('-') && size !== 0 ? -size : size;
}

/** A money string in a parser schema, turned into pence. */
export const PenceAmount = z
  .string()
  .regex(AMOUNT, 'money amount')
  .transform((v) => penceFromAmount(v));

/** A discount: channels send it with or without its minus sign, so only its size counts. */
export const PenceDiscount = z
  .string()
  .regex(SIGNED, 'money amount')
  .transform((v) => Math.abs(signedPence(v)));

/** eBay's `{ value, currency }` amount, GBP only, as pence. */
export const GbpAmount = z
  .object({ value: z.string().regex(AMOUNT, 'money amount'), currency: z.literal('GBP') })
  .transform((a) => penceFromAmount(a.value));

/** eBay's amount where either sign is valid (an adjustment): GBP only, the sign kept. */
export const GbpSignedAmount = z
  .object({ value: z.string().regex(SIGNED, 'money amount'), currency: z.literal('GBP') })
  .transform((a) => signedPence(a.value));

/** eBay's amount for a discount: GBP only, its size. */
export const GbpDiscount = GbpSignedAmount.transform((v) => Math.abs(v));
