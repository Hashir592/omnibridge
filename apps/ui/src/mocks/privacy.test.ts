import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErasureRequest, ErasureRequestCreated } from '../auth/api.ts';
import { pinsOneBuyer } from '../lib/pinsOneBuyer.ts';
import { handlers } from './handlers.ts';
import { MOCK_JOB_MS, resetPrivacyMock } from './privacy.ts';
import { setPersona } from './session.ts';

// The mock stands in for the T-0404 routes in the T-0308 screens, so it must behave as the
// server does: admin only, masked matches, a one-month due date, one confirmation, the outcome
// states and retry (A-006), the 400 for identifiers that do not pin one buyer, and the 422s when a
// search or an export matches too much.

async function call(method: string, path: string, body?: unknown) {
  const res = await getResponse(
    handlers,
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  if (!res) throw new Error(`no mock handler for ${method} ${path}`);
  return res;
}

const MORGAN = { email: 'morgan.ellis@example.com' };
/** A repeat buyer with more orders than one mock answer holds. */
const MANY = { email: 'drew.parker@example.com' };
const OPEN = '00000000-0000-4000-8000-000000000903';
const COMPLETED = '00000000-0000-4000-8000-000000000901';
const FAILED = '00000000-0000-4000-8000-000000000905';
const STUCK = '00000000-0000-4000-8000-000000000906';

async function all(): Promise<ErasureRequest[]> {
  const res = await call('GET', '/api/erasure-requests');
  return ((await res.json()) as { items: ErasureRequest[] }).items;
}
const listed = async (id: string) => (await all()).find((r) => r.id === id);

afterEach(() => {
  setPersona('admin');
  resetPrivacyMock();
});

describe('mock erasure requests', () => {
  it('[DEL-4] finds every match and shows it masked, with the due date one month on', async () => {
    const res = await call('POST', '/api/erasure-requests', { identifiers: MORGAN });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ErasureRequestCreated;
    expect(body.matches).toHaveLength(2);
    expect(body.state).toBe('open');
    const due = new Date(body.requestedAt);
    due.setUTCMonth(due.getUTCMonth() + 1);
    expect(body.dueAt).toBe(due.toISOString());
    const text = JSON.stringify(body.matches);
    expect(text).not.toContain('morgan');
    expect(text).not.toContain('Ellis');
    expect(text).not.toContain('900111');
    expect(body.matches[0]?.masked).toMatchObject({ name: 'M. E***', email: 'm***@e***' });
  });

  it('[DEL-4] every identifier given must match; identifiers that do not pin one buyer are a 400', async () => {
    const both = await call('POST', '/api/erasure-requests', {
      identifiers: { ...MORGAN, postcode: 'M1 1AE' },
    });
    expect(((await both.json()) as ErasureRequestCreated).matches).toHaveLength(0);
    expect((await call('POST', '/api/erasure-requests', { identifiers: {} })).status).toBe(400);
    const weak = await call('POST', '/api/erasure-requests', {
      identifiers: { postcode: 'M1 1AE' },
    });
    expect(weak.status).toBe(400);
    expect((await call('POST', '/api/access-requests/export', { identifiers: {} })).status).toBe(
      400,
    );
  });

  it('[DEL-4] a search that matches too many records is a 422 too_many_matches and stores nothing', async () => {
    const before = await all();
    const res = await call('POST', '/api/erasure-requests', { identifiers: MANY });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('too_many_matches');
    expect(await all()).toHaveLength(before.length);
  });

  it('[DEL-4] confirms once (202 with a job), then answers 409', async () => {
    const created = (await (
      await call('POST', '/api/erasure-requests', { identifiers: MORGAN })
    ).json()) as ErasureRequestCreated;
    const first = await call('POST', `/api/erasure-requests/${created.id}/confirm`);
    expect(first.status).toBe(202);
    const confirmed = (await first.json()) as ErasureRequest;
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.jobId).not.toBeNull();
    const again = await call('POST', `/api/erasure-requests/${created.id}/confirm`);
    expect(again.status).toBe(409);
  });

  it('[DEL-4] a confirmed request is in progress, then completed with completedAt when its job ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const created = (await (
        await call('POST', '/api/erasure-requests', { identifiers: MORGAN })
      ).json()) as ErasureRequestCreated;
      await call('POST', `/api/erasure-requests/${created.id}/confirm`);
      expect(await listed(created.id)).toMatchObject({ state: 'confirmed', completedAt: null });
      vi.setSystemTime(Date.now() + MOCK_JOB_MS + 1);
      const done = await listed(created.id);
      expect(done?.state).toBe('completed');
      expect(done?.completedAt).not.toBeNull();
      expect(done?.overdue).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('[DEL-4] a confirm with no matches answers 202 completed, with no job', async () => {
    const created = (await (
      await call('POST', '/api/erasure-requests', {
        identifiers: { name: 'Nobody Known', postcode: 'ZZ1 1ZZ' },
      })
    ).json()) as ErasureRequestCreated;
    const res = await call('POST', `/api/erasure-requests/${created.id}/confirm`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as ErasureRequest;
    expect(body).toMatchObject({ state: 'completed', jobId: null });
    expect(body.completedAt).not.toBeNull();
  });

  it('[DEL-4] overdue holds for open, confirmed and failed past due; never for completed', async () => {
    const failed = await listed(FAILED);
    expect(failed).toMatchObject({ state: 'failed', overdue: true });
    expect(failed?.failedAt).not.toBeNull();
    const completed = await listed(COMPLETED);
    expect(completed).toMatchObject({ state: 'completed', overdue: false });
    expect(Date.parse(completed?.dueAt ?? '')).toBeLessThan(Date.now());
  });

  it('[DEL-4] retry runs a failed deletion again: 202 confirmed, a new job, retryCount + 1', async () => {
    const before = await listed(FAILED);
    const res = await call('POST', `/api/erasure-requests/${FAILED}/retry`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as ErasureRequest;
    expect(body.state).toBe('confirmed');
    expect(body.jobId).not.toBeNull();
    expect(body.jobId).not.toBe(before?.jobId);
    expect(body.retryCount).toBe((before?.retryCount ?? 0) + 1);
    expect(body.failedAt).toBeNull();
    expect(body.overdue).toBe(true);
    // Only a failed request can be retried: 409 otherwise, 404 for an unknown one.
    expect((await call('POST', `/api/erasure-requests/${FAILED}/retry`)).status).toBe(409);
    expect((await call('POST', `/api/erasure-requests/${OPEN}/retry`)).status).toBe(409);
    expect((await call('POST', `/api/erasure-requests/${COMPLETED}/retry`)).status).toBe(409);
    const unknown = '00000000-0000-4000-8000-000000009999';
    expect((await call('POST', `/api/erasure-requests/${unknown}/retry`)).status).toBe(404);
  });

  it('[DEL-4] a stuck request lists stuck: true, retries with 202 and is then no longer stuck', async () => {
    const stuck = await listed(STUCK);
    expect(stuck).toMatchObject({ state: 'confirmed', stuck: true, jobId: null });
    // Every other answer says false.
    const others = (await all()).filter((r) => r.id !== STUCK);
    expect(others.every((r) => !r.stuck)).toBe(true);
    const res = await call('POST', `/api/erasure-requests/${STUCK}/retry`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as ErasureRequest;
    expect(body).toMatchObject({ state: 'confirmed', stuck: false, retryCount: 1 });
    expect(body.jobId).not.toBeNull();
    expect((await call('POST', `/api/erasure-requests/${STUCK}/retry`)).status).toBe(409);
  });

  // The contract's rule (BuyerIdentifiersSchema, ADR-068). The SPA may not import the Zod registry
  // (ui-uses-contract-client-only), so it reads the shared case table the contract test runs
  // through the schema too (ADR-072): a rule change on either side breaks a test.
  it('[DEL-4] the screen rule and the mock agree with the contract on which identifiers pin one buyer', async () => {
    const fixture = join(
      import.meta.dirname,
      '../../../../packages/testkit/fixtures/buyer-identifier-cases.json',
    );
    const shared = JSON.parse(readFileSync(fixture, 'utf8')) as {
      cases: { identifiers: Record<string, string>; pins: boolean }[];
    };
    const cases = shared.cases.map((c): [Record<string, string>, boolean] => [
      c.identifiers,
      c.pins,
    ]);
    expect(cases.length).toBeGreaterThan(0);
    for (const [identifiers, pins] of cases) {
      expect(pinsOneBuyer(identifiers), JSON.stringify(identifiers)).toBe(pins);
      const status = (await call('POST', '/api/erasure-requests', { identifiers })).status;
      expect(status === 400, JSON.stringify(identifiers)).toBe(!pins);
      resetPrivacyMock();
    }
  });

  it('[DEL-4] lists requests newest first and marks an open one past its due date overdue', async () => {
    const res = await call('GET', '/api/erasure-requests');
    const { items } = (await res.json()) as { items: ErasureRequest[] };
    expect(items.map((r) => r.requestedAt)).toEqual(
      [...items.map((r) => r.requestedAt)].sort().reverse(),
    );
    expect(items.some((r) => r.overdue && r.state === 'open')).toBe(true);
    expect(items.every((r) => !r.overdue || Date.parse(r.dueAt) < Date.now())).toBe(true);
  });

  it('[DEL-4] withdraws an open request with a reason, never overdue, then answers 409', async () => {
    const overdueId = '00000000-0000-4000-8000-000000000902';
    const res = await call('POST', `/api/erasure-requests/${overdueId}/withdraw`, {
      reason: 'wrong_identifiers',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ErasureRequest;
    expect(body.state).toBe('withdrawn');
    expect(body.overdue).toBe(false);
    expect(body.withdrawReason).toBe('wrong_identifiers');
    expect(body.withdrawnAt).not.toBeNull();
    const again = await call('POST', `/api/erasure-requests/${overdueId}/withdraw`, {
      reason: 'duplicate',
    });
    expect(again.status).toBe(409);
    expect((await call('POST', `/api/erasure-requests/${overdueId}/confirm`)).status).toBe(409);
  });

  it('[DEL-4] a withdraw needs a reason from the fixed list (400), on a known request (404)', async () => {
    const open = OPEN;
    expect((await call('POST', `/api/erasure-requests/${open}/withdraw`, {})).status).toBe(400);
    expect(
      (await call('POST', `/api/erasure-requests/${open}/withdraw`, { reason: 'free text' }))
        .status,
    ).toBe(400);
    const unknown = '00000000-0000-4000-8000-000000009999';
    expect(
      (await call('POST', `/api/erasure-requests/${unknown}/withdraw`, { reason: 'other' })).status,
    ).toBe(404);
    expect(
      (await call('POST', `/api/erasure-requests/${COMPLETED}/withdraw`, { reason: 'other' }))
        .status,
    ).toBe(409);
  });
});

describe('mock subject access export', () => {
  it('[DEL-5] exports everything held about one buyer as a JSON file', async () => {
    const res = await call('POST', '/api/access-requests/export', { identifiers: MORGAN });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment');
    const file = (await res.json()) as { records: unknown[]; linkedOrders: unknown[] };
    expect(file.records).toHaveLength(2);
    expect(JSON.stringify(file.records)).toContain('morgan.ellis@example.com');
  });

  it('[DEL-5] answers 422 when too many records match', async () => {
    const res = await call('POST', '/api/access-requests/export', { identifiers: MANY });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/Too many records/);
  });
});

describe('admin only', () => {
  it('[DEL-4] [DEL-5] a child user gets 403 on every buyer data route', async () => {
    setPersona('packer');
    const statuses = await Promise.all([
      call('GET', '/api/erasure-requests'),
      call('POST', '/api/erasure-requests', { identifiers: MORGAN }),
      call('POST', '/api/erasure-requests/00000000-0000-4000-8000-000000000903/confirm'),
      call('POST', '/api/erasure-requests/00000000-0000-4000-8000-000000000903/withdraw', {
        reason: 'other',
      }),
      call('POST', `/api/erasure-requests/${FAILED}/retry`),
      call('POST', '/api/access-requests/export', { identifiers: MORGAN }),
      call('GET', '/api/channel-accounts/ca_1/deletion-certificate'),
    ]);
    expect(statuses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
  });

  it('[DEL-3] the deletion certificate holds counts and IDs, never a buyer value', async () => {
    const res = await call('GET', '/api/channel-accounts/ca_2/deletion-certificate');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Channel account: ca_2');
    expect(text).not.toMatch(/@|Morgan|07700/);
  });
});
