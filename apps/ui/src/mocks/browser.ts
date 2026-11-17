import { getResponse } from 'msw';
import { setupWorker } from 'msw/browser';
import { enableDemoSession } from './auth.ts';
import { handlers } from './handlers.ts';

/**
 * Starts the mocks. Uses the service worker where the browser allows it; some embedded browsers
 * refuse service workers, so we fall back to answering mocked routes inside the page.
 */
export async function startMocks(): Promise<void> {
  enableDemoSession();
  try {
    await setupWorker(...handlers).start({ onUnhandledFrame: 'bypass', quiet: true });
  } catch {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const mocked = await getResponse(handlers, request);
      return mocked ?? realFetch(request);
    };
  }
}
