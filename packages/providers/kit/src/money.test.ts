import { describe, expect, it } from 'vitest';
import { GbpAmount, penceFromAmount } from './money.ts';

describe('channel money to pence', () => {
  it('[FIN-1] turns decimal strings into integer pence without floats', () => {
    expect(penceFromAmount('12.00')).toBe(1200);
    expect(penceFromAmount('0.1')).toBe(10);
    expect(penceFromAmount('7')).toBe(700);
    expect(penceFromAmount('-1.50')).toBe(150);
    // 0.1 + 0.2 style float error cannot happen: the text is read digit by digit.
    expect(penceFromAmount('1234567.89')).toBe(123456789);
    expect(() => penceFromAmount('1.234')).toThrow(RangeError);
    expect(() => penceFromAmount('1e3')).toThrow(RangeError);
  });

  it('[FIN-1] accepts GBP only', () => {
    expect(GbpAmount.parse({ value: '3.00', currency: 'GBP' })).toBe(300);
    expect(GbpAmount.safeParse({ value: '3.00', currency: 'EUR' }).success).toBe(false);
  });
});
