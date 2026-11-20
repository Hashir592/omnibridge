import type { Provider } from '@omnibridge/core';
import type { z } from 'zod';
import { ProviderParserError } from './errors.ts';

/** A versioned response parser (INT-5): unknown fields are stripped, a missing one throws. */
export interface VersionedParser<T> {
  readonly provider: Provider;
  readonly name: string;
  readonly version: number;
  parse(data: unknown): T;
}

const NAME = /^[a-z][a-z0-9_]{0,23}$/;

/** Keys and array positions as a path, with every index written `[]`: no row-specific data. */
function pathOf(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += '[]';
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out === '' ? '(root)' : out;
}

/**
 * Declares a parser. Schemas must use plain (stripping) objects, never `.strict()`, so a field the
 * provider adds later is ignored. The error keeps the path only, never the Zod issue or input.
 */
export function defineParser<S extends z.ZodType>(
  provider: Provider,
  name: string,
  version: number,
  schema: S,
): VersionedParser<z.output<S>> {
  if (!NAME.test(name)) throw new Error(`Parser name ${name} must be short snake_case`);
  if (!Number.isInteger(version) || version < 1) throw new Error('Parser version must be 1 or more');
  return {
    provider,
    name,
    version,
    parse(data) {
      const result = schema.safeParse(data);
      if (result.success) return result.data;
      const issue = result.error.issues[0];
      throw new ProviderParserError(provider, name, version, pathOf(issue?.path ?? []));
    },
  };
}

/** The platform notice record kind for a parser (`platform.report_failure`); its id is the version. */
export function parserRecordKind(parser: { provider: Provider; name: string }): string {
  return `parser_${parser.provider}_${parser.name}`.slice(0, 40);
}
