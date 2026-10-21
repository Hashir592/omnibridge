import { readFileSync } from 'node:fs';
import { hash, verify } from '@node-rs/argon2';
import { ApiError } from '@omnibridge/core';

/**
 * argon2 parameters (ADR-050): 19 MiB, 2 passes, 1 lane. The algorithm is the library's default,
 * argon2id; the database refuses any other hash (`$argon2id$` check, migration 0011).
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** The USR-3 rule ids the SPA shows (apps/ui/src/auth/shapes.ts, ADR-048). */
export type PasswordRule = 'length' | 'personal' | 'breached' | 'history' | 'min_age';

export const MIN_LENGTH = 12;
export const MIN_AGE_MS = 24 * 3_600_000;
export const MAX_AGE_MS = 365 * 24 * 3_600_000;

/**
 * At most `limit` argon2 hashes at once per web process (ADR-050), each holding 19 MiB, so a
 * flood of sign-ins cannot run web out of memory. The rest wait in a bounded queue; a full queue
 * answers 429 rate_limited.
 */
export class HashGate {
  readonly #limit: number;
  readonly #maxQueue: number;
  readonly #waiting: (() => void)[] = [];
  #running = 0;
  /** The most hashes seen running at once (tests). */
  peak = 0;

  constructor(limit = 4, maxQueue = 32) {
    this.#limit = limit;
    this.#maxQueue = maxQueue;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#limit) {
      if (this.#waiting.length >= this.#maxQueue) {
        throw new ApiError({
          status: 429,
          code: 'rate_limited',
          detail: 'Too many sign-ins at once. Try again in a moment.',
          retryAfterSeconds: 1,
        });
      }
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#running += 1;
    this.peak = Math.max(this.peak, this.#running);
    try {
      return await fn();
    } finally {
      this.#running -= 1;
      this.#waiting.shift()?.();
    }
  }
}

/** argon2id hashing and checking, through the gate. */
export class Passwords {
  readonly #gate: HashGate;
  /** A real hash of nothing anyone knows: an unknown email costs the same as a wrong password. */
  readonly #dummy: Promise<string>;

  constructor(gate: HashGate = new HashGate()) {
    this.#gate = gate;
    this.#dummy = hash(`dummy-${String(Math.random())}`, ARGON2_OPTIONS);
  }

  get gate(): HashGate {
    return this.#gate;
  }

  hash(password: string): Promise<string> {
    return this.#gate.run(() => hash(password, ARGON2_OPTIONS));
  }

  /** Checks a password; with no stored hash, checks against the dummy and returns false. */
  async check(stored: string | undefined, password: string): Promise<boolean> {
    const target = stored ?? (await this.#dummy);
    const ok = await this.#gate.run(() => verify(target, password).catch(() => false));
    return stored !== undefined && ok;
  }

  /** True when `password` matches any of the hashes (the history rule). */
  async matchesAny(hashes: readonly string[], password: string): Promise<boolean> {
    for (const h of hashes) {
      if (await this.check(h, password)) return true;
    }
    return false;
  }
}

let common: ReadonlySet<string> | undefined;

/** The committed common-password list (apps/web/data), read once. */
export function commonPasswords(): ReadonlySet<string> {
  if (common === undefined) {
    const text = readFileSync(new URL('../../data/common-passwords.txt', import.meta.url), 'utf8');
    common = new Set(
      text
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
  }
  return common;
}

/** On the list, case-insensitively, also with trailing digits and "!" stripped. */
export function isBreached(password: string, list: ReadonlySet<string> = commonPasswords()) {
  const lower = password.trim().toLowerCase();
  const base = lower.replace(/[0-9!]+$/, '');
  return list.has(lower) || (base !== '' && list.has(base));
}

/**
 * The rules that need no stored data (USR-3): length, the user's name or email local part, and
 * the common-password list. History and minimum age are checked by the caller.
 */
export function passwordProblems(
  password: string,
  person: { name: string; email: string },
): PasswordRule[] {
  const problems: PasswordRule[] = [];
  if (Array.from(password).length < MIN_LENGTH) problems.push('length');
  const lower = password.toLowerCase();
  const local = person.email.split('@')[0]?.toLowerCase() ?? '';
  const nameParts = person.name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length >= 3);
  if ((local.length >= 3 && lower.includes(local)) || nameParts.some((p) => lower.includes(p))) {
    problems.push('personal');
  }
  if (isBreached(password)) problems.push('breached');
  return problems;
}

/** 422 validation_failed with one `password` entry per broken rule (ADR-048). */
export function passwordRejected(rules: readonly PasswordRule[], path = 'password'): ApiError {
  return new ApiError({
    status: 422,
    code: 'validation_failed',
    detail: 'The password does not meet the rules',
    errors: rules.map((rule) => ({ location: 'body', path, message: rule })),
  });
}
