import { describe, expect, it } from 'vitest';
import { pence } from './money.ts';

describe('Pence (stub until M08)', () => {
  it('[FIN-1] wraps integer pence as a bigint', () => {
    const price = pence(1299n);
    expect(typeof price).toBe('bigint');
    expect(price).toBe(1299n);
  });
});
