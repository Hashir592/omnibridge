import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function readRepoFile(path: string): string {
  return readFileSync(`${repoRoot}${path}`, 'utf8');
}

export interface ComposeService {
  image?: string;
  build?: unknown;
  command?: string[];
  environment?: Record<string, string | null>;
  secrets?: { source: string; target: string }[];
  networks?: Record<string, { aliases?: string[] } | null>;
  mem_limit?: string;
  cpus?: number;
  pids_limit?: number;
  profiles?: string[];
  ports?: { host_ip?: string; published?: string; target: number }[];
  volumes?: { type: string; source?: string; target: string }[];
}

export interface ComposeModel {
  name: string;
  services: Record<string, ComposeService>;
  networks: Record<string, { name?: string; internal?: boolean; external?: boolean }>;
  volumes?: Record<string, { external?: boolean }>;
  secrets?: Record<
    string,
    { name?: string; file?: string; environment?: string; external?: boolean }
  >;
}

let cached: ComposeModel | undefined;

/**
 * Docker work (the SOPS image, then `docker compose config`) takes seconds on a cold machine, so it
 * runs once per file in `beforeAll` with this timeout, never inside a test's 5 s budget (F-01).
 */
export const DOCKER_SETUP_TIMEOUT_MS = 120_000;

/** Builds the resolved dev stack (compose.yaml + compose.dev.yaml, every profile on). Call from beforeAll. */
export function loadComposeModel(): ComposeModel {
  if (cached) return cached;
  const secrets = spawnSync('bash', [`${repoRoot}scripts/dev-secrets.sh`], { encoding: 'utf8' });
  if (secrets.status !== 0) {
    throw new Error(
      `scripts/dev-secrets.sh failed (exit ${String(secrets.status)}): ${secrets.stderr}`,
    );
  }
  const json = execFileSync(
    'docker',
    [
      'compose',
      '-f',
      `${repoRoot}infra/compose/compose.yaml`,
      '-f',
      `${repoRoot}infra/compose/compose.dev.yaml`,
      'config',
      '--format',
      'json',
      '--no-interpolate',
    ],
    { encoding: 'utf8', env: { ...process.env, COMPOSE_PROFILES: '*' } },
  );
  cached = JSON.parse(json) as ComposeModel;
  return cached;
}

/** The model built by loadComposeModel() in the file's beforeAll. */
export function composeModel(): ComposeModel {
  if (!cached) throw new Error('Call loadComposeModel() in beforeAll before using composeModel()');
  return cached;
}

export function service(name: string): ComposeService {
  const svc = composeModel().services[name];
  if (!svc) throw new Error(`No compose service ${name}`);
  return svc;
}

export function networksOf(name: string): string[] {
  const model = composeModel();
  return Object.keys(service(name).networks ?? {}).map((n) => model.networks[n]?.name ?? n);
}

export function runScript(script: string, args: string[] = []) {
  const res = spawnSync('bash', [`${repoRoot}${script}`, ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
