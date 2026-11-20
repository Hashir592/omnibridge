import {
  contractRoutes,
  defineRoute,
  listQuery,
  pagedOf,
  pageOf,
  pageQuery,
  type AnyRoute,
} from '@omnibridge/contract';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { walkIsolation, walkPlatform, walkRoutes } from './route-walker.ts';

describe('route walker metadata', () => {
  it('[SEC-3] enumerates every registry route with its permission metadata', () => {
    const walked = walkRoutes(contractRoutes);
    expect(walked.map((r) => r.id)).toEqual(contractRoutes.map((r) => r.id));
    expect(walked).toContainEqual({
      id: 'getHealth',
      method: 'GET',
      path: '/healthz',
      auth: 'public',
      tab: 'none',
      adminOnly: false,
      companyScoped: false,
      pagination: 'none',
    });
  });

  it('[CAP-7] tells numbered-page lists from cursor lists', () => {
    const meta = { auth: 'session', tab: 'orders', adminOnly: false, companyScoped: true } as const;
    const pages = defineRoute({
      ...meta,
      id: 'listThings',
      method: 'GET',
      path: '/things',
      query: pageQuery,
      responses: { 200: pagedOf(z.object({ id: z.string() })) },
    });
    const cursor = defineRoute({
      ...meta,
      id: 'exportThings',
      method: 'GET',
      path: '/things/export',
      query: listQuery,
      responses: { 200: pageOf(z.object({ id: z.string() })) },
    });
    expect(walkRoutes([pages, cursor]).map((r) => [r.id, r.pagination])).toEqual([
      ['listThings', 'page'],
      ['exportThings', 'cursor'],
    ]);
  });

  it('[SEC-3] fails when any route lacks permission metadata', () => {
    const [health] = contractRoutes;
    const withoutTab = Object.fromEntries(Object.entries(health).filter(([k]) => k !== 'tab'));
    expect(() => walkRoutes([withoutTab as unknown as AnyRoute])).toThrow(/getHealth: tab/);
  });
});

describe('isolation walk (TEN-1, AT-1)', () => {
  const meta = { tab: 'none', adminOnly: false, companyScoped: false } as const;
  const getThing = defineRoute({
    ...meta,
    auth: 'session',
    id: 'getThing',
    method: 'GET',
    path: '/things/:id',
    params: z.object({ id: z.string() }),
    responses: { 200: z.object({ id: z.string() }) },
  });
  const listThings = defineRoute({
    ...meta,
    auth: 'session',
    id: 'listThings',
    method: 'GET',
    path: '/things',
    responses: { 200: z.object({ items: z.array(z.string()) }) },
  });
  const base = {
    anonymous: {},
    workspaceA: { 'x-test-session': 'a' },
    markers: ['B-MARKER'],
  };

  it('[TEN-1] a session call that carries B data in its body must be refused too', async () => {
    const claim = defineRoute({
      ...meta,
      auth: 'session',
      id: 'claimThing',
      method: 'POST',
      path: '/things/claim',
      body: z.object({ id: z.string() }),
      responses: { 200: z.object({ id: z.string() }) },
    });
    const outcomes = await walkIsolation({
      ...base,
      routes: [claim],
      againstB: { claimThing: { body: { id: 'b1' } } },
      inject: (req) =>
        Promise.resolve(
          req.headers['x-test-session'] === undefined
            ? { statusCode: 401, body: '{}' }
            : { statusCode: 200, body: '{"id":"ok"}' },
        ),
    });
    expect(outcomes.filter((o) => !o.ok)).toEqual([
      expect.objectContaining({ route: 'claimThing', caller: 'workspace-a', status: 200 }),
    ]);
  });

  it('[SEC-3] calls each route at its served URL: under /api, /healthz at the root', async () => {
    const health = defineRoute({
      ...meta,
      auth: 'public',
      id: 'health',
      method: 'GET',
      path: '/healthz',
      responses: { 200: z.object({}) },
    });
    const urls: string[] = [];
    await walkIsolation({
      ...base,
      routes: [getThing, health],
      againstB: { getThing: { params: { id: 'b1' } }, health: {} },
      inject: (req) => {
        urls.push(req.url);
        return Promise.resolve({ statusCode: 401, body: '{}' });
      },
    });
    expect([...new Set(urls)]).toEqual(['/api/things/b1', '/healthz']);
  });

  it('[TEN-1] fails a route that has no walker call', async () => {
    await expect(
      walkIsolation({
        ...base,
        routes: [getThing, listThings],
        againstB: { getThing: { params: { id: 'b1' } } },
        inject: () => Promise.resolve({ statusCode: 401, body: '' }),
      }),
    ).rejects.toThrow(/listThings/);
  });

  it('[TEN-1] flags a leaked marker, and a session route that answers 200 for an id of B', async () => {
    const outcomes = await walkIsolation({
      ...base,
      routes: [getThing, listThings],
      againstB: { getThing: { params: { id: 'b1' } }, listThings: {} },
      inject: (req) => {
        if (req.headers['x-test-session'] === undefined) {
          return Promise.resolve({ statusCode: 401, body: '{}' });
        }
        return Promise.resolve(
          req.url === '/api/things/b1'
            ? { statusCode: 200, body: '{"id":"b1"}' }
            : { statusCode: 200, body: '{"items":["B-MARKER"]}' },
        );
      },
    });
    expect(outcomes.filter((o) => !o.ok)).toEqual([
      expect.objectContaining({ route: 'getThing', caller: 'workspace-a', status: 200 }),
      expect.objectContaining({ route: 'listThings', caller: 'workspace-a', leaked: ['B-MARKER'] }),
    ]);
  });
});

describe('platform walk (PLAT-3)', () => {
  const meta = { auth: 'platform', tab: 'none', adminOnly: false, companyScoped: false } as const;
  const read = defineRoute({
    ...meta,
    id: 'readThing',
    method: 'GET',
    path: '/platform/thing',
    responses: { 200: z.object({ id: z.string() }) },
  });
  const archive = defineRoute({
    ...meta,
    id: 'archiveThing',
    method: 'POST',
    path: '/platform/thing/archive',
    responses: { 204: z.null(), 409: z.object({ code: z.string() }) },
  });
  const walk = (statuses: Record<string, number>, expected?: Record<string, number[]>) =>
    walkPlatform({
      routes: [read, archive],
      inject: (req) =>
        Promise.resolve({
          statusCode: req.url.endsWith('/archive')
            ? (statuses.archiveThing ?? 204)
            : (statuses.readThing ?? 200),
          body: '{}',
        }),
      platform: {},
      calls: { readThing: {}, archiveThing: {} },
      businessMarkers: ['B-SECRET'],
      ...(expected === undefined ? {} : { expected }),
    });

  it('[PLAT-3] a platform route refused by mistake (403) fails the walk; a 2xx passes (ADR-076)', async () => {
    expect((await walk({})).every((o) => o.ok)).toBe(true);
    const refused = await walk({ readThing: 403 });
    expect(refused.find((o) => o.route === 'readThing')).toMatchObject({
      ok: false,
      expected: '2xx',
    });
  });

  it('[PLAT-3] a declared non-2xx answer passes only as declared', async () => {
    const declared = await walk({ archiveThing: 409 }, { archiveThing: [409] });
    expect(declared.every((o) => o.ok)).toBe(true);
    const other = await walk({ archiveThing: 404 }, { archiveThing: [409] });
    expect(other.find((o) => o.route === 'archiveThing')?.ok).toBe(false);
  });
});
