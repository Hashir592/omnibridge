import { describe, expect, it } from 'vitest';
import {
  formatLondonDate,
  formatLondonDateTime,
  londonDate,
  parseUtc,
  providerDay,
  toUtcIso,
} from './time.ts';

const at = (iso: string) => new Date(iso);

describe('London dates (NFR-7)', () => {
  it('[NFR-7] londonDate maps 2026-03-29T00:30Z and BST boundaries correctly', () => {
    // Spring forward: clocks go from 01:00 GMT to 02:00 BST on Sunday 29 March 2026.
    expect(londonDate(at('2026-03-28T23:30:00Z'))).toBe('2026-03-28'); // GMT, 23:30 Saturday
    expect(londonDate(at('2026-03-29T00:30:00Z'))).toBe('2026-03-29'); // GMT, 00:30 Sunday
    expect(londonDate(at('2026-03-29T00:59:59Z'))).toBe('2026-03-29'); // last GMT second
    expect(londonDate(at('2026-03-29T22:59:59Z'))).toBe('2026-03-29'); // BST, 23:59:59 Sunday
    expect(londonDate(at('2026-03-29T23:00:00Z'))).toBe('2026-03-30'); // BST, midnight Monday

    // Fall back: clocks go from 02:00 BST to 01:00 GMT on Sunday 25 October 2026.
    expect(londonDate(at('2026-10-24T22:59:59Z'))).toBe('2026-10-24'); // BST, 23:59:59 Saturday
    expect(londonDate(at('2026-10-24T23:00:00Z'))).toBe('2026-10-25'); // BST, midnight Sunday
    expect(londonDate(at('2026-10-25T00:30:00Z'))).toBe('2026-10-25'); // BST, first 01:30
    expect(londonDate(at('2026-10-25T01:30:00Z'))).toBe('2026-10-25'); // GMT, second 01:30
    expect(londonDate(at('2026-10-25T23:30:00Z'))).toBe('2026-10-25'); // GMT, 23:30 Sunday
    expect(londonDate(at('2026-10-26T00:00:00Z'))).toBe('2026-10-26'); // GMT, midnight Monday
  });

  it('[NFR-7] a UTC late-evening VAT date in summer falls on the next London day', () => {
    expect(londonDate(at('2026-06-30T23:15:00Z'))).toBe('2026-07-01');
    expect(londonDate(at('2026-12-31T23:15:00Z'))).toBe('2026-12-31');
  });

  it('[NFR-7] displays times in Europe/London as DD/MM/YYYY', () => {
    expect(formatLondonDate(at('2026-03-29T23:00:00Z'))).toBe('30/03/2026');
    expect(formatLondonDateTime(at('2026-07-01T08:05:00Z'))).toBe('01/07/2026 09:05');
    expect(formatLondonDateTime(at('2026-01-15T08:05:00Z'))).toBe('15/01/2026 08:05');
    expect(formatLondonDateTime(at('2026-10-25T00:30:00Z'))).toBe('25/10/2026 01:30');
    expect(formatLondonDateTime(at('2026-10-25T01:30:00Z'))).toBe('25/10/2026 01:30');
  });

  it('[NFR-7] stores instants as UTC ISO strings', () => {
    expect(toUtcIso(at('2026-07-01T09:05:00+01:00'))).toBe('2026-07-01T08:05:00.000Z');
    expect(parseUtc('2026-07-01T09:05:00+01:00').toISOString()).toBe('2026-07-01T08:05:00.000Z');
  });

  it('[NFR-7] refuses timestamps without a zone and invalid dates', () => {
    expect(() => parseUtc('2026-07-01T09:05:00')).toThrow(RangeError);
    expect(() => parseUtc('2026-07-01')).toThrow(RangeError);
    expect(() => parseUtc('not a date')).toThrow(RangeError);
    expect(() => parseUtc('2026-02-30T10:00:00Z')).toThrow(RangeError);
    expect(() => londonDate(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => toUtcIso(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('provider usage days (PLAT-2)', () => {
  it('[PLAT-2] eBay counts by its own US Pacific day; the others by UTC day', () => {
    // 07:30 UTC on 20 Nov is still 23:30 on 19 Nov in Los Angeles (PST, UTC-8).
    expect(providerDay('ebay', at('2026-11-20T07:30:00Z'))).toBe('2026-11-19');
    expect(providerDay('ebay', at('2026-11-20T08:00:00Z'))).toBe('2026-11-20');
    // Summer (PDT, UTC-7).
    expect(providerDay('ebay', at('2026-07-01T06:59:59Z'))).toBe('2026-06-30');
    expect(providerDay('ebay', at('2026-07-01T07:00:00Z'))).toBe('2026-07-01');
    expect(providerDay('amazon', at('2026-11-20T23:59:59Z'))).toBe('2026-11-20');
    expect(providerDay('amazon_ads', at('2026-11-21T00:00:00Z'))).toBe('2026-11-21');
    expect(providerDay('dpd', at('2026-06-30T23:30:00Z'))).toBe('2026-06-30');
  });
});
