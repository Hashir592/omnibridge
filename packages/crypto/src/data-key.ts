import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import {
  assertKeyVersion,
  ciphertextKeyVersion,
  CryptoError,
  encodeAad,
  KEY_BYTES,
  open,
  seal,
  type FieldAad,
} from './envelope.ts';
import type { KeyPurpose, Keyring } from './keyring.ts';

/** A data key (DEK) as stored: wrapped under one KEK version, never in plaintext. */
export interface WrappedDataKey {
  readonly workspaceId: string;
  /** The DEK version written in the prefix of every ciphertext it produces. */
  readonly version: number;
  /** The KEK version that wraps it (also the prefix of `wrapped`). */
  readonly kekVersion: number;
  readonly wrapped: Buffer;
}

/** A wrapped DEK opens only for the purpose, workspace and version it was made for. */
function wrapAad(purpose: KeyPurpose, workspaceId: string, version: number): Buffer {
  return encodeAad('omnibridge/dek/v1', [purpose, workspaceId, String(version)]);
}

/**
 * An unwrapped per-workspace data key. It encrypts field values with AES-256-GCM, bound to the
 * workspace, table, column and row (SEC-6). Key bytes sit in a private field and are never printed.
 */
export class DataKey {
  readonly #key: Buffer;
  readonly purpose: KeyPurpose;
  readonly workspaceId: string;
  readonly version: number;

  constructor(purpose: KeyPurpose, workspaceId: string, version: number, key: Buffer) {
    if (key.length !== KEY_BYTES) throw new CryptoError('A data key must be 32 bytes');
    assertKeyVersion(version);
    this.#key = key;
    this.purpose = purpose;
    this.workspaceId = workspaceId;
    this.version = version;
  }

  encrypt(plaintext: string | Uint8Array, aad: FieldAad): Buffer {
    const bytes = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    return seal(this.#key, this.version, bytes, this.#aad(aad));
  }

  decrypt(ciphertext: Uint8Array, aad: FieldAad): Buffer {
    const aadBytes = this.#aad(aad);
    if (ciphertextKeyVersion(ciphertext) !== this.version) {
      throw new CryptoError('Ciphertext was written under a different data key version');
    }
    return open(this.#key, ciphertext, aadBytes);
  }

  #aad(aad: FieldAad): Buffer {
    if (aad.workspaceId !== this.workspaceId) {
      throw new CryptoError('Data key used for another workspace');
    }
    return encodeAad('omnibridge/field/v1', [
      this.purpose,
      aad.workspaceId,
      aad.table,
      aad.column,
      aad.rowId,
    ]);
  }

  toString(): string {
    return `DataKey(${this.purpose}, version ${String(this.version)}, [REDACTED])`;
  }

  toJSON(): unknown {
    return { purpose: this.purpose, workspaceId: this.workspaceId, version: this.version };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** Makes a new random DEK and wraps it under the keyring's active KEK. */
export function generateDataKey(
  keyring: Keyring,
  workspaceId: string,
  version: number,
): { dataKey: DataKey; wrapped: WrappedDataKey } {
  const key = randomBytes(KEY_BYTES);
  const dataKey = new DataKey(keyring.purpose, workspaceId, version, key);
  const wrapped = keyring.wrap(key, wrapAad(keyring.purpose, workspaceId, version));
  return {
    dataKey,
    wrapped: { workspaceId, version, kekVersion: keyring.activeVersion, wrapped },
  };
}

/** Opens a stored DEK; the only path that checks its prefix and builds its AAD. */
function openWrapped(keyring: Keyring, stored: WrappedDataKey): Buffer {
  if (ciphertextKeyVersion(stored.wrapped) !== stored.kekVersion) {
    throw new CryptoError('Wrapped data key prefix does not match its KEK version');
  }
  return keyring.unwrap(
    stored.wrapped,
    wrapAad(keyring.purpose, stored.workspaceId, stored.version),
  );
}

export function unwrapDataKey(keyring: Keyring, stored: WrappedDataKey): DataKey {
  return new DataKey(
    keyring.purpose,
    stored.workspaceId,
    stored.version,
    openWrapped(keyring, stored),
  );
}

/**
 * KEK rotation: re-wraps a DEK under the active KEK. Only the 65-byte wrapped key changes; data
 * encrypted with the DEK is never touched (SEC-6). A DEK already under the active KEK is returned
 * as it is.
 */
export function rewrapDataKey(keyring: Keyring, stored: WrappedDataKey): WrappedDataKey {
  if (stored.kekVersion === keyring.activeVersion) return stored;
  return {
    workspaceId: stored.workspaceId,
    version: stored.version,
    kekVersion: keyring.activeVersion,
    wrapped: keyring.wrap(
      openWrapped(keyring, stored),
      wrapAad(keyring.purpose, stored.workspaceId, stored.version),
    ),
  };
}
