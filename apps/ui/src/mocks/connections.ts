/**
 * MSW mock of the M07 Connections routes (T-0701, T-0702), for the T-0314 screens. It follows the
 * contract in packages/contract/src/routes/connections.ts. Until the server routes land, this is
 * what the SPA talks to; it is replaced route by route, not reshaped. Synthetic data only.
 */
import { HttpResponse, http } from 'msw/http';
import type {
  BulkAction,
  BulkPreview,
  Connection,
  ConnectionDetail,
  Provider,
} from '../auth/api.ts';
import { channelAccounts } from './data.ts';
import { maintenanceMock } from './platform.ts';
import { channelOn, currentSession } from './session.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Order of precedence, as the server works it out: disconnected, needs_reauth, paused, error. */
function statusOf(c: Seed): Connection['status'] {
  if (c.disconnected) return 'disconnected';
  if (c.needsReauth) return 'needs_reauth';
  if (c.paused_at) return 'paused';
  if (c.lastError) return 'error';
  return 'active';
}

interface Seed {
  id: string;
  provider: Provider;
  display_name: string;
  company_id: string;
  usage: Connection['usage_today'];
  failures: number;
  lastSuccess: string | null;
  paused_at: string | null;
  needsReauth: string | null;
  lastError: { code: string; at: string } | null;
  disconnected: boolean;
}

const PROVIDER = { amazon: 'amazon', ebay: 'ebay', website: 'website' } as const;

let seeds: Seed[] = [];

export function resetConnectionsMock(): void {
  const base = (
    over: Partial<Seed> & Pick<Seed, 'id' | 'provider' | 'display_name' | 'company_id'>,
  ): Seed => ({
    usage: [],
    failures: 0,
    lastSuccess: ago(4 * MIN),
    paused_at: null,
    needsReauth: null,
    lastError: null,
    disconnected: false,
    ...over,
  });
  seeds = [
    ...channelAccounts.map((a) =>
      base({
        id: a.id,
        provider: PROVIDER[a.channel],
        display_name: a.name,
        company_id: a.companyId,
        usage:
          a.channel === 'ebay'
            ? [
                { api: 'sell.fulfillment', calls: 4_120, cap: 5_000 },
                { api: 'sell.inventory', calls: 1_310, cap: 5_000 },
              ]
            : a.channel === 'amazon'
              ? [{ api: 'orders', calls: 9_800, cap: null }]
              : [{ api: 'orders', calls: 312, cap: null }],
      }),
    ),
    base({
      id: 'ads_1',
      provider: 'amazon_ads',
      display_name: 'Amazon Ads · Northfield',
      company_id: 'co_1',
      lastSuccess: ago(52 * MIN),
    }),
    base({
      id: 'car_evri',
      provider: 'evri',
      display_name: 'Evri · Northfield',
      company_id: 'co_1',
      lastSuccess: ago(18 * MIN),
      usage: [{ api: 'labels', calls: 214, cap: null }],
    }),
    base({
      id: 'car_dpd',
      provider: 'dpd',
      display_name: 'DPD · Harbour',
      company_id: 'co_2',
      lastSuccess: ago(1.2 * HOUR),
      usage: [{ api: 'labels', calls: 41, cap: null }],
      lastError: { code: 'provider_unavailable', at: ago(20 * MIN) },
    }),
  ];
  const patch = (id: string, over: Partial<Seed>) => {
    seeds = seeds.map((s) => (s.id === id ? { ...s, ...over } : s));
  };
  patch('ca_3', {
    needsReauth: ago(26 * HOUR),
    failures: 3,
    lastSuccess: ago(26 * HOUR),
    lastError: { code: 'invalid_grant', at: ago(26 * HOUR) },
  });
  patch('ca_5', { paused_at: ago(3 * 24 * HOUR) });
}
resetConnectionsMock();

function toConnection(s: Seed): Connection {
  return {
    id: s.id,
    provider: s.provider,
    display_name: s.display_name,
    company_id: s.company_id,
    status: statusOf(s),
    last_success_at: s.lastSuccess,
    last_token_refresh_at: s.provider === 'evri' || s.provider === 'dpd' ? null : ago(38 * MIN),
    consecutive_auth_failures: s.failures,
    usage_today: s.usage,
    kill_switch: { paused: s.paused_at !== null, paused_at: s.paused_at },
  };
}

