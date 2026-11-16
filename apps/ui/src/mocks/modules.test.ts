import { getResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { handlers } from './handlers.ts';
import { setPersona } from './session.ts';
import type { Session } from './types.ts';

// ADR-059: the website connector is a per-workspace module toggle. With it off, the Website channel
// must not appear in any area. The "starter" persona is an admin of a workspace with it off; the
// demo admin (toggle on) is the control, so each test proves the area did show Website before.

async function json(path: string): Promise<string> {
  const res = await getResponse(handlers, new Request(`http://localhost${path}`));
  if (!res) throw new Error(`no mock handler for ${path}`);
  expect(res.status).toBe(200);
  return JSON.stringify(await res.json());
}

const mentionsWebsite = (body: string) => /website|harbourgoods\.co\.uk|ca_4/i.test(body);

async function onThenOff(path: string): Promise<{ on: boolean; off: boolean }> {
  setPersona('admin');
  const on = mentionsWebsite(await json(path));
  setPersona('starter');
  const off = mentionsWebsite(await json(path));
  return { on, off };
}

afterEach(() => {
  setPersona('admin');
});

describe('website_connector off (ADR-059)', () => {
  it('[ADR-059] the session says the module is off and lists no website account', async () => {
    setPersona('starter');
    const s = JSON.parse(await json('/api/mock/session')) as Session;
    expect(s.modules.website_connector).toBe(false);
    expect(s.channelAccounts.some((a) => a.channel === 'website')).toBe(false);
    setPersona('admin');
    expect((JSON.parse(await json('/api/mock/session')) as Session).modules.website_connector).toBe(
      true,
    );
  });

  it('[ADR-059] Orders: no website orders in the list', async () => {
    expect(await onThenOff('/api/mock/orders?limit=100')).toEqual({ on: true, off: false });
  });

  it('[ADR-059] Home: no Website row in orders today', async () => {
    expect(await onThenOff('/api/mock/home')).toEqual({ on: true, off: false });
  });

  it('[ADR-059] Connections: no Website card', async () => {
    expect(await onThenOff('/api/mock/connections')).toEqual({ on: true, off: false });
  });

  it('[ADR-059] Stock: no website listing rows', async () => {
    expect(await onThenOff('/api/mock/stock/skus?limit=100')).toEqual({ on: true, off: false });
  });

  it('[ADR-059] Sales & Profit: no website account or cluster in the breakdowns', async () => {
    for (const by of ['account', 'cluster']) {
      expect(await onThenOff(`/api/mock/sales-profit?by=${by}`)).toEqual({ on: true, off: false });
    }
  });

  it('[ADR-059] Finance: no website sales line in the P&L', async () => {
    expect(await onThenOff('/api/mock/finance/pnl?company=co_2')).toEqual({ on: true, off: false });
  });
});
