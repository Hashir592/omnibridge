import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { generateDataKey } from './data-key.ts';
import { CryptoError } from './envelope.ts';
import { generateIndexKey, unwrapIndexKey } from './index-key.ts';
import { generateKekLine, parseKeyring } from './keyring.ts';

const WS = '0196d7f2-0000-7000-8000-000000000001';
const OTHER = '0196d7f2-0000-7000-8000-000000000002';

describe('blind-index keys', () => {
  const pii = parseKeyring('pii', generateKekLine(1));

  it('[DP-7] the same value under the same key and field gives the same MAC; field and workspace keep them apart', () => {
    const { indexKey, wrapped } = generateIndexKey(pii, WS, 1);
    const again = unwrapIndexKey(pii, wrapped);
    expect(again.mac('postcode', 'G21AA')).toEqual(indexKey.mac('postcode', 'G21AA'));
    expect(indexKey.mac('postcode', 'G21AA')).toHaveLength(32);
    expect(indexKey.mac('name', 'G21AA')).not.toEqual(indexKey.mac('postcode', 'G21AA'));
    const other = generateIndexKey(pii, OTHER, 1).indexKey;
    expect(other.mac('postcode', 'G21AA')).not.toEqual(indexKey.mac('postcode', 'G21AA'));
  });

  it('[DP-6] an index key is wrapped by the PII KEK only and never opens as another workspace key', () => {
    const secrets = parseKeyring('secrets', generateKekLine(1));
    expect(() => generateIndexKey(secrets, WS, 1)).toThrow(CryptoError);
    const { wrapped } = generateIndexKey(pii, WS, 1);
    expect(() => unwrapIndexKey(pii, { ...wrapped, workspaceId: OTHER })).toThrow();
    // A wrapped data key never opens as an index key (different AAD label).
    const data = generateDataKey(pii, WS, 1).wrapped;
    expect(() => unwrapIndexKey(pii, data)).toThrow();
  });

  it('[DP-6] key bytes are never printed', () => {
    const { indexKey } = generateIndexKey(pii, WS, 1);
    expect(String(indexKey)).toContain('[REDACTED]');
    expect(inspect(indexKey)).toContain('[REDACTED]');
    expect(JSON.stringify(indexKey)).toBe(JSON.stringify({ workspaceId: WS, version: 1 }));
    expect(() => indexKey.mac('name', '')).toThrow(CryptoError);
  });
});
