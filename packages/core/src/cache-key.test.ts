import { describe, expect, it } from 'vitest';
import { cacheKey, companySetHash, type CompanySetHash } from './cache-key.ts';

const WS_A = '0b9f6a52-4c1e-4f7a-9d35-2f1c8e7a1b01';
const WS_B = '7d2e4c90-1a3b-4e5f-8a6b-9c0d1e2f3a04';
const CO_1 = 'c1a2b3c4-0000-4000-8000-000000000001';
const CO_2 = 'c1a2b3c4-0000-4000-8000-000000000002';

describe('dashboard cache keys (NFR-6)', () => {
  it('[NFR-6] cache key includes workspace and company set', () => {
    const set = companySetHash([CO_1, CO_2]);
    const key = cacheKey({ workspaceId: WS_A, companySet: set, name: 'dashboard.sales' });
    expect(key).toContain(WS_A);
    expect(key).toContain(set);

    expect(cacheKey({ workspaceId: WS_B, companySet: set, name: 'dashboard.sales' })).not.toBe(key);
    const narrower = companySetHash([CO_1]);
    expect(cacheKey({ workspaceId: WS_A, companySet: narrower, name: 'dashboard.sales' })).not.toBe(
      key,
    );
  });

  it('[NFR-6] company set hash ignores order and duplicates but not membership', () => {
    expect(companySetHash([CO_2, CO_1, CO_2])).toBe(companySetHash([CO_1, CO_2]));
    expect(companySetHash([CO_1])).not.toBe(companySetHash([CO_1, CO_2]));
    expect(companySetHash([])).not.toBe(companySetHash([CO_1]));
  });

  it('[NFR-6] refuses to build a key without a workspace or a company-set hash', () => {
    const set = companySetHash([CO_1]);
    expect(() => cacheKey({ workspaceId: '', companySet: set, name: 'x' })).toThrow(/workspace/);
    expect(() =>
      cacheKey({ workspaceId: WS_A, companySet: '' as CompanySetHash, name: 'x' }),
    ).toThrow(/company/);
    // A raw company id (or any string that is not a hash from companySetHash) is refused.
    expect(() =>
      cacheKey({ workspaceId: WS_A, companySet: CO_1 as CompanySetHash, name: 'x' }),
    ).toThrow(/company/);
    expect(() => cacheKey({ workspaceId: WS_A, companySet: set, name: '' })).toThrow(/name/);
  });

  it('[NFR-6] key parts cannot forge another workspace or company segment', () => {
    const set = companySetHash([CO_1]);
    const a = cacheKey({ workspaceId: WS_A, companySet: set, name: 'report', parts: ['a:b'] });
    const b = cacheKey({ workspaceId: WS_A, companySet: set, name: 'report', parts: ['a', 'b'] });
    expect(a).not.toBe(b);
    expect(() => cacheKey({ workspaceId: `${WS_A}:x`, companySet: set, name: 'report' })).toThrow(
      /workspace/,
    );
  });
});
