import { readFileSync } from 'node:fs';

type Env = Readonly<Record<string, string | undefined>>;

/** Returns a required environment variable, or throws naming the variable (never its value). */
export function requireEnv(name: string, env: Env = process.env): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Reads a secret from the file named by `<name>_FILE` (SEC-5). Secrets reach containers only as
 * Docker secret files under /run/secrets, so a plain `<name>` variable holding the value itself is
 * refused rather than silently used.
 *
 * Exactly one trailing newline is dropped, the same as psql's backquote substitution in the role
 * init scripts, and any other surrounding whitespace is refused, so the database and the app can
 * never read two different passwords from one file.
 */
export function readSecretFile(name: string, env: Env = process.env): string {
  if (env[name] !== undefined) {
    throw new Error(
      `${name} must not be set directly; pass ${name}_FILE pointing at a secret file`,
    );
  }
  const value = readFileSync(requireEnv(`${name}_FILE`, env), 'utf8').replace(/\r?\n$/, '');
  if (value === '') {
    throw new Error(`Secret file for ${name} is empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`Secret file for ${name} has leading or trailing whitespace`);
  }
  return value;
}
