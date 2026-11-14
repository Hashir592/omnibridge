/**
 * Admin pages for the client preview (T-0305). PROPOSED SHAPE (mock only): users with their tab
 * and company ticks (PERM-1..7, USR-4) and connections (INT-4). Admin-only routes: the handlers
 * answer 403 to a child. Synthetic people and example.com addresses only.
 */
import { channelAccounts } from './data.ts';
import { DAY, HOUR, ago } from './random.ts';
import type { Channel, Tab } from './types.ts';

export const TICKABLE_TABS: Array<{ key: Tab; label: string }> = [
  { key: 'home', label: 'Home' },
  { key: 'orders', label: 'Orders' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'stock', label: 'Stock & Catalogue' },
  { key: 'customer_service', label: 'Customer Service' },
  { key: 'account_health', label: 'Account Health' },
  { key: 'advertising', label: 'Advertising' },
  { key: 'sales_profit', label: 'Sales & Profit' },
  { key: 'forecasting', label: 'Forecasting' },
  { key: 'finance', label: 'Finance' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'notes', label: 'Notes' },
];

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'child';
  /** Admins see every tab and company (PERM-2); these lists apply to children only. */
  tabs: Tab[];
  companyIds: string[];
  mfa: boolean;
  state: 'active' | 'invited' | 'locked';
  lastSignInAt: string | null;
  inviteExpiresAt: string | null;
}

const ALL = TICKABLE_TABS.map((t) => t.key);

export const users: WorkspaceUser[] = [
  {
    id: 'usr_1',
    name: 'Sam Admin',
    email: 'sam.admin@example.com',
    role: 'admin',
    tabs: ALL,
    companyIds: ['co_1', 'co_2', 'co_3'],
    mfa: true,
    state: 'active',
    lastSignInAt: ago(0.4 * HOUR),
    inviteExpiresAt: null,
  },
  {
    id: 'usr_2',
    name: 'Pat Packer',
    email: 'pat.packer@example.com',
    role: 'child',
    tabs: ['home', 'orders', 'shipping'],
    companyIds: ['co_1', 'co_2'],
    mfa: true,
    state: 'active',
    lastSignInAt: ago(2 * HOUR),
    inviteExpiresAt: null,
  },
  {
    id: 'usr_3',
    name: 'Alex Accounts',
    email: 'alex.accounts@example.com',
    role: 'child',
    tabs: ['home', 'sales_profit', 'finance'],
    companyIds: ['co_1', 'co_2', 'co_3'],
    mfa: true,
    state: 'active',
    lastSignInAt: ago(1.5 * DAY),
    inviteExpiresAt: null,
  },
  {
    id: 'usr_4',
    name: 'Jo Support',
    email: 'jo.support@example.com',
    role: 'child',
    tabs: ['home', 'orders', 'customer_service', 'reminders', 'notes'],
    companyIds: ['co_2'],
    mfa: true,
    state: 'locked',
    lastSignInAt: ago(4 * DAY),
    inviteExpiresAt: null,
  },
  {
    id: 'usr_5',
    name: 'Chris Stock',
    email: 'chris.stock@example.com',
    role: 'child',
    tabs: ['home', 'stock', 'forecasting', 'shipping'],
    companyIds: ['co_1', 'co_3'],
    mfa: true,
    state: 'active',
    lastSignInAt: ago(6 * HOUR),
    inviteExpiresAt: null,
  },
  {
    id: 'usr_6',
    name: 'Robin New',
    email: 'robin.new@example.com',
    role: 'child',
    tabs: [],
    companyIds: [],
    mfa: false,
    state: 'invited',
    lastSignInAt: null,
    inviteExpiresAt: new Date(Date.now() + 52 * HOUR).toISOString(),
  },
];

/* ---------- connections ---------- */

export type ConnectionStatus = 'active' | 'needs_reauth' | 'paused' | 'error' | 'disconnected';

