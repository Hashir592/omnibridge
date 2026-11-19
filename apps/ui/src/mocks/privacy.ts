/**
 * Erasure and subject access requests (T-0404 routes, real contract), the deletion certificate
 * (T-0403) and GET /jobs/:id, for the T-0308 screens. The handlers behave as the server does:
 * admin only (403 to a child), identifiers in the body only, masked matches (the vault's ORD-5
 * rules), a one-month due date (DEL-4), 409 when a request is no longer open (confirmed or
 * withdrawn, ADR-067), 400 for a missing or unknown withdraw reason, 400 for identifiers that do
 * not pin one buyer (ADR-068), 422 `too_many_matches` when a search matches too much (nothing is
 * stored, A-001) and 422 when the export does. The outcome states of A-006 (ADR-069): confirmed
 * (in progress), completed when the job ends, failed (seeded), and retry (202/403/404/409).
 * Synthetic buyers only: example.com addresses and Ofcom drama numbers (07700 900xxx).
 */
import { HttpResponse, http } from 'msw/http';
import type {
  BuyerIdentifiers,
  ErasureMatch,
  ErasureRequest,
  ErasureRequestCreated,
  JobProgress,
  WithdrawReason,
} from '../auth/api.ts';
import { channelAccounts } from './data.ts';
import { DAY, ago } from './random.ts';
import { currentSession } from './session.ts';

/** A fixed UUID per mock record, since the contract's ids are UUIDs. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface VaultRecord {
  piiRef: string;
  kind: ErasureMatch['kind'];
  subjectType: string;
  subjectId: string;
  channelAccountId: string | null;
  fields: Record<string, string>;
}

const contact = (
  n: number,
  subjectId: string,
  channelAccountId: string,
  fields: Record<string, string>,
): VaultRecord => ({
  piiRef: uuid(n),
  kind: 'buyer_contact',
  subjectType: 'order',
  subjectId,
  channelAccountId,
  fields: { country: 'GB', ...fields },
});

const MORGAN = {
  name: 'Morgan Ellis',
  email: 'morgan.ellis@example.com',
  phone: '07700 900111',
  postcode: 'LS1 4AP',
  line1: '12 Example Street',
  city: 'Leeds',
};

const SEED_RECORDS: VaultRecord[] = [
  contact(101, 'ord_0012', 'ca_2', { ...MORGAN, buyer: 'morgan_e_88' }),
  contact(102, 'ord_0057', 'ca_1', MORGAN),
  {
    piiRef: uuid(103),
    kind: 'ebay_message',
    subjectType: 'message_thread',
    subjectId: 'thr_0331',
    channelAccountId: 'ca_2',
    fields: { name: MORGAN.name, buyer: 'morgan_e_88', body: 'Hello, has my order shipped yet?' },
  },
  {
    piiRef: uuid(104),
    kind: 'ebay_feedback',
    subjectType: 'feedback',
    subjectId: 'fb_0902',
    channelAccountId: 'ca_2',
    fields: { buyer: 'morgan_e_88', comment: 'Quick delivery, thank you.' },
  },
  // Five buyers on one postcode: a search on the postcode alone matches too many.
  ...[
    ['Riley Shaw', 'riley.shaw@example.com', '07700 900201', 'ca_1'],
    ['Taylor Brooks', 'taylor.brooks@example.com', '07700 900202', 'ca_3'],
    ['Jordan Price', 'jordan.price@example.com', '07700 900203', 'ca_3'],
    ['Casey Lane', 'casey.lane@example.com', '07700 900204', 'ca_4'],
    ['Avery Hughes', 'avery.hughes@example.com', '07700 900205', 'ca_5'],
  ].map(([name = '', email = '', phone = '', ca = ''], i) =>
    contact(201 + i, `ord_01${String(10 + i)}`, ca, {
      name,
      email,
      phone,
      postcode: 'M1 1AE',
      line1: `${String(3 + i)} Sample Road`,
      city: 'Manchester',
    }),
  ),
  // A repeat buyer with more orders than one answer holds: a search on them is refused (422).
  ...[0, 1, 2, 3, 4].map((i) =>
    contact(301 + i, `ord_02${String(10 + i)}`, 'ca_1', {
      name: 'Drew Parker',
      email: 'drew.parker@example.com',
      phone: '07700 900301',
      postcode: 'BS1 5TR',
      line1: '9 Demo Lane',
      city: 'Bristol',
    }),
  ),
];

/** One answer holds at most this many matches in the mock (the server's limit is larger). */
export const MOCK_MATCH_LIMIT = 4;

