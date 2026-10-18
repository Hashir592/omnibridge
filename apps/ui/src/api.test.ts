import { createApiClient } from '@omnibridge/contract/client';
import { describe, expect, it } from 'vitest';
import { getHealth } from './api.ts';

function stubFetch(status: number, body: unknown, contentType = 'application/json') {
  const calls: string[] = [];
  const fetch = (request: Request) => {
    calls.push(`${request.method} ${request.url}`);
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } }),
    );
  };
  return { api: createApiClient({ baseUrl: 'https://app.test', fetch }), calls };
}

describe('typed client usage from apps/ui', () => {
  it('[NFR-1] calls /healthz through the generated client', async () => {
    const health = { status: 'ok', db_main: 'ok', db_pii: 'ok', version: '1.0.0' } as const;
    const { api, calls } = stubFetch(200, health);
    expect(await getHealth(api)).toEqual({ ok: true, health });
    expect(calls).toEqual(['GET https://app.test/healthz']);
  });

  it('[NFR-1] surfaces a problem+json body on failure', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'internal_error',
    } as const;
    const { api } = stubFetch(500, problem, 'application/problem+json');
    expect(await getHealth(api)).toEqual({ ok: false, problem });
  });
});
