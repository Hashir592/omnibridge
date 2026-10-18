import { createHash } from 'node:crypto';

/**
 * Server-side cache keys (NFR-6, ARCHITECTURE.md §6.1). A cached value may only be shared by
 * requests that see the same data, so every key names the workspace and the user's permitted
 * company set (invariant 5: "combined" means permitted companies only).
 */

/** A hash of one user's permitted company ids. Only `companySetHash` makes these. */
export type CompanySetHash = string & { readonly __brand: 'CompanySetHash' };

const HASH_PREFIX = 'cs1-';
const HASH_PATTERN = /^cs1-[0-9a-f]{64}$/;
const WORKSPACE_PATTERN = /^[0-9A-Za-z-]+$/;

/** Order and duplicates do not matter; membership does. The empty set has its own hash. */
export function companySetHash(companyIds: readonly string[]): CompanySetHash {
  const unique = [...new Set(companyIds)].sort();
  const digest = createHash('sha256').update(JSON.stringify(unique)).digest('hex');
  return `${HASH_PREFIX}${digest}` as CompanySetHash;
}

export interface CacheKeyInput {
  workspaceId: string;
  companySet: CompanySetHash;
  /** What is cached, e.g. `dashboard.sales`. */
  name: string;
  /** Further inputs such as a date range. Each part is escaped, so parts cannot forge segments. */
  parts?: readonly (string | number)[];
}

/** Builds `ob:v1:ws:<workspace>:cs:<company set>:<name>[:<part>…]`, or throws. */
export function cacheKey({ workspaceId, companySet, name, parts = [] }: CacheKeyInput): string {
  if (!workspaceId || !WORKSPACE_PATTERN.test(workspaceId)) {
    throw new TypeError('cacheKey needs a workspace id');
  }
  if (!HASH_PATTERN.test(companySet)) {
    throw new TypeError('cacheKey needs a company-set hash from companySetHash()');
  }
  if (!name) throw new TypeError('cacheKey needs a name');
  const tail = [name, ...parts.map(String)].map(encodeURIComponent).join(':');
  return `ob:v1:ws:${workspaceId}:cs:${companySet}:${tail}`;
}
