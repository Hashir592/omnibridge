import { getResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailPreference, Notification } from '../auth/api.ts';
import { handlers } from './handlers.ts';
import { resetNotificationsMock } from './notifications.ts';
import { setPersona } from './session.ts';

// The mock stands in for the T-0501 and T-0502 routes in the T-0312 screens, so it must answer as
// the server does (PS-030, PS-031): per-user read state, tab and company visibility, admin only
// security types, the 404 for a notification the user cannot see, and the email rules.

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

interface Page {
  items: Notification[];
  next_cursor: string | null;
}
const list = async (query = ''): Promise<Page> =>
  (await (await call('GET', `/api/notifications${query}`)).json()) as Page;
const unread = async () =>
  ((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number })
    .unread;
const prefs = async () =>
  (
    (await (await call('GET', '/api/me/notification-email-preferences')).json()) as {
      items: EmailPreference[];
    }
  ).items;
const put = (items: unknown[]) => call('PUT', '/api/me/notification-email-preferences', { items });

const SECURITY = /^(security\.|pii\.)/;

afterEach(() => {
  setPersona('admin');
  resetNotificationsMock();
});

describe('mock notifications', () => {
  it('[NTF-1] lists newest change first with the contract fields and no free text', async () => {
    const { items } = await list();
    expect(items.length).toBeGreaterThan(5);
    const stamps = items.map((n) => n.updatedAt);
    expect(stamps).toEqual([...stamps].sort().reverse());
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      [
        'channelAccountId',
        'companyId',
        'createdAt',
        'id',
        'params',
        'record',
        'resolvedAt',
        'severity',
        'signal',
        'state',
        'tab',
        'title',
        'type',
        'updatedAt',
      ].sort(),
    );
    for (const n of items)
      for (const v of Object.values(n.params)) expect(typeof v).not.toBe('object');
  });

  it('[NTF-1] filters by state and severity, and pages with a cursor', async () => {
    const critical = await list('?severity=critical');
    expect(critical.items.length).toBeGreaterThan(0);
    expect(critical.items.every((n) => n.severity === 'critical')).toBe(true);
    const resolved = await list('?state=resolved');
    expect(resolved.items.length).toBeGreaterThan(0);
    expect(resolved.items.every((n) => n.state === 'resolved' && n.resolvedAt !== null)).toBe(true);
    const first = await list('?limit=4');
    expect(first.items).toHaveLength(4);
    expect(first.next_cursor).not.toBeNull();
    const second = await list(`?limit=4&cursor=${first.next_cursor ?? ''}`);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect((await list()).next_cursor).toBeNull();
    expect((await call('GET', '/api/notifications?state=bogus')).status).toBe(400);
  });

  it('[NTF-1] mark read changes the unread count; read-all clears it; both answer { marked }', async () => {
    const before = await unread();
    const first = (await list('?state=unread')).items[0];
    expect(before).toBeGreaterThan(1);
    const path = `/api/notifications/${first?.id ?? ''}/read`;
    const res = await call('POST', path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ marked: 1 });
    expect(await unread()).toBe(before - 1);
    // Reading it again changes nothing.
    expect(await (await call('POST', path)).json()).toEqual({ marked: 0 });
    expect(await (await call('POST', '/api/notifications/read-all')).json()).toEqual({
      marked: before - 1,
    });
    expect(await unread()).toBe(0);
    // Resolved ones keep their state.
    expect((await list('?state=resolved')).items.length).toBeGreaterThan(0);
  });

  it('[NTF-1] read state is per user', async () => {
    const adminUnread = await unread();
    setPersona('packer');
    expect(await unread()).toBeGreaterThan(0);
    await call('POST', '/api/notifications/read-all');
    expect(await unread()).toBe(0);
    setPersona('admin');
    expect(await unread()).toBe(adminUnread);
  });

  it('[NTF-2] a child sees only the tabs and companies they have; the others answer 404', async () => {
    const adminItems = (await list()).items;
    setPersona('packer');
    const mine = (await list()).items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThan(adminItems.length);
    expect(mine.every((n) => n.tab === 'orders' || n.tab === 'shipping')).toBe(true);
    const hidden = adminItems.find((n) => !mine.some((m) => m.id === n.id));
    expect((await call('POST', `/api/notifications/${hidden?.id ?? ''}/read`)).status).toBe(404);
  });

  it('[NTF-2] the security types are for admins only', async () => {
    expect((await list()).items.some((n) => SECURITY.test(n.type))).toBe(true);
    setPersona('packer');
    expect((await list()).items.some((n) => SECURITY.test(n.type))).toBe(false);
    expect((await prefs()).some((p) => SECURITY.test(p.type))).toBe(false);
  });
});

describe('mock email preferences', () => {
  it('[NTF-4] critical types are on by default and locked for an admin; others are off', async () => {
    const items = await prefs();
    const critical = items.filter((p) => p.severity === 'critical');
    expect(critical.length).toBeGreaterThan(0);
    expect(critical.every((p) => p.email && p.locked)).toBe(true);
    const others = items.filter((p) => p.severity !== 'critical');
    expect(others.every((p) => !p.email && !p.locked)).toBe(true);
  });

  it('[NTF-4] PUT sets one type and returns the full list; a locked type cannot be switched off', async () => {
    const before = await prefs();
    const info = before.find((p) => p.severity === 'info');
    const res = await put([{ type: info?.type ?? '', email: true }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: EmailPreference[] };
    expect(body.items).toHaveLength(before.length);
    expect(body.items.find((p) => p.type === info?.type)?.email).toBe(true);
    const locked = before.find((p) => p.locked);
    expect((await put([{ type: locked?.type ?? '', email: false }])).status).toBe(400);
    expect((await put([{ type: 'nope.nothing', email: true }])).status).toBe(400);
    expect((await put([])).status).toBe(400);
  });

  it('[NTF-4] a child may switch a critical type off; a type of a tab they lack is refused', async () => {
    const admin = await prefs();
    setPersona('packer');
    const items = await prefs();
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(admin.length);
    expect(items.every((p) => !p.locked)).toBe(true);
    const crit = items.find((p) => p.severity === 'critical');
    expect((await put([{ type: crit?.type ?? '', email: false }])).status).toBe(200);
    const notMine = admin.find((p) => !items.some((i) => i.type === p.type));
    expect((await put([{ type: notMine?.type ?? '', email: true }])).status).toBe(400);
  });
});
