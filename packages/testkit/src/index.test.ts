import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, PII_MARKER, POSTGRES_IMAGE } from './index.ts';

describe('@omnibridge/testkit', () => {
  it('[NFR-1] stub package is importable', () => {
    expect(PACKAGE_NAME).toBe('@omnibridge/testkit');
  });

  it('[DP-8] synthetic PII uses the PIIMARK- prefix', () => {
    expect(PII_MARKER).toBe('PIIMARK-');
  });

  it('[NFR-2] integration tests use PostgreSQL 18.6 pinned by digest', () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18\.6@sha256:[0-9a-f]{64}$/);
  });
});
