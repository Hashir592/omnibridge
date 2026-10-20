import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript source in tests (see each package's exports).
const conditions = ['@omnibridge/source'];
const resolve = { conditions };
const exclude = ['**/node_modules/**', '**/dist/**'];

export default defineConfig({
  resolve,
  ssr: { resolve: { conditions } },
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          // .tsx files are UI component tests; each opts into jsdom (ADR-039) with a file comment.
          include: ['{apps,packages,mocks,scripts,tests}/**/*.test.{ts,tsx}'],
          exclude: [...exclude, '**/*.int.test.ts', '**/*.contract.test.ts'],
        },
      },
      {
        resolve,
        test: {
          name: 'integration',
          include: ['{apps,packages,mocks,tests}/**/*.int.test.ts'],
          exclude,
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 300_000,
        },
      },
      {
        resolve,
        test: {
          name: 'contract',
          include: ['{apps,packages,mocks,tests}/**/*.contract.test.ts'],
          exclude,
        },
      },
    ],
  },
});
