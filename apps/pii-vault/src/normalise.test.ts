import { describe, expect, it } from 'vitest';
import {
  indexValues,
  maskEmail,
  maskFields,
  maskName,
  maskPhone,
  maskPostcode,
  normaliseName,
  normalisePhone,
  normalisePostcode,
  queryValues,
} from './normalise.ts';

describe('normalising and masking', () => {
  it('[DP-7] normalising makes equal identifiers equal, exactly and never fuzzily', () => {
    expect(normalisePostcode(' g2 1aa ')).toBe('G21AA');
    expect(normaliseName("  Zoë  O'Brien ")).toBe('zoe o brien');
    expect(normalisePhone('+44 (0)7700 900123')).toBe('07700900123');
    expect(normalisePhone('07700 900123')).toBe('07700900123');
    expect(normaliseName('Jon Smith')).not.toBe(normaliseName('John Smith'));
  });

  it('[DP-7] index values cover the searchable fields and the ORD-9 same-buyer key', () => {
    const values = indexValues({
      name: 'Jane Smith',
      email: 'Jane@Example.TEST',
      postcode: 'g2 1aa',
      address_line1: '1 High St',
      channel_buyer_id: 'Buyer-1',
      delivery_instructions: 'leave by door',
    });
    expect(values).toEqual({
      name: 'jane smith',
      email: 'jane@example.test',
      postcode: 'G21AA',
      buyer: 'buyer-1',
      match: 'jane smith|1 high st|G21AA',
    });
    expect(indexValues({ name: 'Jane Smith' }).match).toBeUndefined();
    expect(queryValues({ postcode: ' ', email: 'A@B.TEST' })).toEqual({ email: 'a@b.test' });
  });

  it('[DP-7] masks follow ORD-5 and show nothing else', () => {
    expect(maskName('Jane Smith')).toBe('J. S***');
    expect(maskName('Cher')).toBe('C***');
    expect(maskPostcode('G2 1AA')).toBe('G2');
    expect(maskPostcode('SW1A 1AA')).toBe('SW1A');
    expect(maskEmail('jane@example.test')).toBe('j***@e***');
    expect(maskPhone('07700 900123')).toBe('***123');
    expect(maskFields({ address_line1: '1 High St', delivery_instructions: 'x' })).toEqual({
      address_line1: '***',
      delivery_instructions: '***',
    });
  });
});
