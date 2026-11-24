import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/** Same image and digest as infra/compose/compose.yaml (a config test keeps the two equal). */
export const POSTGRES_IMAGE =
  'postgres:18.6@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface RoleCluster {
  container: StartedPostgreSqlContainer;
  database: string;
  /** Synthetic per-run passwords, keyed by role name. */
  passwords: Readonly<Record<string, string>>;
  connection(role: string): {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}

const CLOSE_WAIT_MS = 5000;

/** Waits until no client session is open, at most CLOSE_WAIT_MS. */
async function sessionsClosed(container: StartedPostgreSqlContainer): Promise<void> {
  const until = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < until) {
    const res = await container.exec([
      'psql',
      '-U',
      container.getUsername(),
      '-d',
      'postgres',
      '-Atc',
      `SELECT count(*) FROM pg_stat_activity
        WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`,
    ]);
    // Anything but a count (the server is already down): there is nothing to wait for.
    if (res.exitCode !== 0 || res.output.trim() === '0') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Every role whose password the cluster's roles script reads (`/run/secrets/<role>_password`). */
function scriptRoles(cluster: 'db-main' | 'db-pii'): string[] {
  const script = readFileSync(`${repoRoot}infra/compose/${cluster}/10-roles.sh`, 'utf8');
  return [...script.matchAll(/\/run\/secrets\/([a-z_]+)_password/g)].map((m) => m[1] ?? '');
}

/**
 * Starts PostgreSQL 18 with the real role init script from infra/compose/<cluster>/10-roles.sh,
 * fed with random synthetic secrets mounted the same way Docker secrets are. Every role the script
 * creates gets a password, so a test lists only the roles it connects as.
 */
export async function startRoleCluster(
  cluster: 'db-main' | 'db-pii',
  database: string,
  roles: readonly string[],
): Promise<RoleCluster> {
  const all = [...new Set([...scriptRoles(cluster), ...roles])];
  const passwords = Object.fromEntries(all.map((r) => [r, randomBytes(18).toString('hex')]));
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(database)
    .withCopyFilesToContainer([
      {
        source: `${repoRoot}infra/compose/${cluster}/10-roles.sh`,
        target: '/docker-entrypoint-initdb.d/10-roles.sh',
        mode: 0o755,
      },
    ])
    .withCopyContentToContainer(
      all.map((role) => ({
        content: passwords[role] ?? '',
        target: `/run/secrets/${role}_password`,
        mode: 0o444,
      })),
    )
    .start();

  // Stop only once closing sessions are gone. `pool.end()` resolves before its sockets close
  // (pg-pool), so a stop straight after it could end a session mid-close: an uncaught 57P01 that
  // fails a run whose tests all passed. A session still open after the wait is a real leak: the
  // stop ends it, and its error is reported as before.
  const stop = container.stop.bind(container);
  container.stop = async (options) => {
    await sessionsClosed(container);
    return stop(options);
  };

  return {
    container,
    database,
    passwords,
    connection(role: string) {
      const password = passwords[role];
      if (password === undefined) throw new Error(`Unknown role ${role}`);
      return {
        host: container.getHost(),
        port: container.getPort(),
        database,
        user: role,
        password,
      };
    },
  };
}
