// The input hash of a compose image (T-0208, ADR-056): a key that changes whenever anything the
// image is built from changes, so CI can load a saved image instead of rebuilding it.
//
// An image's inputs: its Dockerfile and build arg, every root-level file (package.json, the
// lockfile, tsconfig, ...), and the tracked files of its workspace package and of every
// workspace package it depends on, transitively. File contents come from git's blob ids, so a
// key is cheap and exact for a clean checkout (CI). Uncommitted edits are not seen: the cache is
// used only where OB_IMAGE_CACHE_DIR is set (CI).
//
// Usage: node scripts/lib/image-key.mjs <target>...   -> one "<target> <key>" line per target
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Compose build target → its workspace package and Dockerfile (infra/compose/*.yaml). */
export const TARGETS = {
  web: { pkg: '@omnibridge/web', dockerfile: 'infra/docker/node-app.Dockerfile' },
  worker: { pkg: '@omnibridge/worker', dockerfile: 'infra/docker/node-app.Dockerfile' },
  'pii-vault': { pkg: '@omnibridge/pii-vault', dockerfile: 'infra/docker/node-app.Dockerfile' },
  'provider-mocks': {
    pkg: '@omnibridge/provider-mocks',
    dockerfile: 'infra/docker/node-app.Dockerfile',
  },
  site: { pkg: '@omnibridge/site', dockerfile: 'infra/docker/site.Dockerfile' },
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

/** Workspace package name → its directory, from every tracked package.json below the root. */
function workspacePackages() {
  const dirs = new Map();
  for (const file of git('ls-files', '*/package.json').split('\n').filter(Boolean)) {
    if (file.includes('node_modules/')) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof manifest.name === 'string')
      dirs.set(manifest.name, { dir: file.slice(0, -13), manifest });
  }
  return dirs;
}

/** The package and every workspace package it depends on, transitively. */
function closure(name, packages) {
  const seen = new Set();
  const visit = (n) => {
    const pkg = packages.get(n);
    if (pkg === undefined || seen.has(n)) return;
    seen.add(n);
    const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = pkg.manifest;
    for (const [dep, range] of Object.entries({
      ...dependencies,
      ...devDependencies,
      ...peerDependencies,
    })) {
      if (String(range).startsWith('workspace:')) visit(dep);
    }
  };
  visit(name);
  return [...seen].map((n) => packages.get(n).dir);
}

export function imageKey(target, packages = workspacePackages()) {
  const spec = TARGETS[target];
  if (spec === undefined) throw new Error(`image-key: unknown target '${target}'`);
  const rootFiles = git('ls-files')
    .split('\n')
    .filter((f) => f !== '' && !f.includes('/'));
  const paths = [...rootFiles, 'infra/docker', ...closure(spec.pkg, packages)];
  const blobs = git('ls-files', '-s', '--', ...paths);
  return createHash('sha256')
    .update(`${target}\0${spec.pkg}\0${spec.dockerfile}\0${blobs}`)
    .digest('hex')
    .slice(0, 24);
}

if (process.argv[1]?.endsWith('image-key.mjs')) {
  const packages = workspacePackages();
  for (const target of process.argv.slice(2)) {
    process.stdout.write(`${target} ${imageKey(target, packages)}\n`);
  }
}
