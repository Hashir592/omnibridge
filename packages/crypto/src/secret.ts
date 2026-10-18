import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * A decrypted credential. It prints as `[REDACTED]` through String(), JSON (so pino) and
 * util.inspect; only `reveal()` returns the value, at the point it is sent to a provider (INT-3).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
