/**
 * Audit log viewer for the client preview (T-0305). PROPOSED SHAPE (mock only), AUD-1..4.
 * Append-only: there is no edit or delete route. Entries never hold buyer PII (AUD-3).
 * Synthetic users and documentation-range IP addresses only.
 */
import { orders } from './data.ts';
import { HOUR, rng } from './random.ts';

export type AuditArea =
  'sign_in' | 'users' | 'connections' | 'stock' | 'finance' | 'ads' | 'exports';

export interface AuditEntry {
  id: string;
  at: string;
  user: string;
  area: AuditArea;
  action: string;
  entity: string;
  change: string | null;
  reason: string | null;
  ip: string;
}

export const AREA_LABEL: Record<AuditArea, string> = {
  sign_in: 'Sign-in',
  users: 'Users and permissions',
  connections: 'Connections',
  stock: 'Stock and catalogue',
  finance: 'Finance',
  ads: 'Advertising',
  exports: 'Exports',
};

const r = rng(2_6);
const ADMIN_ONLY = new Set([
  'vat_period.filed',
  'user.permissions_changed',
  'connection.kill_switch',
  'expense.company_changed',
]);
const USERS = ['Sam Admin', 'Pat Packer', 'Alex Accounts', 'Chris Stock', 'Jo Support'];

const KINDS: Array<() => Omit<AuditEntry, 'id' | 'at' | 'user' | 'ip'>> = [
  () => ({ area: 'sign_in', action: 'auth.login', entity: 'Session', change: null, reason: null }),
  () => ({
    area: 'sign_in',
    action: 'auth.login_failed',
    entity: 'Session',
    change: 'Wrong password',
    reason: null,
  }),
  () => ({
    area: 'stock',
    action: 'stock.adjusted',
    entity: `SKU TT-STE-M10${String(r.int(0, 9))}`,
    change: `On hand ${String(r.int(20, 90))} → ${String(r.int(10, 19))}`,
    reason: 'Damaged',
  }),
  () => ({
    area: 'stock',
    action: 'cogs.changed',
    entity: `SKU CB-OAK-L1${String(r.int(10, 40))}`,
    change: '£3.85 → £4.10 from 21/10/2026',
    reason: null,
  }),
  () => ({
    area: 'finance',
    action: 'expense.created',
    entity: `Expense INV-${String(r.int(10_000, 99_999))}`,
    change: 'Gross £340.50, Professional fees',
    reason: null,
  }),
  () => ({
    area: 'finance',
    action: 'expense.company_changed',
    entity: `Expense INV-${String(r.int(10_000, 99_999))}`,
    change: 'Northfield Trading → Harbour Goods',
    reason: 'Booked to the wrong company',
  }),
  () => ({
    area: 'finance',
    action: 'vat_period.filed',
    entity: 'VAT Apr to Jun 2026, Northfield Trading',
    change: 'Open → Filed and locked',
    reason: null,
  }),
  () => ({
    area: 'users',
    action: 'user.permissions_changed',
    entity: 'User Chris Stock',
    change: 'Tabs: + Forecasting',
    reason: null,
  }),
  () => ({
    area: 'connections',
    action: 'connection.kill_switch',
    entity: 'eBay · kestrel-home',
    change: 'Off → On',
    reason: 'Listings under review',
  }),
  () => ({
    area: 'ads',
    action: 'ads.bid_changed',
    entity: 'Keyword "oak board"',
    change: '£0.85 → £0.72 (rule)',
    reason: null,
  }),
  () => {
    const o = r.pick(orders);
    return {
      area: 'exports',
      action: 'orders.exported',
      entity: `Orders CSV, ${String(r.int(40, 500))} rows`,
      change: `Filter: ${o.channel}`,
      reason: null,
    };
  },
];

const ENTRIES: AuditEntry[] = Array.from({ length: 240 }, (_, i) => {
  const k = r.pick(KINDS)();
  return {
    id: `aud_${String(i)}`,
    at: new Date(Date.now() - i * 0.9 * HOUR - r.int(0, 50) * 60_000).toISOString(),
    // Admin-only actions (PERM-2, VQ-3) are always by an admin.
    user:
      k.area === 'ads' && k.change?.includes('rule')
        ? 'Ads rule'
        : ADMIN_ONLY.has(k.action)
          ? 'Sam Admin'
          : r.pick(USERS),
    ip: `203.0.113.${String(r.int(2, 250))}`,
    ...k,
  };
});

export function auditPage(p: URLSearchParams) {
  const q = (p.get('q') ?? '').trim().toLowerCase();
  const areas = (p.get('area') ?? '').split(',').filter(Boolean);
  const users = (p.get('user') ?? '').split(',').filter(Boolean);
  const items = ENTRIES.filter(
    (e) =>
      (areas.length === 0 || areas.includes(e.area)) &&
      (users.length === 0 || users.includes(e.user)) &&
      (!q || e.entity.toLowerCase().includes(q) || e.action.includes(q)),
  );
  const limit = [20, 50, 100].includes(Number(p.get('limit'))) ? Number(p.get('limit')) : 50;
  const cursor = Number(p.get('cursor') ?? 0);
  return {
    items: items.slice(cursor, cursor + limit),
    total: items.length,
    users: [...USERS, 'Ads rule'],
  };
}

export type AuditPage = ReturnType<typeof auditPage>;
