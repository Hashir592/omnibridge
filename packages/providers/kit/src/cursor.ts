/** INT-8: every poll reads from the cursor minus this overlap. */
export const OVERLAP_MS = 5 * 60_000;
/** The overlap list is bounded (db-main 0037); past this the sink's upsert by external ID copes. */
const MAX_OVERLAP = 10_000;

/** One stream's cursor: the newest change seen, and the (id, updatedAt) pairs inside the overlap. */
export interface CursorState {
  readonly cursorAt: Date | null;
  readonly overlap: readonly { readonly id: string; readonly at: string }[];
}

export interface SyncItem {
  readonly externalId: string;
  readonly updatedAt: Date;
}

/** Where the next poll starts: the cursor minus the overlap, or `lookbackMs` before now at first. */
export function pollSince(state: CursorState, now: Date, lookbackMs: number): Date {
  return state.cursorAt === null
    ? new Date(now.getTime() - lookbackMs)
    : new Date(state.cursorAt.getTime() - OVERLAP_MS);
}

/**
 * Drops the changes already handled (same ID and same updatedAt inside the overlap), keeps one
 * item per ID (its latest change), and works out the next cursor. Sinks still upsert by external
 * ID, so a change seen twice can never create a second record.
 */
export function applyPoll<T extends SyncItem>(
  state: CursorState,
  items: readonly T[],
): { fresh: T[]; next: CursorState } {
  const seen = new Set(state.overlap.map((o) => `${o.id}|${o.at}`));
  const latest = new Map<string, T>();
  for (const item of items) {
    const prev = latest.get(item.externalId);
    if (prev === undefined || item.updatedAt > prev.updatedAt) latest.set(item.externalId, item);
  }
  const fresh = [...latest.values()].filter(
    (i) => !seen.has(`${i.externalId}|${i.updatedAt.toISOString()}`),
  );
  let cursor = state.cursorAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  for (const i of latest.values()) cursor = Math.max(cursor, i.updatedAt.getTime());
  if (!Number.isFinite(cursor)) return { fresh, next: state };
  const floor = cursor - OVERLAP_MS;
  const pairs = new Map<string, { id: string; at: string }>();
  for (const o of state.overlap) pairs.set(`${o.id}|${o.at}`, { id: o.id, at: o.at });
  for (const i of latest.values()) {
    const at = i.updatedAt.toISOString();
    pairs.set(`${i.externalId}|${at}`, { id: i.externalId, at });
  }
  const overlap = [...pairs.values()]
    .filter((o) => Date.parse(o.at) > floor)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_OVERLAP);
  return { fresh, next: { cursorAt: new Date(cursor), overlap } };
}
