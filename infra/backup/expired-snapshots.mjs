#!/usr/bin/env node
// Prints the id of every restic snapshot older than <days> by its own time, one per line
// (A-004, ADR-069). restic's --keep-daily counts days that have snapshots and --keep-within
// measures from the newest snapshot, so after a gap in nightly runs neither drops an old db-pii
// copy; retention.sh forgets these ids explicitly. Usage:
//   restic snapshots --json | node infra/backup/expired-snapshots.mjs 3
// Exit 0: done (also when none is expired). Exit 2: the input or the age is not valid.

import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;

/** restic writes nanoseconds; Date.parse wants at most milliseconds. */
function parseTime(value) {
  if (typeof value !== 'string') return Number.NaN;
  return Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
}

/** The ids of snapshots whose time is before now − days. Throws on bad input. */
export function expiredSnapshotIds(input, days, now = Date.now()) {
  // restic prints null, not [], when no snapshot matches.
  const snapshots = input === null ? [] : input;
  if (!Array.isArray(snapshots)) throw new Error('expected a JSON array of snapshots');
  if (!Number.isFinite(days) || days <= 0) throw new Error('expected a positive age in days');
  const cutoff = now - days * DAY_MS;
  return snapshots
    .filter((s) => {
      const at = parseTime(s?.time);
      if (Number.isNaN(at) || typeof s?.id !== 'string') {
        throw new Error('a snapshot has no valid id or time');
      }
      return at < cutoff;
    })
    .map((s) => s.id);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const ids = expiredSnapshotIds(
      JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]'),
      Number(process.argv[2]),
    );
    if (ids.length > 0) process.stdout.write(`${ids.join('\n')}\n`);
  } catch (err) {
    process.stderr.write(`expired-snapshots: ${err instanceof Error ? err.message : 'failed'}\n`);
    process.exit(2);
  }
}
