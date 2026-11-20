/**
 * MSW mock of the platform console routes (T-0504, T-0505; PS-032, PS-033), for the T-0313
 * screens. It follows the contract in packages/contract/src/routes/platform.ts: counts, IDs,
 * names, statuses and dates only (PLAT-3); app secret values are taken and never returned (PLAT-4).
 * Synthetic data only.
 */
import { HttpResponse, http } from 'msw/http';
import type {
  ApiUsage,
  AppSecretName,
  AppSecretStatus,
  ConsoleWorkspace,
  CredentialExpiry,
  DeadLetter,
  PlatformFlags,
  QueueOverview,
} from '../auth/api.ts';
import type { Incident } from '../auth/shapes.ts';

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const ymd = (offsetDays: number) => iso(offsetDays * DAY).slice(0, 10);

export const MOCK_WS = {
  demo: '7b0c2f0e-1d4a-4c1b-9a51-000000000001',
  second: '7b0c2f0e-1d4a-4c1b-9a51-000000000002',
  trial: '7b0c2f0e-1d4a-4c1b-9a51-000000000003',
  closed: '7b0c2f0e-1d4a-4c1b-9a51-000000000004',
} as const;
const ACCOUNT = {
  amazon: '5a1e9d3c-7f20-4e8a-b1c4-000000000011',
  ebay: '5a1e9d3c-7f20-4e8a-b1c4-000000000012',
  ads: '5a1e9d3c-7f20-4e8a-b1c4-000000000013',
} as const;

/** True once POST /auth/platform succeeded: GET /auth/session then says platform: true. */
let consoleMode = false;
let incident: Incident | null = null;
let workspaces: ConsoleWorkspace[] = [];
let flags: PlatformFlags = { public_signup: false, updated_at: null };
let deadLetters: DeadLetter[] = [];
let secrets: AppSecretStatus[] = [];

export const inConsoleMock = () => consoleMode;
export const enterConsoleMock = () => {
  consoleMode = true;
};
/** The incident GET /auth/session carries (PS-032). */
export const mockIncident = () => incident;

/** Back to the seed (tests, and each page load in the mock-ups). */
export function resetPlatformMock(): void {
  consoleMode = false;
  incident = null;
  flags = { public_signup: false, updated_at: null };
  workspaces = [
    {
      id: MOCK_WS.demo,
      name: 'Demo workspace',
      status: 'active',
      status_changed_at: null,
      created_at: iso(-200 * DAY),
      modules: { website_connector: true },
      counts: { users: 6, channel_accounts: 5, orders_per_day: null },
    },
    {
      id: MOCK_WS.second,
      name: 'Second demo workspace',
      status: 'active',
      status_changed_at: null,
      created_at: iso(-90 * DAY),
      modules: { website_connector: false },
      counts: { users: 2, channel_accounts: 1, orders_per_day: null },
    },
    {
      id: MOCK_WS.trial,
      name: 'Trial workspace',
      status: 'suspended',
      status_changed_at: iso(-3 * DAY),
      created_at: iso(-40 * DAY),
      modules: { website_connector: false },
      counts: { users: 1, channel_accounts: 0, orders_per_day: null },
    },
    {
      id: MOCK_WS.closed,
      name: 'Closed workspace',
      status: 'archived',
      status_changed_at: iso(-20 * DAY),
      created_at: iso(-300 * DAY),
      modules: { website_connector: false },
      counts: { users: 0, channel_accounts: 0, orders_per_day: null },
    },
  ];
  deadLetters = [
    {
      id: 'c3f1a2b4-5d6e-4f70-8a9b-000000000021',
      type: 'notify.email',
      workspace_id: MOCK_WS.demo,
      attempt: 5,
      error_code: 'handler_failed',
      dead_lettered_at: iso(-2 * 3_600_000),
    },
    {
      id: 'c3f1a2b4-5d6e-4f70-8a9b-000000000022',
      type: 'deletion.run',
      workspace_id: MOCK_WS.second,
      attempt: 3,
      error_code: 'invalid_envelope',
      dead_lettered_at: iso(-26 * 3_600_000),
    },
  ];
  secrets = [
    { name: 'amazon.lwa_client_id', current: { set_at: iso(-60 * DAY) }, next: null },
    {
      name: 'amazon.lwa_client_secret',
      current: { set_at: iso(-170 * DAY) },
      next: { set_at: iso(-1 * DAY) },
    },
    { name: 'ads.client_id', current: { set_at: iso(-60 * DAY) }, next: null },
    { name: 'ads.client_secret', current: { set_at: iso(-60 * DAY) }, next: null },
    { name: 'ebay.client_id', current: null, next: null },
    { name: 'ebay.client_secret', current: null, next: null },
    { name: 'ebay.dev_id', current: null, next: null },
    { name: 'ebay.verification_token', current: null, next: null },
  ];
}
resetPlatformMock();

