import { describe, expect, it } from 'vitest';
import {
  checkRaise,
  InvalidNotification,
  NOTIFICATION_TYPES,
  Notifier,
  type CheckedRaise,
  type NotificationStore,
  type RaiseResult,
} from './notifications.ts';

const ID = '7b0c3c9e-5d0e-4a8e-9a43-6d1f5f0b2c11';
const ctx = { workspaceId: ID, companyIds: [] };

describe('notification types', () => {
  it('[NTF-1] every PRD section 6 type (and the SEC-12 security types) is registered once, with a severity and a tab or platform scope', () => {
    expect(NOTIFICATION_TYPES).toHaveLength(28);
    expect(new Set(NOTIFICATION_TYPES.map((t) => t.code)).size).toBe(28);
    for (const t of NOTIFICATION_TYPES) {
      expect(t.severities.length).toBeGreaterThan(0);
      expect(t.scope === 'platform' ? t.tab : typeof t.tab).toBe(
        t.scope === 'platform' ? undefined : 'string',
      );
    }
    const platform = NOTIFICATION_TYPES.filter((t) => t.scope === 'platform').map((t) => t.code);
    expect(platform.sort()).toEqual([
      'ebay.api_usage_high',
      'ebay.public_key_throttled',
      'platform.amazon_auth_limit',
      'platform.amazon_secret_rotation',
      'platform.report_failure',
      'security.canary_read',
    ]);
  });

  it('[NTF-1] a raise takes the type defaults and refuses unknown types, wrong scopes, severities and signals', () => {
    const raised = checkRaise(
      { type: 'inventory.oversold', record: { kind: 'sku', id: ID } },
      'workspace',
    );
    expect(raised).toMatchObject({ severity: 'critical', signal: 'derived', companyId: null });
    expect(
      checkRaise({ type: 'reminders.due', record: { kind: 'reminder', id: ID } }, 'workspace')
        .signal,
    ).toBeNull();
    const bad: [Parameters<typeof checkRaise>[0], 'workspace' | 'platform'][] = [
      [{ type: 'nope.nope', record: { kind: 'sku', id: ID } }, 'workspace'],
      [{ type: 'ebay.api_usage_high', record: { kind: 'day', id: '2026-11-19' } }, 'workspace'],
      [{ type: 'inventory.oversold', record: { kind: 'sku', id: ID } }, 'platform'],
      [
        { type: 'inventory.oversold', record: { kind: 'sku', id: ID }, severity: 'info' },
        'workspace',
      ],
      [
        { type: 'inventory.oversold', record: { kind: 'sku', id: ID }, signal: 'native' },
        'workspace',
      ],
      [
        { type: 'reminders.due', record: { kind: 'reminder', id: ID }, signal: 'derived' },
        'workspace',
      ],
      [
        { type: 'ebay.api_usage_high', record: { kind: 'day', id: '2026-11-19' }, companyId: ID },
        'platform',
      ],
    ];
    for (const [input, scope] of bad) {
      expect(() => checkRaise(input, scope)).toThrow(InvalidNotification);
    }
  });

  it('[NTF-1] a notification holds IDs, counts and flags only: no text in params or record ids', () => {
    const base = { type: 'cs.ebay_message', record: { kind: 'message', id: ID } };
    expect(
      checkRaise({ ...base, params: { count: 2, urgent: true, orderId: ID } }, 'workspace').params,
    ).toEqual({
      count: 2,
      urgent: true,
      orderId: ID,
    });
    for (const params of [
      { buyer: 'PIIMARK-Jane Doe' },
      { note: 'hello' },
      { n: Number.NaN },
      { 'bad key': 1 },
    ]) {
      expect(() => checkRaise({ ...base, params }, 'workspace')).toThrow(InvalidNotification);
    }
    for (const id of ['jane@example.test', 'PIIMARK-someone', 'buyer name', '']) {
      expect(() => checkRaise({ ...base, record: { kind: 'message', id } }, 'workspace')).toThrow(
        InvalidNotification,
      );
    }
    expect(
      checkRaise({ ...base, record: { kind: 'day', id: '2026-11-19T10' } }, 'workspace').record.id,
    ).toBe('2026-11-19T10');
  });
});

describe('Notifier', () => {
  it('[NTF-5] passes the caller context to the store and the hook, so the raise joins its transaction', async () => {
    const seen: unknown[] = [];
    const result: RaiseResult = {
      id: ID,
      version: 1,
      created: true,
      escalated: false,
      reopened: false,
    };
    const store: NotificationStore = {
      raise: (c, r: CheckedRaise) => (
        seen.push(['raise', c, r.type.code]),
        Promise.resolve(result)
      ),
      resolve: (c) => (seen.push(['resolve', c]), Promise.resolve(true)),
      raisePlatform: (c) => (seen.push(['platform', c]), Promise.resolve(result)),
      resolvePlatform: () => Promise.resolve(false),
    };
    const notifier = new Notifier({
      store,
      onRaised: (c, r) => (seen.push(['hook', c, r.type.code]), Promise.resolve()),
    });
    await notifier.raise(ctx, { type: 'inventory.oversold', record: { kind: 'sku', id: ID } });
    await notifier.resolve(ctx, 'inventory.oversold', { kind: 'sku', id: ID });
    await notifier.raisePlatform(null, {
      type: 'platform.report_failure',
      record: { kind: 'day', id: '2026-11-19' },
    });
    expect(seen).toEqual([
      ['raise', ctx, 'inventory.oversold'],
      ['hook', ctx, 'inventory.oversold'],
      ['resolve', ctx],
      ['platform', null],
      ['hook', null, 'platform.report_failure'],
    ]);
    await expect(
      notifier.resolve(ctx, 'platform.report_failure', { kind: 'day', id: '2026-11-19' }),
    ).rejects.toThrow(InvalidNotification);
  });
});
