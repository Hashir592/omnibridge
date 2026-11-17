/**
 * Envelope encryption (AES-256-GCM, DEK/KEK) for credentials in db-main and, from M04, PII fields
 * in pii-vault (SEC-6, ADR-007, ADR-014). Built only on node:crypto.
 */
export const PACKAGE_NAME = '@omnibridge/crypto';

export { ciphertextKeyVersion, CryptoError, type FieldAad } from './envelope.ts';
export {
  DataKey,
  generateDataKey,
  rewrapDataKey,
  unwrapDataKey,
  type WrappedDataKey,
} from './data-key.ts';
export { generateIndexKey, IndexKey, unwrapIndexKey, type WrappedIndexKey } from './index-key.ts';
export { generateKekLine, Keyring, loadKeyring, parseKeyring, type KeyPurpose } from './keyring.ts';
export { Secret } from './secret.ts';