const problem = (status: number, code: string, detail: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: '', status, code, detail },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** The console's own gate (PLAT-1): no console session is 403 here. */
const gate = () => (consoleMode ? undefined : problem(403, 'forbidden', 'not_in_console'));

const jobs = (): QueueOverview[] => [
  { type: 'notify.email', queued: 3, active: 1, failed: 0, dead_letter: count('notify.email') },
  { type: 'deletion.run', queued: 0, active: 0, failed: 1, dead_letter: count('deletion.run') },
  { type: 'platform.health-digest', queued: 0, active: 0, failed: 0, dead_letter: 0 },
  { type: 'workspace.close', queued: 0, active: 0, failed: 0, dead_letter: 0 },
];
const count = (type: string) => deadLetters.filter((d) => d.type === type).length;

function usage(from: string, to: string): ApiUsage[] {
  const rows: ApiUsage[] = [];
  for (let d = 0; d < 7; d++) {
    const day = ymd(-d);
    if (day < from || day > to) continue;
    rows.push(
      {
        workspace_id: MOCK_WS.demo,
        channel_account_id: ACCOUNT.ebay,
        provider: 'ebay',
        api: 'sell.fulfillment',
        day,
        calls: 1_800 + d * 310,
        cap: 5_000,
      },
      {
        workspace_id: MOCK_WS.demo,
        channel_account_id: ACCOUNT.amazon,
        provider: 'amazon',
        api: 'orders',
        day,
        calls: 640 + d * 25,
        cap: null,
      },
    );
  }
  return rows;
}

function expiry(withinDays: number): CredentialExpiry[] {
  const rows: CredentialExpiry[] = [
    {
      workspace_id: MOCK_WS.demo,
      channel_account_id: ACCOUNT.ebay,
      kind: 'ebay.refresh_token',
      slot: 'current',
      expires_at: iso(12 * DAY),
    },
    {
      workspace_id: MOCK_WS.demo,
      channel_account_id: ACCOUNT.ads,
      kind: 'ads.refresh_token',
      slot: 'current',
      expires_at: iso(45 * DAY),
    },
  ];
  // App secrets have no workspace (PS-033): Amazon's LWA client secret, 180 days after set.
  const lwa = secrets.find((s) => s.name === 'amazon.lwa_client_secret');
  for (const slot of ['current', 'next'] as const) {
    const set = lwa?.[slot];
    if (set) {
      rows.push({
        workspace_id: null,
        channel_account_id: null,
        kind: 'amazon.lwa_client_secret',
        slot,
        expires_at: new Date(Date.parse(set.set_at) + 180 * DAY).toISOString(),
      });
    }
  }
  return rows
    .filter((r) => Date.parse(r.expires_at) <= Date.now() + withinDays * DAY)
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
}

const MOVES = {
  suspend: { from: ['active'], to: 'suspended' },
  reactivate: { from: ['suspended'], to: 'active' },
  archive: { from: ['active', 'suspended'], to: 'archived' },
} as const;

