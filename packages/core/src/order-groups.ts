import { londonDate } from './time.ts';

/*
 * Same-buyer groups (ORD-9; docs/plan/client-changes-20261112.md C3.1). The vault says which
 * orders share a buyer and delivery address (its `match` capability, exact after normalising);
 * this decides which of them are shown together. Pure: no PII, IDs and placed times only.
 */

export interface GroupCandidate {
  id: string;
  /** The channel's placed time (C3.1 point 4), never the time OmniBridge received the order. */
  placedAt: Date;
  /** Orders with the same class share a vault match key (same buyer and address). */
  matchClass: string;
}

/** C3.1: at most this many orders in one group; a 21st starts a new group. */
export const GROUP_CAP = 20;

/**
 * Two orders link when they share a match class, are not a pair that was dismissed or removed,
 * and were placed on the same Europe/London day, or within `graceHours` of each other in real
 * elapsed time (UTC instants, so a clock change cannot stretch it; adjacent days by construction).
 */
export function ordersLink(
  a: GroupCandidate,
  b: GroupCandidate,
  graceHours: number,
  excluded: (a: string, b: string) => boolean,
): boolean {
  if (a.id === b.id || a.matchClass !== b.matchClass || excluded(a.id, b.id)) return false;
  if (londonDate(a.placedAt) === londonDate(b.placedAt)) return true;
  return Math.abs(a.placedAt.getTime() - b.placedAt.getTime()) <= graceHours * 3_600_000;
}

/**
 * The groups: linking is transitive (A–B and B–C make one group of three). Each group is sorted by
 * placed time and split every GROUP_CAP orders. Orders on their own are left out.
 */
export function sameBuyerGroups(
  candidates: readonly GroupCandidate[],
  options: { graceHours: number; excluded?: (a: string, b: string) => boolean; cap?: number },
): string[][] {
  const excluded = options.excluded ?? (() => false);
  const cap = options.cap ?? GROUP_CAP;
  const parent = new Map(candidates.map((c) => [c.id, c.id]));
  const members = new Map(candidates.map((c) => [c.id, [c.id]]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };
  /**
   * Merges two components unless that would put a dismissed or removed pair in one group: a pair
   * marked "never again" is never grouped through a third order either (C3.3, ADR-057).
   */
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const left = members.get(ra) ?? [];
    const right = members.get(rb) ?? [];
    if (left.some((x) => right.some((y) => excluded(x, y)))) return;
    parent.set(ra, rb);
    members.set(rb, [...right, ...left]);
    members.delete(ra);
  };
  // Closest pairs first, so a "never again" pair keeps each order with its nearest neighbour.
  const pairs: [GroupCandidate, GroupCandidate][] = [];
  const classes = new Map<string, GroupCandidate[]>();
  for (const c of candidates) classes.set(c.matchClass, [...(classes.get(c.matchClass) ?? []), c]);
  for (const same of classes.values()) {
    for (const [i, a] of same.entries()) {
      for (const b of same.slice(i + 1)) {
        if (ordersLink(a, b, options.graceHours, excluded)) pairs.push([a, b]);
      }
    }
  }
  pairs.sort(
    ([a, b], [c, d]) =>
      Math.abs(a.placedAt.getTime() - b.placedAt.getTime()) -
      Math.abs(c.placedAt.getTime() - d.placedAt.getTime()),
  );
  for (const [a, b] of pairs) union(a.id, b.id);
  const byRoot = new Map<string, GroupCandidate[]>();
  for (const c of candidates) byRoot.set(find(c.id), [...(byRoot.get(find(c.id)) ?? []), c]);
  const groups: string[][] = [];
  for (const component of byRoot.values()) {
    if (component.length < 2) continue;
    const sorted = [...component].sort(
      (x, y) => x.placedAt.getTime() - y.placedAt.getTime() || (x.id < y.id ? -1 : 1),
    );
    for (let k = 0; k < sorted.length; k += cap) {
      const chunk = sorted.slice(k, k + cap).map((c) => c.id);
      if (chunk.length >= 2) groups.push(chunk);
    }
  }
  // Earliest group first (by its first member's placed time), so a recompute hands an existing
  // group id to the part that keeps that group's earliest order.
  const placed = new Map(candidates.map((c) => [c.id, c.placedAt.getTime()]));
  return groups.sort(
    (x, y) =>
      (placed.get(x[0] ?? '') ?? 0) - (placed.get(y[0] ?? '') ?? 0) ||
      ((x[0] ?? '') < (y[0] ?? '') ? -1 : 1),
  );
}
