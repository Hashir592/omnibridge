import { describe, expect, it } from 'vitest';
import { API_PREFIX, isRootPath, mountedPath } from './mount.ts';

// ADR-060
describe('route mounting', () => {
  it('[SEC-3] serves contract routes under /api, keeping their own paths', () => {
    expect(API_PREFIX).toBe('/api');
    expect(mountedPath('/users')).toBe('/api/users');
    expect(mountedPath('/auth/invites/:token')).toBe('/api/auth/invites/:token');
  });

  it('[SEC-3] keeps only the PRD-fixed paths at the root', () => {
    for (const path of [
      '/healthz',
      '/webhooks/ebay/account-deletion',
      '/connect/:channel/callback',
      '/connect/ebay/declined',
    ]) {
      expect({ path, root: isRootPath(path) }).toEqual({ path, root: true });
    }
    for (const path of [
      '/healthz/x',
      '/webhooks',
      '/connect/ebay',
      '/connect/ebay/start',
      '/users',
    ]) {
      expect({ path, root: isRootPath(path) }).toEqual({ path, root: false });
    }
  });
});
