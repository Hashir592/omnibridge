import { ProviderHttp } from '@omnibridge/provider-kit';
import { z } from 'zod';

/**
 * Amazon SP-API adapter (INT-1). `createAmazonAdapter` is the M07 adapter; the T-0101 stub below
 * stays for its walking-skeleton test and now calls through the provider HTTP client.
 */
export {
  AMAZON_APIS,
  createAmazonAdapter,
  UK_MARKETPLACE_ID,
  type AmazonAdapterOptions,
} from './adapter.ts';

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
  const http = new ProviderHttp({
    mode: 'mock',
    mocksUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    async ping() {
      const res = await http.request('amazon', { url: new URL('/amazon/ping', base) });
      if (!res.ok) throw new Error(`Amazon ping failed with HTTP ${String(res.status)}`);
      return PingResponseV1.parse(await res.json());
    },
  };
}
