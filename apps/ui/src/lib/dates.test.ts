import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  formatUkDate,
  longDate,
  monthGrid,
  parseUkDate,
  todayLondon,
  weekday,
} from './dates.ts';

describe('calendar dates', () => {
  it('[NFR-9] shows a stored date as DD/MM/YYYY', () => {
    expect(formatUkDate('2026-10-19')).toBe('19/10/2026');
    expect(formatUkDate('2026-01-05')).toBe('05/01/2026');
  });

  it('[NFR-9] reads typed UK dates, including short forms', () => {
    expect(parseUkDate('19/10/2026')).toBe('2026-10-19');
    expect(parseUkDate('3/11/26')).toBe('2026-11-03');
    expect(parseUkDate(' 1.2.2026 ')).toBe('2026-02-01');
    expect(parseUkDate('29/02/2028')).toBe('2028-02-29');
  });

  it('[NFR-9] rejects dates that do not exist or are not day-first', () => {
    expect(parseUkDate('31/02/2026')).toBeNull();
    expect(parseUkDate('29/02/2026')).toBeNull();
    expect(parseUkDate('10/13/2026')).toBeNull();
    expect(parseUkDate('2026-10-19')).toBeNull();
    expect(parseUkDate('')).toBeNull();
  });

  it('[NFR-9] uses the London calendar day for "today"', () => {
    // 23:30 UTC on 30 June is already 1 July in London (BST).
    expect(todayLondon(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
    // 23:30 UTC on 30 December is still 30 December in London (GMT).
    expect(todayLondon(new Date('2026-12-30T23:30:00Z'))).toBe('2026-12-30');
  });

  it('[NFR-9] moves across the clock change without losing a day', () => {
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
  });

  it('[NFR-9] clamps month steps to the last day of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('[NFR-9] lays out a month in UK weeks starting on Monday', () => {
    const grid = monthGrid('2026-10-19');
    expect(grid).toHaveLength(42);
    expect(weekday(grid[0] ?? '')).toBe(0);
    expect(grid[0]).toBe('2026-09-28');
    expect(grid).toContain('2026-10-01');
    expect(grid).toContain('2026-10-31');
    expect(longDate('2026-10-19')).toBe('Monday 19 October 2026');
  });
});
