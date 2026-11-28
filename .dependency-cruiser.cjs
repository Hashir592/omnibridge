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
      name: 'governors-no-core-retry-helper',
      comment:
        'RL-3, ADR-078: a governor may not import a backoff or retry helper from core either; each ' +
        'governor keeps its own.',
      severity: 'error',
      from: { path: '^packages/governors/' },
      to: { path: '^packages/core/src/[^/]*(retry|backoff)[^/]*$' },
    },
    {
      name: 'providers-do-not-import-governors',
      comment:
        'RL-3: the worker routes each call to its own governor; no provider package imports one, ' +
        'so the eBay path can never pick up the Amazon governor or the other way round.',
      severity: 'error',
      from: { path: '^packages/providers/' },
      to: { path: '^packages/governors/' },
    },
    {
      name: 'kit-carrier-backoff-only-carriers',
      comment:
        "RL-3, RL-4, ADR-078: the kit's carrier backoff and cap serve the carriers and the website " +
        'only; the Amazon, Ads and eBay code paths never import them.',
      severity: 'error',
      from: { path: '^packages/(governors|providers/(amazon|ads|ebay))/' },
      to: { path: '^packages/providers/kit/src/carrier\\.ts$' },
    },
    {
      name: 'providers-only-from-worker',
      comment:
        'INT-1, invariant 15: provider APIs are called only from packages/providers, through the ' +
        'queue; business modules never import a provider package. Named exceptions: the eBay ' +
        'account deletion webhook reads eBay public keys (T-0602, PS-022: eBay needs an answer ' +
        'within 3 seconds), and the OAuth code exchange (T-0701, INT-2), each from its own file.',
      severity: 'error',
      from: {
        path:
          '^(apps/(web|ui|pii-vault|site)|packages/(core|db|pii-db|contract|crypto|logger|queue|' +
          'files|mail|vault-client))/',
        pathNot: [
          '^apps/web/src/(webhooks/ebay(\\.test)?|privacy\\.int\\.test)\\.ts$',
          '^apps/web/src/oauth-exchange\\.ts$',
        ],
      },
      to: { path: '^packages/providers/' },
    },
    {
      name: 'ebay-webhook-only-ebay-provider',
      comment: 'The PS-022 exception covers the eBay provider only, from those files.',
      severity: 'error',
      from: { path: '^apps/web/src/(webhooks/ebay(\\.test)?|privacy\\.int\\.test)\\.ts$' },
      to: { path: '^packages/providers/(?!ebay/)' },
    },
    {
      name: 'oauth-exchange-only-oauth-providers',
      comment:
        'INT-2: the web OAuth exchange may use the provider kit and the OAuth providers (eBay, ' +
        'Amazon) to exchange a code, nothing else.',
      severity: 'error',
      from: { path: '^apps/web/src/oauth-exchange\\.ts$' },
      to: { path: '^packages/providers/(?!(kit|ebay|amazon)/)' },
    },
    {
      name: 'provider-kit-is-generic',
      comment:
        'INT-1: the provider kit holds the shared plumbing only; it imports no provider and no ' +
        'governor, so no provider code can hide in it.',
      severity: 'error',
      from: { path: '^packages/providers/kit/' },
      to: { path: '^packages/(providers/(?!kit/)|governors/)' },
    },
    {
      name: 'order-ingest-calls-no-provider',
      comment:
        'T-1101 (ADR-054 FA-04): the order ingest step is shared by the worker and the website ' +
        'push, so it takes the provider kit for its order types only and imports no provider and ' +
        'no governor: it calls no provider (invariant 15).',
      severity: 'error',
      from: { path: '^packages/order-ingest/' },
      to: { path: '^packages/(providers/(?!kit/)|governors/)' },
    },
    {
      name: 'order-ingest-only-website-in-web',
      comment:
        'T-1101: in the web app only the website push stores orders, vault first; no other ' +
        'handler reaches the ingest step.',
      severity: 'error',
      from: { path: '^apps/(web|ui|pii-vault|site)/', pathNot: '^apps/web/src/website[^/]*\\.ts$' },
      to: { path: '^packages/order-ingest/' },
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
      name: 'vault-client-holds-no-keys',
      comment:
        'Invariant 8 (T-0402): the vault client is what web and worker hold, so it carries no db, db-pii or key code.',
      severity: 'error',
      from: { path: '^packages/vault-client/' },
      to: { path: '^(apps/|packages/(db|pii-db|crypto)/)' },
    },
    {
      name: 'vault-reached-over-http-only',
      comment:
        'Web and worker reach pii-vault only through @omnibridge/vault-client; only tests may start one in-process.',
      severity: 'error',
      from: {
        pathNot: ['^apps/pii-vault/', '\\.(test|int\\.test|contract\\.test)\\.ts$'],
      },
      to: { path: '^apps/pii-vault/' },
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
