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
import { walkRoutes } from './route-walker.ts';

describe('route walker (stub until T-0201)', () => {
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
