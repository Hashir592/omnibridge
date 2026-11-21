import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv.ts';

describe('CSV (CAT-4, CAT-5 imports and exports)', () => {
  it('[CAT-4] reads a header and rows, with quotes, commas, CRLF and a BOM', () => {
    const text =
      '﻿sku,cogs,effective_from\r\nA-1,12.34,01/02/2026\r\n"B,2","1,234.50",2026-02-01\n';
    expect(parseCsv(text)).toEqual({
      header: ['sku', 'cogs', 'effective_from'],
      rows: [
        { line: 2, cells: ['A-1', '12.34', '01/02/2026'] },
        { line: 3, cells: ['B,2', '1,234.50', '2026-02-01'] },
      ],
    });
  });

  it('[CAT-4] keeps escaped quotes and new lines inside quotes; skips blank lines', () => {
    const text = 'a,b\n"say ""hi""","line\nbreak"\n\n';
    expect(parseCsv(text).rows).toEqual([{ line: 2, cells: ['say "hi"', 'line\nbreak'] }]);
  });

  it('[CAT-5] an unclosed quote is an error, not a guess', () => {
    expect(() => parseCsv('a\n"open')).toThrow(/quote/);
  });

  it('[CAT-5] writes CSV that spreadsheets cannot run as a formula', () => {
    expect(
      toCsv(
        ['sku', 'title'],
        [
          ['A,1', 'say "hi"'],
          ['=HYPERLINK("x")', '+1'],
        ],
      ),
    ).toBe('sku,title\r\n"A,1","say ""hi"""\r\n"\'=HYPERLINK(""x"")",\'+1\r\n');
  });
});
