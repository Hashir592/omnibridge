import '@fontsource-variable/inter';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppStateProvider } from './app/session.tsx';
import { router } from './router.tsx';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
});

async function start() {
  if (import.meta.env.DEV) {
    const { startMocks } = await import('./mocks/browser.ts');
    await startMocks();
  }
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppStateProvider>
          <RouterProvider router={router} />
        </AppStateProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
