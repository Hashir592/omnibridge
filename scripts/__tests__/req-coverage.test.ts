import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkCoverage,
  indexIds,
  moduleOwners,
  prdIds,
  testTitleIds,
} from '../lib/req-coverage-lib.mjs';

const prd = [
  '- **AAA-1** first',
  '- **AAA-2** second',
  '| **CAP-1** | capacity |',
  '### 12.2 Acceptance tests (each MUST pass)',
  '',
  '1. one',
  '2. two',
  '### 12.3 Next',
  '3. not an acceptance test',
].join('\n');

const index = ['- AAA-1 — a', '- AAA-2 — b', '- CAP-1 — c', '- AT-1 — d', '- AT-2 — e'].join('\n');

const modules = [
  '### M01 One',
  '- **Owns:** AAA-1, AAA-2, CAP-1',
  '### M02 Two',
  '- **Owns:** AT-1, AT-2',
  '',
  'Unmapped IDs: none',
].join('\n');

const task = (over: Record<string, unknown>) => ({
  id: 'T-1',
  module: 'M01',
  status: 'todo',
  prd_ids: ['AAA-1', 'AAA-2', 'CAP-1'],
  supports: [],
  ...over,
});

const base = { prd, index, modules, testIds: new Set<string>() };

describe('req-coverage rules', () => {
  it('[SEC-16] reads bold PRD IDs and the §12.2 acceptance list only', () => {
    expect([...prdIds(prd)].sort()).toEqual(['AAA-1', 'AAA-2', 'AT-1', 'AT-2', 'CAP-1']);
    expect(indexIds(index).size).toBe(5);
    expect(moduleOwners(modules).unmappedNone).toBe(true);
  });

  it('[SEC-16] passes a consistent plan', () => {
    const backlog = {
      tasks: [task({}), task({ id: 'T-2', module: 'M02', prd_ids: ['AT-1', 'AT-2'] })],
    };
    const result = checkCoverage({ ...base, backlog });
    expect(result).toMatchObject({
      indexed: 5,
      owned: 5,
      unmapped: 0,
      outsideModule: 0,
      failures: [],
    });
  });

  it('[SEC-16] rule 1 fails when the index and the PRD differ', () => {
    const result = checkCoverage({
      ...base,
      index: `${index}\n- ZZZ-9 — extra`,
      backlog: { tasks: [] },
    });
    expect(result.failures).toContain('rule 1: ZZZ-9 is in the index but not the PRD');
  });

  it('[SEC-16] rule 2 fails on a double owner or a missing "Unmapped IDs: none"', () => {
    const doubled = modules
      .replace('AT-1, AT-2', 'AT-1, AT-2, AAA-1')
      .replace('Unmapped IDs: none', '');
    const { failures } = checkCoverage({ ...base, modules: doubled, backlog: { tasks: [] } });
    expect(failures).toContain('rule 2: AAA-1 is owned by M01, M02');
    expect(failures).toContain('rule 2: MODULES.md does not end with "Unmapped IDs: none"');
  });

  it('[SEC-16] rule 3 flags a prd_id owned by another module', () => {
    const backlog = { tasks: [task({ prd_ids: ['AAA-1', 'AAA-2', 'CAP-1', 'AT-1'] })] };
    const result = checkCoverage({ ...base, backlog });
    expect(result.outsideModule).toBe(1);
    expect(result.failures).toContain('rule 3: T-1 prd_ids AT-1 is not owned by M01');
  });

  it('[SEC-16] rule 4 flags an owned ID that no task of the module lists', () => {
    const backlog = { tasks: [task({ prd_ids: ['AAA-1'] })] };
    const { failures } = checkCoverage({ ...base, backlog });
    expect(failures).toContain('rule 4: M01 owns AAA-2 but no M01 task lists it');
  });

  it('[SEC-16] rule 5 needs a test title for every ID of a done task', () => {
    const backlog = { tasks: [task({ status: 'done' })] };
    const { failures } = checkCoverage({ ...base, backlog, testIds: new Set(['AAA-1', 'CAP-1']) });
    expect(failures).toEqual(['rule 5: T-1 is done but no test title cites [AAA-2]']);
  });

  it('[SEC-16] rule 6 rejects a test citing an unknown ID', () => {
    const backlog = { tasks: [task({})] };
    const { failures } = checkCoverage({ ...base, backlog, testIds: new Set(['NOPE-1']) });
    expect(failures).toContain('rule 6: a test cites [NOPE-1], which is not indexed');
  });

  it('[SEC-16] extracts IDs from it, test and describe titles', () => {
    // The sample lives in a fixture so the real scan does not count its fake IDs.
    const source = readFileSync(
      fileURLToPath(new URL('../__fixtures__/test-titles.sample.txt', import.meta.url)),
      'utf8',
    );
    expect([...testTitleIds(source)].sort()).toEqual(['AAA-1', 'AAA-2', 'AT-1', 'AT-2', 'CAP-1']);
  });
});
