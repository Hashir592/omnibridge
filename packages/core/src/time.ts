/**
 * Time rules (NFR-7, invariant 13): instants are stored in UTC and shown in Europe/London.
 * VAT dates are London calendar dates, worked out once when a record is written.
 *
 * Uses the runtime's IANA time-zone data (Intl), so this file has no imports and is safe to use
 * in the browser through `@omnibridge/core/time`.
 */
export const LONDON_TIME_ZONE = 'Europe/London';

/** A London calendar date as `YYYY-MM-DD`, e.g. a VAT tax point date. */
export type LondonDate = string & { readonly __brand: 'LondonDate' };

const londonParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function assertValid(instant: Date): void {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid date');
}

function partsInLondon(instant: Date) {
  assertValid(instant);
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of londonParts.formatToParts(instant)) parts[part.type] = part.value;
  const { year = '', month = '', day = '', hour = '', minute = '' } = parts;
  return { year, month, day, hour, minute };
}

/** The calendar date in London at this instant. Use it for VAT dates (`tax_point_date`). */
export function londonDate(instant: Date): LondonDate {
  const { year, month, day } = partsInLondon(instant);
  return `${year}-${month}-${day}` as LondonDate;
}

/** `DD/MM/YYYY` in London (NFR-9). */
export function formatLondonDate(instant: Date): string {
  const { year, month, day } = partsInLondon(instant);
  return `${day}/${month}/${year}`;
}

/** `DD/MM/YYYY HH:mm` (24-hour) in London. */
export function formatLondonDateTime(instant: Date): string {
  const { year, month, day, hour, minute } = partsInLondon(instant);
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

/** The storage and wire form of an instant: ISO 8601 in UTC, e.g. `2026-07-01T08:05:00.000Z`. */
export function toUtcIso(instant: Date): string {
  assertValid(instant);
  return instant.toISOString();
}

const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO 8601 timestamp that names its offset (`Z` or `±HH:MM`). A timestamp without one
 * is refused, because JavaScript would read it in the server's own time zone.
 */
export function parseUtc(iso: string): Date {
  if (!ZONED_TIMESTAMP.test(iso)) throw new RangeError(`Timestamp must include a UTC offset`);
  const instant = new Date(iso);
  assertValid(instant);
  // Date rolls impossible days over (30 Feb becomes 2 Mar); refuse them instead.
  const [y = 0, m = 0, d = 0] = iso.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) {
    throw new RangeError(`Not a calendar date: ${iso.slice(0, 10)}`);
  }
  return instant;
}
