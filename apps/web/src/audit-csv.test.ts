import type { AuditEvent } from '@omnibridge/db';
import { describe, expect, it } from 'vitest';
import { auditCsv, csvCell, UTF8_BOM } from './audit-csv.ts';

const event: AuditEvent = {
  id: '00000000-0000-4000-8000-000000000001',
  occurredAt: new Date('2026-07-01T08:05:00.000Z'),
  actorKind: 'user',
  userId: '00000000-0000-4000-8000-0000000000b1',
  userName: 'Sam "Ops" Admin',
  action: 'vat_quarter.unlocked',
  entityType: 'vat_quarter',
  entityId: 'q-2026-1',
  before: { period: '2026-Q1' },
  after: null,
  reason: '=HYPERLINK("http://example.test")',
  ip: '192.0.2.10',
};

describe('audit CSV export (AUD-4)', () => {
  it('[AUD-4] quotes every cell and neutralises formulas', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${start}1+1`)).toBe(`"'${start}1+1"`);
    }
  });

  it('[AUD-4] writes a header and one row per event, in UTC and London time', () => {
    const csv = auditCsv([event]);
    expect(csv.startsWith(`${UTF8_BOM}occurred_at_utc,occurred_at_london,`)).toBe(true);
    const [, row] = csv.slice(1).split('\r\n');
    expect(row).toBe(
      [
        '"2026-07-01T08:05:00.000Z"',
        '"01/07/2026 09:05"',
        '"user"',
        '"00000000-0000-4000-8000-0000000000b1"',
        '"Sam ""Ops"" Admin"',
        '"vat_quarter.unlocked"',
        '"vat_quarter"',
        '"q-2026-1"',
        '"{""period"":""2026-Q1""}"',
        '""',
        `"'=HYPERLINK(""http://example.test"")"`,
        '"192.0.2.10"',
      ].join(','),
    );
    expect(auditCsv([]).split('\r\n')).toHaveLength(2);
  });
});
