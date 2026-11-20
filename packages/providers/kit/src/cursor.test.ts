import { describe, expect, it } from 'vitest';
import { applyPoll, OVERLAP_MS, pollSince, type CursorState } from './cursor.ts';

const at = (iso: string) => new Date(iso);
const item = (externalId: string, iso: string) => ({ externalId, updatedAt: at(iso) });

describe('incremental cursors (INT-8)', () => {
  it('[INT-8] reads from the cursor minus a 5-minute overlap; the first poll uses the lookback', () => {
    const now = at('2026-11-21T12:00:00.000Z');
    expect(OVERLAP_MS).toBe(300_000);
    expect(pollSince({ cursorAt: null, overlap: [] }, now, 86_400_000)).toEqual(
      at('2026-11-20T12:00:00.000Z'),
    );
    expect(pollSince({ cursorAt: at('2026-11-21T11:00:00.000Z'), overlap: [] }, now, 1)).toEqual(
      at('2026-11-21T10:55:00.000Z'),
    );
  });

  it('[INT-8] a re-poll inside the overlap creates no duplicate; a newer change of the same record comes through', () => {
    const first = applyPoll({ cursorAt: null, overlap: [] }, [
      item('A', '2026-11-21T10:58:00.000Z'),
      item('B', '2026-11-21T11:00:00.000Z'),
    ]);
    expect(first.fresh.map((i) => i.externalId)).toEqual(['A', 'B']);
    expect(first.next.cursorAt).toEqual(at('2026-11-21T11:00:00.000Z'));

    // The provider answers the overlap window again: A and B unchanged, C new.
    const second = applyPoll(first.next, [
      item('A', '2026-11-21T10:58:00.000Z'),
      item('B', '2026-11-21T11:00:00.000Z'),
      item('C', '2026-11-21T11:01:00.000Z'),
    ]);
    expect(second.fresh.map((i) => i.externalId)).toEqual(['C']);
    // A changed again: that change is new.
    const third = applyPoll(second.next, [
      item('B', '2026-11-21T11:00:00.000Z'),
      item('A', '2026-11-21T11:02:00.000Z'),
    ]);
    expect(third.fresh.map((i) => `${i.externalId}@${i.updatedAt.toISOString()}`)).toEqual([
      'A@2026-11-21T11:02:00.000Z',
    ]);
  });

  it('[INT-8] the same record twice in one answer (two pages) is handled once, as its latest change', () => {
    const out = applyPoll({ cursorAt: null, overlap: [] }, [
      item('A', '2026-11-21T11:00:00.000Z'),
      item('A', '2026-11-21T11:03:00.000Z'),
    ]);
    expect(out.fresh).toEqual([item('A', '2026-11-21T11:03:00.000Z')]);
  });

  it('[INT-8] the overlap keeps only the IDs inside the new window, and the cursor never moves back', () => {
    const state: CursorState = {
      cursorAt: at('2026-11-21T11:00:00.000Z'),
      overlap: [{ id: 'old', at: '2026-11-21T10:50:00.000Z' }],
    };
    const out = applyPoll(state, [item('late', '2026-11-21T10:57:00.000Z')]);
    expect(out.next.cursorAt).toEqual(at('2026-11-21T11:00:00.000Z'));
    expect(out.next.overlap).toEqual([{ id: 'late', at: '2026-11-21T10:57:00.000Z' }]);
    expect(applyPoll(out.next, []).next).toEqual(out.next);
  });
});
