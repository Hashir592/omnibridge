#!/usr/bin/env node
// Writes every message Mailpit holds, in full, to stdout for the AT-9 marker scan (T-0409,
// S5-20261118-03). The list endpoint gives only headers and a short snippet, so each message's
// raw source (headers and every body part) is fetched on its own. Usage:
//   node infra/backup/mailpit-raw.mjs http://127.0.0.1:8025 > mail.eml
// Exit 0: done (also when there is no mail). Exit 2: Mailpit could not be read.

const base = (process.argv[2] ?? 'http://127.0.0.1:8025').replace(/\/+$/, '');
const PAGE = 200;

async function get(path, as) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${String(res.status)}`);
  return as === 'json' ? res.json() : res.text();
}

try {
  let start = 0;
  let count = 0;
  for (;;) {
    const page = await get(`/api/v1/messages?start=${String(start)}&limit=${String(PAGE)}`, 'json');
    const ids = (page.messages ?? []).map((m) => m.ID);
    for (const id of ids) {
      const raw = await get(`/api/v1/message/${encodeURIComponent(id)}/raw`, 'text');
      process.stdout.write(`${raw}\n`);
      count += 1;
    }
    start += ids.length;
    if (ids.length < PAGE || start >= (page.messages_count ?? page.total ?? 0)) break;
  }
  console.error(`mailpit: ${String(count)} messages`);
} catch (err) {
  console.error(`mailpit: cannot read: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
