import type { Notification } from '../auth/api.ts';
import { formatInt } from './format.ts';

/** Where a notification leads: the tab of its record, or a more exact view for some types. */
export interface NotificationTarget {
  to: string;
  search?: Record<string, string>;
}

const TAB_PATH: Record<string, string> = {
  home: '/',
  orders: '/orders',
  shipping: '/shipping',
  'stock-catalogue': '/stock',
  'customer-service': '/customer-service',
  'account-health': '/account-health',
  advertising: '/advertising',
  'sales-profit': '/sales-profit',
  forecasting: '/forecasting',
  finance: '/finance',
  reminders: '/reminders',
  notes: '/notes',
  connections: '/connections',
  users: '/users',
  settings: '/settings',
  'audit-log': '/audit-log',
};

const BY_TYPE: Record<string, NotificationTarget> = {
  'inventory.oversold': { to: '/stock', search: { view: 'oversold' } },
  'inventory.sync_failed': { to: '/stock', search: { view: 'sync' } },
  'tracking.unconfirmed': { to: '/orders', search: { flag: 'tracking_unconfirmed' } },
  'cs.negative_feedback': { to: '/customer-service', search: { section: 'feedback' } },
  'finance.bill_due': { to: '/finance', search: { section: 'expenses', status: 'overdue' } },
  'ads.rule_changes': { to: '/advertising', search: { section: 'rules' } },
  'pii.erasure_failed': { to: '/users/buyer-data' },
};

/** A platform notice (no tab) belongs to the console. */
export function targetOf(n: Pick<Notification, 'type' | 'tab'>): NotificationTarget {
  return BY_TYPE[n.type] ?? { to: n.tab === null ? '/platform' : (TAB_PATH[n.tab] ?? '/') };
}

const KIND: Record<string, string> = {
  sku: 'SKU',
  channel_account: 'Channel account',
  ads_rule: 'Ads rule',
};

const humanise = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();

export const kindLabel = (kind: string): string =>
  KIND[kind] ?? humanise(kind).replace(/^./, (c) => c.toUpperCase());

/**
 * The line under the title (PS-030: the server sends no detail text). Built from the record's kind
 * and the counts in its params; IDs and flags are never shown.
 */
export function detailOf(n: Pick<Notification, 'record' | 'params'>): string {
  const bits = [kindLabel(n.record.kind)];
  for (const [key, value] of Object.entries(n.params)) {
    if (typeof value === 'number')
      bits.push(`${formatInt(value)} ${key === 'count' ? 'affected' : humanise(key)}`);
  }
  return bits.join(' · ');
}
