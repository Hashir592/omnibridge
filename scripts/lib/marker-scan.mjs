#!/usr/bin/env node
// The AT-9 marker scan (T-0405, DP-8, ARCHITECTURE invariant 7): synthetic PII carries the
// `PIIMARK-` marker, so any place it shows up outside the PII store is a leak. Scans the files
// given (and stdin for `-`): db-main dumps (job tables, results, idempotency records and webhook
// inboxes are tables in them), container logs, captured mail and export files.
//
// Prints the source and line number of each hit, never the line: in production a hit could be
// real PII. Exit 0: no hit. Exit 1: hits. Exit 2: a source could not be read.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const MARKER = 'PIIMARK-';

async function scan(source) {
  const input = source === '-' ? process.stdin : createReadStream(source);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const hits = [];
  let n = 0;
  for await (const line of lines) {
    n += 1;
    if (line.includes(MARKER)) hits.push(`${source === '-' ? 'stdin' : source}:${String(n)}`);
  }
  return hits;
}

const sources = process.argv.slice(2);
if (sources.length === 0) {
  console.error('usage: marker-scan.mjs <file|-> ...');
  process.exit(2);
}
const hits = [];
for (const source of sources) {
  try {
    hits.push(...(await scan(source)));
  } catch (err) {
    console.error(
      `marker scan: cannot read ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
}
for (const hit of hits) console.log(`PII marker at ${hit}`);
console.log(`marker scan: ${String(sources.length)} sources, ${String(hits.length)} hits`);
process.exit(hits.length === 0 ? 0 : 1);
