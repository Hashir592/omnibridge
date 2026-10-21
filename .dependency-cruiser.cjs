// Architecture rules (ARCHITECTURE.md §5). Run: pnpm depcruise
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'An import that cannot be resolved would hide every other rule.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'governors-share-nothing',
      comment:
        'Invariant 11 / RL-3: the Amazon and eBay governors are separate code paths with no shared ' +
        'retry helper. A governor may use only its own files, packages/core and packages/logger.',
      severity: 'error',
      from: { path: '^packages/governors/([^/]+)/src/' },
      to: {
        path: '^(packages|apps|mocks)/',
        pathNot: ['^packages/governors/$1/', '^packages/core/', '^packages/logger/'],
      },
    },
    {
      name: 'providers-only-from-worker',
      comment:
        'Invariant 10: provider APIs are called only from packages/providers, through the queue. ' +
        'Web handlers make no provider calls (OAuth code exchanges will get a named exception).',
      severity: 'error',
      from: {
        path: '^(apps/(web|ui|pii-vault|site)|packages/(core|db|pii-db|contract|crypto|logger))/',
      },
      to: { path: '^packages/providers/' },
    },
    {
      name: 'pii-db-only-from-vault',
      comment: 'Invariant 5: db-pii is reachable only through pii-vault.',
      severity: 'error',
      from: { pathNot: '^(apps/pii-vault|packages/pii-db)/' },
      to: { path: '^packages/pii-db/' },
    },
    {
      name: 'vault-not-main-db',
      comment: 'pii-vault must not hold db-main code or credentials.',
      severity: 'error',
      from: { path: '^(apps/pii-vault|packages/pii-db)/' },
      to: { path: '^packages/db/' },
    },
    {
      name: 'ui-uses-contract-client-only',
      comment:
        'ADR-004: the SPA talks to the API only through the generated typed client ' +
        '(@omnibridge/contract/client), never the Zod registry or server code.',
      severity: 'error',
      from: { path: '^apps/ui/' },
      to: { path: '^packages/contract/', pathNot: '^packages/contract/src/client/' },
    },
    {
      name: 'db-access-only-in-packages-db',
      comment:
        'Invariant 3: db-main is reached only through packages/db, whose repositories take a ' +
        'TenantContext and run in a tenant transaction. Apps and other packages never import pg ' +
        'or kysely themselves (createMainDb is the way in). db-pii has its own pair, pii-db and ' +
        'pii-vault; tests may build fixtures directly.',
      severity: 'error',
      from: {
        path: '^(apps|packages|mocks)/',
        pathNot: [
          '^packages/(db|pii-db|testkit)/',
          '^apps/pii-vault/',
          '\\.(test|int\\.test|contract\\.test)\\.ts$',
        ],
      },
      to: { path: '(^|/)node_modules/(kysely|pg)/' },
    },
    {
      name: 'ob-platform-only-in-fanout',
      comment:
        'Invariant 2 / ADR-049: ob_platform (the workspace id list) is opened only by the ' +
        "worker's PLATFORM_JOBS module and the one-off KEK re-wrap job, through " +
        '@omnibridge/db/platform. Tests may build fixtures.',
      severity: 'error',
      from: {
        path: '^(apps|packages|mocks)/',
        pathNot: [
          '^packages/db/',
          '^apps/worker/src/platform-jobs\\.ts$',
          '^apps/web/src/rewrap-keys\\.ts$',
          '\\.(test|int\\.test|contract\\.test)\\.ts$',
        ],
      },
      to: { path: '^packages/db/src/platform\\.ts$' },
    },
    {
      name: 'mocks-and-testkit-only-in-tests',
      comment: 'Provider mocks and the testkit never ship inside production code paths.',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
        pathNot: ['\\.(test|int\\.test|contract\\.test)\\.ts$', '^packages/testkit/'],
      },
      to: { path: '^(mocks/|packages/testkit/)' },
    },
  ],
  options: {
    // npm packages stay in the graph as leaves (not followed), so a rule can forbid one.
    doNotFollow: { path: 'node_modules' },
    // Only our own build output: npm packages often live under a dist/ folder too.
    exclude: { path: '^(apps|packages|mocks)/[^.]*(dist|\\.astro)/' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      conditionNames: ['@omnibridge/source', 'import', 'default'],
      exportsFields: ['exports'],
      extensions: ['.ts', '.tsx', '.mjs', '.js'], // .tsx: the React SPA in apps/ui
    },
    preserveSymlinks: false,
  },
};
