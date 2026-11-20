import type { Provider } from '@omnibridge/core';

/** A call refused before it was sent: its host is not on this mode's allowlist (invariant 17). */
export class EgressRefused extends Error {
  constructor(provider: Provider, host: string) {
    super(`Provider ${provider} may not reach host ${host} in this mode`);
    this.name = 'EgressRefused';
  }
}

/**
 * A provider answer the versioned parser cannot read (INT-5). It names the provider, parser,
 * version and field path only, never a value, and carries no cause (the Zod issue holds input).
 */
export class ProviderParserError extends Error {
  readonly provider: Provider;
  readonly parser: string;
  readonly version: number;
  readonly path: string;

  constructor(provider: Provider, parser: string, version: number, path: string) {
    super(`Parser ${provider}.${parser} v${String(version)} failed at ${path}`);
    this.name = 'ProviderParserError';
    this.provider = provider;
    this.parser = parser;
    this.version = version;
    this.path = path;
  }

  toJSON() {
    return { provider: this.provider, parser: this.parser, version: this.version, path: this.path };
  }
}
