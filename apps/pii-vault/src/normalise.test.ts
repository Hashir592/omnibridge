import { describe, expect, it } from 'vitest';
import {
  indexValues,
  maskEmail,
  maskFields,
  maskName,
  maskPhone,
  maskPostcode,
  normaliseBuyerExact,
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
      buyer_exact: 'Buyer-1',
      match: 'jane smith|1 high st|||G21AA||',
    });
    expect(indexValues({ name: 'Jane Smith' }).match).toBeUndefined();
    expect(queryValues({ postcode: ' ', email: 'A@B.TEST' })).toEqual({ email: 'a@b.test' });
  });

  it('[AT-26][ORD-9] the same-buyer key is exact after normalising, with town, country and eBay username (C3.1)', () => {
    const key = (f: Record<string, string>) => indexValues(f).match;
    const base = {
      name: 'Zoë Smith',
      address_line1: '1 High St.',
      address_line2: 'Flat 2',
      city: 'Glasgow',
      postcode: 'G2 1AA',
      country: 'gb',
      channel_username: 'zoe_s',
    };
    // Case, spacing, accents and punctuation do not matter.
    expect(
      key({
        ...base,
        name: ' ZOE   SMITH',
        address_line1: '1 high st',
        postcode: 'g21aa',
        country: 'GB',
      }),
    ).toBe(key(base));
    // A different name at the same address, another town, or another eBay username does.
    expect(key({ ...base, name: 'Ian Smith' })).not.toBe(key(base));
    expect(key({ ...base, city: 'Edinburgh' })).not.toBe(key(base));
    expect(key({ ...base, channel_username: 'Zoe_S' })).not.toBe(key(base));
  });

  it("[AT-10] the exact buyer index trims only: 'AbC' and 'abc' stay different (ADR-066)", () => {
    expect(normaliseBuyerExact('  AbC	')).toBe('AbC');
    expect(normaliseBuyerExact('AbC')).not.toBe(normaliseBuyerExact('abc'));
    expect(indexValues({ buyer_username: ' Seller_Fan ' })).toEqual({
      buyer: 'seller_fan',
      buyer_exact: 'Seller_Fan',
    });
    expect(indexValues({ channel_buyer_id: '   ' })).toEqual({});
    // A blank ID never hides the username behind it.
    expect(indexValues({ channel_buyer_id: ' ', buyer_username: 'Fan' })).toEqual({
      buyer: 'fan',
      buyer_exact: 'Fan',
    });
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
