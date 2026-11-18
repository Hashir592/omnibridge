import { POSTGRES_IMAGE } from '@omnibridge/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  composeModel,
  DOCKER_SETUP_TIMEOUT_MS,
  loadComposeModel,
  networksOf,
  readRepoFile,
  runScript,
  service,
} from './helpers.ts';

// Docker runs once here, outside every test's timeout (F-M01-halfway-01).
let unlimited: ReturnType<typeof runScript>;
let realStack: ReturnType<typeof runScript>;
beforeAll(() => {
  loadComposeModel();
  unlimited = runScript('scripts/check-limits.sh', ['scripts/__fixtures__/unlimited.compose.yaml']);
  realStack = runScript('scripts/check-limits.sh');
}, DOCKER_SETUP_TIMEOUT_MS);

describe('compose stack: limits (OPS-10)', () => {
  it('[OPS-10] check-limits rejects unlimited service', () => {
    const res = unlimited;
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('unlimited: no mem_limit');
    expect(res.stderr).toContain('unlimited: no cpus limit');
    expect(res.stderr).toContain('unlimited: no pids_limit');
    expect(res.stderr).toContain('no-health: no healthcheck');
  });

  it('[OPS-10] check-limits accepts the real stack', () => {
    const res = realStack;
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
  });

  it('[OPS-10] service limits match the "today" budget in ARCHITECTURE.md §7', () => {
    const budget: Record<string, [string, number]> = {
      web: ['384m', 1.0],
      worker: ['512m', 1.0],
      'pii-vault': ['96m', 0.25],
      'db-main': ['1536m', 1.5],
      'db-pii': ['256m', 0.5],
      site: ['24m', 0.1],
      'migrate-main': ['192m', 0.5],
      'migrate-pii': ['192m', 0.5],
    };
    for (const [name, [mem, cpus]] of Object.entries(budget)) {
      expect({ name, mem: service(name).mem_limit, cpus: service(name).cpus }).toEqual({
        name,
        mem,
        cpus,
      });
    }
  });

  it('[OPS-10] PostgreSQL settings match ARCHITECTURE.md §7', () => {
    const settings = (name: string) =>
      Object.fromEntries(
        (service(name).command ?? [])
          .filter((arg) => arg.includes('='))
          .map((arg) => arg.split('=') as [string, string]),
      );
    expect(settings('db-main')).toMatchObject({
      shared_buffers: '384MB',
      effective_cache_size: '1GB',
      work_mem: '8MB',
      maintenance_work_mem: '96MB',
      max_connections: '45',
      random_page_cost: '1.1',
      effective_io_concurrency: '200',
      max_wal_size: '1GB',
    });
    expect(settings('db-pii')).toMatchObject({
      shared_buffers: '64MB',
      effective_cache_size: '160MB',
      work_mem: '4MB',
      maintenance_work_mem: '32MB',
      max_connections: '15',
    });
  });

  it('[OPS-10] every login role has a connection cap, and the caps sum to at most max_connections minus 5', () => {
    // FA-22, ADR-064: 3 superuser slots plus room for the deploy overlap, the exporter and backups.
    const HEADROOM = 5;
    for (const cluster of ['db-main', 'db-pii'] as const) {
      const maxArg = (service(cluster).command ?? []).find((arg) =>
        arg.startsWith('max_connections='),
      );
      const max = Number(maxArg?.split('=')[1]);
      expect(max).toBeGreaterThan(HEADROOM);
      const script = readRepoFile(`infra/compose/${cluster}/10-roles.sh`);
      const logins = [...script.matchAll(/CREATE ROLE (\w+) LOGIN[^;]*;/g)].map((m) => ({
        role: m[1],
        cap: /CONNECTION LIMIT (\d+)/.exec(m[0])?.[1],
      }));
      expect(logins.length).toBeGreaterThan(1);
      expect(logins.filter((l) => l.cap === undefined)).toEqual([]);
      const total = logins.reduce((sum, l) => sum + Number(l.cap), 0);
      expect({ cluster, total, fits: total <= max - HEADROOM }).toEqual({
        cluster,
        total,
        fits: true,
      });
    }
  });

  it('[OPS-10] the KEK re-wrap job is opt-in through the ops profile and exits when done', () => {
    expect(service('rewrap-keys').profiles).toEqual(['ops']);
    expect(service('rewrap-keys').restart).toBe('no');
  });

  it('[OPS-10] clamd is opt-in through the scan profile', () => {
    expect(service('clamd').profiles).toEqual(['scan']);
  });
});

