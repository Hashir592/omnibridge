/**
 * Calendar dates (no time) as 'YYYY-MM-DD' strings, shown as DD/MM/YYYY (NFR-9).
 * Plain calendar arithmetic in UTC, so no daylight-saving shift can move a day.
 */

const DAY_MS = 86_400_000;
const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }); // YYYY-MM-DD

/** Today's date in London. */
export function todayLondon(now = new Date()): string {
  return londonDay.format(now);
}

/** '2026-10-19' → '19/10/2026'. */
export function formatUkDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

/**
 * '19/10/2026', '19/10/26', '1/2/2026' or '19.10.2026' → ISO, or null if it is not a real date.
 * Two-digit years mean 20xx.
 */
export function parseUkDate(text: string): string | null {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\s*$/.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d)
    return null;
  return toIso(t);
}

function toIso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function toTime(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

export function addDays(iso: string, n: number): string {
  return toIso(toTime(iso) + n * DAY_MS);
}

/** Same day in another month, clamped to that month's last day (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(iso: string, n: number): string {
  const d = new Date(toTime(iso));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return toIso(target.getTime());
}

/** Monday = 0 … Sunday = 6 (UK weeks start on Monday). */
export function weekday(iso: string): number {
  return (new Date(toTime(iso)).getUTCDay() + 6) % 7;
}

/** The 6 x 7 days shown for the month containing `iso`, starting on a Monday. */
export function monthGrid(iso: string): string[] {
  const first = `${iso.slice(0, 7)}-01`;
  const start = addDays(first, -weekday(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

const monthFmt = new Intl.DateTimeFormat('en-GB', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const longFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** 'October 2026' */
export function monthLabel(iso: string): string {
  return monthFmt.format(new Date(toTime(iso)));
}

/** 'Monday 19 October 2026', for screen readers. */
export function longDate(iso: string): string {
  return longFmt.format(new Date(toTime(iso))).replace(',', '');
}
