/**
 * The orders list query for the mock-ups: filters, views, same-buyer groups and paging.
 * PROPOSED SHAPE (mock only). T-0301 filters plus T-0306: SKU lines (C2), `placed=today` (C1
 * "View all") and same-buyer groups (C3): a group sorts as one unit by its earliest member, its
 * rows are adjacent, a page never splits it, and hidden members are counted.
 */
import { daysFromToday } from '../lib/format.ts';
import { orderSkus } from './detail.ts';
import { computeGroups, type OrderGroup } from './groups.ts';
import type { OrderCounts, OrderListItem, OrderPage, OrderRow } from './types.ts';

const SIZES = [20, 50, 100];

const isOverdue = (o: OrderRow, now: number) =>
  o.status === 'awaiting_dispatch' && Date.parse(o.shipBy) < now;
const isDueToday = (o: OrderRow, now: number) =>
  o.status === 'awaiting_dispatch' && !isOverdue(o, now) && daysFromToday(o.shipBy) === 0;
const isFlagged = (o: OrderRow) => o.flags.some((f) => f !== 'fba');

export function orderCounts(rows: readonly OrderRow[], now: number): OrderCounts {
  return {
    all: rows.length,
    awaiting: rows.filter((o) => o.status === 'awaiting_dispatch').length,
    overdue: rows.filter((o) => isOverdue(o, now)).length,
    dueToday: rows.filter((o) => isDueToday(o, now)).length,
    flagged: rows.filter(isFlagged).length,
  };
}

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

/** `base` is the user's permitted orders in the chosen company scope (invariant 4). */
export function orderPage(base: readonly OrderRow[], p: URLSearchParams): OrderPage {
  const now = Date.now();
  const view = p.get('view') ?? 'all';
  const q = (p.get('q') ?? '').trim().toLowerCase();
  const channels = list(p.get('channel'));
  const statuses = list(p.get('status'));
  const flags = list(p.get('flag'));
  const placedToday = p.get('placed') === 'today';
  const onlyGroup = p.get('group');

  // Groups are found on the whole scope, so a filter can hide members but never split a group.
  const groups = computeGroups(base);
  const groupOf = new Map<string, OrderGroup>();
  for (const g of groups) for (const id of g.memberIds) groupOf.set(id, g);

  let rows = base.filter((o) => {
    if (onlyGroup) return groupOf.get(o.id)?.id === onlyGroup;
    if (view === 'awaiting' && o.status !== 'awaiting_dispatch') return false;
    if (view === 'overdue' && !isOverdue(o, now)) return false;
    if (view === 'today' && !isDueToday(o, now)) return false;
    if (view === 'flagged' && !isFlagged(o)) return false;
    if (placedToday && daysFromToday(o.placedAt) !== 0) return false;
    if (channels.length && !channels.includes(o.channelAccountId)) return false;
    if (statuses.length && !statuses.includes(o.status)) return false;
    if (flags.length && !flags.some((f) => o.flags.includes(f as OrderRow['flags'][number])))
      return false;
    if (
      q &&
      !o.ref.toLowerCase().includes(q) &&
      !orderSkus(o).some((l) => l.sku.toLowerCase().includes(q))
    )
      return false;
    return true;
  });

  // Sort: by ship-by in the dispatch views, else newest first. A group takes the place of its
  // earliest member and lists its members oldest first.
  const byShipBy = view === 'awaiting' || view === 'overdue' || view === 'today';
  const keyOf = (o: OrderRow) => (byShipBy ? o.shipBy : o.placedAt);
  const visibleIds = new Set(rows.map((o) => o.id));
  const groupKey = new Map<string, string>();
  for (const g of groups) {
    const members = rows.filter((o) => g.memberIds.includes(o.id));
    if (members.length === 0) continue;
    const earliest = members.reduce((a, b) => (keyOf(a) < keyOf(b) ? a : b));
    groupKey.set(g.id, keyOf(earliest));
  }
  const sortKey = (o: OrderRow) => {
    const g = groupOf.get(o.id);
    return g ? (groupKey.get(g.id) ?? keyOf(o)) : keyOf(o);
  };
  rows = [...rows].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return byShipBy ? ka.localeCompare(kb) : kb.localeCompare(ka);
    const ga = groupOf.get(a.id)?.id ?? a.id;
    const gb = groupOf.get(b.id)?.id ?? b.id;
    if (ga !== gb) return ga.localeCompare(gb);
    return a.placedAt.localeCompare(b.placedAt);
  });

  // Paging: a page may run past `limit` to finish a group, and skips the tail of a group that
  // the previous page already finished.
  const limit = SIZES.includes(Number(p.get('limit'))) ? Number(p.get('limit')) : 50;
  const cursor = Number(p.get('cursor') ?? 0);
  const gid = (i: number) => {
    const o = rows[i];
    return o ? groupOf.get(o.id)?.id : undefined;
  };
  let start = cursor;
  while (
    start > 0 &&
    start < rows.length &&
    gid(start) !== undefined &&
    gid(start) === gid(start - 1)
  )
    start++;
  let end = Math.min(rows.length, cursor + limit);
  while (end < rows.length && gid(end) !== undefined && gid(end) === gid(end - 1)) end++;

  const page = rows.slice(start, end);
  const items: OrderListItem[] = page.map((o) => {
    const g = groupOf.get(o.id);
    const shown = g ? g.memberIds.filter((id) => visibleIds.has(id)) : [];
    return {
      ...o,
      skus: orderSkus(o),
      group: g
        ? {
            id: g.id,
            size: g.memberIds.length,
            index: shown.indexOf(o.id),
            last: shown[shown.length - 1] === o.id,
            hidden: g.memberIds.length - shown.length,
            warnings: g.warnings,
            memberRefs: g.memberIds.map((id) => base.find((x) => x.id === id)?.ref ?? id),
          }
        : null,
    };
  });

  return {
    items,
    nextCursor: end < rows.length ? end : null,
    total: rows.length,
    counts: orderCounts(base, now),
  };
}
