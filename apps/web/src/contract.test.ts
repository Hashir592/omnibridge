import {
  ADMIN_ONLY_TABS,
  defineRoute,
  listQuery,
  pageOf,
  TABS,
  type AnyRoute,
} from '@omnibridge/contract';
import {
  ApiError,
  NotAMember,
  type MemberAccess,
  type SessionActor,
  type TenantRunner,
} from '@omnibridge/core';
import { createLogger } from '@omnibridge/logger';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractRoutesPlugin, installContract, type Handlers } from './contract.ts';

const logger = createLogger({ service: 'web-test', version: '0', level: 'silent' });

const Thing = z.object({ id: z.string() });

const listThings = defineRoute({
  id: 'listThings',
  method: 'GET',
  path: '/things',
  query: listQuery,
  responses: { 200: pageOf(Thing) },
  auth: 'session',
  tab: 'orders',
  adminOnly: false,
  companyScoped: true,
});

const getThing = defineRoute({
  id: 'getThing',
  method: 'GET',
  path: '/things/:thingId',
  params: z.object({ thingId: z.string().regex(/^t\d+$/) }),
  responses: { 200: Thing },
  auth: 'session',
  tab: 'orders',
  adminOnly: false,
  companyScoped: true,
});

const claimThing = defineRoute({
  id: 'claimThing',
  method: 'POST',
  path: '/things/claim',
  body: z.object({ id: z.string() }),
  responses: { 200: Thing, 409: z.object({ holder: z.string() }) },
  auth: 'session',
  tab: 'orders',
  adminOnly: false,
  companyScoped: true,
});

const routes = [listThings, getThing, claimThing] as const;
const ALL = Array.from({ length: 1000 }, (_, i) => ({ id: `t${String(i)}` }));

const handlers: Handlers<typeof routes> = {
  listThings: ({ query }) => {
    const start = query.cursor ? Number(query.cursor) : 0;
    const items = ALL.slice(start, start + query.limit);
    const next = start + query.limit;
    return Promise.resolve({
      status: 200,
      body: { items, next_cursor: next < ALL.length ? String(next) : null },
    });
  },
  getThing: ({ params }) => {
    if (params.thingId === 't999999') {
      return Promise.reject(new ApiError({ status: 404, code: 'not_found', detail: 'No thing.' }));
    }
    if (params.thingId === 't666') return Promise.reject(new Error('boom: secret detail'));
    return Promise.resolve({ status: 200, body: { id: params.thingId } });
  },
  claimThing: ({ body }) => {
    if (body.id === 'held') return Promise.resolve({ status: 409, body: { holder: 'other' } });
    if (body.id === 'gone') {
      return Promise.reject(new ApiError({ status: 409, code: 'conflict', detail: 'Gone.' }));
    }
    return Promise.resolve({ status: 200, body: { id: body.id } });
  },
};

const SESSION: SessionActor = {
  workspaceId: '00000000-0000-4000-8000-0000000000a1',
  userId: '00000000-0000-4000-8000-0000000000b1',
  sessionId: 'session-1',
};
/** No database here: the tenancy only hands the handler a context. */
function tenancyAs(access: MemberAccess | 'not-a-member'): TenantRunner {
  return {
    runWorkspace: (actor, fn) => fn({ ...actor, companyIds: [] }),
    run: (ctx, fn) => fn(ctx),
    runMember: (actor, fn) =>
      access === 'not-a-member'
        ? Promise.reject(new NotAMember())
        : fn({ ...actor, companyIds: [] }, access),
  };
}
const tenancy = tenancyAs({ role: 'admin', tabs: 'all' });

async function server(rs: readonly AnyRoute[] = routes, hs: object = handlers) {
  const app = Fastify({ loggerInstance: logger });
  installContract(app);
  void app.register(
    contractRoutesPlugin(rs, hs as Handlers<typeof rs>, {
      auth: { resolveSession: () => SESSION, tenancy },
    }),
  );
  await app.ready();
  return app;
}

describe('contract registration (invariant 4)', () => {
  it('[SEC-3] server refuses route without permission metadata', async () => {
    for (const key of ['auth', 'tab', 'adminOnly', 'companyScoped']) {
      const broken = Object.fromEntries(Object.entries(listThings).filter(([k]) => k !== key));
      await expect(server([broken as unknown as AnyRoute])).rejects.toThrow(key);
    }
  });

  it('[SEC-3] server refuses a route registered outside the contract', async () => {
    const app = Fastify({ loggerInstance: logger });
    installContract(app);
    expect(() => app.get('/rogue', () => 'hi')).toThrow(/contract/);
    await app.close();
  });

  it('[SEC-3] server refuses duplicate route ids and missing handlers', async () => {
    await expect(server([listThings, listThings])).rejects.toThrow(/listThings/);
    await expect(server(routes, { listThings: handlers.listThings })).rejects.toThrow(/getThing/);
  });
});