/* ---------- the vault's normalising and masking rules (apps/pii-vault/src/normalise.ts) ---------- */

const collapse = (v: string) => v.trim().replace(/\s+/g, ' ');
const NORMALISE: Record<keyof BuyerIdentifiers, (v: string) => string> = {
  name: (v) => collapse(v).toLowerCase(),
  email: (v) => v.trim().toLowerCase(),
  phone: (v) => v.replace(/\D/g, '').replace(/^44/, '0'),
  postcode: (v) => v.replace(/\s/g, '').toUpperCase(),
  buyer: (v) => v.trim().toLowerCase(),
};

const STARS = '***';
function mask(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'name') {
      const w = collapse(v).split(' ');
      const first = w[0]?.charAt(0).toUpperCase() ?? '';
      const last = w.length > 1 ? (w.at(-1)?.charAt(0).toUpperCase() ?? '') : '';
      out[k] = last ? `${first}. ${last}${STARS}` : `${first}${STARS}`;
    } else if (k === 'postcode') out[k] = NORMALISE.postcode(v).slice(0, -3) || STARS;
    else if (k === 'email') {
      const [local = '', domain = ''] = NORMALISE.email(v).split('@');
      out[k] = `${local.charAt(0)}${STARS}@${domain.charAt(0)}${STARS}`;
    } else if (k === 'phone') out[k] = `${STARS}${NORMALISE.phone(v).slice(-3)}`;
    else if (k === 'country') out[k] = v.trim().toUpperCase().slice(0, 2);
    else out[k] = STARS;
  }
  return out;
}

/** Every identifier given must match (AND), as in the vault's search. */
function search(q: BuyerIdentifiers): VaultRecord[] {
  const given = (Object.keys(NORMALISE) as Array<keyof BuyerIdentifiers>).flatMap((k) => {
    const v = q[k];
    return v === undefined ? [] : [[k, NORMALISE[k](v)] as const];
  });
  return records.filter((r) =>
    given.every(([k, v]) => r.fields[k] !== undefined && NORMALISE[k](r.fields[k]) === v),
  );
}

/* ---------- requests and jobs ---------- */

interface StoredRequest {
  id: string;
  requestedAt: string;
  state: ErasureRequest['state'];
  piiRefs: string[];
  confirmedAt: string | null;
  jobId: string | null;
  completedAt?: string;
  failedAt?: string;
  retryCount?: number;
  /** ADR-070: confirmed, but its deletion job died or was never queued. */
  stuck?: boolean;
  withdrawnAt?: string;
  withdrawReason?: WithdrawReason;
}

/** The fixed list of the contract (ERASURE_WITHDRAW_REASONS in @omnibridge/core). */
const WITHDRAW_REASONS: readonly WithdrawReason[] = [
  'wrong_identifiers',
  'no_match',
  'duplicate',
  'buyer_withdrew',
  'other',
];

/** DEL-4: one calendar month after the request. */
function oneMonthAfter(iso: string): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/** Overdue until the deletion is done (A-006): open, confirmed and failed requests count. */
const PENDING: ReadonlyArray<ErasureRequest['state']> = ['open', 'confirmed', 'failed'];

const asBody = (r: StoredRequest): ErasureRequest => {
  settle(r);
  const dueAt = oneMonthAfter(r.requestedAt);
  return {
    id: r.id,
    requestedAt: r.requestedAt,
    dueAt,
    overdue: PENDING.includes(r.state) && Date.now() > Date.parse(dueAt),
    state: r.state,
    matchCount: r.piiRefs.length,
    confirmedAt: r.confirmedAt,
    completedAt: r.completedAt ?? null,
    failedAt: r.failedAt ?? null,
    retryCount: r.retryCount ?? 0,
    // ADR-070: only a confirmed request can be stuck; every other answer says false.
    stuck: r.state === 'confirmed' && r.stuck === true,
    jobId: r.jobId,
    withdrawnAt: r.withdrawnAt ?? null,
    withdrawReason: r.withdrawReason ?? null,
  };
};

