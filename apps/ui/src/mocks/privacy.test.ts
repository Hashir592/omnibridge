import { getResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { ErasureRequest, ErasureRequestCreated } from '../auth/api.ts';
import { handlers } from './handlers.ts';
import { MOCK_MATCH_LIMIT, resetPrivacyMock } from './privacy.ts';
import { setPersona } from './session.ts';

// The mock stands in for the T-0404 routes in the T-0308 screens, so it must behave as the
// server does: admin only, masked matches, a one-month due date, one confirmation, and the 422
// when an export matches too much.

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

  it('[DEL-4] every identifier given must match, and none given is a 422', async () => {
    const both = await call('POST', '/api/erasure-requests', {
      identifiers: { ...MORGAN, postcode: 'M1 1AE' },
    });
    expect(((await both.json()) as ErasureRequestCreated).matches).toHaveLength(0);
    expect((await call('POST', '/api/erasure-requests', { identifiers: {} })).status).toBe(422);
  });

  it('[DEL-4] a broad search is cut short and says so', async () => {
    const res = await call('POST', '/api/erasure-requests', {
      identifiers: { postcode: 'm11ae' },
    });
    const body = (await res.json()) as ErasureRequestCreated;
    expect(body.matches).toHaveLength(MOCK_MATCH_LIMIT);
    expect(body.truncated).toBe(true);
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

  it('[DEL-4] lists requests newest first and marks an open one past its due date overdue', async () => {
    const res = await call('GET', '/api/erasure-requests');
    const { items } = (await res.json()) as { items: ErasureRequest[] };
    expect(items.map((r) => r.requestedAt)).toEqual(
      [...items.map((r) => r.requestedAt)].sort().reverse(),
    );
    expect(items.some((r) => r.overdue && r.state === 'open')).toBe(true);
    expect(items.every((r) => !r.overdue || Date.parse(r.dueAt) < Date.now())).toBe(true);
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
    const res = await call('POST', '/api/access-requests/export', {
      identifiers: { postcode: 'M1 1AE' },
    });
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
      call('POST', '/api/access-requests/export', { identifiers: MORGAN }),
      call('GET', '/api/channel-accounts/ca_1/deletion-certificate'),
    ]);
    expect(statuses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
  });

  it('[DEL-3] the deletion certificate holds counts and IDs, never a buyer value', async () => {
    const res = await call('GET', '/api/channel-accounts/ca_2/deletion-certificate');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Channel account: ca_2');
    expect(text).not.toMatch(/@|Morgan|07700/);
  });
});
