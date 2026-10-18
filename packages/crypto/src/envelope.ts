import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing shared by data keys (field values) and keyrings (wrapped data keys).
 *
 * Every sealed blob is `[format 0x01][key version: uint32 BE][nonce: 12 bytes][ciphertext][tag: 16]`.
 * The 5-byte header is authenticated together with the caller's AAD, so the version cannot be
 * swapped without the tag failing (SEC-6).
 */
const FORMAT_V1 = 0x01;
const HEADER_BYTES = 5;
const NONCE_BYTES = 12; // 96-bit random nonce, the GCM standard size
const TAG_BYTES = 16;
export const KEY_BYTES = 32; // AES-256

/** Thrown for every crypto failure. The message never carries plaintext, AAD values or keys. */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/** What a field ciphertext is bound to: it decrypts only for the same workspace, table, column and row. */
export interface FieldAad {
  readonly workspaceId: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

/**
 * Encodes AAD parts with a 4-byte length before each, so no two different part lists produce the
 * same bytes (for example table "a_b" + column "c" never equals table "a" + column "b_c").
 */
export function encodeAad(label: string, parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of [label, ...parts]) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

export function assertKeyVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1 || version > 0xffff_ffff) {
    throw new CryptoError('Key versions are integers from 1');
  }
}

/** Reads the key version from a sealed blob's prefix, after checking its format. */
export function ciphertextKeyVersion(blob: Uint8Array): number {
  if (blob.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES || blob[0] !== FORMAT_V1) {
    throw new CryptoError('Unrecognised ciphertext format');
  }
  return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).readUInt32BE(1);
}

export function seal(key: Buffer, version: number, plaintext: Uint8Array, aad: Buffer): Buffer {
  assertKeyVersion(version);
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = FORMAT_V1;
  header.writeUInt32BE(version, 1);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([header, aad]));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, nonce, body, cipher.getAuthTag()]);
}

export function open(key: Buffer, blob: Uint8Array, aad: Buffer): Buffer {
  ciphertextKeyVersion(blob);
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const header = bytes.subarray(0, HEADER_BYTES);
  const nonce = bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const body = bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.concat([header, aad]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CryptoError('Decryption failed: wrong key, wrong AAD or tampered ciphertext');
  }
}
