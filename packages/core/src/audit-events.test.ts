import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_EVENTS,
  auditDiff,
  AuditValueRejected,
  isAuditAction,
} from './audit-events.ts';

describe('audit event catalogue (AUD-2, AUD-3)', () => {
  it('[AUD-2] lists an event for every kind of change the PRD names', () => {
    // One prefix per AUD-2 group: logins, MFA, users and permissions, connections, kill switch,
    // stock, catalogue, COGS, finance, intercompany, VAT quarters, exports, deletions, ads.
    const groups = [
      'auth.login',
      'auth.login_failed',
      'mfa.',
      'user.invited',
      'user.permissions_changed',
      'connection.added',
      'connection.removed',
      'connection.reauthorised',
      'kill_switch.',
      'stock.adjusted',
      'catalogue.',
      'cogs.',
      'finance.created',
      'finance.edited',
      'finance.deleted',
      'intercompany.edited',
      'vat_quarter.locked',
      'vat_quarter.unlocked',
      'export.',
      'deletion.run',
      'ads.',
    ];
    for (const group of groups) {
      expect(
        AUDIT_ACTIONS.some((action) => action.startsWith(group)),
        group,
      ).toBe(true);
    }
  });

  it('[AUD-2] action names and entity types are lower-case dotted names', () => {
    for (const action of AUDIT_ACTIONS) expect(action).toMatch(/^[a-z_]+\.[a-z_]+$/);
    for (const type of AUDIT_ENTITY_TYPES) expect(type).toMatch(/^[a-z_]+$/);
    expect(isAuditAction('vat_quarter.unlocked')).toBe(true);
    expect(isAuditAction('toString')).toBe(false);
  });

  it('[AUD-1] the events the PRD gives a typed reason require one', () => {
    for (const action of [
      'vat_quarter.unlocked',
      'intercompany.edited',
      'intercompany.deleted',
      'stock.adjusted',
      'finance.company_moved',
    ] as const) {
      expect(AUDIT_EVENTS[action].reasonRequired, action).toBe(true);
    }
  });

  it('[AUD-3] no catalogue field names a buyer field', () => {
    const buyer = /buyer|customer|address|phone|email|postcode|recipient/;
    for (const action of AUDIT_ACTIONS) {
      for (const field of AUDIT_EVENTS[action].fields) expect(field).not.toMatch(buyer);
    }
  });
});

describe('auditDiff (AUD-1, AUD-3)', () => {
  it('[AUD-1] keeps only the allowed fields that changed', () => {
    expect(
      auditDiff(
        'user.permissions_changed',
        { tabs: ['orders'], company_ids: ['c1'] },
        { tabs: ['orders', 'shipping'], company_ids: ['c1'] },
      ),
    ).toEqual({ before: { tabs: ['orders'] }, after: { tabs: ['orders', 'shipping'] } });
    expect(auditDiff('connection.added', null, { provider: 'ebay', company_id: 'c1' })).toEqual({
      before: null,
      after: { provider: 'ebay', company_id: 'c1' },
    });
  });

  it('[AUD-3] PII marker in before/after is rejected', () => {
    // A buyer field is not in the catalogue, so the event is refused, not trimmed.
    expect(() =>
      auditDiff('stock.adjusted', null, { delta: -1, buyer_name: 'PIIMARK-Jane Doe' }),
    ).toThrow(AuditValueRejected);
    // An allowed field that somehow carries buyer data is refused too.
    expect(() =>
      auditDiff('connection.added', null, { display_name: 'PIIMARK-jane@example.test' }),
    ).toThrow(/carries PII/);
    expect(() =>
      auditDiff('catalogue.changed', { title: 'PIIMARK-Jane' }, { title: 'Mug' }),
    ).toThrow(AuditValueRejected);
  });

  it('[AUD-3] refuses objects, long text and non-finite numbers', () => {
    expect(() => auditDiff('catalogue.changed', null, { title: { nested: 'x' } })).toThrow(
      /scalar/,
    );
    expect(() => auditDiff('catalogue.changed', null, { title: 'x'.repeat(501) })).toThrow(
      /too long/,
    );
    expect(() => auditDiff('cogs.changed', null, { cogs_pence: Number.NaN })).toThrow(/scalar/);
    expect(() => auditDiff('user.invited', null, { tabs: [{ tab: 'orders' }] })).toThrow(/list/);
  });
});
