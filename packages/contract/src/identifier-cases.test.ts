import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuyerIdentifiersSchema } from './routes/privacy.ts';

// ADR-072: one case table for the identifier rule, shared with the SPA's test, so a change to the
// rule on either side breaks a test.
const FIXTURE = join(import.meta.dirname, '../../testkit/fixtures/buyer-identifier-cases.json');
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  cases: { identifiers: Record<string, string>; pins: boolean }[];
};

describe('erasure identifier rule', () => {
  it('[DEL-4] BuyerIdentifiersSchema accepts exactly the shared cases that pin one buyer', () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const { identifiers, pins } of cases) {
      expect(
        BuyerIdentifiersSchema.safeParse(identifiers).success,
        JSON.stringify(identifiers),
      ).toBe(pins);
    }
  });
});
