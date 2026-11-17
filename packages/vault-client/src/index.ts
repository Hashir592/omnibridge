/**
 * The typed pii-vault client and API shapes (T-0402, invariant 8). Web and worker reach buyer PII
 * only through this client and their own service token; they never hold db-pii credentials.
 */
export const PACKAGE_NAME = '@omnibridge/vault-client';

export { VaultClient, VaultError, type VaultClientOptions } from './client.ts';
export * from './schemas.ts';
