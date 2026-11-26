/** INT-8: every poll reads from the cursor minus this overlap. */
export const OVERLAP_MS = 5 * 60_000;
/** The overlap list is bounded (db-main 0037); past this the sink's upsert by external ID copes. */
const MAX_OVERLAP = 10_000;

type Pair = { readonly id: string; readonly at: string };

/**
 * Where a poll that stopped at the page cap goes on from: the same `since`, the next page (`''` for
 * the first), and the newest change read so far (the cursor moves there only once every page has
 * been read).
 */
export interface CursorResume {
  readonly since: string;
  readonly page: string;
  readonly maxAt: string | null;
}

/** One stream's cursor: the newest change seen, and the (id, updatedAt) pairs inside the overlap. */
export interface CursorState {
  readonly cursorAt: Date | null;
  readonly overlap: readonly Pair[];
  readonly resume?: CursorResume | null;
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

const key = (id: string, at: string) => `${id}|${at}`;

/** One item per ID, its latest change. */
function latestOf<T extends SyncItem>(items: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const item of items) {
    const prev = latest.get(item.externalId);
    if (prev === undefined || item.updatedAt > prev.updatedAt) latest.set(item.externalId, item);
  }
  return latest;
}

function withPairs(overlap: readonly Pair[], items: Iterable<SyncItem>): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const o of overlap) pairs.set(key(o.id, o.at), { id: o.id, at: o.at });
  for (const i of items) {
    const at = i.updatedAt.toISOString();
    pairs.set(key(i.externalId, at), { id: i.externalId, at });
  }
  return [...pairs.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
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
  const seen = new Set(state.overlap.map((o) => key(o.id, o.at)));
  const latest = latestOf(items);
  const fresh = [...latest.values()].filter(
    (i) => !seen.has(key(i.externalId, i.updatedAt.toISOString())),
  );
  let cursor = state.cursorAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  for (const i of latest.values()) cursor = Math.max(cursor, i.updatedAt.getTime());
  if (!Number.isFinite(cursor)) return { fresh, next: { cursorAt: null, overlap: state.overlap } };
  const floor = cursor - OVERLAP_MS;
  const overlap = withPairs(state.overlap, latest.values())
    .filter((o) => Date.parse(o.at) > floor)
    .slice(-MAX_OVERLAP);
  return { fresh, next: { cursorAt: new Date(cursor), overlap } };
}

/**
 * A run that stopped before all it had read was stored: the cursor and its page stay where they
 * were, so the same pages are read again, and what was stored is remembered, so none of it is
 * stored twice. Those pairs come last: the bound drops others first. A run that resumed nothing
 * keeps its own `since`, from the first page (`page: ''`): a first poll's start is worked out from
 * the clock, and the next run must not move it on.
 */
export function applyPart<T extends SyncItem>(
  state: CursorState,
  items: readonly T[],
  handled: readonly T[],
  since: Date,
): CursorState {
  const done = new Set(state.overlap.map((o) => key(o.id, o.at)));
  for (const i of handled) done.add(key(i.externalId, i.updatedAt.toISOString()));
  const ofRun = withPairs([], latestOf(items).values()).filter((o) => done.has(key(o.id, o.at)));
  const here = new Set(ofRun.map((o) => key(o.id, o.at)));
  const others = state.overlap.filter((o) => !here.has(key(o.id, o.at)));
  return {
    cursorAt: state.cursorAt,
    overlap: [...others, ...ofRun].slice(-MAX_OVERLAP),
    resume: state.resume ?? { since: since.toISOString(), page: '', maxAt: null },
  };
}

/**
 * One run's pages. When the run stopped at the page cap (`nextPage` set), the cursor stays where
 * it was and the run resumes from that page next time with the same `since`, so no unread page
 * is ever skipped; every change handled so far is remembered so none is handled twice. When the
 * last page was read, the cursor moves to the newest change of all those runs.
 */
export function applyRun<T extends SyncItem>(
  state: CursorState,
  items: readonly T[],
  run: { since: Date; nextPage: string | undefined },
): { fresh: T[]; next: CursorState } {
  const latest = latestOf(items);
  let maxAt = state.resume?.maxAt ?? null;
  for (const i of latest.values()) {
    const at = i.updatedAt.toISOString();
    if (maxAt === null || Date.parse(at) > Date.parse(maxAt)) maxAt = at;
  }
  if (run.nextPage !== undefined) {
    const seen = new Set(state.overlap.map((o) => key(o.id, o.at)));
    const fresh = [...latest.values()].filter(
      (i) => !seen.has(key(i.externalId, i.updatedAt.toISOString())),
    );
    return {
      fresh,
      next: {
        cursorAt: state.cursorAt,
        overlap: withPairs(state.overlap, latest.values()).slice(-MAX_OVERLAP),
        resume: { since: run.since.toISOString(), page: run.nextPage, maxAt },
      },
    };
  }
  const resumedAt = state.resume?.maxAt ?? null;
  const cursorAt =
    resumedAt !== null &&
    (state.cursorAt === null || Date.parse(resumedAt) > state.cursorAt.getTime())
      ? new Date(resumedAt)
      : state.cursorAt;
  const { fresh, next } = applyPoll({ cursorAt, overlap: state.overlap }, items);
  return { fresh, next: { ...next, resume: null } };
}
