import { describe, expect, it } from 'vitest';
import {
  GbpAmount,
  GbpDiscount,
  GbpSignedAmount,
  PenceAmount,
  PenceDiscount,
  penceFromAmount,
} from './money.ts';

describe('channel money to pence', () => {
  it('[FIN-1] turns decimal strings into integer pence without floats', () => {
    expect(penceFromAmount('12.00')).toBe(1200);
    expect(penceFromAmount('0.1')).toBe(10);
    expect(penceFromAmount('7')).toBe(700);
    // 0.1 + 0.2 style float error cannot happen: the text is read digit by digit.
    expect(penceFromAmount('1234567.89')).toBe(123456789);
    expect(() => penceFromAmount('1.234')).toThrow(RangeError);
    expect(() => penceFromAmount('1e3')).toThrow(RangeError);
  });

  it('[FIN-1] a minus sign is refused, never dropped: -5.00 is not 5.00', () => {
    expect(() => penceFromAmount('-1.50')).toThrow(RangeError);
    expect(PenceAmount.safeParse('-5.00').success).toBe(false);
    expect(GbpAmount.safeParse({ value: '-4.00', currency: 'GBP' }).success).toBe(false);
  });

  it('[FIN-1] a discount arrives with or without its minus: only its size counts', () => {
    expect(PenceDiscount.parse('-1.50')).toBe(150);
    expect(PenceDiscount.parse('1.50')).toBe(150);
    expect(GbpDiscount.parse({ value: '-1.50', currency: 'GBP' })).toBe(150);
    expect(GbpDiscount.safeParse({ value: '-1.50', currency: 'EUR' }).success).toBe(false);
  });

  it('[FIN-1] a signed amount keeps its sign', () => {
    expect(GbpSignedAmount.parse({ value: '-1.50', currency: 'GBP' })).toBe(-150);
    expect(GbpSignedAmount.parse({ value: '1.50', currency: 'GBP' })).toBe(150);
  });

  it('[FIN-1] accepts GBP only', () => {
    expect(GbpAmount.parse({ value: '3.00', currency: 'GBP' })).toBe(300);
    expect(GbpAmount.safeParse({ value: '3.00', currency: 'EUR' }).success).toBe(false);
  });
});
