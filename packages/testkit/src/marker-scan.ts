import pg from 'pg';
import type { RoleCluster } from './postgres.ts';

/** Synthetic PII carries this prefix, so any copy of it outside the vault can be found (AT-9). */
export const PII_MARKER = 'PIIMARK-';

/** One column of one table where the marker was found. */
export interface MarkerHit {
  table: string;
  column: string;
  rows: number;
}

/**
 * AT-9 harness (invariants 7 and 7a): searches every text, JSON and bytea column of the given
 * schemas of a db-main test cluster for the marker, as the cluster's superuser so row-level
 * security hides nothing. The default schemas are the app's own and pg-boss (job payloads and
 * results), so a pii value in a job, a job record or any business row is caught.
 */
export async function scanDatabaseForMarkers(
  cluster: RoleCluster,
  schemas: readonly string[] = ['app', 'pgboss'],
  marker = PII_MARKER,
): Promise<MarkerHit[]> {
  const c = cluster.container;
  const client = new pg.Client({
    host: c.getHost(),
    port: c.getPort(),
    database: cluster.database,
    user: c.getUsername(),
    password: c.getPassword(),
  });
  await client.connect();
  try {
    const columns = await client.query<{ s: string; t: string; c: string; type: string }>(
      `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.data_type AS type
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = ANY($1::text[]) AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'bytea', 'ARRAY')
        ORDER BY 1, 2, 3`,
      [schemas],
    );
    const hits: MarkerHit[] = [];
    for (const col of columns.rows) {
      const ident = `${pg.escapeIdentifier(col.s)}.${pg.escapeIdentifier(col.t)}`;
      const column = pg.escapeIdentifier(col.c);
      const test =
        col.type === 'bytea'
          ? `position(convert_to($1, 'UTF8') in ${column}) > 0`
          : `strpos(${column}::text, $1) > 0`;
      const res = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${ident} WHERE ${test}`,
        [marker],
      );
      const rows = Number(res.rows[0]?.n ?? '0');
      if (rows > 0) hits.push({ table: `${col.s}.${col.t}`, column: col.c, rows });
    }
    return hits;
  } finally {
    await client.end();
  }
}

/** The captured lines (logs, emails, export files) that hold the marker. */
export function scanTextForMarkers(lines: readonly string[], marker = PII_MARKER): string[] {
  return lines.filter((line) => line.includes(marker));
}
