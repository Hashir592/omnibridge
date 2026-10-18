/** UK display formats (NFR-9). Money arrives as integer pence and never passes through a float. */

const LONDON = 'Europe/London';

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }); // YYYY-MM-DD
const intFmt = new Intl.NumberFormat('en-GB');

/** 123456 → "£1,234.56"; -500 → "−£5.00". */
export function formatPence(pence: number): string {
  const neg = pence < 0;
  const abs = Math.abs(Math.trunc(pence));
  const pounds = Math.trunc(abs / 100);
  const pennies = String(abs % 100).padStart(2, '0');
  return `${neg ? '−' : ''}£${intFmt.format(pounds)}.${pennies}`;
}

export function formatInt(n: number): string {
  return intFmt.format(n);
}

/** UTC ISO → "18/10/2026" in London time. */
export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

/** UTC ISO → "14:05" in London time. */
export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

function dayNumber(d: Date): number {
  return Date.parse(`${dayKeyFmt.format(d)}T00:00:00Z`) / 86_400_000;
}

/** Whole London calendar days from today to the given instant (negative = past). */
export function daysFromToday(iso: string, now = new Date()): number {
  return dayNumber(new Date(iso)) - dayNumber(now);
}
