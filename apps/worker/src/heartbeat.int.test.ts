import { mkdtempSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateMain } from '@omnibridge/db';
import { createLogger } from '@omnibridge/logger';
import { HEARTBEAT_QUEUE } from '@omnibridge/queue';
import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerBoss, startHeartbeat } from './heartbeat.ts';

describe('worker heartbeat', () => {
  let cluster: RoleCluster;
  let boss: PgBoss;
  const errors: unknown[] = [];
  const lines: string[] = [];
  const healthFile = join(mkdtempSync(join(tmpdir(), 'ob-worker-')), 'heartbeat');

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', [
      'ob_owner',
      'ob_app',
      'ob_platform',
    ]);
    await migrateMain(cluster.connection('ob_owner'));
    boss = createWorkerBoss(cluster.connection('ob_app'));
    boss.on('error', (err) => errors.push(err));
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop({ graceful: false, close: true });
    await cluster.container.stop();
  });

  it('[NFR-1] the worker runs as ob_app and consumes the heartbeat job', async () => {
    const log = createLogger({
      service: 'worker-test',
      version: '0',
      destination: { write: (line: string) => lines.push(line) },
    });
    await startHeartbeat({ boss, log, healthFile });
    // Age the file, so only a heartbeat job (not startup) can make it fresh again.
    const stale = new Date(Date.now() - 3_600_000);
    utimesSync(healthFile, stale, stale);

    // The cron fires once a minute; send one job directly so the test does not wait for it.
    await boss.send(HEARTBEAT_QUEUE, null);
    await expect
      .poll(() => lines.some((l) => l.includes('"event":"heartbeat"')), { timeout: 30_000 })
      .toBe(true);

    await expect
      .poll(() => Date.now() - statSync(healthFile).mtimeMs, { timeout: 5_000 })
      .toBeLessThan(60_000);
    expect(errors).toEqual([]);
  });

  it('[NFR-1] the heartbeat is scheduled every minute in UTC', async () => {
    const schedules = await boss.getSchedules();
    expect(schedules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: HEARTBEAT_QUEUE, cron: '* * * * *', timezone: 'UTC' }),
      ]),
    );
  });
});
