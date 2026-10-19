import { describe, expect, it } from 'vitest';
import { parseKg, parseParcels } from './NumberField.tsx';

describe('shipping desk number fields', () => {
  it('[SHP-2] reads a parcel weight in kg as whole grams, and waits on half-typed values', () => {
    expect(parseKg('1.25')).toBe(1250);
    expect(parseKg('0.49')).toBe(490);
    expect(parseKg('2')).toBe(2000);
    expect(parseKg('1.')).toBe(1000);
    expect(parseKg('')).toBeNull();
    expect(parseKg('.')).toBeNull();
    expect(parseKg('0')).toBeNull();
    expect(parseKg('1.2345')).toBeNull();
    expect(parseKg('-1')).toBeNull();
  });

  it('[SHP-2] accepts a parcel count from 1 to 9 only', () => {
    expect(parseParcels('2')).toBe(2);
    expect(parseParcels('')).toBeNull();
    expect(parseParcels('0')).toBeNull();
    expect(parseParcels('12')).toBeNull();
  });
});
