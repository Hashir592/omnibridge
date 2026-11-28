import type { FieldAad } from '@omnibridge/crypto';
import { Secret } from '@omnibridge/crypto';
import { sql, type Kysely } from 'kysely';
import { PLATFORM_KEY_SCOPE, type PlatformKeys } from './platform-keys.ts';
import type { MainDb } from './schema.ts';

/**
 * Every app secret the store accepts (PLAT-4), one per row of docs/ops/secrets-register.md. A
 * typo is a type error here and a 404 at the route, never a slot nobody reads.
 */
export const APP_SECRET_NAMES = [
  'amazon.lwa_client_id',
  'amazon.lwa_client_secret',
  'ads.client_id',
  'ads.client_secret',
  'ebay.client_id',
  'ebay.client_secret',
  'ebay.dev_id',
  'ebay.verification_token',
  // EVRI-1, EVRI-2 (T-1201): the platform's client credentials, shared by every Evri account.
  'evri.client_id',
  'evri.client_secret',
] as const;
export type AppSecretName = (typeof APP_SECRET_NAMES)[number];
export type AppSecretSlot = 'current' | 'next';

const KNOWN: ReadonlySet<string> = new Set(APP_SECRET_NAMES);

export function isAppSecretName(name: string): name is AppSecretName {
  return KNOWN.has(name);
}

/** AMZ-10: Amazon's LWA client secret expires this long after it is set. */
export const LWA_SECRET_LIFETIME_DAYS = 180;

/** What the console sees of one secret: when each slot was set, never the value. */
export interface AppSecretStatus {
  name: AppSecretName;
  current: { setAt: Date } | null;
  next: { setAt: Date } | null;
}

/** The value is sealed to its name: ciphertext copied under another name does not open. */
function aad(name: AppSecretName): FieldAad {
  return { workspaceId: PLATFORM_KEY_SCOPE, table: 'app_secrets', column: 'value', rowId: name };
}

/**
 * The app secrets store (T-0505: PLAT-4, SEC-6). Values go in and come out only as `Secret`,
 * sealed with AES-256-GCM under the platform data key, which the secrets master key wraps. Writes
 * and the name list are console-only (checked again in the database); `get` is the typed reader
 * for the provider modules (M07 onwards) and the OAuth code exchange.
 */
export class AppSecretStore {
  readonly #db: Kysely<MainDb>;
  readonly #keys: Pick<PlatformKeys, 'current' | 'version'>;

  constructor(db: Kysely<MainDb>, keys: Pick<PlatformKeys, 'current' | 'version'>) {
    this.#db = db;
    this.#keys = keys;
  }

  /** Sets one slot (write-only); the audit row in the same call holds the name and slot. */
  async set(
    userId: string,
    name: AppSecretName,
    slot: AppSecretSlot,
    value: Secret,
    now: Date,
    ip: string | null,
  ): Promise<void> {
    if (!isAppSecretName(name)) throw new Error('Unknown app secret');
    const key = await this.#keys.current();
    const sealed = key.encrypt(value.reveal(), aad(name));
    await sql`
      SELECT app.app_secret_put(${userId}::uuid, ${name}, ${slot}, ${sealed}, ${key.version},
                                ${now}, ${ip}::inet)`.execute(this.#db);
  }

  /** Every known name with the set-on date of each slot. */
  async list(userId: string): Promise<AppSecretStatus[]> {
    const { rows } = await sql<{ name: string; slot: AppSecretSlot; set_at: Date }>`
      SELECT * FROM app.app_secret_list(${userId}::uuid)`.execute(this.#db);
    return APP_SECRET_NAMES.map((name) => {
      const at = (slot: AppSecretSlot) => {
        const row = rows.find((r) => r.name === name && r.slot === slot);
        return row === undefined ? null : { setAt: row.set_at };
      };
      return { name, current: at('current'), next: at('next') };
    });
  }

  /** Promotes `next` to `current`; false when there is no next value. */
  async promote(userId: string, name: AppSecretName, now: Date, ip: string | null) {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT app.app_secret_promote(${userId}::uuid, ${name}, ${now}, ${ip}::inet) AS ok`.execute(
      this.#db,
    );
    return rows[0]?.ok === true;
  }

  /** The value of one slot, or undefined when it is not set. */
  async get(name: AppSecretName, slot: AppSecretSlot = 'current'): Promise<Secret | undefined> {
    if (!isAppSecretName(name)) throw new Error('Unknown app secret');
    const { rows } = await sql<{ ciphertext: Buffer; key_version: string }>`
      SELECT ciphertext, key_version FROM app.app_secret_read(${name}, ${slot})`.execute(this.#db);
    const row = rows[0];
    if (row === undefined) return undefined;
    const key = await this.#keys.version(Number(row.key_version));
    return new Secret(key.decrypt(row.ciphertext, aad(name)).toString('utf8'));
  }
}
