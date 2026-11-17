import { createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import {
  assertKeyVersion,
  ciphertextKeyVersion,
  CryptoError,
  encodeAad,
  KEY_BYTES,
} from './envelope.ts';
import type { Keyring } from './keyring.ts';

/** A blind-index key as stored: wrapped under one KEK version, never in plaintext. */
export interface WrappedIndexKey {
  readonly workspaceId: string;
  readonly version: number;
  readonly kekVersion: number;
  readonly wrapped: Buffer;
}

/** An index key opens only as an index key, for its workspace and version (never as a DEK). */
function wrapAad(workspaceId: string, version: number): Buffer {
  return encodeAad('omnibridge/idx/v1', ['pii', workspaceId, String(version)]);
}

/**
 * A per-workspace blind-index key (ADR-007, DP-7): HMAC-SHA256 of a normalised value, so the vault
 * can find an exact match without decrypting anything. Separate from the data key, so a leaked
 * index never helps decrypt a field. Key bytes sit in a private field and are never printed.
 */
export class IndexKey {
  readonly #key: Buffer;
  readonly workspaceId: string;
  readonly version: number;

  constructor(workspaceId: string, version: number, key: Buffer) {
    if (key.length !== KEY_BYTES) throw new CryptoError('An index key must be 32 bytes');
    assertKeyVersion(version);
    this.#key = key;
    this.workspaceId = workspaceId;
    this.version = version;
  }

  /** The 32-byte MAC of `value` for `field`; the field name keeps equal values apart across fields. */
  mac(field: string, value: string): Buffer {
    if (value === '') throw new CryptoError('An empty value has no blind index');
    return createHmac('sha256', this.#key)
      .update(encodeAad('omnibridge/bidx/v1', [this.workspaceId, field, value]))
      .digest();
  }

  toString(): string {
    return `IndexKey(version ${String(this.version)}, [REDACTED])`;
  }

  toJSON(): unknown {
    return { workspaceId: this.workspaceId, version: this.version };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** Makes a new random index key and wraps it under the `pii` keyring's active KEK. */
export function generateIndexKey(
  keyring: Keyring,
  workspaceId: string,
  version: number,
): { indexKey: IndexKey; wrapped: WrappedIndexKey } {
  if (keyring.purpose !== 'pii')
    throw new CryptoError('Index keys are wrapped by the PII KEK only');
  const key = randomBytes(KEY_BYTES);
  const wrapped = keyring.wrap(key, wrapAad(workspaceId, version));
  return {
    indexKey: new IndexKey(workspaceId, version, key),
    wrapped: { workspaceId, version, kekVersion: keyring.activeVersion, wrapped },
  };
}

export function unwrapIndexKey(keyring: Keyring, stored: WrappedIndexKey): IndexKey {
  if (keyring.purpose !== 'pii')
    throw new CryptoError('Index keys are wrapped by the PII KEK only');
  if (ciphertextKeyVersion(stored.wrapped) !== stored.kekVersion) {
    throw new CryptoError('Wrapped index key prefix does not match its KEK version');
  }
  const key = keyring.unwrap(stored.wrapped, wrapAad(stored.workspaceId, stored.version));
  return new IndexKey(stored.workspaceId, stored.version, key);
}
