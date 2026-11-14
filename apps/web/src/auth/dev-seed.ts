import type { Keyring } from '@omnibridge/crypto';
import {
  AuthStore,
  MembershipRepository,
  Tenancy,
  UserRepository,
  type MainDbHandle,
} from '@omnibridge/db';
import type { Passwords } from './passwords.ts';
import { PlatformKeys, totpAad } from './platform-keys.ts';
import { base32, recoveryCodeHmac, totpStep } from './totp.ts';

/**
 * DEV ONLY. The demo sign-in for localhost and the e2e test (T-0203, ADR-050). Every value is
 * synthetic and published here on purpose: it exists only in dev and test databases, because the
 * seed refuses to run anywhere else (seed-dev.ts). Never reuse any of it.
 */
export const DEV_ONLY_DEMO_USER = {
  id: '5eed0000-0000-4000-8000-0000000000d1',
  email: 'demo.admin@example.test',
  name: 'Demo Admin',
  /** DEV ONLY password. */
  password: 'DEV ONLY lantern harbour 2026',
  /** DEV ONLY TOTP secret: 20 bytes, as an authenticator app takes it in base32. */
  totpSecret: Buffer.from('DEV-ONLY-TOTP-SECRET', 'utf8'),
  /** DEV ONLY recovery codes. */
  recoveryCodes: [
    'DEVA-ONLY-AAAA-AAAA',
    'DEVB-ONLY-BBBB-BBBB',
    'DEVC-ONLY-CCCC-CCCC',
    'DEVD-ONLY-DDDD-DDDD',
    'DEVE-ONLY-EEEE-EEEE',
    'DEVF-ONLY-FFFF-FFFF',
    'DEVG-ONLY-GGGG-GGGG',
    'DEVH-ONLY-HHHH-HHHH',
    'DEVI-ONLY-IIII-IIII',
    'DEVJ-ONLY-JJJJ-JJJJ',
  ],
} as const;

/** The seed refuses to run unless OB_ENV is dev or test (S1, ADR-050). */
export function refuseOutsideDev(env: Readonly<Record<string, string | undefined>>): void {
  if (env.OB_ENV !== 'dev' && env.OB_ENV !== 'test') {
    throw new Error('The dev seed runs only with OB_ENV=dev or OB_ENV=test');
  }
}

/** The DEV ONLY TOTP secret as typed into an authenticator app. */
export const DEV_ONLY_TOTP_BASE32 = base32(DEV_ONLY_DEMO_USER.totpSecret);

/**
 * Adds the DEV ONLY demo user to a workspace as its admin, with a password and confirmed MFA.
 * Running it again changes nothing.
 */
export async function seedDemoUser(deps: {
  db: MainDbHandle['db'];
  workspaceId: string;
  keyring: Keyring;
  hmacKey: Buffer;
  passwords: Passwords;
  now?: Date;
}): Promise<{ created: boolean }> {
  const store = new AuthStore(deps.db);
  const demo = DEV_ONLY_DEMO_USER;
  // Read through auth_user, not the sign-in lookup: ob_ops never sees a password hash (ADR-051).
  if ((await store.user(demo.id))?.passwordSetAt != null) return { created: false };
  const now = deps.now ?? new Date();
  // Older than a day, so a password change can be tried at once (USR-3 minimum age).
  const setAt = new Date(now.getTime() - 2 * 24 * 3_600_000);
  await new Tenancy(deps.db).run(
    { workspaceId: deps.workspaceId, companyIds: [], userId: demo.id },
    async (ctx) => {
      if ((await new UserRepository(deps.db).get(ctx, demo.id)) === undefined) {
        await new UserRepository(deps.db).create(ctx, {
          id: demo.id,
          email: demo.email,
          name: demo.name,
        });
      }
      if ((await new MembershipRepository(deps.db).roleOf(ctx)) === undefined) {
        await new MembershipRepository(deps.db).add(ctx, { userId: demo.id, role: 'admin' });
      }
    },
  );
  await store.setPassword(demo.id, await deps.passwords.hash(demo.password), setAt);
  const key = await new PlatformKeys(store, deps.keyring).current();
  await store.setPendingTotp(demo.id, key.encrypt(demo.totpSecret, totpAad(demo.id)), key.version);
  await store.confirmTotp(
    demo.id,
    // An old step: every code from now on is accepted once.
    totpStep(now) - 100,
    demo.recoveryCodes.map((c) => recoveryCodeHmac(deps.hmacKey, demo.id, c)),
    now,
  );
  return { created: true };
}
