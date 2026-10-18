import { describe, expect, it } from 'vitest';
import { HEARTBEAT_CRON, PACKAGE_NAME } from './index.ts';

describe('@omnibridge/queue', () => {
  it('[NFR-1] stub package is importable', () => {
    expect(PACKAGE_NAME).toBe('@omnibridge/queue');
  });

  it('[NFR-1] heartbeat runs every minute', () => {
    expect(HEARTBEAT_CRON).toBe('* * * * *');
  });
});
