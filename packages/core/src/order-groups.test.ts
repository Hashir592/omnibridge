import { describe, expect, it } from 'vitest';
import { GROUP_CAP, sameBuyerGroups, type GroupCandidate } from './order-groups.ts';

const at = (iso: string, id: string, matchClass = 'buyer-1'): GroupCandidate => ({
  id,
  placedAt: new Date(iso),
  matchClass,
});
const groups = (
  cands: GroupCandidate[],
  graceHours = 3,
  excluded?: (a: string, b: string) => boolean,
) => sameBuyerGroups(cands, { graceHours, ...(excluded === undefined ? {} : { excluded }) });

describe('same-buyer groups (ORD-9, C3.1)', () => {
  it('[AT-26] 23:59 and 00:01 London on one account form one group', () => {
    // 23:59 and 00:01 GMT in November: two London days, two minutes apart.
    expect(groups([at('2026-11-20T23:59:00Z', 'a'), at('2026-11-21T00:01:00Z', 'b')])).toEqual([
      ['a', 'b'],
    ]);
  });

  it('[AT-26] 23:30 BST and 00:30 on the night the clocks go back form one group', () => {
    // 25 Oct 2026: 23:30 BST on the 24th is 22:30Z; 00:30 GMT on the 25th is 00:30Z, two hours on.
    expect(groups([at('2026-10-24T22:30:00Z', 'a'), at('2026-10-25T00:30:00Z', 'b')])).toEqual([
      ['a', 'b'],
    ]);
  });

  it('[AT-26] 09:00 Monday and 09:00 Tuesday do not group; 10:00 and 22:00 the same day do', () => {
    expect(groups([at('2026-11-23T09:00:00Z', 'a'), at('2026-11-24T09:00:00Z', 'b')])).toEqual([]);
    expect(groups([at('2026-11-23T10:00:00Z', 'a'), at('2026-11-23T22:00:00Z', 'b')])).toEqual([
      ['a', 'b'],
    ]);
  });

  it('[AT-26] a different buyer or address (another match class) never groups', () => {
    expect(
      groups([at('2026-11-23T10:00:00Z', 'a', 'x'), at('2026-11-23T10:05:00Z', 'b', 'y')]),
    ).toEqual([]);
  });

  it('[ORD-9] linking is transitive: A, B and C chained make one group', () => {
    // A 22:00 Mon, B 00:30 Tue (2.5 h), C 18:00 Tue (same day as B): A and C alone would not link.
    const chain = [
      at('2026-11-23T22:00:00Z', 'a'),
      at('2026-11-24T00:30:00Z', 'b'),
      at('2026-11-24T18:00:00Z', 'c'),
    ];
    expect(groups(chain)).toEqual([['a', 'b', 'c']]);
    expect(groups([chain[0] as GroupCandidate, chain[2] as GroupCandidate])).toEqual([]);
  });

  it('[ORD-9] a dismissed or removed pair never links again', () => {
    const two = [at('2026-11-23T10:00:00Z', 'a'), at('2026-11-23T11:00:00Z', 'b')];
    expect(groups(two, 3, (x, y) => [x, y].sort().join() === 'a,b')).toEqual([]);
  });

  it('[ORD-9] a dismissed pair is not grouped again through a third order of the same buyer', () => {
    const three = [
      at('2026-11-23T10:00:00Z', 'a'),
      at('2026-11-23T11:00:00Z', 'b'),
      at('2026-11-23T12:00:00Z', 'c'),
    ];
    const dismissed = (x: string, y: string) => [x, y].sort().join() === 'a,b';
    const out = groups(three, 3, dismissed);
    expect(out.some((g) => g.includes('a') && g.includes('b'))).toBe(false);
    // C sits with its nearest neighbour, B.
    expect(out).toEqual([['b', 'c']]);
  });

  it('[ORD-9] the cap is 20: a 21st matching order starts a new group', () => {
    const many = Array.from({ length: GROUP_CAP + 2 }, (_, i) =>
      at(new Date(Date.UTC(2026, 10, 23, 8, i)).toISOString(), `o${String(i).padStart(2, '0')}`),
    );
    const out = groups(many);
    expect(out.map((g) => g.length)).toEqual([20, 2]);
  });

  it('[ORD-9] a group that would take a 21st order is reported once, by its first 20 (ADR-087)', () => {
    const many = Array.from({ length: GROUP_CAP + 3 }, (_, i) =>
      at(new Date(Date.UTC(2026, 10, 23, 8, i)).toISOString(), `o${String(i).padStart(2, '0')}`),
    );
    const full: string[][] = [];
    sameBuyerGroups(many, { graceHours: 3, onFull: (members) => full.push([...members]) });
    expect(full).toHaveLength(1);
    expect(full[0]).toHaveLength(20);
    expect(full[0]?.[0]).toBe('o00');
    // Exactly 20 is not full.
    const twenty = many.slice(0, GROUP_CAP);
    const none: string[][] = [];
    sameBuyerGroups(twenty, { graceHours: 3, onFull: (members) => none.push([...members]) });
    expect(none).toEqual([]);
  });
});
