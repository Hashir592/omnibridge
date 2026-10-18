import { contractRoutes, type AnyRoute } from '@omnibridge/contract';
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
    });
  });

  it('[SEC-3] fails when any route lacks permission metadata', () => {
    const [health] = contractRoutes;
    const withoutTab = Object.fromEntries(Object.entries(health).filter(([k]) => k !== 'tab'));
    expect(() => walkRoutes([withoutTab as unknown as AnyRoute])).toThrow(/getHealth: tab/);
  });
});
