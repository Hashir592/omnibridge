import { describe, expect, it } from 'vitest';
import {
  daysFromToday,
  formatDate,
  formatDateTime,
  formatInt,
  formatPence,
  formatTime,
  overdueText,
} from './format.ts';
import { pageList } from './paging.ts';

describe('UK formats', () => {
  it('[NFR-9] shows money from integer pence as £1,234.56', () => {
    expect(formatPence(123456)).toBe('£1,234.56');
    expect(formatPence(5)).toBe('£0.05');
    expect(formatPence(0)).toBe('£0.00');
    expect(formatPence(123456789)).toBe('£1,234,567.89');
  });

  it('[NFR-9] shows a negative amount with a minus sign before the pound sign', () => {
    expect(formatPence(-500)).toBe('−£5.00');
  });

  it('[NFR-9] shows dates as DD/MM/YYYY in London time, across the BST boundary', () => {
    // 23:30 UTC on 18 Oct is 00:30 on 19 Oct in London (BST).
    expect(formatDate('2026-10-18T23:30:00Z')).toBe('19/10/2026');
    expect(formatTime('2026-10-18T23:30:00Z')).toBe('00:30');
    // In December London is on GMT, so the clock matches UTC.
    expect(formatDateTime('2026-12-01T09:05:00Z')).toBe('01/12/2026 09:05');
  });

  it('[NFR-9] groups thousands the UK way', () => {
    expect(formatInt(12345)).toBe('12,345');
  });

  it('[NFR-9] counts whole London calendar days, not 24-hour spans', () => {
    const now = new Date('2026-10-19T08:00:00Z');
    expect(daysFromToday('2026-10-19T22:59:00Z', now)).toBe(0); // 23:59 London, same day
    expect(daysFromToday('2026-10-19T23:30:00Z', now)).toBe(1); // 00:30 London, next day
    expect(daysFromToday('2026-10-17T12:00:00Z', now)).toBe(-2);
  });
});

describe('ship-by wording', () => {
  it('[NFR-9] counts overdue days in London calendar days', () => {
    const now = new Date('2026-10-19T10:00:00Z');
    expect(overdueText('2026-10-19T08:00:00Z', now)).toBe('Overdue today');
    expect(overdueText('2026-10-18T22:00:00Z', now)).toBe('Overdue 1 day');
    expect(overdueText('2026-10-10T09:00:00Z', now)).toBe('Overdue 9 days');
  });
});

describe('pagination', () => {
  it('[NFR-8] always shows the first and last page, and the pages next to the current one', () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(1, 10)).toEqual([1, 2, 'gap', 10]);
    expect(pageList(5, 10)).toEqual([1, 'gap', 4, 5, 6, 'gap', 10]);
    expect(pageList(10, 10)).toEqual([1, 'gap', 9, 10]);
    expect(pageList(3, 4)).toEqual([1, 2, 3, 4]);
  });
});
