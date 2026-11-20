import type { FieldAad } from '@omnibridge/crypto';

/** The platform data key now lives in @omnibridge/db (the worker reads app secrets with it). */
export { PlatformKeys, rewrapPlatformKeys } from '@omnibridge/db';

/** Where a TOTP secret is sealed: bound to its user, so it cannot be moved to another row. */
export function totpAad(userId: string): FieldAad {
  return { workspaceId: 'platform', table: 'user_auth', column: 'totp_secret', rowId: userId };
}