describe('authentication per route kind (SEC-3)', () => {
  const internal = defineRoute({
    id: 'internalPing',
    method: 'POST',
    path: '/internal/ping',
    responses: { 204: z.null() },
    auth: 'service',
    tab: 'none',
    adminOnly: false,
    companyScoped: false,
  });
  const webhook = defineRoute({
    id: 'providerHook',
    method: 'POST',
    path: '/hooks/provider',
    responses: { 204: z.null() },
    auth: 'signed-webhook',
    tab: 'none',
    adminOnly: false,
    companyScoped: false,
  });
  const open = () => Promise.resolve({ status: 204 as const, body: null });

  it('[SEC-3] service and signed-webhook routes fail closed until their checks exist', async () => {
    const rs = [internal, webhook] as const;
    const app = await server(rs, { internalPing: open, providerHook: open });
    for (const url of ['/api/internal/ping', '/api/hooks/provider']) {
      const res = await app.inject({ method: 'POST', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 401 });
    }
    await app.close();
  });

  it('[SEC-3] a session route answers 401 before validation when no session resolves', async () => {
    const app = Fastify({ loggerInstance: logger });
    installContract(app);
    void app.register(
      contractRoutesPlugin(routes, handlers, {
        auth: { resolveSession: () => undefined, tenancy },
      }),
    );
    await app.ready();
    // An invalid id would be a 400; an anonymous caller learns nothing about the schema.
    const res = await app.inject({ method: 'GET', url: '/api/things/nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthorized' });
    await app.close();
  });

  it('[SEC-3] a session handler gets the tenant context of the resolved session', async () => {
    const whoAmI = defineRoute({
      id: 'whoAmI',
      method: 'GET',
      path: '/me',
      responses: { 200: z.object({ workspace: z.string(), user: z.string().optional() }) },
      auth: 'session',
      tab: 'none',
      adminOnly: false,
      companyScoped: false,
    });
    const rs = [whoAmI] as const;
    const hs: Handlers<typeof rs> = {
      whoAmI: ({ tenant }) =>
        Promise.resolve({
          status: 200,
          body: {
            workspace: tenant.workspaceId,
            ...(tenant.userId ? { user: tenant.userId } : {}),
          },
        }),
    };
    const app = await server(rs, hs);
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.json()).toEqual({ workspace: SESSION.workspaceId, user: SESSION.userId });
    await app.close();
  });

  it('[PERM-3][AT-2] child with {Orders} gets 403 on every other tab, using fixture routes for every tab', async () => {
    // One fixture route per tab, so every tab the app will ever have is covered now (PERM-4).
    const fixtures = TABS.map((tab) =>
      defineRoute({
        id: `tab${tab.replace(/(^|-)([a-z])/g, (_m, _d: string, c: string) => c.toUpperCase())}`,
        method: 'GET',
        path: `/fixture/${tab}`,
        responses: { 200: Thing },
        auth: 'session',
        tab,
        adminOnly: (ADMIN_ONLY_TABS as readonly string[]).includes(tab),
        companyScoped: false,
      }),
    );
    const hs = Object.fromEntries(
      fixtures.map((r) => [r.id, () => Promise.resolve({ status: 200, body: { id: r.id } })]),
    );
    const statusOf = async (access: MemberAccess) => {
      const app = Fastify({ loggerInstance: logger });
      installContract(app);
      void app.register(
        contractRoutesPlugin(fixtures, hs as Handlers<typeof fixtures>, {
          auth: { resolveSession: () => SESSION, tenancy: tenancyAs(access) },
        }),
      );
      await app.ready();
      const out: Record<string, number> = {};
      for (const tab of TABS) {
        out[tab] = (await app.inject({ method: 'GET', url: `/api/fixture/${tab}` })).statusCode;
      }
      await app.close();
      return out;
    };
    const child = await statusOf({ role: 'member', tabs: ['orders'] });
    for (const tab of TABS) {
      const want = tab === 'orders' || tab === 'none' ? 200 : 403;
      expect({ tab, status: child[tab] }).toEqual({ tab, status: want });
    }
    // A child with no ticks reaches only the routes outside the tabs (PERM-6).
    const empty = await statusOf({ role: 'member', tabs: [] });
    expect(
      Object.entries(empty)
        .filter(([, s]) => s === 200)
        .map(([t]) => t),
    ).toEqual(['none']);
    // An admin reaches every tab, the admin-only ones included.
    const admin = await statusOf({ role: 'admin', tabs: 'all' });
    expect(Object.values(admin).every((s) => s === 200)).toBe(true);
  });

  it('[AUD-4][SEC-3] an adminOnly route answers 403 to anyone but a workspace admin', async () => {
    const adminThing = defineRoute({
      id: 'adminThing',
      method: 'GET',
      path: '/admin-thing',
      responses: { 200: Thing },
      auth: 'session',
      tab: 'audit-log',
      adminOnly: true,
      companyScoped: false,
    });
    const rs = [adminThing] as const;
    let calls = 0;
    const hs: Handlers<typeof rs> = {
      adminThing: () => {
        calls += 1;
        return Promise.resolve({ status: 200, body: { id: 'secret' } });
      },
    };
    const statusWith = async (auth: Parameters<typeof contractRoutesPlugin>[2]) => {
      const app = Fastify({ loggerInstance: logger });
      installContract(app);
      void app.register(contractRoutesPlugin(rs, hs, auth));
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/admin-thing' });
      await app.close();
      return res.statusCode;
    };
    const as = (t: TenantRunner) => ({ auth: { resolveSession: () => SESSION, tenancy: t } });
    expect(await statusWith(as(tenancyAs({ role: 'admin', tabs: 'all' })))).toBe(200);
    expect(await statusWith(as(tenancyAs({ role: 'member', tabs: ['orders'] })))).toBe(403);
    // Removed from the workspace: refused on the next request (USR-8).
    expect(await statusWith(as(tenancyAs('not-a-member')))).toBe(401);
    // No tenancy to look the member up: the server refuses to start at all.
    await expect(statusWith({ auth: { resolveSession: () => SESSION } })).rejects.toThrow(
      /need a tenancy/,
    );
    expect(calls).toBe(1);
  });
});

