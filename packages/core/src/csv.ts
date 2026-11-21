/**
 * A small CSV reader and writer for the catalogue's imports and exports (RFC 4180: commas,
 * double-quoted fields, doubled quotes inside them, CRLF or LF). No dependency: the files are a
 * few thousand rows of SKUs and costs.
 */

export interface CsvRow {
  /** 1-based line number in the file, for error reports. */
  line: number;
  cells: string[];
}

export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const records: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const endRecord = () => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0] === '')) records.push({ line: start, cells });
    cells = [];
    cell = '';
  };
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charAt(i);
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === '\n') line += 1;
        cell += c;
      }
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      start = line;
    } else {
      cell += c;
    }
  }
  if (quoted) throw new SyntaxError(`CSV line ${String(start)}: a quote is never closed`);
  if (cell !== '' || cells.length > 0) endRecord();
  const [first, ...rows] = records;
  return { header: (first?.cells ?? []).map((h) => h.trim().toLowerCase()), rows };
}

/** A cell a spreadsheet could run as a formula gets a leading quote (CSV injection). */
function safe(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((r) => r.map(safe).join(',')).join('\r\n') + '\r\n';
}
