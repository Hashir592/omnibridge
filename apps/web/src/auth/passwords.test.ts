import { describe, expect, it } from 'vitest';
import { commonPasswords, HashGate, isBreached, Passwords, passwordProblems } from './passwords.ts';

const person = { name: 'Sam Admin', email: 'sam.admin@example.test' };

describe('password rules and hashing (USR-3, ADR-050)', () => {
  it('[USR-3] the committed list holds a few hundred common passwords', () => {
    const list = commonPasswords();
    expect(list.size).toBeGreaterThanOrEqual(300);
    for (const p of ['123456', 'password', 'qwerty123', 'iloveyou']) expect(list.has(p)).toBe(true);
  });

  it('[USR-3] breached is case-insensitive and ignores trailing digits and "!"', () => {
    for (const p of ['Password', 'PASSWORD123', 'password!', 'Qwerty123!!', 'iloveyou2026']) {
      expect({ p, breached: isBreached(p) }).toEqual({ p, breached: true });
    }
    for (const p of ['tangerine harbour lantern 47', 'my2password-is-long', '12345678x']) {
      expect({ p, breached: isBreached(p) }).toEqual({ p, breached: false });
    }
  });

  it('[USR-3] a password from the list is rejected with the rule id "breached"; a strong one passes', () => {
    expect(passwordProblems('Password123456!', person)).toEqual(['breached']);
    expect(passwordProblems('tangerine harbour lantern 47', person)).toEqual([]);
  });

  it('[USR-3] at least 12 characters, and never the name or the email local part', () => {
    expect(passwordProblems('short pass', person)).toContain('length');
    expect(passwordProblems('ADMIN rules the sea', person)).toEqual(['personal']);
    expect(passwordProblems('i am sam.admin always', person)).toEqual(['personal']);
    // Name parts shorter than 3 letters do not count.
    expect(passwordProblems('al gore was here 12', { name: 'Al Ng', email: 'x@y.test' })).toEqual(
      [],
    );
  });

  it('[USR-3] hashes are argon2id with the ADR-050 parameters and check both ways', async () => {
    const passwords = new Passwords();
    const h = await passwords.hash('tangerine harbour lantern 47');
    expect(h.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await passwords.check(h, 'tangerine harbour lantern 47')).toBe(true);
    expect(await passwords.check(h, 'tangerine harbour lantern 48')).toBe(false);
    // No stored hash: checked against the dummy, always false.
    expect(await passwords.check(undefined, 'anything at all')).toBe(false);
  });

  it('[USR-5] the hash gate runs at most 4 at once and refuses when its queue is full', async () => {
    const gate = new HashGate(4, 2);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = Array.from({ length: 6 }, () => gate.run(() => held));
    await expect(gate.run(() => Promise.resolve())).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 1,
    });
    release();
    await Promise.all(running);
    expect(gate.peak).toBe(4);
  });
});