describe('list pagination over HTTP (CAP-7)', () => {
  it('[CAP-7] list routes default to 50 rows and cap at 200', async () => {
    const app = await server();
    const first = await app.inject({ method: 'GET', url: '/api/things' });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: unknown[]; next_cursor: string | null }>();
    expect(page.items).toHaveLength(50);
    expect(page.next_cursor).toBe('50');

    const max = await app.inject({ method: 'GET', url: '/api/things?limit=200' });
    expect(max.json<{ items: unknown[] }>().items).toHaveLength(200);

    const over = await app.inject({ method: 'GET', url: '/api/things?limit=201' });
    expect(over.statusCode).toBe(400);
    expect(over.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(over.json()).toMatchObject({ status: 400, code: 'validation_failed' });
    await app.close();
  });
});

describe('problem+json errors (RFC 9457)', () => {
  it('[NFR-1] invalid params return a problem with field errors', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/things/nope' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'validation_failed',
      errors: [{ location: 'params', path: 'thingId' }],
    });
    await app.close();
  });

  it('[NFR-1] an ApiError keeps its status and stable code', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/things/t999999' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: 404, code: 'not_found', detail: 'No thing.' });
    await app.close();
  });

  it('[NFR-1] a declared error status still answers problems as problem+json', async () => {
    const app = await server();
    const held = await app.inject({
      method: 'POST',
      url: '/api/things/claim',
      body: { id: 'held' },
    });
    expect(held.statusCode).toBe(409);
    expect(held.json()).toEqual({ holder: 'other' });
    const gone = await app.inject({
      method: 'POST',
      url: '/api/things/claim',
      body: { id: 'gone' },
    });
    expect(gone.statusCode).toBe(409);
    expect(gone.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(gone.json()).toMatchObject({ status: 409, code: 'conflict', detail: 'Gone.' });
    await app.close();
  });

  it('[NFR-1] an unexpected error is a 500 problem that leaks no detail', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/things/t666' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ status: 500, code: 'internal_error' });
    expect(res.body).not.toContain('secret detail');
    await app.close();
  });

  it('[NFR-1] unknown paths return a not_found problem', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/nowhere' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.json()).toMatchObject({ status: 404, code: 'not_found' });
    await app.close();
  });
});