function toDetail(s: Seed): ConnectionDetail {
  const oauth = s.provider === 'amazon' || s.provider === 'amazon_ads' || s.provider === 'ebay';
  return {
    ...toConnection(s),
    needs_reauth_at: s.needsReauth,
    last_error: s.lastError,
    streams:
      s.provider === 'evri' || s.provider === 'dpd'
        ? []
        : [
            { stream: 'orders', cursor_at: ago(6 * MIN), last_success_at: s.lastSuccess },
            { stream: 'listings', cursor_at: ago(2 * HOUR), last_success_at: ago(2 * HOUR) },
          ],
    credentials: oauth
      ? [
          {
            kind: `${s.provider === 'amazon_ads' ? 'ads' : s.provider}.refresh_token`,
            slot: 'current',
            expires_at: s.provider === 'ebay' ? ago(-12 * 24 * HOUR) : null,
          },
        ]
      : [{ kind: `${s.provider}.api_key`, slot: 'current', expires_at: null }],
  };
}

const problem = (status: number, code: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: code, status, code },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** Admins only (the Connections tab), and only the companies in the user's scope. */
function inScope(): Seed[] | null {
  const s = currentSession();
  if (!s.user.isAdmin) return null;
  const allowed = new Set(s.companies.map((c) => c.id));
  // A sales channel the workspace has switched off has no accounts to show (mock personas).
  const on = (p: Provider) =>
    p === 'amazon' || p === 'ebay' || p === 'website' ? channelOn(p) : true;
  return seeds.filter((x) => allowed.has(x.company_id) && on(x.provider));
}

/** Bulk preview tokens: single use, 10 minutes, this user only (SAFE-1). */
const tokens = new Map<
  string,
  { action: BulkAction; ids: string[]; expires: number; used: boolean }
>();

export const connectionHandlers = [
  http.get('*/api/connections', () => {
    const list = inScope();
    if (!list) return problem(403, 'forbidden');
    return HttpResponse.json({ items: list.map(toConnection), maintenance: maintenanceMock() });
  }),
  http.get('*/api/connections/:id', ({ params }) => {
    const s = inScope()?.find((x) => x.id === params.id);
    return s ? HttpResponse.json(toDetail(s)) : problem(404, 'not_found');
  }),
  http.put('*/api/connections/:id/kill-switch', async ({ params, request }) => {
    const s = inScope()?.find((x) => x.id === params.id);
    if (!s) return problem(404, 'not_found');
    const { paused } = (await request.json()) as { paused: boolean };
    s.paused_at = paused ? (s.paused_at ?? new Date().toISOString()) : null;
    return HttpResponse.json(toConnection(s));
  }),
  http.post('*/api/connections/:id/authorise', ({ params }) => {
    const s = inScope()?.find((x) => x.id === params.id);
    if (!s) return problem(404, 'not_found');
    if (!['amazon', 'amazon_ads', 'ebay'].includes(s.provider))
      return problem(409, 'api_key_provider');
    // The mock "provider" says yes at once and sends the browser back, as the callback would.
    s.needsReauth = null;
    s.failures = 0;
    s.lastError = null;
    s.lastSuccess = new Date().toISOString();
    return HttpResponse.json({
      redirect_url: `${location.origin}/connections?connected=${encodeURIComponent(s.id)}`,
    });
  }),
  http.post('*/api/bulk-writes/preview', async ({ request }) => {
    const body = (await request.json()) as { action: BulkAction; channel_account_ids: string[] };
    const ids = body.channel_account_ids;
    if (ids.length < 2 || ids.length > 100) return problem(422, 'validation_failed');
    const allowed = new Set(currentSession().companies.map((c) => c.id));
    const accounts = ids.map((id) => seeds.find((s) => s.id === id));
    if (accounts.some((a) => !a || !allowed.has(a.company_id))) return problem(404, 'not_found');
    const token = `bulk_${crypto.randomUUID().replaceAll('-', '')}`;
    const expires = Date.now() + 10 * MIN;
    tokens.set(token, { action: body.action, ids, expires, used: false });
    const preview: BulkPreview = {
      token,
      expires_at: new Date(expires).toISOString(),
      action: body.action,
      accounts: accounts.flatMap((a) =>
        a
          ? [
              {
                id: a.id,
                provider: a.provider,
                display_name: a.display_name,
                company_id: a.company_id,
                paused: a.paused_at !== null,
              },
            ]
          : [],
      ),
    };
    return HttpResponse.json(preview);
  }),
  http.post('*/api/bulk-writes/confirm', async ({ request }) => {
    const { token } = (await request.json()) as { token: string };
    const t = tokens.get(token);
    if (!t) return problem(404, 'not_found');
    if (t.used || t.expires < Date.now()) return problem(409, 'token_spent');
    t.used = true;
    const queued = t.ids.filter((id) => !seeds.find((s) => s.id === id)?.paused_at).length;
    return HttpResponse.json(
      { action: t.action, account_count: t.ids.length, queued },
      { status: 202 },
    );
  }),
];
