// Time-boxed audit exceptions (PS-026). An advisory is let through only while an entry naming
// it is unexpired; an expired entry lets nothing through, so the gate goes red again by itself.
import { readFileSync } from 'node:fs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function loadExceptions(path = new URL('./audit-exceptions.json', import.meta.url)) {
  const { exceptions } = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(exceptions))
    throw new Error('audit-exceptions: "exceptions" must be an array');
  for (const e of exceptions) {
    if (
      !Array.isArray(e.ids) ||
      e.ids.length === 0 ||
      !DATE.test(e.expires ?? '') ||
      !e.ref ||
      !e.reason
    ) {
      throw new Error(
        `audit-exceptions: entry for ${e.package ?? '?'} needs ids, expires, ref and reason`,
      );
    }
  }
  return exceptions;
}

/** The unexpired exception covering any of `ids`, or undefined. `today` is YYYY-MM-DD (UTC). */
export function activeException(exceptions, ids, today = new Date().toISOString().slice(0, 10)) {
  return exceptions.find((e) => e.expires >= today && ids.some((id) => e.ids.includes(id)));
}
