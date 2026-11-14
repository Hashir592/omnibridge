/**
 * Same-buyer order groups for the T-0306 mock-ups (C3, ORD-9). PROPOSED SHAPE (mock only).
 * Follows docs/plan/client-changes-20261112.md C3.1 exactly: same channel account, exact match
 * of the normalised name and address (and eBay username), Awaiting dispatch and not FBA, placed
 * on the same London day or within the grace hours across midnight, linked transitively, at most
 * 20 per group. The real match runs inside pii-vault; here the scenario buyers stand in for it.
 */
import { formatDate } from '../lib/format.ts';
import { SCENARIO_BUYERS, type ScenarioBuyer } from './scenarios.ts';
import type { OrderRow } from './types.ts';

export const GROUP_GRACE_HOURS = 3; // workspace setting `group_midnight_grace_hours`
const MAX_GROUP = 20;

export interface OrderGroup {
  id: string;
  channelAccountId: string;
  memberIds: string[]; // placed time, oldest first
  warnings: string[];
}

/** Dismissed with "Not the same buyer": these orders are never grouped together again. */
const dismissed = new Map<string, string>(); // "orderA|orderB" pair → reason
/** Taken out of their group one at a time (Hashir, 14/11/2026): never grouped again. */
const removed = new Map<string, string>(); // order id → reason

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Stand-in for the vault's HMAC match key: the normalised fields joined (C3.1 rule 2). */
function matchKey(o: OrderRow, b: ScenarioBuyer): string {
  return [
    norm(b.name),
    ...b.lines.slice(0, 2).map(norm),
    norm(b.town),
    b.postcode.toUpperCase().replace(/\s+/g, ''),
    b.country.toUpperCase(),
    o.channel === 'ebay' ? (b.username ?? '').toLowerCase() : '',
  ].join('|');
}

const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' });
const dayNumber = (iso: string) =>
  Date.parse(`${londonDay.format(new Date(iso))}T00:00:00Z`) / 86_400_000;

/** Rule 4: same London day, or within the grace hours on adjacent London days. */
function linked(a: OrderRow, b: OrderRow): boolean {
  const da = dayNumber(a.placedAt);
  const db = dayNumber(b.placedAt);
  if (da === db) return true;
  const gapMs = Math.abs(Date.parse(a.placedAt) - Date.parse(b.placedAt));
  return Math.abs(da - db) === 1 && gapMs <= GROUP_GRACE_HOURS * 3_600_000;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function warningsFor(members: OrderRow[]): string[] {
  const out: string[] = [];
  const days = new Set(members.map((o) => dayNumber(o.shipBy)));
  if (days.size > 1) {
    const earliest = members.reduce((a, b) => (a.shipBy < b.shipBy ? a : b));
    out.push(`Ship by the earliest: ${formatDate(earliest.shipBy)}`);
  }
  if (new Set(members.map((o) => o.delivery)).size > 1) out.push('One order paid for Next Day');
  for (const o of members) {
    if (o.flags.includes('address_shortened')) out.push(`Address shortened on ${o.ref}`);
    if (o.flags.includes('unmapped')) out.push(`Unmapped item on ${o.ref}`);
  }
  return out;
}

/** Groups among the given orders (one company scope); orders outside a group are left out. */
export function computeGroups(rows: readonly OrderRow[]): OrderGroup[] {
  const candidates = rows.filter(
    (o) =>
      o.status === 'awaiting_dispatch' &&
      !o.flags.includes('fba') &&
      SCENARIO_BUYERS.has(o.id) &&
      !removed.has(o.id),
  );
  // Bucket by channel account and match key, then link by time (transitive, union-find).
  const buckets = new Map<string, OrderRow[]>();
  for (const o of candidates) {
    const b = SCENARIO_BUYERS.get(o.id);
    if (!b) continue;
    const k = `${o.channelAccountId}#${matchKey(o, b)}`;
    buckets.set(k, [...(buckets.get(k) ?? []), o]);
  }
  const groups: OrderGroup[] = [];
  for (const list of buckets.values()) {
    const sorted = [...list].sort((a, b) => a.placedAt.localeCompare(b.placedAt));
    const parent = sorted.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i] ?? i)));
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (a && b && linked(a, b) && !dismissed.has(pairKey(a.id, b.id)))
          parent[find(j)] = find(i);
      }
    const sets = new Map<number, OrderRow[]>();
    sorted.forEach((o, i) => {
      const root = find(i);
      sets.set(root, [...(sets.get(root) ?? []), o]);
    });
    for (const members of sets.values()) {
      for (let start = 0; start < members.length; start += MAX_GROUP) {
        const chunk = members.slice(start, start + MAX_GROUP);
        if (chunk.length < 2) continue;
        const ids = chunk.map((o) => o.id);
        groups.push({
          id: `grp_${ids[0] ?? ''}`,
          channelAccountId: chunk[0]?.channelAccountId ?? '',
          memberIds: ids,
          warnings: warningsFor(chunk),
        });
      }
    }
  }
  return groups;
}

/**
 * Takes one order out of its group, for example when it must go by another carrier. The rest stay
 * grouped if two or more are left. The real route writes the reason to the audit log.
 */
export function removeFromGroup(
  rows: readonly OrderRow[],
  groupId: string,
  orderId: string,
  reason: string,
): boolean {
  const g = computeGroups(rows).find((x) => x.id === groupId);
  if (!g?.memberIds.includes(orderId)) return false;
  removed.set(orderId, reason);
  return true;
}

/** "Not the same buyer": records the reason (the real route writes the audit log). */
export function dismissGroup(rows: readonly OrderRow[], groupId: string, reason: string): boolean {
  const g = computeGroups(rows).find((x) => x.id === groupId);
  if (!g) return false;
  for (const a of g.memberIds)
    for (const b of g.memberIds) if (a < b) dismissed.set(pairKey(a, b), reason);
  return true;
}
