import { describe, expect, it } from 'vitest';
import { DEV_ONLY_DEMO_USER, DEV_ONLY_TOTP_BASE32 } from './dev-seed.ts';
import { base32 } from './totp.ts';

describe('DEV ONLY demo sign-in (USR-4, F-M02h-07)', () => {
  it('[USR-4][AT-3] the documented demo TOTP secret is the seed secret in base32', () => {
    // The same literal is given in docs/reviews/M02-halfway-report.md for an authenticator app.
    expect(base32(DEV_ONLY_DEMO_USER.totpSecret)).toBe('IRCVMLKPJZGFSLKUJ5KFALKTIVBVERKU');
    expect(DEV_ONLY_TOTP_BASE32).toBe('IRCVMLKPJZGFSLKUJ5KFALKTIVBVERKU');
  });
});
