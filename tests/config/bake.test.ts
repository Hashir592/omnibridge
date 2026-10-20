import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DOCKER_SETUP_TIMEOUT_MS, readRepoFile, repoRoot } from './helpers.ts';

interface BakeTarget {
  context: string;
  dockerfile: string;
  tags: string[];
}

const TARGETS = ['web', 'worker', 'pii-vault', 'site', 'provider-mocks'];

describe('CI image build with buildx bake (ADR-043)', () => {
  let targets: Record<string, BakeTarget> = {};

  // The same bake call as verify.sh build_images, printed instead of built: from infra/compose,
  // for the five distinct images.
  beforeAll(() => {
    const res = spawnSync(
      'docker',
      ['buildx', 'bake', '-f', 'compose.yaml', '-f', 'compose.dev.yaml', '--print', ...TARGETS],
      { cwd: `${repoRoot}infra/compose`, encoding: 'utf8' },
    );
    if (res.status !== 0) throw new Error(`bake --print failed: ${res.stderr}`);
    targets = (JSON.parse(res.stdout) as { target: Record<string, BakeTarget> }).target;
  }, DOCKER_SETUP_TIMEOUT_MS);

  it('[SEC-4] the cached CI build runs bake from infra/compose for the five distinct images', () => {
    const verify = readRepoFile('scripts/verify.sh');
    expect(verify).toContain(
      '(cd infra/compose && docker buildx bake -f compose.yaml -f compose.dev.yaml',
    );
    expect(verify).toContain('BAKE_TARGETS=(web worker pii-vault site provider-mocks)');
    // Parallel targets must not share a cache directory: their blob writes collide.
    expect(verify).toContain('$target.cache-to=type=local,dest=$cache-new/$target,mode=max');
    expect(Object.keys(targets).sort()).toEqual([...TARGETS].sort());
  });

  it('[SEC-4] every bake target builds from the repository root, as compose does', () => {
    for (const [name, target] of Object.entries(targets)) {
      const context = resolve(`${repoRoot}infra/compose`, target.context);
      expect({ name, context }).toEqual({ name, context: resolve(repoRoot) });
      expect(target.tags).toEqual([`omnibridge/${name}:dev`]);
    }
  });
});
