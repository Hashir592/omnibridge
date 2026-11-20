// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkPreview, Connection, ConnectionDetail } from '../../auth/api.ts';
import { BulkConfirmDialog } from '../../components/BulkConfirmDialog.tsx';
import { MaintenanceLine, PausedLine } from '../../components/PausedLine.tsx';
import { bulkConfirmProblem } from '../../lib/connections.ts';
import { ConnectionCard, ConnectionDetailBody } from './parts.tsx';
import { canAuthorise, kindOf, oauthReturn, usageLine } from './rules.ts';

afterEach(cleanup);

const ACCOUNT = '5a1e9d3c-7f20-4e8a-b1c4-000000000012';
const COMPANY = { name: 'Northfield Trading', colour: '#2F7F7A' };

function connection(over: Partial<Connection> = {}): Connection {
  return {
    id: ACCOUNT,
    provider: 'ebay',
    display_name: 'eBay · northfield-trading',
    company_id: '7b0c2f0e-1d4a-4c1b-9a51-0000000000c1',
    status: 'active',
    last_success_at: '2026-11-21T09:40:00Z',
    last_token_refresh_at: '2026-11-21T09:05:00Z',
    consecutive_auth_failures: 2,
    usage_today: [{ api: 'sell.fulfillment', calls: 4_120, cap: 5_000 }],
    kill_switch: { paused: false, paused_at: null },
    ...over,
  };
}

const paused = (): Connection =>
  connection({
    status: 'paused',
    kill_switch: { paused: true, paused_at: '2026-11-20T15:30:00Z' },
  });

function card(c: Connection, onKill = vi.fn()) {
  render(
    <ConnectionCard
      c={c}
      company={COMPANY}
      onKill={onKill}
      onAuthorise={vi.fn()}
      onDetails={vi.fn()}
      busy={false}
    />,
  );
  return onKill;
}

