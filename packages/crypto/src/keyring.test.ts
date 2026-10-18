import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CryptoError } from './envelope.ts';
import { generateKekLine, loadKeyring, parseKeyring } from './keyring.ts';
import { Secret } from './secret.ts';

const dir = mkdtempSync(join(tmpdir(), 'ob-kek-'));
const writeSecret = (name: string, content: string) => {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
};

describe('master key keyrings (SEC-5, SEC-6)', () => {
  it('[SEC-5] loads each KEK only from its Docker secret file, never from an env value', () => {
    const file = writeSecret('secrets_kek', `${generateKekLine(1)}\n${generateKekLine(2)}\n`);
    const ring = loadKeyring('secrets', { SECRETS_KEK_FILE: file });
    expect(ring.purpose).toBe('secrets');
    expect(ring.versions).toEqual([1, 2]);
    expect(ring.activeVersion).toBe(2);

    const piiFile = writeSecret('pii_kek', generateKekLine(1));
    expect(loadKeyring('pii', { PII_KEK_FILE: piiFile }).purpose).toBe('pii');

    expect(() =>
      loadKeyring('secrets', { SECRETS_KEK: generateKekLine(1), SECRETS_KEK_FILE: file }),
    ).toThrow(/must not be set directly/);
    expect(() => loadKeyring('secrets', {})).toThrow(/SECRETS_KEK_FILE is not set/);
    // The PII keyring is never read from the secrets KEK variable, or the other way round.
    expect(() => loadKeyring('pii', { SECRETS_KEK_FILE: file })).toThrow(/PII_KEK_FILE/);
  });

  it('[SEC-6] refuses malformed, short, duplicate or out-of-order KEK lines', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    const bad = [
      '',
      'not-a-key-line',
      `1:${short}`,
      `0:${Buffer.alloc(32, 1).toString('base64')}`,
      `1:${Buffer.alloc(32, 1).toString('base64')}x`,
      `${generateKekLine(2)}\n${generateKekLine(1)}`,
      `${generateKekLine(1)}\n${generateKekLine(1)}`,
      `${generateKekLine(1)}\n\n${generateKekLine(2)}`,
    ];
    for (const text of bad) {
      expect(() => parseKeyring('secrets', text), JSON.stringify(text.slice(0, 12))).toThrow(
        CryptoError,
      );
    }
  });

  it('[SEC-6] parse errors and the keyring itself never print key material', () => {
    const line = generateKekLine(1);
    const b64 = line.split(':')[1] ?? '';
    const ring = parseKeyring('secrets', line);
    const printed = `${String(ring)} ${JSON.stringify(ring)} ${inspect(ring, { depth: 5 })}`;
    expect(printed).not.toContain(b64);
    let message = '';
    try {
      parseKeyring('secrets', `${line}x`);
    } catch (err) {
      message = String(err);
    }
    expect(message).not.toContain(b64);
  });
});

describe('Secret wrapper (INT-3)', () => {
  it('[INT-3] a Secret prints as [REDACTED] everywhere except reveal()', () => {
    const value = 'SECRETMARK-wrapper-value';
    const secret = new Secret(value);
    expect(secret.reveal()).toBe(value);
    expect(String(secret)).toBe('[REDACTED]');
    expect([secret].join('')).toBe('[REDACTED]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(inspect({ secret }, { depth: 5, showHidden: true })).not.toContain(value);
    expect(Object.keys(secret)).toEqual([]);
  });
});
