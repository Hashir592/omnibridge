import { z } from 'zod';

/**
 * Amazon SP-API adapter. T-0101 has only a stub with one call, which proves the adapter → mock
 * path; the real adapter arrives with the Amazon module (M07+).
 */

/** Versioned response parser (ARCHITECTURE.md §6.5): unknown fields are ignored. */
const PingResponseV1 = z.object({ ok: z.literal(true), provider: z.literal('amazon') });
export type PingResponse = z.infer<typeof PingResponseV1>;

export interface AmazonStubAdapterOptions {
  baseUrl: string;
  /** Hosts this adapter may call. Dev and CI pass only the provider-mocks host (invariant 17). */
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
}

export interface AmazonStubAdapter {
  ping(): Promise<PingResponse>;
}

export function createAmazonStubAdapter(options: AmazonStubAdapterOptions): AmazonStubAdapter {
  const base = new URL(options.baseUrl);
  if (!options.allowedHosts.includes(base.hostname)) {
    throw new Error(`Provider host ${base.hostname} is not on the allowlist`);
  }
  const doFetch = options.fetch ?? fetch;

  return {
    async ping() {
      const res = await doFetch(new URL('/amazon/ping', base), {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Amazon ping failed with HTTP ${String(res.status)}`);
      return PingResponseV1.parse(await res.json());
    },
  };
}
