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

/** The resolved dev stack (compose.yaml + compose.dev.yaml, every profile on). */
export function composeModel(): ComposeModel {
  if (cached) return cached;
  spawnSync('bash', [`${repoRoot}scripts/dev-secrets.sh`], { stdio: 'ignore' });
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
