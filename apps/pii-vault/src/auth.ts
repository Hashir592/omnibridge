import { createHash, timingSafeEqual } from 'node:crypto';
import type { Capability, ReadPurpose } from '@omnibridge/vault-client/schemas';
import type { Caller } from './vault.ts';

/**
 * Per-caller service tokens (invariant 8, ADR-007). Each token stands for one caller, and each
 * caller holds a fixed set of capabilities; anything else answers 403. Tokens are compared as
 * SHA-256 digests in constant time, and the vault never logs one.
 */
export const CALLER_CAPABILITIES: Readonly<Record<Caller, readonly Capability[]>> = {
  // Web: inbound website orders are ingested inside the request (invariant 7a); order detail and
  // the inbox read in full; lists are masked; order search and same-buyer groups.
  web: ['ingest', 'read_full', 'mask', 'search', 'match'],
  // Worker: marketplace ingestion, labels, the inbox sync, same-buyer groups.
  worker: ['ingest', 'read_full', 'mask', 'match'],
  // The deletion jobs only (DEL-1): nothing but delete.
  deletion: ['delete'],
};

/** DP-7: which caller may read in full for which purpose. */
export const CALLER_READ_PURPOSES: Readonly<Record<Caller, readonly ReadPurpose[]>> = {
  web: ['order_detail', 'inbox', 'subject_access'],
  worker: ['label', 'inbox'],
  deletion: [],
};

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();

export class ServiceTokens {
  readonly #byCaller: readonly (readonly [Caller, Buffer])[];

  /** Tokens shorter than 32 characters are refused at boot: a weak token is a missing token. */
  constructor(tokens: Readonly<Record<Caller, string>>) {
    this.#byCaller = (Object.entries(tokens) as [Caller, string][]).map(([caller, token]) => {
      if (token.length < 32) throw new Error(`The ${caller} vault token is too short`);
      return [caller, digest(token)] as const;
    });
    const unique = new Set(this.#byCaller.map(([, d]) => d.toString('hex')));
    if (unique.size !== this.#byCaller.length)
      throw new Error('Every caller needs its own vault token');
  }

  /** The caller a bearer token stands for, or undefined. Every token is compared, every time. */
  callerOf(authorization: string | undefined): Caller | undefined {
    const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(authorization ?? '');
    if (match?.[1] === undefined) return undefined;
    const given = digest(match[1]);
    let found: Caller | undefined;
    for (const [caller, expected] of this.#byCaller) {
      if (timingSafeEqual(given, expected)) found = caller;
    }
    return found;
  }
}

export function can(caller: Caller, capability: Capability): boolean {
  return CALLER_CAPABILITIES[caller].includes(capability);
}
