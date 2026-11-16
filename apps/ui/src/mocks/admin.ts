/**
 * Admin pages for the client preview (T-0305). Users, invites and access reviews follow the real
 * T-0204 contract (PERM-1..7, USR-1, USR-8, USR-9); connections (INT-4) are still a PROPOSED SHAPE. Admin-only routes: the handlers
 * answer 403 to a child. Synthetic people and example.com addresses only.
 */
import { HttpResponse, http } from 'msw/http';
import type { AccessReview, UserAccess, WorkspaceUser } from '../auth/api.ts';
import { channelAccounts } from './data.ts';
import { DAY, HOUR, ago } from './random.ts';
import { currentSession } from './session.ts';
import type { Channel } from './types.ts';

/** The demo workspace's users in the contract's shape (T-0204). Admins carry no ticks (PERM-2). */
const SEED_USERS: WorkspaceUser[] = [
  {
    id: 'usr_1',
    name: 'Sam Admin',
    email: 'sam.admin@example.com',
    role: 'admin',
    tabs: [],
    companyIds: [],
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
    tabs: ['home', 'sales-profit', 'finance'],
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
    tabs: ['home', 'orders', 'customer-service', 'reminders', 'notes'],
    companyIds: ['co_2'],
    mfa: true,
    state: 'active',
    lastSignInAt: ago(4 * DAY),
    inviteExpiresAt: null,
  },
  {
    id: 'usr_5',
    name: 'Chris Stock',
    email: 'chris.stock@example.com',
    role: 'child',
    tabs: ['home', 'stock-catalogue', 'forecasting', 'shipping'],
    companyIds: ['co_1', 'co_3'],
    mfa: true,
    state: 'active',
    lastSignInAt: ago(6 * HOUR),
    inviteExpiresAt: null,
  },
  {
    id: 'inv_1',
    name: '',
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

const SEED_REVIEWS: AccessReview[] = [
  {
    id: 'rev_3',
    dueAt: new Date(Date.now() + 9 * DAY).toISOString(),
    createdAt: ago(21 * DAY),
    completedAt: null,
  },
  { id: 'rev_2', dueAt: ago(83 * DAY), createdAt: ago(113 * DAY), completedAt: ago(86 * DAY) },
  { id: 'rev_1', dueAt: ago(174 * DAY), createdAt: ago(204 * DAY), completedAt: ago(176 * DAY) },
];

/** Mutable copies, so the mock-ups can invite, edit and remove. */
export let users: WorkspaceUser[] = SEED_USERS.map((u) => ({ ...u }));
let reviews: AccessReview[] = SEED_REVIEWS.map((r) => ({ ...r }));
let inviteSeq = 1;

export function resetUsersMock(): void {
  users = SEED_USERS.map((u) => ({ ...u }));
  reviews = SEED_REVIEWS.map((r) => ({ ...r }));
  inviteSeq = 1;
}

const problem = (status: number, code: string, detail?: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: '', status, code, ...(detail ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
const forbidden = () => problem(403, 'forbidden');
const isAdmin = () => currentSession().user.isAdmin;
const admins = () => users.filter((u) => u.state === 'active' && u.role === 'admin');
const lastAdmin = (id: string) => {
  const a = admins();
  return a.length === 1 && a[0]?.id === id;
};
const PERM7 = 'A workspace must keep at least one admin';

/** T-0204 user routes, admin only (403 to a child), with the server's 409 for PERM-7. */
export const userHandlers = [
  http.get('*/users', () => (isAdmin() ? HttpResponse.json(users) : forbidden())),

  http.post('*/users/invites', async ({ request }) => {
    if (!isAdmin()) return forbidden();
    const body = (await request.json()) as { email: string } & UserAccess;
    const email = body.email.trim().toLowerCase();
    if (users.some((u) => u.email === email && u.state === 'active')) {
      return problem(409, 'conflict', 'This person is already a member of this workspace');
    }
    inviteSeq += 1;
    const invited: WorkspaceUser = {
      id: `inv_${String(inviteSeq)}`,
      name: '',
      email,
      role: body.role,
      tabs: body.role === 'admin' ? [] : body.tabs,
      companyIds: body.role === 'admin' ? [] : body.companyIds,
      mfa: false,
      state: 'invited',
      lastSignInAt: null,
      inviteExpiresAt: new Date(Date.now() + 72 * HOUR).toISOString(),
    };
    users = [...users, invited];
    return HttpResponse.json(invited, { status: 201 });
  }),

  http.post('*/users/invites/:inviteId/revoke', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const id = String(params.inviteId);
    if (!users.some((u) => u.id === id && u.state === 'invited')) return problem(404, 'not_found');
    users = users.filter((u) => u.id !== id);
    return new HttpResponse(null, { status: 204 });
  }),

  http.put('*/users/:userId/access', async ({ params, request }) => {
    if (!isAdmin()) return forbidden();
    const id = String(params.userId);
    const u = users.find((x) => x.id === id && x.state === 'active');
    if (!u) return problem(404, 'not_found');
    const body = (await request.json()) as UserAccess;
    if (body.role !== 'admin' && lastAdmin(id)) return problem(409, 'conflict', PERM7);
    users = users.map((x) =>
      x.id === id
        ? {
            ...x,
            role: body.role,
            tabs: body.role === 'admin' ? [] : body.tabs,
            companyIds: body.role === 'admin' ? [] : body.companyIds,
          }
        : x,
    );
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete('*/users/:userId', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const id = String(params.userId);
    if (!users.some((x) => x.id === id && x.state === 'active')) return problem(404, 'not_found');
    if (lastAdmin(id)) return problem(409, 'conflict', PERM7);
    users = users.filter((x) => x.id !== id);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/access-reviews', () => (isAdmin() ? HttpResponse.json(reviews) : forbidden())),

  http.post('*/access-reviews/:reviewId/complete', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const id = String(params.reviewId);
    const r = reviews.find((x) => x.id === id && x.completedAt === null);
    if (!r) return problem(404, 'not_found');
    reviews = reviews.map((x) =>
      x.id === id ? { ...x, completedAt: new Date().toISOString() } : x,
    );
    return new HttpResponse(null, { status: 204 });
  }),
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
