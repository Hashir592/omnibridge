import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise, type IConfiguration } from 'dependency-cruiser';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const config = createRequire(import.meta.url)(
  join(repoRoot, '.dependency-cruiser.cjs'),
) as IConfiguration;
const temp: string[] = [];

afterAll(() => {
  for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

/** Writes a small tree of files (path -> source) into a fresh folder. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'ob-arch-'));
  temp.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/** Cruises a fixture tree with the repository's own rules; answers the rules it breaks. */
async function violations(root: string): Promise<string[]> {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const dirs = ['apps', 'packages'].filter((d) => readdirSync(root).includes(d));
    const result = await cruise(
      dirs,
      {
        validate: true,
        ruleSet: { forbidden: config.forbidden ?? [] },
        doNotFollow: { path: 'node_modules' },
      },
      { extensions: ['.ts'] },
    );
    if (typeof result.output === 'string') throw new Error('unexpected text output');
    return [...new Set(result.output.summary.violations.map((v) => v.rule.name))].sort();
  } finally {
    process.chdir(cwd);
  }
}

const provider = { 'packages/providers/ebay/src/index.ts': 'export const ebay = 1;\n' };

describe('architecture rules (INT-1, INT-2)', () => {
  it('[INT-1] a business module importing a provider package fails the architecture check', async () => {
    const root = tree({
      ...provider,
      'packages/db/src/orders.ts':
        "import { ebay } from '../../providers/ebay/src/index.ts';\nexport const x = ebay;\n",
      'packages/queue/src/jobs.ts':
        "import { ebay } from '../../providers/ebay/src/index.ts';\nexport const y = ebay;\n",
    });
    expect(await violations(root)).toEqual(['providers-only-from-worker']);
  });

  it('[INT-1] the worker may use providers; the kit may use no provider', async () => {
    const ok = tree({
      ...provider,
      'apps/worker/src/sync.ts':
        "import { ebay } from '../../../packages/providers/ebay/src/index.ts';\nexport const z = ebay;\n",
    });
    expect(await violations(ok)).toEqual([]);
    const kit = tree({
      ...provider,
      'packages/providers/kit/src/http.ts':
        "import { ebay } from '../../ebay/src/index.ts';\nexport const k = ebay;\n",
    });
    expect(await violations(kit)).toEqual(['provider-kit-is-generic']);
  });

  it('[INT-2] web reaches a provider only from the OAuth exchange, and only an OAuth provider', async () => {
    const root = tree({
      ...provider,
      'packages/providers/evri/src/index.ts': 'export const evri = 1;\n',
      'apps/web/src/connections.ts':
        "import { ebay } from '../../../packages/providers/ebay/src/index.ts';\nexport const a = ebay;\n",
      'apps/web/src/oauth-exchange.ts':
        "import { ebay } from '../../../packages/providers/ebay/src/index.ts';\n" +
        "import { evri } from '../../../packages/providers/evri/src/index.ts';\nexport const b = [ebay, evri];\n",
    });
    expect(await violations(root)).toEqual([
      'oauth-exchange-only-oauth-providers',
      'providers-only-from-worker',
    ]);
  });
});

/** Every workspace package.json with its runtime dependencies. */
function workspacePackages(root: string): { path: string; runtime: string[]; dev: string[] }[] {
  const out: { path: string; runtime: string[]; dev: string[] }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || ['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      try {
        const pkg = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        out.push({
          path,
          runtime: Object.keys(pkg.dependencies ?? {}),
          dev: Object.keys(pkg.devDependencies ?? {}),
        });
      } catch {
        // not a package
      }
      if (depth < 3) walk(path, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** INT-7: libraries that drive a browser or scrape a page. Test-only browsers are allowed. */
const SCRAPING =
  /^(puppeteer(-core)?|playwright(-core|-chromium)?|@playwright\/test|selenium-webdriver|webdriverio|cheerio|jsdom|happy-dom|crawlee|x-ray|osmosis|nightmare|zombie|phantomjs(-prebuilt)?|got-scraping|chrome-remote-interface|@sparticuz\/chromium|robotjs|@nut-tree\/nut-js|node-html-parser|htmlparser2)$/;
/** Where a test browser may sit: the root e2e suite and the SPA's component tests (dev only). */
const TEST_BROWSER_HOMES = new Set(['', 'apps/ui']);

function scrapingProblems(root: string): string[] {
  const problems: string[] = [];
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = [
    {
      path: '',
      runtime: Object.keys(rootPkg.dependencies ?? {}),
      dev: Object.keys(rootPkg.devDependencies ?? {}),
    },
    ...workspacePackages(root),
  ];
  for (const pkg of all) {
    for (const name of pkg.runtime.filter((n) => SCRAPING.test(n)))
      problems.push(`${pkg.path || '.'}: ${name}`);
    if (!TEST_BROWSER_HOMES.has(pkg.path)) {
      for (const name of pkg.dev.filter((n) => SCRAPING.test(n)))
        problems.push(`${pkg.path}: ${name} (dev)`);
    }
  }
  return problems;
}

describe('no scraping or browser automation (INT-7)', () => {
  it('[INT-7] no package depends on a headless browser or scraping library', () => {
    expect(scrapingProblems(repoRoot)).toEqual([]);
  });

  it('[INT-7] the scan fails on a planted dependency', () => {
    const root = tree({
      'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '1.0.0' } }),
      'packages/providers/amazon/package.json': JSON.stringify({
        dependencies: { puppeteer: '1.0.0' },
      }),
      'apps/worker/package.json': JSON.stringify({ devDependencies: { cheerio: '1.0.0' } }),
    });
    expect(scrapingProblems(root)).toEqual(
      ['packages/providers/amazon: puppeteer', 'apps/worker: cheerio (dev)'].sort((a, b) =>
        a.startsWith('apps') ? -1 : b.startsWith('apps') ? 1 : 0,
      ),
    );
  });
});

/** Source files (not tests, not builds) under the given folders. */
function sources(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist'].includes(entry.name)) walk(path);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.(test|int\.test|contract\.test)\.tsx?$/.test(entry.name)
      ) {
        out.push(path);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

/** A source file without its comments: docs may name a host or the word fetch. */
function code(file: string): string {
  return readFileSync(join(repoRoot, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('provider egress in source (INT-3, INT-7, invariant 17)', () => {
  it('[INT-7] no marketplace or carrier website (as opposed to its API) is named in code; provider hosts live in one file', () => {
    const SITES =
      /\b(www\.amazon\.|www\.ebay\.|ebay\.co\.uk|evri\.com|dpd\.co\.uk|dpdlocal\.co\.uk)/;
    const HOST_FILE = 'packages/providers/kit/src/http.ts';
    // A host in URL form. eBay's OAuth scope names look like URLs but are names, not hosts.
    const API_HOSTS =
      /https?:(\/\/|%3A%2F%2F|%2F%2F)(sellingpartnerapi|advertising-api|api\.sandbox\.ebay|sellercentral\.amazon|auth\.(sandbox\.)?ebay|api\.amazon\.|api\.ebay\.com(?!(\/|%2F)oauth(\/|%2F)api_scope))/i;
    const offenders = sources(['apps/web/src', 'apps/worker/src', 'packages', 'mocks']).filter(
      (file) => {
        const text = code(file);
        return SITES.test(text) || (file !== HOST_FILE && API_HOSTS.test(text));
      },
    );
    expect(offenders).toEqual([]);
  });

  it('[INT-3] provider and governor code makes no HTTP call except through the provider HTTP client', () => {
    const RAW =
      /((?<![.#\w])fetch\s*\(|globalThis\.fetch|from 'node:https?'|from 'undici'|from 'axios'|from 'got')/;
    const offenders = sources(['packages/providers', 'packages/governors']).filter((file) => {
      if (file === 'packages/providers/kit/src/http.ts') return false;
      return RAW.test(code(file));
    });
    expect(offenders).toEqual([]);
  });
});