describe('compose stack: isolation (NFR-1, NFR-2, OPS-7, OPS-8, OPS-9)', () => {
  it('[NFR-1] web and worker run as separate containers from separate images', () => {
    expect(service('web').image).toBe('omnibridge/web:dev');
    expect(service('worker').image).toBe('omnibridge/worker:dev');
  });

  it('[NFR-2] db-main and db-pii are separate clusters; only the vault reaches db-pii', () => {
    expect(networksOf('db-main')).toEqual(['ob_db']);
    expect(networksOf('db-pii')).toEqual(['ob_pii']);
    const onPii = Object.keys(composeModel().services).filter((s) =>
      networksOf(s).includes('ob_pii'),
    );
    expect(onPii.sort()).toEqual(['db-pii', 'migrate-pii', 'pii-vault']);
    expect(networksOf('web')).not.toContain('ob_pii');
    expect(networksOf('worker')).not.toContain('ob_pii');
  });

  it('[DP-4] pii-vault has no internet egress: only the internal ob_vault and ob_pii networks, shared with web and worker alone (ADR-068)', () => {
    const model = composeModel();
    expect(networksOf('pii-vault').sort()).toEqual(['ob_pii', 'ob_vault']);
    expect(model.networks.ob_vault?.internal).toBe(true);
    const onVault = Object.keys(model.services).filter((s) => networksOf(s).includes('ob_vault'));
    expect(onVault.sort()).toEqual(['pii-vault', 'web', 'worker']);
  });

  it('[NFR-2] integration tests use the same PostgreSQL image as compose', () => {
    expect(service('db-main').image).toBe(POSTGRES_IMAGE);
    expect(service('db-pii').image).toBe(POSTGRES_IMAGE);
  });

  it('[OPS-8] the stack is its own compose project on OmniBridge-only networks', () => {
    const model = composeModel();
    expect(model.name).toBe('omnibridge');
    const names = Object.values(model.networks).map((n) => n.name);
    expect(names.sort()).toEqual(['ob_app', 'ob_db', 'ob_edge', 'ob_pii', 'ob_vault', 'scan_ob']);
    expect(model.networks.ob_pii?.internal).toBe(true);
    expect(model.networks.ob_db?.internal).toBe(true);
  });

  it('[OPS-7] the stack needs nothing outside itself (no external networks or volumes)', () => {
    const model = composeModel();
    expect(Object.values(model.networks).filter((n) => n.external)).toEqual([]);
    expect(Object.values(model.volumes ?? {}).filter((v) => v.external)).toEqual([]);
  });

  it('[OPS-8] published ports bind to localhost only', () => {
    for (const [name, svc] of Object.entries(composeModel().services)) {
      for (const port of svc.ports ?? []) {
        expect({ name, host_ip: port.host_ip }).toEqual({ name, host_ip: '127.0.0.1' });
      }
    }
  });

  it('[OPS-9] clamd is reached only over the scan_ob network', () => {
    expect(networksOf('clamd')).toEqual(['scan_ob']);
    expect(composeModel().networks.scan_ob?.internal).toBe(true);
  });

  it('[OPS-10] every image is built here or pinned by digest', () => {
    for (const [name, svc] of Object.entries(composeModel().services)) {
      const image = svc.image ?? '';
      const ok = /^omnibridge\/[a-z-]+:dev$/.test(image) || /@sha256:[0-9a-f]{64}$/.test(image);
      expect({ name, image, ok }).toEqual({ name, image, ok: true });
    }
  });
});

describe('compose stack: secrets (SEC-5)', () => {
  it('[SEC-5] passwords reach containers only as /run/secrets files', () => {
    for (const [name, svc] of Object.entries(composeModel().services)) {
      for (const [key, value] of Object.entries(svc.environment ?? {})) {
        if (/PASSWORD|SECRET|TOKEN|KEY/.test(key)) {
          expect({
            name,
            key,
            ok: key.endsWith('_FILE') && value?.startsWith('/run/secrets/'),
          }).toEqual({ name, key, ok: true });
        }
      }
    }
  });

  it('[SEC-5] each secret is mounted only into the containers that need it', () => {
    const secretsOf = (name: string) => (service(name).secrets ?? []).map((s) => s.source).sort();
    expect(secretsOf('web')).toEqual([
      'auth_hmac_key',
      'file_link_hmac_key',
      'ob_app_password',
      'secrets_kek',
      'vault_token_web',
    ]);
    // The worker lists workspace ids as ob_platform for the scheduled fan-out (T-0202).
    // The worker logs in as ob_worker (ADR-049), never as ob_app.
    expect(secretsOf('worker')).toEqual([
      'ob_platform_password',
      'ob_worker_password',
      'secrets_kek',
      'vault_token_deletion',
      'vault_token_worker',
    ]);
    expect(secretsOf('pii-vault')).toEqual([
      'pii_kek',
      'vault_app_password',
      'vault_token_deletion',
      'vault_token_web',
      'vault_token_worker',
    ]);
    expect(secretsOf('migrate-main')).toEqual(['ob_owner_password']);
    // Besides the worker, only the one-off KEK re-wrap job holds ob_platform (T-0201).
    // It logs in as ob_ops (ADR-051): platform keys and tenant rows, never sessions.
    expect(secretsOf('rewrap-keys')).toEqual([
      'ob_ops_password',
      'ob_platform_password',
      'secrets_kek',
    ]);
    expect(secretsOf('migrate-pii')).toEqual(['vault_owner_password']);
    expect(secretsOf('site')).toEqual([]);
  });
});

describe('terms version (WWW-7)', () => {
  it('[WWW-7] the version users accept is the date on the public legal pages', () => {
    const site = readRepoFile('apps/site/src/settings.ts');
    const legal = /LEGAL_VERSION = '([\d-]+)'/.exec(site)?.[1];
    const compose = readRepoFile('infra/compose/compose.yaml');
    expect(legal).toBeDefined();
    expect(compose).toContain(`TERMS_VERSION: \${TERMS_VERSION:-${legal ?? ''}}`);
  });
});
