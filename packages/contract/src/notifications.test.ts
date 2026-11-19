import { NOTIFICATION_TABS, NOTIFICATION_TYPES } from '@omnibridge/core';
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_TABS, TABS } from './metadata.ts';

describe('notification tabs', () => {
  it('[NTF-2] the tabs a notification can belong to are exactly the app tabs, so ticks decide who sees it', () => {
    expect([...NOTIFICATION_TABS].sort()).toEqual(TABS.filter((t) => t !== 'none').sort());
    // Types on an admin-only tab reach admins only (a child can never tick those tabs).
    const adminOnly = NOTIFICATION_TYPES.filter((t) =>
      (ADMIN_ONLY_TABS as readonly string[]).includes(t.tab ?? ''),
    ).map((t) => t.code);
    expect(adminOnly.sort()).toEqual([
      'channel.auth_lost',
      'channel.deletion_scheduled',
      'users.access_review_due',
    ]);
  });
});
