import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractRoutes } from './registry.ts';

/**
 * PLAT-3, statically: the fields any platform route may answer with. IDs, workspace names,
 * statuses, dates, counts, names of flags, modules, job types and notice types, never a tenant's
 * orders, customers, finance or messages. A new field must be added here on purpose.
 */
const CONSOLE_FIELDS = new Set([
  // workspaces
  'id',
  'name',
  'status',
  'status_changed_at',
  'created_at',
  'modules',
  'website_connector',
  'counts',
  'users',
  'channel_accounts',
  'orders_per_day',
  'items',
  // flags and the incident banner
  'public_signup',
  'updated_at',
  'incident',
  'message',
  'severity',
  'set_at',
  // jobs
  'type',
  'queued',
  'active',
  'failed',
  'dead_letter',
  'workspace_id',
  'attempt',
  'error_code',
  'dead_lettered_at',
  // API usage and credential expiry
  'channel_account_id',
  'provider',
  'api',
  'day',
  'calls',
  'cap',
  'kind',
  'slot',
  'expires_at',
  // app secrets (PLAT-4): names and set-on dates, never a value
  'current',
  'next',
  // health
  'services',
  'web',
  'db_main',
  'pii_vault',
  'worker',
  'worker_heartbeat_at',
  'queue',
  'version',
  // platform notices (T-0501): the registry's title, IDs and counts in params
  'next_cursor',
  'unread',
  'marked',
  'title',
  'signal',
  'tab',
  'companyId',
  'channelAccountId',
  'record',
  'params',
  'state',
  'createdAt',
  'updatedAt',
  'resolvedAt',
  // M07: the maintenance switch and live usage (SAFE-3, RL-5), names and counts only
  'maintenance',
  'ebay_budget',
  'non_urgent_limit',
  'hard_limit',
]);

/** Every property name anywhere in a JSON Schema. */
function propertyNames(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, out);
  } else if (typeof schema === 'object' && schema !== null) {
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        for (const name of Object.keys(value)) out.add(name);
      }
      propertyNames(value, out);
    }
  }
  return out;
}

describe('platform console answers (PLAT-3)', () => {
  it('[PLAT-3] every platform route answers only allowlisted fields: no tenant business data', () => {
    const platform = contractRoutes.filter((r) => r.auth === 'platform');
    expect(platform.length).toBeGreaterThanOrEqual(20);
    const unexpected: string[] = [];
    for (const route of platform) {
      for (const schema of Object.values(route.responses)) {
        for (const name of propertyNames(z.toJSONSchema(schema, { io: 'output' }))) {
          if (!CONSOLE_FIELDS.has(name)) unexpected.push(`${route.id}: ${name}`);
        }
      }
    }
    expect(unexpected).toEqual([]);
  });
});