describe('Connections card', () => {
  it('[INT-4] shows provider, company, status, last call, last refresh, failures, usage and kill switch', () => {
    card(connection());
    const text = document.body.textContent;
    expect(text).toContain('eBay · northfield-trading');
    expect(text).toContain('eBay');
    expect(text).toContain('Northfield Trading');
    expect(text).toContain('Active');
    expect(screen.getByText('Last successful call')).toBeTruthy();
    expect(screen.getByText('Last token refresh')).toBeTruthy();
    expect(screen.getByText('Auth failures in a row')).toBeTruthy();
    expect(text).toContain('4,120 of 5,000');
    expect(screen.getByRole('checkbox', { name: /Kill switch/ })).toBeTruthy();
  });

  it('[INT-4] names every status the server can answer', () => {
    for (const [status, label] of [
      ['active', 'Active'],
      ['needs_reauth', 'Needs re-authorisation'],
      ['paused', 'Paused'],
      ['error', 'Error'],
      ['disconnected', 'Disconnected'],
    ] as const) {
      card(connection({ status }));
      expect(document.body.textContent).toContain(label);
      cleanup();
    }
  });

  it('[INT-4] says when an API is above 80% of its daily cap', () => {
    card(connection());
    expect(document.body.textContent).toContain('Above 80% of a daily cap');
    cleanup();
    card(connection({ usage_today: [{ api: 'orders', calls: 10, cap: 5_000 }] }));
    expect(document.body.textContent).not.toContain('Above 80%');
  });

  it('[INT-4] usage reads against the cap, or says there is none', () => {
    expect(usageLine({ api: 'orders', calls: 640, cap: null })).toBe('640 calls, no daily cap');
    expect(usageLine({ api: 'x', calls: 4_120, cap: 5_000 })).toBe('4,120 of 5,000');
  });

  it('[INT-4] groups accounts by kind and offers re-authorisation for OAuth only', () => {
    expect(kindOf('amazon')).toBe('channel');
    expect(kindOf('website')).toBe('channel');
    expect(kindOf('amazon_ads')).toBe('ads');
    expect(kindOf('dpd')).toBe('carrier');
    expect(canAuthorise(connection({ status: 'needs_reauth' }))).toBe(true);
    expect(canAuthorise(connection({ status: 'disconnected', provider: 'amazon' }))).toBe(true);
    expect(canAuthorise(connection({ status: 'needs_reauth', provider: 'evri' }))).toBe(false);
    expect(canAuthorise(connection({ status: 'active' }))).toBe(false);
  });

  it('[SAFE-2] pausing asks first, then sends paused: true', () => {
    const onKill = card(connection());
    fireEvent.click(screen.getByRole('checkbox', { name: /Kill switch/ }));
    expect(onKill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause writes' }));
    expect(onKill).toHaveBeenCalledWith(true);
  });

  it('[SAFE-2] resuming sends paused: false at once', () => {
    const onKill = card(paused());
    fireEvent.click(screen.getByRole('checkbox', { name: /Kill switch/ }));
    expect(onKill).toHaveBeenCalledWith(false);
  });

  it('[SAFE-2] a paused account shows the red paused line on its card', () => {
    card(paused());
    const line = screen.getByTestId('paused-line');
    expect(line.textContent).toContain('Paused');
    expect(line.textContent).toContain('20/11/2026');
    expect(line.className).toContain('text-danger');
  });

  it('[SAFE-2] an account that is not paused shows no paused line', () => {
    card(connection());
    expect(screen.queryByTestId('paused-line')).toBeNull();
  });
});

describe('paused and maintenance lines', () => {
  it('[SAFE-2] is a plain red line: icon and text, no tinted box', () => {
    render(<PausedLine pausedAt="2026-11-20T15:30:00Z" />);
    const line = screen.getByTestId('paused-line');
    expect(line.textContent).toContain('Automated writes wait');
    expect(line.className).not.toMatch(/\bbg-|border-danger/);
  });

  it('[SAFE-3] maintenance shows while it is on and says reads go on', () => {
    render(<MaintenanceLine state={{ on: true, since: '2026-11-21T08:00:00Z' }} />);
    expect(screen.getByRole('status').textContent).toContain('Maintenance');
    cleanup();
    const { container } = render(<MaintenanceLine state={{ on: false, since: null }} />);
    expect(container.textContent).toBe('');
  });
});

describe('Connection detail', () => {
  const detail = (over: Partial<ConnectionDetail> = {}): ConnectionDetail => ({
    ...paused(),
    needs_reauth_at: null,
    last_error: { code: 'provider_timeout', at: '2026-11-21T07:00:00Z' },
    streams: [
      {
        stream: 'orders',
        cursor_at: '2026-11-21T09:00:00Z',
        last_success_at: '2026-11-21T09:01:00Z',
      },
    ],
    credentials: [
      { kind: 'ebay.refresh_token', slot: 'current', expires_at: '2027-05-01T00:00:00Z' },
    ],
    ...over,
  });

  it('[SAFE-2] a paused account shows the paused line in its detail too', () => {
    render(<ConnectionDetailBody d={detail()} />);
    expect(screen.getByTestId('paused-line')).toBeTruthy();
  });

  it('[INT-4] shows the last error code, sync streams and token expiry, never a value', () => {
    render(<ConnectionDetailBody d={detail()} />);
    const text = document.body.textContent;
    expect(text).toContain('provider_timeout');
    expect(text).toContain('orders');
    expect(text).toContain('01/05/2027');
    expect(text).toContain('Current');
  });
});

describe('bulk confirmation', () => {
  const preview: BulkPreview = {
    token: 'synthetic-bulk-token-for-tests-only',
    expires_at: '2026-11-21T10:10:00Z',
    action: 'stock_push',
    accounts: [
      {
        id: 'a1',
        provider: 'amazon',
        display_name: 'Amazon UK · Northfield',
        company_id: 'c1',
        paused: false,
      },
      {
        id: 'a2',
        provider: 'ebay',
        display_name: 'eBay · northfield-trading',
        company_id: 'c1',
        paused: true,
      },
      {
        id: 'a3',
        provider: 'website',
        display_name: 'harbourgoods.co.uk',
        company_id: 'c2',
        paused: false,
      },
    ],
  };

  function dialog(onConfirm = vi.fn()) {
    render(
      <BulkConfirmDialog
        preview={preview}
        onClose={vi.fn()}
        onConfirm={onConfirm}
        busy={false}
        error={undefined}
        companyName={() => undefined}
      />,
    );
    return onConfirm;
  }

  it('[SAFE-1] names every account the preview returned', () => {
    dialog();
    const list = screen.getByRole('list', { name: 'Accounts this reaches' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    for (const a of preview.accounts) expect(list.textContent).toContain(a.display_name);
  });

  it('[SAFE-1] confirm sends the token only', async () => {
    const onConfirm = dialog();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Push stock to 3 accounts' }));
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledWith(preview.token);
  });

  it('[SAFE-2] a paused account is marked paused in the dialog', () => {
    dialog();
    const items = within(screen.getByRole('list', { name: 'Accounts this reaches' })).getAllByRole(
      'listitem',
    );
    expect(items[1]?.textContent).toContain('Paused');
    expect(items[0]?.textContent).not.toContain('Paused');
  });

  it('[SAFE-1] explains a refused confirm', () => {
    expect(bulkConfirmProblem(404)).toMatch(/not found/i);
    expect(bulkConfirmProblem(409)).toMatch(/expired|changed/i);
    expect(bulkConfirmProblem(500)).toMatch(/try again/i);
  });
});

describe('OAuth return', () => {
  it('[INT-4] reads the OAuth return from the address', () => {
    expect(oauthReturn({ connected: ACCOUNT })).toEqual({ ok: true, accountId: ACCOUNT });
    expect(oauthReturn({ error: 'access_denied' })).toMatchObject({ ok: false });
    expect(oauthReturn({})).toBeUndefined();
  });
});