const seedRequests = (): StoredRequest[] => [
  {
    id: uuid(904),
    requestedAt: ago(6 * DAY),
    state: 'withdrawn',
    piiRefs: [],
    confirmedAt: null,
    jobId: null,
    withdrawnAt: ago(6 * DAY),
    withdrawReason: 'wrong_identifiers',
  },
  {
    id: uuid(903),
    requestedAt: ago(3 * DAY),
    state: 'open',
    piiRefs: [uuid(301)],
    confirmedAt: null,
    jobId: null,
  },
  {
    id: uuid(902),
    requestedAt: ago(34 * DAY),
    state: 'open',
    piiRefs: [uuid(302), uuid(303)],
    confirmedAt: null,
    jobId: null,
  },
  {
    id: uuid(905),
    requestedAt: ago(40 * DAY),
    state: 'failed',
    piiRefs: [uuid(307), uuid(308)],
    confirmedAt: ago(39 * DAY),
    jobId: uuid(802),
    failedAt: ago(2 * DAY),
  },
  {
    id: uuid(906),
    requestedAt: ago(5 * DAY),
    state: 'confirmed',
    piiRefs: [uuid(309)],
    confirmedAt: ago(4 * DAY),
    jobId: null,
    stuck: true,
  },
  {
    id: uuid(901),
    requestedAt: ago(52 * DAY),
    state: 'completed',
    piiRefs: [uuid(304), uuid(305), uuid(306)],
    confirmedAt: ago(51 * DAY),
    completedAt: ago(51 * DAY),
    jobId: uuid(801),
  },
];

/** A deletion job finishes this long after it starts, so the screen shows its progress. */
export const MOCK_JOB_MS = 3_000;

let records: VaultRecord[] = SEED_RECORDS.map((r) => ({ ...r }));
let requests: StoredRequest[] = seedRequests();
const seedJobs = () =>
  new Map<string, { startedAt: number; refs: string[] }>([
    [uuid(801), { startedAt: Date.now() - 51 * DAY, refs: [] }],
  ]);
let jobs = seedJobs();
let seq = 0;

export function resetPrivacyMock(): void {
  records = SEED_RECORDS.map((r) => ({ ...r }));
  requests = seedRequests();
  jobs = seedJobs();
  seq = 0;
}

function jobBody(id: string): JobProgress | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  const elapsed = Date.now() - j.startedAt;
  const done = elapsed >= MOCK_JOB_MS;
  if (done) records = records.filter((r) => !j.refs.includes(r.piiRef));
  return {
    id,
    type: 'pii.delete',
    state: done ? 'completed' : 'active',
    attempt: 1,
    percent: done ? 100 : Math.min(99, Math.floor((elapsed / MOCK_JOB_MS) * 100)),
    result: done ? { deleted: j.refs.length } : null,
    error_code: null,
    created_at: new Date(j.startedAt).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** A confirmed request completes when its deletion job ends, as the pii.delete job does. */
function settle(r: StoredRequest): void {
  if (r.state !== 'confirmed' || r.jobId === null) return;
  const j = jobBody(r.jobId);
  if (j?.state !== 'completed') return;
  r.state = 'completed';
  r.completedAt = j.updated_at;
}

/* ---------- handlers ---------- */

const problem = (status: number, code: string, detail?: string) =>
  HttpResponse.json(
    { type: 'about:blank', title: '', status, code, ...(detail ? { detail } : {}) },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
const forbidden = () => problem(403, 'forbidden');
const isAdmin = () => currentSession().user.isAdmin;

/**
 * The body's identifiers, trimmed; undefined unless they pin one buyer (the contract's 400): an
 * email, a phone, a marketplace ID, or a name with a postcode (ADR-068).
 */
async function identifiersOf(request: Request): Promise<BuyerIdentifiers | undefined> {
  const body = (await request.json()) as { identifiers?: Record<string, unknown> };
  const out: BuyerIdentifiers = {};
  for (const k of Object.keys(NORMALISE) as Array<keyof BuyerIdentifiers>) {
    const v = body.identifiers?.[k];
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
  }
  const pins = out.email ?? out.phone ?? out.buyer ?? (out.name && out.postcode);
  return pins ? out : undefined;
}

const noIdentifier = () =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: '',
      status: 400,
      code: 'validation_failed',
      errors: [
        {
          path: 'identifiers',
          message: "Add the buyer's email, phone or marketplace ID, or their name and postcode",
        },
      ],
    },
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  );

