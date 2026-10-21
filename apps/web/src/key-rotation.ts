import type { DataKeyTotals } from '@omnibridge/db';
import type { FileKeyStore } from '@omnibridge/files';
import type { Logger } from '@omnibridge/logger';

export interface KeyCounts {
  rewrapped: number;
  /** Still under an older KEK than the active one, counted after the re-wrap. */
  stale: number;
  /** Under a newer KEK than this process holds: left alone, and the rotation is not done. */
  newer: number;
}

export interface RotationReport {
  /** True only when no data key and no file key is under any KEK but the active one. */
  done: boolean;
  kekVersion: number;
  dataKeys: DataKeyTotals;
  fileKeys: KeyCounts;
}

/**
 * The all-workspace KEK re-wrap (SEC-6, F-03, PS-015 (2), R2-02): the data keys of every
 * workspace in db-main, then the file keys on the volume. Re-wrapping changes no data and no file
 * body. The old keyring line may be removed only when this reports `done`.
 */
export async function rotateKeys(deps: {
  kekVersion: number;
  dataKeys: () => Promise<DataKeyTotals>;
  fileKeys: Pick<FileKeyStore, 'rewrapAll' | 'countStale' | 'countNewer'>;
  logger: Logger;
}): Promise<RotationReport> {
  const log = deps.logger.child({ component: 'key-rotation' });
  const dataKeys = await deps.dataKeys();
  const fileKeys: KeyCounts = {
    rewrapped: await deps.fileKeys.rewrapAll(),
    stale: await deps.fileKeys.countStale(),
    newer: await deps.fileKeys.countNewer(),
  };
  const done =
    dataKeys.stale === 0 && dataKeys.newer === 0 && fileKeys.stale === 0 && fileKeys.newer === 0;
  const kekVersion = deps.kekVersion;
  log.info(
    { event: 'data_keys.rewrapped', kekVersion, count: dataKeys.rewrapped },
    'data keys of every workspace re-wrapped',
  );
  log.info(
    { event: 'file_keys.rewrapped', kekVersion, count: fileKeys.rewrapped },
    'file keys re-wrapped',
  );
  for (const [event, count, msg] of [
    [
      'data_keys.stale',
      dataKeys.stale,
      'data keys still under an old KEK: keep the old keyring line',
    ],
    [
      'file_keys.stale',
      fileKeys.stale,
      'file keys still under an old KEK: keep the old keyring line',
    ],
    [
      'data_keys.newer_kek',
      dataKeys.newer,
      'data keys under a newer KEK than this keyring: run it with the new keyring',
    ],
    [
      'file_keys.newer_kek',
      fileKeys.newer,
      'file keys under a newer KEK than this keyring: run it with the new keyring',
    ],
  ] as const) {
    if (count > 0) log.error({ event, kekVersion, count }, msg);
  }
  if (done) log.info({ event: 'key_rotation.done', kekVersion }, 'no key is left under an old KEK');
  return { done, kekVersion, dataKeys, fileKeys };
}

/**
 * The database's data keys in one count: every workspace's, plus the platform key that seals
 * the TOTP secrets (T-0203). The rotation is done only when neither is left under an old KEK.
 */
export function withPlatformKeys(
  workspaces: DataKeyTotals,
  platform: Omit<DataKeyTotals, 'workspaces'>,
): DataKeyTotals {
  return {
    workspaces: workspaces.workspaces,
    rewrapped: workspaces.rewrapped + platform.rewrapped,
    stale: workspaces.stale + platform.stale,
    newer: workspaces.newer + platform.newer,
  };
}
