import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.ts';

describe('@omnibridge/governor-ebay', () => {
  it('[NFR-1] stub package is importable', () => {
    expect(PACKAGE_NAME).toBe('@omnibridge/governor-ebay');
  });
});
