import type { Provider } from '@omnibridge/core';

/** One provider call, as a governor sees it. */
export interface CallInput {
  workspaceId: string;
  channelAccountId: string;
  provider: Provider;
  api: string;
  urgent: boolean;
}

/**
 * The rate governors behind one interface (INT-2, RL-1 to RL-4): `admit` before a call is sent
 * (Amazon bucket, eBay budget), `run` around it (Amazon's 429 backoff, the carrier and website
 * concurrency cap). The worker builds it from the separate governor packages (RL-3).
 */
export interface ProviderGovernor {
  admit(
    input: CallInput,
  ): Promise<{ ok: true; usageRecorded: boolean } | { ok: false; retryAt: Date }>;
  run<T>(input: CallInput, fn: () => Promise<T>): Promise<T>;
}

/** Lets every call through: for tests of the path alone. */
export const passThroughGovernor: ProviderGovernor = {
  admit: () => Promise.resolve({ ok: true, usageRecorded: false }),
  run: (_input, fn) => fn(),
};