export const platformHandlers = [
  http.get('*/api/platform/workspaces', () => gate() ?? HttpResponse.json({ items: workspaces })),

  http.post('*/api/platform/workspaces/:id/:move', ({ params }) => {
    const denied = gate();
    if (denied) return denied;
    const move = MOVES[params.move as keyof typeof MOVES] as
      (typeof MOVES)[keyof typeof MOVES] | undefined;
    const ws = workspaces.find((w) => w.id === params.id);
    if (!move || !ws) return problem(404, 'not_found', 'workspace');
    if (!(move.from as readonly string[]).includes(ws.status)) {
      return problem(409, 'conflict', 'wrong_state');
    }
    ws.status = move.to;
    ws.status_changed_at = new Date().toISOString();
    if (move.to === 'archived') ws.counts = { ...ws.counts, users: 0 };
    return HttpResponse.json({ id: ws.id, status: ws.status }, { status: 202 });
  }),

  http.put('*/api/platform/workspaces/:id/modules', async ({ params, request }) => {
    const denied = gate();
    if (denied) return denied;
    const ws = workspaces.find((w) => w.id === params.id);
    if (!ws) return problem(404, 'not_found', 'workspace');
    if (ws.status === 'archived') return problem(409, 'conflict', 'archived');
    ws.modules = (await request.json()) as ConsoleWorkspace['modules'];
    return HttpResponse.json(ws.modules);
  }),

  http.get('*/api/platform/flags', () => gate() ?? HttpResponse.json(flags)),
  http.put('*/api/platform/flags', async ({ request }) => {
    const denied = gate();
    if (denied) return denied;
    const body = (await request.json()) as { public_signup: boolean };
    flags = { public_signup: body.public_signup, updated_at: new Date().toISOString() };
    return HttpResponse.json(flags);
  }),

  http.get('*/api/platform/jobs', () => gate() ?? HttpResponse.json({ items: jobs() })),
  http.get(
    '*/api/platform/jobs/dead-letters',
    () => gate() ?? HttpResponse.json({ items: deadLetters }),
  ),
  http.post('*/api/platform/jobs/:type/dead-letters/:id/redrive', ({ params }) => {
    const denied = gate();
    if (denied) return denied;
    const hit = deadLetters.find((d) => d.id === params.id && d.type === params.type);
    if (!hit) return problem(404, 'not_found', 'dead_letter');
    deadLetters = deadLetters.filter((d) => d !== hit);
    return HttpResponse.json({ id: hit.id }, { status: 202 });
  }),

  http.get('*/api/platform/api-usage', ({ request }) => {
    const denied = gate();
    if (denied) return denied;
    const q = new URL(request.url).searchParams;
    return HttpResponse.json({ items: usage(q.get('from') ?? ymd(-6), q.get('to') ?? ymd(0)) });
  }),

  http.get('*/api/platform/credential-expiry', ({ request }) => {
    const denied = gate();
    if (denied) return denied;
    const days = Number(new URL(request.url).searchParams.get('within_days') ?? 30);
    return HttpResponse.json({ items: expiry(days) });
  }),

  http.get(
    '*/api/platform/health',
    () =>
      gate() ??
      HttpResponse.json({
        status: 'degraded',
        services: { web: 'ok', db_main: 'ok', pii_vault: 'ok', worker: 'error' },
        worker_heartbeat_at: iso(-4 * 60_000),
        queue: { queued: 3, dead_letter: deadLetters.length },
        version: 'mock',
      }),
  ),

  http.get('*/api/platform/incident-banner', () => gate() ?? HttpResponse.json({ incident })),
  http.put('*/api/platform/incident-banner', async ({ request }) => {
    const denied = gate();
    if (denied) return denied;
    const body = (await request.json()) as { message: string; severity: Incident['severity'] };
    const message = body.message.trim();
    if (message.length < 1 || message.length > 200 || message.includes('@')) {
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: 'validation_failed',
          status: 422,
          code: 'validation_failed',
          errors: [{ path: 'message', message: 'No email addresses in the banner' }],
        },
        { status: 422 },
      );
    }
    incident = { message, severity: body.severity, set_at: new Date().toISOString() };
    return HttpResponse.json({ incident });
  }),
  http.delete('*/api/platform/incident-banner', () => {
    const denied = gate();
    if (denied) return denied;
    incident = null;
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('*/api/platform/app-secrets', () => gate() ?? HttpResponse.json({ items: secrets })),
  http.put('*/api/platform/app-secrets/:name/:slot', ({ params }) => {
    const denied = gate();
    if (denied) return denied;
    const row = secrets.find((s) => s.name === (params.name as AppSecretName));
    const slot = params.slot;
    if (!row || (slot !== 'current' && slot !== 'next')) {
      return problem(400, 'bad_request', 'unknown_secret');
    }
    // The value is read by the server and never stored or echoed by this mock.
    row[slot] = { set_at: new Date().toISOString() };
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('*/api/platform/app-secrets/:name/promote', ({ params }) => {
    const denied = gate();
    if (denied) return denied;
    const row = secrets.find((s) => s.name === (params.name as AppSecretName));
    if (!row) return problem(400, 'bad_request', 'unknown_secret');
    if (!row.next) return problem(409, 'conflict', 'no_next');
    row.current = row.next;
    row.next = null;
    return new HttpResponse(null, { status: 204 });
  }),
];
