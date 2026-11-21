import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderParserError } from './errors.ts';
import { defineParser, parserRecordKind } from './parser.ts';

const orders = defineParser(
  'ebay',
  'orders',
  1,
  z.object({
    orders: z.array(
      z.object({
        orderId: z.string(),
        lastModifiedDate: z.iso.datetime(),
        lineItems: z.array(z.object({ sku: z.string().optional(), quantity: z.number().int() })),
      }),
    ),
  }),
);

describe('versioned response parsers (INT-5)', () => {
  it('[INT-5] an unknown field is ignored and does not reach the result', () => {
    const parsed = orders.parse({
      orders: [
        {
          orderId: '12-34',
          lastModifiedDate: '2026-11-20T10:00:00.000Z',
          lineItems: [{ sku: 'A', quantity: 2, newEbayField: true }],
          buyer: { username: 'PIIMARK-buyer' },
        },
      ],
      href: 'https://example.test',
    });
    expect(parsed).toEqual({
      orders: [
        {
          orderId: '12-34',
          lastModifiedDate: '2026-11-20T10:00:00.000Z',
          lineItems: [{ sku: 'A', quantity: 2 }],
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain('PIIMARK');
  });

  it('[INT-5] a missing required field throws one parser error naming provider, parser, version and path, never the value', () => {
    let caught: unknown;
    try {
      orders.parse({
        orders: [
          {
            orderId: 'PIIMARK-123',
            lastModifiedDate: '2026-11-20T10:00:00.000Z',
            lineItems: [{ sku: 'PIIMARK-sku' }],
          },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderParserError);
    const err = caught as ProviderParserError;
    expect({
      provider: err.provider,
      parser: err.parser,
      version: err.version,
      path: err.path,
    }).toEqual({
      provider: 'ebay',
      parser: 'orders',
      version: 1,
      path: 'orders[].lineItems[].quantity',
    });
    expect(err.message).not.toContain('PIIMARK');
    expect(JSON.stringify(err)).not.toContain('PIIMARK');
    expect(err.cause).toBeUndefined();
  });

  it('[INT-5] the notice record names the parser and its version within the notification rules', () => {
    expect(parserRecordKind(orders)).toBe('parser_ebay_orders');
    expect(() => defineParser('ebay', 'Orders List', 1, z.object({}))).toThrow(/name/);
    expect(() => defineParser('ebay', 'orders', 0, z.object({}))).toThrow(/version/);
  });
});