export interface Connection {
  id: string;
  kind: 'channel' | 'ads' | 'carrier';
  provider: 'Amazon SP-API' | 'Amazon Ads' | 'eBay' | 'Website' | 'Evri' | 'DPD';
  channel: Channel | null;
  name: string;
  companyId: string | null;
  status: ConnectionStatus;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  authFailures: number;
  usage: { used: number; limit: number; unit: string } | null;
  /** INT-4 / invariant 13: when on, every outbound write for this account stops. */
  killSwitch: boolean;
  note: string | null;
  /**
   * C6 (CS-6), Amazon accounts only: the relay setup. Amazon copies buyer messages to `inbound`;
   * replies go from `sender`, which the seller approves in Seller Central.
   */
  buyerMessages?: {
    inbound: string;
    sender: string;
    lastTest: 'passed' | 'failed' | null;
  };
}

const PROVIDER: Record<Channel, Connection['provider']> = {
  amazon: 'Amazon SP-API',
  ebay: 'eBay',
  website: 'Website',
};

const STATE: Record<string, Partial<Connection>> = {
  ca_1: {
    usage: { used: 18_240, limit: 0, unit: 'calls today' },
    buyerMessages: {
      inbound: 'amazon-msg+3f9c1a7e52b04d8c9e6a1b2c3d4e5f60@omnibridge.co.uk',
      sender: 'amazon-msg@omnibridge.co.uk',
      lastTest: 'passed',
    },
  },
  ca_2: {
    usage: { used: 4_120, limit: 5_000, unit: 'calls today' },
    note: 'eBay daily call budget above 80%. Non-urgent syncs are slowed down.',
  },
  ca_3: {
    buyerMessages: {
      inbound: 'amazon-msg+8b27d0c4e91f4a6b8c3d2e1f0a9b8c7d@omnibridge.co.uk',
      sender: 'amazon-msg@omnibridge.co.uk',
      lastTest: 'failed',
    },
    status: 'needs_reauth',
    authFailures: 3,
    lastSuccessAt: ago(26 * HOUR),
    note: 'Amazon refused the refresh token. Re-authorise to resume orders and stock updates.',
  },
  ca_4: { usage: { used: 312, limit: 0, unit: 'calls today' } },
  ca_5: {
    status: 'paused',
    note: 'Paused by Sam Admin on 18/10/2026. Nothing is sent or fetched.',
  },
};

export const connections: Connection[] = [
  ...channelAccounts.map((a): Connection => ({
    id: a.id,
    kind: 'channel',
    provider: PROVIDER[a.channel],
    channel: a.channel,
    name: a.name,
    companyId: a.companyId,
    status: 'active',
    lastSuccessAt: ago(4 * 60_000),
    lastRefreshAt: ago(38 * 60_000),
    authFailures: 0,
    usage: { used: 9_800, limit: 0, unit: 'calls today' },
    killSwitch: false,
    note: null,
    ...STATE[a.id],
  })),
  {
    id: 'ads_1',
    kind: 'ads',
    provider: 'Amazon Ads',
    channel: 'amazon',
    name: 'Amazon Ads · Northfield',
    companyId: 'co_1',
    status: 'active',
    lastSuccessAt: ago(52 * 60_000),
    lastRefreshAt: ago(52 * 60_000),
    authFailures: 0,
    usage: null,
    killSwitch: false,
    note: null,
  },
  {
    id: 'car_evri',
    kind: 'carrier',
    provider: 'Evri',
    channel: null,
    name: 'Evri · workspace account',
    companyId: null,
    status: 'active',
    lastSuccessAt: ago(18 * 60_000),
    lastRefreshAt: ago(3 * HOUR),
    authFailures: 0,
    usage: { used: 214, limit: 0, unit: 'labels today' },
    killSwitch: false,
    note: null,
  },
  {
    id: 'car_dpd',
    kind: 'carrier',
    provider: 'DPD',
    channel: null,
    name: 'DPD · workspace account',
    companyId: null,
    status: 'error',
    lastSuccessAt: ago(1.2 * HOUR),
    lastRefreshAt: ago(1.2 * HOUR),
    authFailures: 0,
    usage: { used: 41, limit: 0, unit: 'labels today' },
    killSwitch: false,
    note: 'The last 4 label requests failed: the DPD service did not answer. Retrying every 5 minutes.',
  },
];