export const privacyHandlers = [
  http.get('*/api/erasure-requests', () =>
    isAdmin()
      ? HttpResponse.json({
          items: [...requests]
            .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
            .map(asBody),
        })
      : forbidden(),
  ),

  http.post('*/api/erasure-requests', async ({ request }) => {
    if (!isAdmin()) return forbidden();
    const q = await identifiersOf(request);
    if (!q) return noIdentifier();
    const found = search(q);
    // A-001: a search that matches more than one request holds is refused; nothing is stored.
    if (found.length > MOCK_MATCH_LIMIT) return problem(422, 'too_many_matches');
    seq += 1;
    const stored: StoredRequest = {
      id: uuid(1000 + seq),
      requestedAt: new Date().toISOString(),
      state: 'open',
      piiRefs: found.map((r) => r.piiRef),
      confirmedAt: null,
      jobId: null,
    };
    requests = [stored, ...requests];
    const body: ErasureRequestCreated = {
      ...asBody(stored),
      matches: found.map((r) => ({
        piiRef: r.piiRef,
        kind: r.kind,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        channelAccountId: r.channelAccountId,
        masked: mask(r.fields),
      })),
      truncated: false,
    };
    return HttpResponse.json(body, { status: 201 });
  }),

  http.post('*/api/erasure-requests/:id/confirm', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const r = requests.find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found');
    if (r.state !== 'open') return problem(409, 'conflict', 'This erasure request is not open.');
    let jobId: string | null = null;
    if (r.piiRefs.length > 0) {
      seq += 1;
      jobId = uuid(2000 + seq);
      jobs.set(jobId, { startedAt: Date.now(), refs: r.piiRefs });
    }
    const now = new Date().toISOString();
    // Nothing to delete: the request completes at once, with no job.
    r.state = jobId === null ? 'completed' : 'confirmed';
    r.confirmedAt = now;
    if (jobId === null) r.completedAt = now;
    r.jobId = jobId;
    return HttpResponse.json(asBody(r), { status: 202 });
  }),

  http.post('*/api/erasure-requests/:id/retry', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const r = requests.find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found');
    if (r.state !== 'failed' && !(r.state === 'confirmed' && r.stuck))
      return problem(409, 'conflict', 'This erasure request is not failed or stuck.');
    seq += 1;
    const jobId = uuid(2000 + seq);
    jobs.set(jobId, { startedAt: Date.now(), refs: r.piiRefs });
    r.state = 'confirmed';
    r.jobId = jobId;
    delete r.failedAt;
    delete r.stuck;
    r.retryCount = (r.retryCount ?? 0) + 1;
    return HttpResponse.json(asBody(r), { status: 202 });
  }),

  http.post('*/api/erasure-requests/:id/withdraw', async ({ params, request }) => {
    if (!isAdmin()) return forbidden();
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason = WITHDRAW_REASONS.find((x) => x === body.reason);
    if (!reason)
      return HttpResponse.json(
        {
          type: 'about:blank',
          title: '',
          status: 400,
          code: 'validation_failed',
          errors: [{ path: 'reason', message: 'one of the withdraw reasons' }],
        },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    const r = requests.find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found');
    if (r.state !== 'open') return problem(409, 'conflict', 'This erasure request is not open.');
    r.state = 'withdrawn';
    r.withdrawnAt = new Date().toISOString();
    r.withdrawReason = reason;
    return HttpResponse.json(asBody(r));
  }),

  http.get('*/api/jobs/:id', ({ params }) => {
    const j = jobBody(String(params.id));
    return j ? HttpResponse.json(j) : problem(404, 'not_found');
  }),

  http.post('*/api/access-requests/export', async ({ request }) => {
    if (!isAdmin()) return forbidden();
    const q = await identifiersOf(request);
    if (!q) return noIdentifier();
    const found = search(q);
    if (found.length > MOCK_MATCH_LIMIT)
      return problem(
        422,
        'validation_failed',
        'Too many records match. Add more details of the buyer and try again.',
      );
    const file = `${JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        note: 'Everything OmniBridge holds about this buyer in this workspace (DEL-5).',
        records: found.map((r) => ({
          kind: r.kind,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          channelAccountId: r.channelAccountId,
          fields: r.fields,
        })),
        linkedOrders: [],
      },
      null,
      2,
    )}\n`;
    return new HttpResponse(file, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment',
        'cache-control': 'no-store',
      },
    });
  }),

  http.get('*/api/channel-accounts/:id/deletion-certificate', ({ params }) => {
    if (!isAdmin()) return forbidden();
    const a = channelAccounts.find((x) => x.id === params.id);
    if (!a) return problem(404, 'not_found');
    const text = [
      'OmniBridge deletion certificate',
      `Channel account: ${a.id}`,
      `Issued: ${new Date().toISOString()}`,
      '',
      'Buyer records deleted for this account: 1,284',
      '',
      'Deletion runs (time, trigger, records deleted, run ID):',
      `${ago(2 * DAY)}  expiry  41  run_${a.id}_0003`,
      `${ago(9 * DAY)}  expiry  57  run_${a.id}_0002`,
      `${ago(23 * DAY)}  erasure  2  run_${a.id}_0001`,
      '',
      'Counts and IDs only. No deleted value is kept.',
      '',
    ].join('\n');
    return new HttpResponse(text, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment',
        'cache-control': 'no-store',
      },
    });
  }),
];
