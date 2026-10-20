import type { PlatformActor, SessionActor } from '@omnibridge/core';

/**
 * Stand-in session and platform checks for tests and local development, until T-0203 builds the
 * real ones (SEC-3). The caller is read from a test header. It refuses to exist anywhere else:
 * production passes no resolver at all, so session and platform routes answer 401 there.
 */
export const TEST_SESSION_HEADER = 'x-test-session';
export const TEST_PLATFORM_HEADER = 'x-test-platform';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Env = Readonly<Record<string, string | undefined>>;
type Headers = Readonly<Record<string, string | string[] | undefined>>;

export interface StubAuth {
  resolveSession: (request: { headers: Headers }) => SessionActor | undefined;
  resolvePlatform: (request: { headers: Headers }) => PlatformActor | undefined;
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Throws unless OB_ENV is dev or test and NODE_ENV is not production (S1, 20 Oct 2026). */
export function stubAuth(env: Env = process.env): StubAuth {
  if (env.NODE_ENV === 'production' || (env.OB_ENV !== 'dev' && env.OB_ENV !== 'test')) {
    throw new Error(
      'The stub auth runs only with OB_ENV=dev or test and never with NODE_ENV=production',
    );
  }
  return {
    resolveSession: ({ headers }) => {
      const [workspaceId, userId, sessionId, ...rest] = (
        header(headers, TEST_SESSION_HEADER) ?? ''
      ).split(':');
      if (
        rest.length > 0 ||
        workspaceId === undefined ||
        userId === undefined ||
        sessionId === undefined ||
        !UUID.test(workspaceId) ||
        !UUID.test(userId) ||
        !SESSION_ID.test(sessionId)
      ) {
        return undefined;
      }
      return { workspaceId, userId, sessionId };
    },
    resolvePlatform: ({ headers }) => {
      const userId = header(headers, TEST_PLATFORM_HEADER);
      return userId !== undefined && UUID.test(userId) ? { userId } : undefined;
    },
  };
}

/** Request headers that the stub resolves to this session. */
export function sessionHeaders(actor: SessionActor): Record<string, string> {
  return {
    [TEST_SESSION_HEADER]: `${actor.workspaceId}:${actor.userId}:${actor.sessionId}`,
  };
}

/** Request headers that the stub resolves to this platform operator. */
export function platformHeaders(userId: string): Record<string, string> {
  return { [TEST_PLATFORM_HEADER]: userId };
}
