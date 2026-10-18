// Requirement-ID coverage rules (docs/sessions/S3-builder.md §Coverage, ADR-027, invariant 24).
// Pure functions over file contents so the rules can be unit-tested; scripts/req-coverage.mjs
// reads the files and prints the report.

const ID = /^[A-Z]+-\d+$/;

/** Every bold `**XXX-n**` ID in the PRD (CAP-n included), plus AT-n for each item in §12.2. */
export function prdIds(prd) {
  const ids = new Set();
  for (const m of prd.matchAll(/\*\*([A-Z]+-\d+)\*\*/g)) ids.add(m[1]);

  const lines = prd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^###\s+12\.2\b/.test(l));
  if (start === -1) throw new Error('PRD §12.2 (acceptance tests) not found');
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    const item = /^(\d+)\.\s/.exec(line);
    if (item) ids.add(`AT-${item[1]}`);
  }
  return ids;
}

/** IDs listed in docs/plan/requirements-index.md as `- XXX-n — summary`. */
export function indexIds(index) {
  const ids = new Set();
  for (const m of index.matchAll(/^- ([A-Z]+-\d+) — /gm)) ids.add(m[1]);
  return ids;
}

/** Module → owned IDs from `### Mxx ...` headings and their `**Owns:**` lines in MODULES.md. */
export function moduleOwners(modules) {
  const owners = new Map(); // id -> [module, ...]
  const byModule = new Map(); // module -> Set(id)
  let current;
  for (const line of modules.split(/\r?\n/)) {
    const heading = /^###\s+(M\d+[a-z]?)\b/.exec(line);
    if (heading) {
      current = heading[1];
      continue;
    }
    const owns = /^- \*\*Owns:\*\*\s*(.*)$/.exec(line);
    if (!owns) continue;
    if (current === undefined) throw new Error('Owns: line before any module heading');
    const ids = owns[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => ID.test(s));
    const set = byModule.get(current) ?? new Set();
    for (const id of ids) {
      set.add(id);
      owners.set(id, [...(owners.get(id) ?? []), current]);
    }
    byModule.set(current, set);
  }
  const unmappedNone = /^Unmapped IDs: none\s*$/m.test(
    modules.trimEnd().split(/\r?\n/).pop() ?? '',
  );
  return { owners, byModule, unmappedNone };
}

/** `[ID]` citations in test titles: it/test/describe('...[ID] ...'), several per title allowed. */
export function testTitleIds(source) {
  const ids = new Set();
  const call = /\b(?:it|test|describe)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  for (const m of source.matchAll(call)) {
    for (const bracket of m[2].matchAll(/\[([A-Z]+-\d+(?:\s*,\s*[A-Z]+-\d+)*)\]/g)) {
      for (const id of bracket[1].split(',')) ids.add(id.trim());
    }
  }
  return ids;
}

/**
 * Applies the six rules. Inputs are file contents and parsed objects; returns counts and a list of
 * human-readable failures (empty when every rule holds).
 */
export function checkCoverage({ prd, index, modules, backlog, testIds }) {
  const failures = [];
  const fromPrd = prdIds(prd);
  const indexed = indexIds(index);
  const { owners, byModule, unmappedNone } = moduleOwners(modules);

  // Rule 1: index equals PRD.
  for (const id of fromPrd)
    if (!indexed.has(id)) failures.push(`rule 1: ${id} is in the PRD but not the index`);
  for (const id of indexed)
    if (!fromPrd.has(id)) failures.push(`rule 1: ${id} is in the index but not the PRD`);

  // Rule 2: exactly one owner per indexed ID, and MODULES.md ends with "Unmapped IDs: none".
  let owned = 0;
  let unmapped = 0;
  for (const id of indexed) {
    const mods = owners.get(id) ?? [];
    if (mods.length === 1) owned += 1;
    else if (mods.length === 0) {
      unmapped += 1;
      failures.push(`rule 2: ${id} has no owning module`);
    } else failures.push(`rule 2: ${id} is owned by ${mods.join(', ')}`);
  }
  for (const id of owners.keys())
    if (!indexed.has(id)) failures.push(`rule 2: ${id} is owned but not indexed`);
  if (!unmappedNone) failures.push('rule 2: MODULES.md does not end with "Unmapped IDs: none"');

  // Rule 3: prd_ids are owned by the task's module; supports cite indexed IDs.
  let outsideModule = 0;
  for (const task of backlog.tasks) {
    const mine = byModule.get(task.module) ?? new Set();
    for (const id of task.prd_ids) {
      if (!mine.has(id)) {
        outsideModule += 1;
        failures.push(`rule 3: ${task.id} prd_ids ${id} is not owned by ${task.module}`);
      }
    }
    for (const id of task.supports ?? []) {
      if (!indexed.has(id))
        failures.push(`rule 3: ${task.id} supports ${id}, which is not indexed`);
    }
  }

  // Rule 4: every ID owned by a module that has tasks appears in one of its tasks' prd_ids.
  const modulesWithTasks = new Set(backlog.tasks.map((t) => t.module));
  for (const mod of modulesWithTasks) {
    const covered = new Set(
      backlog.tasks.filter((t) => t.module === mod).flatMap((t) => t.prd_ids),
    );
    for (const id of byModule.get(mod) ?? []) {
      if (!covered.has(id)) failures.push(`rule 4: ${mod} owns ${id} but no ${mod} task lists it`);
    }
  }

  // Rule 5: done tasks have every prd_id cited by a test title.
  for (const task of backlog.tasks.filter((t) => t.status === 'done')) {
    for (const id of task.prd_ids) {
      if (!testIds.has(id))
        failures.push(`rule 5: ${task.id} is done but no test title cites [${id}]`);
    }
  }

  // Rule 6: tests cite indexed IDs only.
  for (const id of testIds)
    if (!indexed.has(id)) failures.push(`rule 6: a test cites [${id}], which is not indexed`);

  return { indexed: indexed.size, owned, unmapped, outsideModule, failures };
}
