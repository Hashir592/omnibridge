import { describe, expect, it } from 'vitest';
import { ORIGIN_TAGS, PROVIDERS, providerModeFrom } from './origins.ts';
import type { UsageProvider } from './time.ts';

describe('origin tags (INT-6)', () => {
  it('[INT-6] lists the seven PRD origins, and the providers are those minus manual', () => {
    expect(ORIGIN_TAGS).toEqual([
      'amazon',
      'amazon_ads',
      'ebay',
      'website',
      'evri',
      'dpd',
      'manual',
    ]);
    expect(PROVIDERS).toEqual(ORIGIN_TAGS.filter((t) => t !== 'manual'));
    // The usage table's providers (db-main 0033) are the same set.
    const usage: readonly UsageProvider[] = PROVIDERS;
    expect(usage).toHaveLength(6);
  });

  it('[INT-3] PROVIDER_MODE defaults to mock and refuses anything unknown', () => {
    expect(providerModeFrom(undefined)).toBe('mock');
    expect(providerModeFrom('live')).toBe('live');
    expect(() => providerModeFrom('production')).toThrow(/PROVIDER_MODE/);
  });
});
