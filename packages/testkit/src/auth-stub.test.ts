import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { platformHeaders, sessionHeaders, stubAuth } from './auth-stub.ts';

describe('stub auth until T-0203 (SEC-3)', () => {
  it('[SEC-3] the stub refuses to start in production or outside dev and test', () => {
    for (const env of [
      {},
      { OB_ENV: 'prod' },
      { OB_ENV: 'staging' },
      { OB_ENV: 'test', NODE_ENV: 'production' },
      { OB_ENV: 'dev', NODE_ENV: 'production' },
    ]) {
      expect(() => stubAuth(env)).toThrow(/stub auth/);
    }
    expect(() => stubAuth({ OB_ENV: 'test', NODE_ENV: 'test' })).not.toThrow();
    expect(() => stubAuth({ OB_ENV: 'dev' })).not.toThrow();
  });

  it('[SEC-3] the stub reads actors only from its test headers and refuses malformed ones', () => {
    const auth = stubAuth({ OB_ENV: 'test' });
    const actor = { workspaceId: randomUUID(), userId: randomUUID(), sessionId: 'session-1' };
    expect(auth.resolveSession({ headers: sessionHeaders(actor) })).toEqual(actor);
    expect(auth.resolvePlatform({ headers: sessionHeaders(actor) })).toBeUndefined();
    const admin = randomUUID();
    expect(auth.resolvePlatform({ headers: platformHeaders(admin) })).toEqual({ userId: admin });
    expect(auth.resolveSession({ headers: platformHeaders(admin) })).toBeUndefined();
    expect(auth.resolveSession({ headers: {} })).toBeUndefined();
    for (const bad of ['', 'x:y:z', `${actor.workspaceId}:${actor.userId}`, ['a', 'b']]) {
      expect(auth.resolveSession({ headers: { 'x-test-session': bad } })).toBeUndefined();
    }
    expect(auth.resolvePlatform({ headers: { 'x-test-platform': 'not-a-uuid' } })).toBeUndefined();
  });
});
