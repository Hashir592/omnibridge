import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const DAY = 86_400_000;

const run = (input: string, days = '3') =>
  spawnSync('node', ['infra/backup/expired-snapshots.mjs', days], {
    cwd: repoRoot,
    input,
    encoding: 'utf8',
  });

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

describe('expired db-pii snapshots (A-004)', () => {
  it('[DEL-2] lists every snapshot older than 3 days by its own time, whatever the count', () => {
    const snapshots = [
      { id: 'jan-1', time: at(45) },
      { id: 'jan-2', time: at(44).replace('Z', '123456Z') },
      { id: 'jan-3', time: at(43) },
      { id: 'fresh', time: at(0.5) },
    ];
    const res = run(JSON.stringify(snapshots));
    expect(res.status).toBe(0);
    expect(res.stdout.trim().split('\n')).toEqual(['jan-1', 'jan-2', 'jan-3']);
  });

  it('[DEL-2] prints nothing when every snapshot is recent, or when there is none', () => {
    const res = run(JSON.stringify([{ id: 'a', time: at(1) }]));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    // restic prints null, not [], when no snapshot matches.
    for (const empty of ['null', '[]', '']) {
      const none = run(empty);
      expect(none.status).toBe(0);
      expect(none.stdout).toBe('');
    }
  });

  it('[DEL-2] fails loudly on input it cannot read, so retention never skips a forget', () => {
    expect(run('not json').status).toBe(2);
    expect(run(JSON.stringify([{ id: 'a' }])).status).toBe(2);
    expect(run('[]', '0').status).toBe(2);
  });
});
