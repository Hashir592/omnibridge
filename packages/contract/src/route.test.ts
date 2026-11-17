import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractRoutes } from './registry.ts';
import { defineRoute, routeMetadataProblems, type AnyRoute } from './route.ts';
import { listQuery, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from './pagination.ts';

const base = {
  id: 'listThings',
  method: 'GET',
  path: '/things',
  responses: { 200: z.object({ ok: z.boolean() }) },
  auth: 'session',
  tab: 'orders',
  adminOnly: false,
  companyScoped: true,
} as const;

/** Simulates a route object that skipped the type checker (JS caller, cast, bad merge). */
function withoutKey(key: keyof typeof base): AnyRoute {
  const copy = Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
  return copy as unknown as AnyRoute;
}

describe('route metadata (invariant 4)', () => {
  it('[SEC-3] every registry route declares auth, tab, adminOnly and companyScoped', () => {
    expect(contractRoutes.length).toBeGreaterThan(0);
    for (const route of contractRoutes) expect(routeMetadataProblems(route)).toEqual([]);
  });

  it('[SEC-3] a route missing any permission field is reported', () => {
    for (const key of ['auth', 'tab', 'adminOnly', 'companyScoped'] as const) {
      expect(routeMetadataProblems(withoutKey(key)).join('\n')).toContain(key);
    }
  });

  it('[SEC-3] unknown auth kinds and tabs are reported', () => {
    const bad = { ...base, auth: 'cookie', tab: 'everything' } as unknown as AnyRoute;
    const problems = routeMetadataProblems(bad).join('\n');
    expect(problems).toContain('auth');
    expect(problems).toContain('tab');
  });

  // ADR-060
  it('[SEC-3] a route path never carries the /api prefix the server adds', () => {
    expect(routeMetadataProblems({ ...base, path: '/api/v1/x' }).join('\n')).toMatch(/ADR-060/);
  });

  it('[SEC-3] admin-only tabs must be marked adminOnly', () => {
    expect(routeMetadataProblems({ ...base, tab: 'users' }).join('\n')).toMatch(/adminOnly/);
    expect(routeMetadataProblems({ ...base, tab: 'users', adminOnly: true })).toEqual([]);
  });

  it('[SEC-3] public routes sit on no tab and are not company-scoped', () => {
    expect(routeMetadataProblems({ ...base, auth: 'public' }).join('\n')).toMatch(/public/);
    expect(
      routeMetadataProblems({ ...base, auth: 'public', tab: 'none', companyScoped: false }),
    ).toEqual([]);
  });

  it('[SEC-3] defineRoute itself refuses a route without permission metadata', () => {
    expect(() => defineRoute(withoutKey('companyScoped'))).toThrow(/companyScoped/);
  });

  it('[SEC-3] a path parameter must have a params schema', () => {
    const route = { ...base, path: '/things/:thingId' };
    expect(routeMetadataProblems(route).join('\n')).toMatch(/thingId/);
    const withParams = { ...route, params: z.object({ thingId: z.uuid() }) };
    expect(routeMetadataProblems(withParams)).toEqual([]);
  });
});

describe('list pagination (CAP-7)', () => {
  it('[CAP-7] list query defaults to 50 rows and rejects more than 200', () => {
    expect(PAGE_LIMIT_DEFAULT).toBe(50);
    expect(PAGE_LIMIT_MAX).toBe(200);
    expect(listQuery.parse({})).toEqual({ limit: 50 });
    expect(listQuery.parse({ limit: '200', cursor: 'abc' })).toEqual({ limit: 200, cursor: 'abc' });
    expect(listQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(listQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(listQuery.safeParse({ limit: '2.5' }).success).toBe(false);
  });
});
