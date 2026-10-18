import { contractRoutes } from '@omnibridge/contract';
import { createLogger } from '@omnibridge/logger';
import { describe, expect, it } from 'vitest';
import { buildWebApp } from './app.ts';

describe('OpenAPI document', () => {
  it('[NFR-1] lists every registry route with its permission metadata', async () => {
    const app = buildWebApp({
      logger: createLogger({ service: 'web-test', version: '0', level: 'silent' }),
      version: '0',
      openapi: true,
      checks: { dbMain: () => Promise.resolve(true), dbPii: () => Promise.resolve(true) },
    });
    await app.ready();
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, { operationId: string; 'x-permissions': unknown }>>;
    };
    await app.close();

    for (const route of contractRoutes) {
      const operation =
        doc.paths[route.path.replace(/:(\w+)/g, '{$1}')]?.[route.method.toLowerCase()];
      expect(operation?.operationId).toBe(route.id);
      expect(operation?.['x-permissions']).toEqual({
        auth: route.auth,
        tab: route.tab,
        adminOnly: route.adminOnly,
        companyScoped: route.companyScoped,
      });
    }
  });
});
