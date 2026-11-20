import { APP_SECRET_NAMES as CONTRACT_NAMES } from '@omnibridge/contract';
import { APP_SECRET_NAMES as STORE_NAMES } from '@omnibridge/db';
import { describe, expect, it } from 'vitest';

describe('app secret names (PLAT-4)', () => {
  it('[PLAT-4] the contract and the store accept exactly the same app secret names', () => {
    // The contract cannot import packages/db, so each keeps its list; this keeps them equal.
    expect([...CONTRACT_NAMES].sort()).toEqual([...STORE_NAMES].sort());
  });
});
