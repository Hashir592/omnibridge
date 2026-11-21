import { startRoleCluster, type RoleCluster } from '@omnibridge/testkit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateMain } from './migrate.ts';

/**
 * F-M05e-02 (ADR-078 1, ARCHITECTURE 6.8): some tenant tables carry an owner policy opened by a
 * transaction setting (`app.platform_console`, `app.outbound_paused_list`). The app role can set
 * such a setting itself before calling a definer, so a definer that relied on RLS alone for its
 * workspace scope would then read every workspace. Every definer the app can call that reads one
 * of those tables must therefore be the setting's own reader (it sets the setting itself), a
 * console definer (`app.console_require`), or filter by workspace or user in its own body.
 */
describe('schema rules: definer scope (F-M05e-02) and money columns (FIN-1)', () => {
  let cluster: RoleCluster;
  let owner: pg.Pool;

  beforeAll(async () => {
    cluster = await startRoleCluster('db-main', 'omnibridge', ['ob_owner', 'ob_app']);
    await migrateMain(cluster.connection('ob_owner'));
    owner = new pg.Pool({ connectionString: cluster.container.getConnectionUri(), max: 1 });
  }, 300_000);

  afterAll(async () => {
    await owner.end();
    await cluster.container.stop();
  });

  it('[TEN-1][PLAT-3] every app-callable definer reading a setting-gated table filters its scope explicitly', async () => {
    const { rows: policies } = await owner.query<{ table: string; qual: string }>(
      `SELECT tablename AS table, qual FROM pg_policies
        WHERE schemaname = 'app' AND qual ~ 'current_setting'
          AND qual !~ 'app\\.(workspace_id|company_ids)'`,
    );
    const gates = new Map<string, Set<string>>();
    for (const p of policies) {
      for (const m of p.qual.matchAll(/current_setting\('(app\.[a-z_]+)'/g)) {
        const setting = m[1] ?? '';
        gates.set(p.table, (gates.get(p.table) ?? new Set()).add(setting));
      }
    }
    // The gated tables this test knows about: if a new one appears, it is checked too.
    expect([...gates.keys()].sort()).toEqual(
      expect.arrayContaining(['channel_accounts', 'memberships', 'outbound_writes', 'workspaces']),
    );

    const { rows: definers } = await owner.query<{ name: string; src: string }>(
      `SELECT p.proname AS name, p.prosrc AS src
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.prosecdef
          AND has_function_privilege('ob_app', p.oid, 'EXECUTE')`,
    );
    expect(definers.length).toBeGreaterThan(20);

    const explicitScope = /\b(workspace_id|user_id)\s*=|=\s*([a-z_]+\.)?(workspace_id|user_id)\b/;
    const offenders: string[] = [];
    for (const d of definers) {
      for (const [table, settings] of gates) {
        if (!new RegExp(`\\bapp\\.${table}\\b`).test(d.src)) continue;
        const ownReader = [...settings].some((s) => d.src.includes(`'${s}'`));
        const console = d.src.includes('app.console_require');
        if (!ownReader && !console && !explicitScope.test(d.src)) {
          offenders.push(`${d.name} reads app.${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('[FIN-1] no money column is a float: every *_pence column is bigint, and no float or numeric column exists outside the allowlist', async () => {
    const { rows } = await owner.query<{ table: string; column: string; type: string }>(
      `SELECT table_name AS table, column_name AS column, data_type AS type
         FROM information_schema.columns
        WHERE table_schema = 'app'`,
    );
    const pence = rows.filter((r) => r.column.endsWith('_pence'));
    expect(pence.length).toBeGreaterThan(0);
    expect(pence.filter((r) => r.type !== 'bigint')).toEqual([]);
    // Amazon's request rates are fractions of a second, never money (RL-1).
    const allowed = new Set([
      'amazon_rate_buckets.rate',
      'amazon_rate_buckets.burst',
      'amazon_rate_buckets.tokens',
    ]);
    const floats = rows.filter(
      (r) =>
        ['real', 'double precision', 'numeric'].includes(r.type) &&
        !allowed.has(`${r.table}.${r.column}`),
    );
    expect(floats).toEqual([]);
  });
});
