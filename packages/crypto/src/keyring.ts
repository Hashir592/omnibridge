import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { readSecretFile } from '@omnibridge/core';
import {
  assertKeyVersion,
  ciphertextKeyVersion,
  CryptoError,
  KEY_BYTES,
  open,
  seal,
} from './envelope.ts';

/**
 * The two master keys (KEKs). `secrets` wraps the data keys of db-main credentials and is mounted
 * only into web and worker; `pii` wraps the per-workspace PII data keys and is mounted only into
 * pii-vault (invariant 9, ADR-007, ADR-014).
 */
export type KeyPurpose = 'secrets' | 'pii';

const SECRET_NAME: Readonly<Record<KeyPurpose, string>> = {
  secrets: 'SECRETS_KEK',
  pii: 'PII_KEK',
};

/** One KEK version per line: `<version>:<base64 of 32 bytes>`. */
const LINE = /^([1-9][0-9]{0,8}):([A-Za-z0-9+/]{43}=)$/;

const REDACTED = '[REDACTED]';

/**
 * The versions of one master key. The last version is active and wraps every new data key; older
 * versions stay only until `rewrapDataKey` has moved every data key off them (SEC-6). Key bytes are
 * held in a private field and never printed.
 */
export class Keyring {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly purpose: KeyPurpose;
  readonly versions: readonly number[];
  readonly activeVersion: number;

  constructor(purpose: KeyPurpose, keys: ReadonlyMap<number, Buffer>) {
    const versions = [...keys.keys()];
    const active = versions.at(-1);
    if (active === undefined) throw new CryptoError(`The ${purpose} keyring is empty`);
    this.#keys = keys;
    this.purpose = purpose;
    this.versions = versions;
    this.activeVersion = active;
  }

  /** Seals a data key under the active KEK. */
  wrap(dataKey: Buffer, aad: Buffer): Buffer {
    return seal(this.#key(this.activeVersion), this.activeVersion, dataKey, aad);
  }

  /** Opens a wrapped data key with the KEK version named in its prefix. */
  unwrap(wrapped: Uint8Array, aad: Buffer): Buffer {
    return open(this.#key(ciphertextKeyVersion(wrapped)), wrapped, aad);
  }

  #key(version: number): Buffer {
    const key = this.#keys.get(version);
    if (key === undefined) {
      throw new CryptoError(`The ${this.purpose} keyring has no KEK version ${String(version)}`);
    }
    return key;
  }

  toString(): string {
    return `Keyring(${this.purpose}, versions ${this.versions.join(',')}, ${REDACTED})`;
  }

  toJSON(): unknown {
    return { purpose: this.purpose, versions: this.versions, activeVersion: this.activeVersion };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** Parses a keyring file. Errors name the line number only, never its content. */
export function parseKeyring(purpose: KeyPurpose, text: string): Keyring {
  const keys = new Map<number, Buffer>();
  let previous = 0;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const where = `${purpose} keyring line ${String(index + 1)}`;
    const match = LINE.exec(line);
    if (match === null) throw new CryptoError(`${where} is not <version>:<base64 32-byte key>`);
    const version = Number(match[1]);
    const key = Buffer.from(match[2] ?? '', 'base64');
    if (key.length !== KEY_BYTES) throw new CryptoError(`${where} does not hold a 32-byte key`);
    if (version <= previous) throw new CryptoError(`${where}: versions must increase`);
    assertKeyVersion(version);
    keys.set(version, key);
    previous = version;
  }
  return new Keyring(purpose, keys);
}

/**
 * Loads a master key from its Docker secret file (`SECRETS_KEK_FILE` or `PII_KEK_FILE`). A value
 * passed directly in the environment is refused, and nothing is ever read from a database (SEC-5,
 * SEC-6).
 */
export function loadKeyring(
  purpose: KeyPurpose,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Keyring {
  return parseKeyring(purpose, readSecretFile(SECRET_NAME[purpose], env));
}

/** A new random KEK line, for generating dev or production secret files. */
export function generateKekLine(version: number): string {
  assertKeyVersion(version);
  return `${String(version)}:${randomBytes(KEY_BYTES).toString('base64')}`;
}
