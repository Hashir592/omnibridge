import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKekLine, parseKeyring } from '@omnibridge/crypto';
import { createLogger } from '@omnibridge/logger';
import { PII_MARKER, startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import { VaultClient, VaultError } from '@omnibridge/vault-client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestVault, type TestVault } from './testing.ts';

// T-0405: a backup taken before a deletion, restored, then put right by re-applying every
// tombstone (db-pii's own, db-main's copy and the off-site journal) and re-running expiry,
// exactly as the restore drill does with infra/backup/apply-tombstones.sql (AT-8, DEL-2).

const SQL = readFileSync(
  new URL('../../../infra/backup/apply-tombstones.sql', import.meta.url),
  'utf8',
);
/** psql runs the file statement by statement; here the part after this line runs on its own. */
const VACUUM_SPLIT = '-- Outside the transaction: VACUUM cannot run inside one (invariant 10).';
const DAY = 86_400_000;

describe('restore with tombstones re-applied [AT-8][DEL-2]', () => {
  let cluster: RoleCluster;
  let vault: TestVault;
  let clock = new Date('2026-11-18T09:00:00.000Z');
  const journalDir = mkdtempSync(join(tmpdir(), 'ob-journal-'));
  const clients = {} as Record<'web' | 'worker' | 'deletion', VaultClient>;
  const keyring = parseKeyring('pii', generateKekLine(1));
  const A = randomUUID();
  const C = randomUUID();

  const ingest = async (workspace: string, subject: string, deleteAfter?: Date) =>
    (
      await clients.worker.ingest({
        workspace_id: workspace,
        kind: 'buyer_contact',
        subject_type: 'order',
        subject_id: subject,
        ...(deleteAfter === undefined ? {} : { delete_after: deleteAfter.toISOString() }),
        fields: { name: `${PII_MARKER}${subject}`, postcode: 'RE1 1ST' },
      })
    ).pii_ref;
  const sh = async (cmd: string) => {
    const res = await cluster.container.exec(['sh', '-c', cmd]);
    if (res.exitCode !== 0) throw new Error(`${cmd}: ${res.output}`);
    return res.output;
  };
  const superuser = (database: string) => {
    const uri = new URL(cluster.container.getConnectionUri());
    uri.pathname = `/${database}`;
    return new pg.Client({ connectionString: uri.toString() });
  };
  /** What the drill does: load the journal and db-main's tombstones, then run the SQL file. */
  const replay = async (
    database: string,
    mainTombstones: { workspace_id: string; pii_ref: string; run_id: string }[] = [],
    journal = journalDir,
  ) => {
    const c = superuser(database);
    await c.connect();
    try {
      await c.query('CREATE TEMP TABLE replay_journal (line text)');
      await c.query(
        `CREATE TEMP TABLE replay_main (workspace_id uuid, pii_ref uuid, run_id uuid,
                                        channel_account_id uuid, deleted_at timestamptz)`,
      );
      // A restic restore nests the files under /journal, so look in every folder.
      const lines = readdirSync(journal, { recursive: true, withFileTypes: true })
        .filter((f) => f.isFile() && /^tombstones-.*\.jsonl$/.test(f.name))
        .flatMap((f) => readFileSync(join(f.parentPath, f.name), 'utf8').split('\n'))
        .filter((l) => l !== '');
      for (const line of lines) await c.query('INSERT INTO replay_journal VALUES ($1)', [line]);
      for (const t of mainTombstones) {
        await c.query(`INSERT INTO replay_main VALUES ($1, $2, $3, NULL, now())`, [
          t.workspace_id,
          t.pii_ref,
          t.run_id,
        ]);
      }
      await c.query(`SET restore.now = '${clock.toISOString()}'`);
      const [inTx, vacuum] = SQL.split(VACUUM_SPLIT);
      await c.query(inTx ?? '');
      for (const stmt of (vacuum ?? '').split(';').map((s) => s.trim())) {
        if (stmt !== '' && !stmt.startsWith('--')) await c.query(stmt);
      }
    } finally {
      await c.end();
    }
  };
  const rows = async (database: string, workspace: string, sql: string) => {
    const c = superuser(database);
    await c.connect();
    try {
      return (await c.query(sql, [workspace])).rows as Record<string, unknown>[];
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    cluster = await startRoleCluster('db-pii', 'omnibridge_pii', ['vault_owner', 'vault_app']);
    vault = await startTestVault({
      owner: cluster.connection('vault_owner'),
      app: cluster.connection('vault_app'),
      logger: createLogger({
        service: 'pii-vault',
        version: 'test',
        destination: { write: () => true },
      }),
      journalDir,
      now: () => clock,
      keyring,
    });
    for (const caller of ['web', 'worker', 'deletion'] as const) {
      clients[caller] = new VaultClient({ baseUrl: vault.baseUrl, token: vault.tokens[caller] });
    }
  }, 300_000);

  afterAll(async () => {
    await vault.close();
    await cluster.container.stop();
  });

  it('[AT-8] a backup from before a deletion, restored and replayed, shows the deleted records gone', async () => {
    const keep = await ingest(A, 'keep');
    const erased = await ingest(A, 'erased');
    const fromMain = await ingest(A, 'main-only');
    const expiring = await ingest(A, 'expiring', new Date(clock.getTime() + 25 * DAY));
    await ingest(C, 'closing');
    const user = cluster.container.getUsername();
    await sh(`pg_dump -U ${user} -Fc -f /tmp/before.dump omnibridge_pii`);

    // After the backup: an erasure, a workspace closure.
    await clients.deletion.delete({
      workspace_id: A,
      run_id: randomUUID(),
      trigger: 'erasure',
      scope: { type: 'refs', pii_refs: [erased] },
    });
    await clients.deletion.delete({
      workspace_id: C,
      run_id: randomUUID(),
      trigger: 'workspace_closure',
      scope: { type: 'workspace' },
    });

    // The restore brings them back...
    await sh(`createdb -U ${user} restored && pg_restore -U ${user} -d restored /tmp/before.dump`);
    const back = await rows(
      'restored',
      A,
      'SELECT pii_ref FROM vault.records WHERE workspace_id = $1',
    );
    expect(back.map((r) => r.pii_ref)).toEqual(expect.arrayContaining([keep, erased, fromMain]));

    // ...until the tombstones are re-applied, 26 days on (expiry re-runs too, FA-21).
    clock = new Date(clock.getTime() + 26 * DAY);
    await replay('restored', [{ workspace_id: A, pii_ref: fromMain, run_id: randomUUID() }]);
    const left = await rows(
      'restored',
      A,
      'SELECT pii_ref FROM vault.records WHERE workspace_id = $1 AND NOT canary',
    );
    expect(left.map((r) => r.pii_ref)).toEqual([keep]);
    for (const gone of [erased, fromMain, expiring]) {
      expect(
        await rows(
          'restored',
          A,
          `SELECT 1 FROM vault.record_fields WHERE pii_ref = '${gone}' AND workspace_id = $1`,
        ),
      ).toEqual([]);
    }
    // The closed workspace: no record, no key, no directory row; the marker is back.
    expect(
      await rows('restored', C, 'SELECT 1 FROM vault.records WHERE workspace_id = $1'),
    ).toEqual([]);
    expect(
      await rows('restored', C, 'SELECT 1 FROM vault.workspace_keys WHERE workspace_id = $1'),
    ).toEqual([]);
    expect(
      await rows('restored', C, 'SELECT 1 FROM vault.workspace_directory WHERE workspace_id = $1'),
    ).toEqual([]);
    expect(
      await rows('restored', C, 'SELECT 1 FROM vault.closed_workspaces WHERE workspace_id = $1'),
    ).toHaveLength(1);
    // Every ref deleted is tombstoned in the restored copy, so a second replay changes nothing.
    await replay('restored');
    expect(
      (
        await rows(
          'restored',
          A,
          'SELECT pii_ref FROM vault.records WHERE workspace_id = $1 AND NOT canary',
        )
      ).map((r) => r.pii_ref),
    ).toEqual([keep]);
    // A plain dump of the restored store holds ciphertext only: no marker in it (AT-9).
    const plain = await sh(`pg_dump -U ${user} restored`);
    expect(plain).not.toContain(PII_MARKER);
  });

  it('[AT-8][DEL-2] a deletion made after the nightly backup stays deleted after a full restore: the 15-minute journal run ships it (S5-20261118-01)', async () => {
    const user = cluster.container.getUsername();
    const backupDir = mkdtempSync(join(tmpdir(), 'ob-restic-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BACKUP_DIR: backupDir,
      JOURNAL_VOLUME: journalDir,
    };
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const bash = (script: string) => {
      const res = spawnSync('bash', ['-c', script], { cwd: repoRoot, env, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`${script}: ${res.stderr}`);
      return res.stdout;
    };
    const keep = await ingest(A, 'day-keep');
    const erased = await ingest(A, 'day-erased');

    // The nightly run: the db-pii dump and the journal as it stood then.
    await sh(`pg_dump -U ${user} -Fc -f /tmp/nightly.dump omnibridge_pii`);
    bash('infra/backup/journal.sh');

    // 14:00: an erasure. 14:15: the journal-only run ships its tombstone off-site.
    await clients.deletion.delete({
      workspace_id: A,
      run_id: randomUUID(),
      trigger: 'erasure',
      scope: { type: 'refs', pii_refs: [erased] },
    });
    expect(bash('infra/backup/journal.sh')).toContain('journal: backed up');

    // 18:00: the host is lost. Only last night's dump and the off-site journal are left; db-main
    // comes from the same nightly run, so it holds no tombstone of this deletion.
    await sh(`createdb -U ${user} lost && pg_restore -U ${user} -d lost /tmp/nightly.dump`);
    const restored = await rows(
      'lost',
      A,
      'SELECT pii_ref FROM vault.records WHERE workspace_id = $1',
    );
    expect(restored.map((r) => r.pii_ref)).toEqual(expect.arrayContaining([keep, erased]));
    const offsite = mkdtempSync(join(tmpdir(), 'ob-offsite-'));
    env.OFFSITE = offsite;
    bash('source infra/backup/lib.sh && journal_restore "$OFFSITE"');
    await replay('lost', [], offsite);

    const left = await rows(
      'lost',
      A,
      'SELECT pii_ref FROM vault.records WHERE workspace_id = $1 AND NOT canary',
    );
    expect(left.map((r) => r.pii_ref)).toContain(keep);
    expect(left.map((r) => r.pii_ref)).not.toContain(erased);
    expect(
      await rows(
        'lost',
        A,
        `SELECT 1 FROM vault.record_fields WHERE pii_ref = '${erased}' AND workspace_id = $1`,
      ),
    ).toEqual([]);
  }, 300_000);
  it('[DEL-1][AT-10] a backup older than an eBay notice, restored and replayed, still refuses the buyer', async () => {
    const user = cluster.container.getUsername();
    const tag = randomUUID().slice(0, 8);
    const recent = `PIIMARK-restored-${tag}`;
    const name = `PIIMARK-restored-name-${tag}`;
    const old = `PIIMARK-restored-old-${tag}`;
    const today = clock;
    await sh(`pg_dump -U ${user} -Fc -f /tmp/notice.dump omnibridge_pii`);
    // After the backup: one notice long ago, then one user twice, then its username.
    clock = new Date(today.getTime() - 181 * DAY);
    await clients.web.ebayUserMatch({ user_id: old });
    clock = new Date(today.getTime() - 20 * DAY);
    await clients.web.ebayUserMatch({ username: name });
    clock = new Date(today.getTime() - 10 * DAY);
    await clients.web.ebayUserMatch({ user_id: recent });
    await clients.web.ebayUserMatch({ username: name });
    clock = today;

    await sh(
      `createdb -U ${user} restored_notice && pg_restore -U ${user} -d restored_notice /tmp/notice.dump`,
    );
    await replay('restored_notice');
    await replay('restored_notice');
    const entries = await rows(
      'restored_notice',
      randomUUID(),
      `SELECT field, noticed_at FROM vault.ebay_deleted_buyers WHERE $1::uuid IS NOT NULL
        ORDER BY field`,
    );
    // Both fields once each; the old one is past its 180 days; the newest date wins.
    expect(entries.map((e) => [e.field, (e.noticed_at as Date).getTime()])).toEqual([
      ['ebay_user_id', today.getTime() - 10 * DAY],
      ['ebay_username', today.getTime() - 10 * DAY],
    ]);
    const restored = await startTestVault({
      owner: { ...cluster.connection('vault_owner'), database: 'restored_notice' },
      app: { ...cluster.connection('vault_app'), database: 'restored_notice' },
      logger: createLogger({
        service: 'pii-vault',
        version: 'test',
        destination: { write: () => true },
      }),
      journalDir: mkdtempSync(join(tmpdir(), 'ob-journal-')),
      now: () => clock,
      keyring,
    });
    try {
      const worker = new VaultClient({ baseUrl: restored.baseUrl, token: restored.tokens.worker });
      const store = (fields: Record<string, string>, placedAt: Date) =>
        worker
          .ingest({
            workspace_id: randomUUID(),
            kind: 'buyer_contact',
            subject_type: 'order',
            subject_id: randomUUID(),
            placed_at: placedAt.toISOString(),
            fields: { name: `${PII_MARKER}back`, ...fields },
          })
          .then(
            () => 'stored',
            (e: unknown) => (e instanceof VaultError ? e.code : 'error'),
          );
      expect(await store({ channel_buyer_id: recent }, today)).toBe('buyer_deleted');
      const before = new Date(today.getTime() - 15 * DAY);
      expect(await store({ channel_username: name }, before)).toBe('buyer_deleted');
      expect(await store({ channel_username: name }, today)).toBe('stored');
    } finally {
      await restored.close();
    }
  }, 300_000);

  it('[DEL-1][AT-8] of several journalled dates for one record the newest line wins, wherever it stands in the files', async () => {
    const user = cluster.container.getUsername();
    const refs = [await ingest(A, 'newest-1'), await ingest(A, 'newest-2')];
    await sh(`pg_dump -U ${user} -Fc -f /tmp/newest.dump omnibridge_pii`);
    const at = (minutes: number) => new Date(clock.getTime() + minutes * 60_000).toISOString();
    const until = (days: number) => new Date(clock.getTime() + days * DAY).toISOString();
    const entry = (ref: string, minute: number, days: number) =>
      JSON.stringify({
        type: 'expiry',
        workspace_id: A,
        pii_ref: ref,
        delete_after: until(days),
        reason: 'dispatch',
        at: at(minute),
      });
    const dir = mkdtempSync(join(tmpdir(), 'ob-newest-'));
    // Newest first for one, last for the other, across two files.
    writeFileSync(
      join(dir, 'tombstones-2026-01-01.jsonl'),
      [entry(refs[0] ?? '', 30, 40), entry(refs[1] ?? '', 10, 70)].join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'tombstones-2026-01-02.jsonl'),
      [entry(refs[0] ?? '', 20, 60), entry(refs[1] ?? '', 40, 45)].join('\n') + '\n',
    );
    await sh(
      `createdb -U ${user} restored_newest && pg_restore -U ${user} -d restored_newest /tmp/newest.dump`,
    );
    await replay('restored_newest', [], dir);
    const dates = await rows(
      'restored_newest',
      A,
      `SELECT pii_ref, delete_after FROM vault.records
        WHERE workspace_id = $1 AND pii_ref IN ('${refs.join("','")}') ORDER BY pii_ref`,
    );
    expect(
      Object.fromEntries(dates.map((d) => [d.pii_ref, (d.delete_after as Date).toISOString()])),
    ).toEqual({ [refs[0] ?? '']: until(40), [refs[1] ?? '']: until(45) });
  });

  it('[DEL-1][AT-8] an expiry shortened after the backup is re-applied by the restore, so the copy goes on time (ADR-068)', async () => {
    const W = randomUUID();
    // Stored with the 90-day backstop; the backup holds that date.
    const shortened = await ingest(W, 'shortened');
    const untouched = await ingest(W, 'untouched');
    const user = cluster.container.getUsername();
    await sh(`pg_dump -U ${user} -Fc -f /tmp/expiry.dump omnibridge_pii`);

    // After the backup the order is dispatched: the live copy now goes 25 days on (journalled).
    await clients.worker.setExpiry({
      workspace_id: W,
      pii_refs: [shortened],
      delete_after: new Date(clock.getTime() + 25 * DAY).toISOString(),
      reason: 'dispatch',
    });

    await sh(
      `createdb -U ${user} restored_expiry && pg_restore -U ${user} -d restored_expiry /tmp/expiry.dump`,
    );
    clock = new Date(clock.getTime() + 26 * DAY);
    await replay('restored_expiry');
    const left = await rows(
      'restored_expiry',
      W,
      'SELECT pii_ref FROM vault.records WHERE workspace_id = $1 AND NOT canary',
    );
    expect(left.map((r) => r.pii_ref)).toEqual([untouched]);
    expect(
      await rows(
        'restored_expiry',
        W,
        `SELECT 1 FROM vault.tombstones WHERE workspace_id = $1 AND pii_ref = '${shortened}'`,
      ),
    ).toHaveLength(1);
  });
});
