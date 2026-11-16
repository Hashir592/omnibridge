import { describe, expect, it } from 'vitest';
import { DailyCallBudget, EBAY_WEBHOOK_DAILY_BUDGET, PACKAGE_NAME } from './index.ts';

describe('@omnibridge/governor-ebay', () => {
  it('[NFR-1] package is importable', () => {
    expect(PACKAGE_NAME).toBe('@omnibridge/governor-ebay');
  });

  it('[RL-2] counts before sending: past the daily budget it refuses, and a new day starts again', () => {
    let now = Date.parse('2026-11-16T10:00:00Z');
    const budget = new DailyCallBudget({ 'notification.public_key': 2, other: 1 }, () => now);
    expect(budget.take('notification.public_key')).toBe(true);
    expect(budget.take('notification.public_key')).toBe(true);
    expect(budget.take('notification.public_key')).toBe(false);
    // Each API has its own budget.
    expect(budget.take('other')).toBe(true);
    now = Date.parse('2026-11-17T00:00:01Z');
    expect(budget.take('notification.public_key')).toBe(true);
  });

  it('[RL-2] the webhook budget covers both calls of a key read', () => {
    expect(Object.keys(EBAY_WEBHOOK_DAILY_BUDGET).sort()).toEqual([
      'identity.app_token',
      'notification.public_key',
    ]);
  });
});
