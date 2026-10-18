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
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules|\\.astro)/' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      conditionNames: ['@omnibridge/source', 'import', 'default'],
      exportsFields: ['exports'],
      extensions: ['.ts', '.tsx', '.mjs', '.js'], // .tsx: the React SPA in apps/ui
    },
    preserveSymlinks: false,
  },
};
