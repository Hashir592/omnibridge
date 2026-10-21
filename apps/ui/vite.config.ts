import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig } from 'vite';

// Design mock-ups (T-0301). Vite compiles TSX itself (oxc), so no React plugin is needed.
// The MSW service worker in public/ is for the dev server only; production builds never ship it.
export default defineConfig(({ command }) => ({
  publicDir: command === 'serve' ? 'public' : false,
  plugins: [tailwindcss()],
  resolve: { conditions: ['@omnibridge/source', ...defaultClientConditions] },
  oxc: { jsx: { runtime: 'automatic' } },
  server: {
    port: 5173,
    strictPort: true,
    // Transform the entry and every route at start-up, so the first page a test opens does not
    // wait for it on a busy machine (the gate runs the UI tests while the whole stack is up).
    warmup: { clientFiles: ['./src/main.tsx', './src/routes/**/*.tsx'] },
  },
  // Scan the lazy routes up front, so the dev server never reloads the page mid-test to
  // optimise a dependency it found late.
  optimizeDeps: { entries: ['index.html', 'src/routes/**/*.tsx'] },
  build: {
    rolldownOptions: {
      // React libraries mark modules "use client" for server-component bundlers; meaningless in an SPA.
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
}));
