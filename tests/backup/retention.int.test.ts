import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const DAY = 86_400_000;

/** restic's --time format, in UTC (the restic container runs in UTC). */
const resticTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

// A-004 (ADR-069): the auditor's proof was that --keep-daily 3 kept January db-pii snapshots
// after a gap in the nightly runs, because it counts days that have snapshots. DEL-2 needs an
// absolute limit: no db-pii copy older than 3 days by its own time, whatever the count.
describe('db-pii backup retention (A-004)', () => {
  it('[DEL-2] after a 40-day gap in backups no db-pii snapshot older than 3 days is left', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BACKUP_DIR: mkdtempSync(join(tmpdir(), 'ob-retention-')),
    };
    const bash = (script: string) => {
      const res = spawnSync('bash', ['-c', script], { cwd: repoRoot, env, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`${script}: ${res.stderr}`);
      return res.stdout;
    };
    const now = Date.now();
    bash('source infra/backup/lib.sh && restic_init main && restic_init pii');
    // Three nightly runs 45 to 43 days ago, then nothing for 40 days, then tonight's run.
    for (const daysAgo of [45, 44, 43, 0]) {
      env.SNAPSHOT_TIME = resticTime(new Date(now - daysAgo * DAY));
      bash(
        'source infra/backup/lib.sh && echo synthetic | restic_run pii backup --quiet ' +
          '--host omnibridge --tag db-pii --stdin --stdin-filename db-pii.dump --time "$SNAPSHOT_TIME"',
      );
    }

    expect(bash('infra/backup/retention.sh')).toContain('retention: done');

    const left = JSON.parse(
      bash('source infra/backup/lib.sh && restic_run pii snapshots --json --tag db-pii'),
    ) as { time: string }[];
    const ages = left.map((s) => (now - Date.parse(s.time.replace(/(\.\d{3})\d+/, '$1'))) / DAY);
    expect(ages).toHaveLength(1);
    expect(Math.max(...ages)).toBeLessThan(3);
  }, 300_000);
});
