import {
  generateDataKey,
  rewrapDataKey,
  unwrapDataKey,
  type DataKey,
  type Keyring,
} from '@omnibridge/crypto';
import type { AuthStore } from './auth.ts';
import type { DataKeyTotals } from './rewrap.ts';

/** The AAD "workspace" of the platform key: it belongs to no workspace. */
export const PLATFORM_KEY_SCOPE = 'platform';
const PLATFORM = PLATFORM_KEY_SCOPE;

/**
 * The platform data key (migration 0011): seals what belongs to no workspace, the TOTP secrets
 * (a person's) and the app secrets (PLAT-4, migration 0034). Wrapped by the secrets KEK like the workspace keys, made on first use.
 */
export class PlatformKeys {
  readonly #store: Pick<AuthStore, 'platformKeys' | 'insertPlatformKey'>;
  readonly #keyring: Keyring;
  readonly #open = new Map<number, DataKey>();

  constructor(store: Pick<AuthStore, 'platformKeys' | 'insertPlatformKey'>, keyring: Keyring) {
    this.#store = store;
    this.#keyring = keyring;
  }

  /** The newest key, made (version 1) if there is none yet. */
  async current(): Promise<DataKey> {
    const [latest] = await this.#store.platformKeys();
    if (latest !== undefined) return this.#unwrap(latest);
    const { wrapped } = generateDataKey(this.#keyring, PLATFORM, 1);
    // Two processes may race to make it: the database keeps the first, both then read that one.
    await this.#store.insertPlatformKey({
      version: 1,
      kekVersion: wrapped.kekVersion,
      wrapped: wrapped.wrapped,
    });
    const [made] = await this.#store.platformKeys(1);
    if (made === undefined) throw new Error('The platform key could not be stored');
    return this.#unwrap(made);
  }

  async version(version: number): Promise<DataKey> {
    const cached = this.#open.get(version);
    if (cached !== undefined) return cached;
    const [row] = await this.#store.platformKeys(version);
    if (row === undefined) throw new Error(`Platform key version ${String(version)} is missing`);
    return this.#unwrap(row);
  }

  #unwrap(row: { version: number; kekVersion: number; wrapped: Buffer }): DataKey {
    const cached = this.#open.get(row.version);
    if (cached !== undefined) return cached;
    const key = unwrapDataKey(this.#keyring, {
      workspaceId: PLATFORM,
      version: row.version,
      kekVersion: row.kekVersion,
      wrapped: row.wrapped,
    });
    this.#open.set(row.version, key);
    return key;
  }
}

/** KEK rotation for the platform keys (SEC-6), counted like the workspace data keys. */
export async function rewrapPlatformKeys(
  store: Pick<AuthStore, 'platformKeys' | 'rewrapPlatformKey'>,
  keyring: Keyring,
): Promise<Omit<DataKeyTotals, 'workspaces'>> {
  const active = keyring.activeVersion;
  let rewrapped = 0;
  for (const row of await store.platformKeys()) {
    if (row.kekVersion >= active) continue;
    const moved = rewrapDataKey(keyring, {
      workspaceId: PLATFORM,
      version: row.version,
      kekVersion: row.kekVersion,
      wrapped: row.wrapped,
    });
    await store.rewrapPlatformKey({
      version: row.version,
      kekVersion: moved.kekVersion,
      wrapped: moved.wrapped,
    });
    rewrapped += 1;
  }
  const after = await store.platformKeys();
  return {
    rewrapped,
    stale: after.filter((r) => r.kekVersion < active).length,
    newer: after.filter((r) => r.kekVersion > active).length,
  };
}
