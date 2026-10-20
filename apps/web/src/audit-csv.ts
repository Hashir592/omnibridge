import { formatLondonDateTime, toUtcIso } from '@omnibridge/core';
import type { AuditEvent } from '@omnibridge/db';

const COLUMNS = [
  'occurred_at_utc',
  'occurred_at_london',
  'actor_kind',
  'user_id',
  'user_name',
  'action',
  'entity_type',
  'entity_id',
  'before',
  'after',
  'reason',
  'ip',
] as const;

/** Makes Excel read the file as UTF-8, so names with accents survive. */
export const UTF8_BOM = String.fromCodePoint(0xfeff);

/**
 * One CSV cell: always quoted, quotes doubled. A cell a spreadsheet would read as a formula
 * (starting with = + - @, tab or carriage return) gets a leading apostrophe, so an exported
 * value can never run in Excel (CSV injection).
 */
export function csvCell(value: string | null): string {
  const text = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** The first line of the export: the BOM and the header, ending in CRLF. */
export const AUDIT_CSV_HEADER = `${UTF8_BOM}${COLUMNS.join(',')}\r\n`;

/** One CSV line per event, each ending in CRLF. */
export function auditCsvRows(events: readonly AuditEvent[]): string {
  return events
    .map((e) =>
      [
        toUtcIso(e.occurredAt),
        formatLondonDateTime(e.occurredAt),
        e.actorKind,
        e.userId,
        e.userName,
        e.action,
        e.entityType,
        e.entityId,
        e.before === null ? null : JSON.stringify(e.before),
        e.after === null ? null : JSON.stringify(e.after),
        e.reason,
        e.ip,
      ]
        .map(csvCell)
        .join(','),
    )
    .map((line) => `${line}\r\n`)
    .join('');
}

/** The whole export (AUD-4): header, then one row per event. */
export function auditCsv(events: readonly AuditEvent[]): string {
  return AUDIT_CSV_HEADER + auditCsvRows(events);
}
