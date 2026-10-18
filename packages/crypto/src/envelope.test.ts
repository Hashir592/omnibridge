import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ciphertextKeyVersion, CryptoError, type FieldAad } from './envelope.ts';
import { generateDataKey, rewrapDataKey, unwrapDataKey } from './data-key.ts';
import { generateKekLine, parseKeyring } from './keyring.ts';

const WS_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const WS_B = '0b0b0b0b-0000-4000-8000-00000000000b';

const aad = (over: Partial<FieldAad> = {}): FieldAad => ({
  workspaceId: WS_A,
  table: 'credentials',
  column: 'encrypted_value',
  rowId: 'c0c0c0c0-0000-4000-8000-000000000001',
  ...over,
});

const keyring = (lines = [generateKekLine(1)]) => parseKeyring('secrets', lines.join('\n'));

describe('envelope encryption (SEC-6)', () => {
  it('[SEC-6] encrypt/decrypt round trip', () => {
    const { dataKey } = generateDataKey(keyring(), WS_A, 1);
    const plaintext = 'SECRETMARK-synthetic-refresh-token-ä€';
    const ct = dataKey.encrypt(plaintext, aad());
    expect(ct.includes(Buffer.from(plaintext))).toBe(false);
    expect(dataKey.decrypt(ct, aad()).toString('utf8')).toBe(plaintext);

    const bytes = randomBytes(300);
    expect(dataKey.decrypt(dataKey.encrypt(bytes, aad()), aad()).equals(bytes)).toBe(true);
  });

  it('[SEC-6] every ciphertext carries the key-version prefix and a fresh 96-bit nonce', () => {
    const { dataKey } = generateDataKey(keyring(), WS_A, 7);
    const a = dataKey.encrypt('same value', aad());
    const b = dataKey.encrypt('same value', aad());
    expect(ciphertextKeyVersion(a)).toBe(7);
    expect(a[0]).toBe(0x01); // format byte
    // format (1) + key version (4) + nonce (12) + ciphertext + tag (16)
    expect(a.length).toBe(1 + 4 + 12 + 'same value'.length + 16);
    expect(a.subarray(5, 17).equals(b.subarray(5, 17))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it('[SEC-6] tampered ciphertext or wrong AAD fails', () => {
    const { dataKey } = generateDataKey(keyring(), WS_A, 1);
    const ct = dataKey.encrypt('SECRETMARK-tamper-me', aad());

    // Flip one bit in each region: format, key version, nonce, body and tag.
    for (const index of [0, 2, 8, 20, ct.length - 1]) {
      const bad = Buffer.from(ct);
      bad[index] = (bad[index] ?? 0) ^ 0x01;
      expect(() => dataKey.decrypt(bad, aad()), `byte ${String(index)}`).toThrow(CryptoError);
    }
    expect(() => dataKey.decrypt(ct.subarray(0, ct.length - 1), aad())).toThrow(CryptoError);
    expect(() => dataKey.decrypt(Buffer.alloc(10), aad())).toThrow(CryptoError);

    // Each AAD component is bound.
    expect(() => dataKey.decrypt(ct, aad({ table: 'other_table' }))).toThrow(CryptoError);
    expect(() => dataKey.decrypt(ct, aad({ column: 'other_column' }))).toThrow(CryptoError);
    expect(() => dataKey.decrypt(ct, aad({ rowId: 'another-row' }))).toThrow(CryptoError);
    // Length-prefixed encoding: moving characters between components does not collide.
    expect(() =>
      dataKey.decrypt(ct, aad({ table: 'credentials_encrypted', column: 'value' })),
    ).toThrow(CryptoError);

    // Another workspace's data key, even one with the same version, cannot read it.
    const { dataKey: other } = generateDataKey(keyring(), WS_B, 1);
    expect(() => other.decrypt(ct, aad({ workspaceId: WS_B }))).toThrow(CryptoError);
    // A key refuses an AAD for a different workspace before it tries to decrypt.
    expect(() => dataKey.decrypt(ct, aad({ workspaceId: WS_B }))).toThrow(CryptoError);
  });

  it('[SEC-6] decrypt errors never contain the plaintext or key material', () => {
    const { dataKey } = generateDataKey(keyring(), WS_A, 1);
    const ct = dataKey.encrypt('SECRETMARK-error-text', aad());
    const bad = Buffer.from(ct);
    bad[25] = (bad[25] ?? 0) ^ 0xff;
    let caught: unknown;
    try {
      dataKey.decrypt(bad, aad());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    const text = `${String(caught)} ${JSON.stringify(caught)} ${(caught as Error).stack ?? ''}`;
    expect(text).not.toContain('SECRETMARK');
    expect(JSON.stringify(dataKey)).not.toMatch(/[A-Za-z0-9+/]{40,}/);
  });

  it('[SEC-6] KEK rotation re-wraps DEKs and old data still decrypts', () => {
    const v1 = generateKekLine(1);
    const before = keyring([v1]);
    const { dataKey, wrapped } = generateDataKey(before, WS_A, 1);
    const ct = dataKey.encrypt('SECRETMARK-survives-rotation', aad());
    expect(wrapped.kekVersion).toBe(1);

    // Rotation: the new KEK is appended (and becomes active); the data is never touched.
    const v2 = generateKekLine(2);
    const during = keyring([v1, v2]);
    const rewrapped = rewrapDataKey(during, wrapped);
    expect(rewrapped.kekVersion).toBe(2);
    expect(rewrapped.version).toBe(1);
    expect(rewrapped.wrapped.equals(wrapped.wrapped)).toBe(false);

    // After the old KEK is removed, the re-wrapped DEK still opens the old ciphertext.
    const after = keyring([v2]);
    expect(after.versions).toEqual([2]);
    expect(unwrapDataKey(after, rewrapped).decrypt(ct, aad()).toString()).toBe(
      'SECRETMARK-survives-rotation',
    );
    // The old wrapping is unusable without the old KEK.
    expect(() => unwrapDataKey(after, wrapped)).toThrow(CryptoError);
    // Re-wrapping a DEK that is already under the active KEK changes nothing.
    expect(rewrapDataKey(after, rewrapped)).toBe(rewrapped);
  });

  it('[SEC-6] a wrapped DEK is bound to its workspace, purpose and version', () => {
    const line = generateKekLine(1);
    const ring = keyring([line]);
    const { wrapped } = generateDataKey(ring, WS_A, 3);
    expect(wrapped.wrapped.subarray(1, 5).readUInt32BE(0)).toBe(wrapped.kekVersion);
    expect(() => unwrapDataKey(ring, { ...wrapped, workspaceId: WS_B })).toThrow(CryptoError);
    expect(() => unwrapDataKey(ring, { ...wrapped, version: 4 })).toThrow(CryptoError);
    const piiRing = parseKeyring('pii', line);
    expect(() => unwrapDataKey(piiRing, wrapped)).toThrow(CryptoError);
  });
});
