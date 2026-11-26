import { contractRoutes, isRootPath, type AnyRoute } from '@omnibridge/contract';
import { createLogger } from '@omnibridge/logger';
import { describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

interface Doc {
  servers?: { url: string }[];
  paths: Record<
    string,
    Record<string, { operationId: string; 'x-permissions': unknown; servers?: { url: string }[] }>
  >;
}

async function document(): Promise<Doc> {
  const app = buildWebApp({
    logger: createLogger({ service: 'web-test', version: '0', level: 'silent' }),
    version: '0',
    openapi: true,
    checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
  });
  await app.ready();
  const doc = app.swagger() as unknown as Doc;
  await app.close();
  return doc;
}

describe('OpenAPI document', () => {
  it('[NFR-1] lists every registry route with its permission metadata', async () => {
    const doc = await document();

    for (const route of contractRoutes) {
      const operation =
        doc.paths[route.path.replace(/:(\w+)/g, '{$1}')]?.[route.method.toLowerCase()];
      expect(operation?.operationId).toBe(route.id);
      expect(operation?.['x-permissions']).toEqual({
        auth: route.auth,
        tab: route.tab,
        adminOnly: route.adminOnly,
        companyScoped: route.companyScoped,
        // ADR-059: a route behind a module toggle says so.
        ...((route as AnyRoute).module === undefined ? {} : { module: (route as AnyRoute).module }),
      });
    }
  });

  // ADR-060
  it('[SEC-3] serves the API under /api; only the PRD-fixed paths override it', async () => {
    const doc = await document();
    expect(doc.servers).toEqual([{ url: '/api' }]);
    const atRoot = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.values(ops)
        .filter((op) => op.servers !== undefined)
        .map((op) => ({ path, servers: op.servers })),
    );
    expect(atRoot.map((r) => r.path).sort()).toEqual(
      contractRoutes
        .filter((r) => isRootPath(r.path))
        .map((r) => r.path)
        .sort(),
    );
    expect(new Set(atRoot.map((r) => r.path))).toEqual(
      new Set(['/healthz', '/webhooks/ebay/account-deletion']),
    );
    for (const r of atRoot) expect(r.servers).toEqual([{ url: '/' }]);
  });
});
