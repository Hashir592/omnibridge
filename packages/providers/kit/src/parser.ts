import type { Provider } from '@omnibridge/core';
import { z } from 'zod';
import type { SetAside, SetAsideReason } from './adapters.ts';
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
  if (!Number.isInteger(version) || version < 1)
    throw new Error('Parser version must be 1 or more');
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

/**
 * Free text a person typed (a title, a buyer's instructions): NUL removed, which PostgreSQL cannot
 * store, and cut to its limit rather than refused (S5-20261124-07).
 */
export const freeText = (max: number) =>
  z.string().transform((s) => s.replaceAll('\u0000', '').slice(0, max));

/** An ID or SKU: NUL removed, then at least one character and at most `max`. */
export const cleanId = (max: number) =>
  z
    .string()
    .transform((s) => s.replaceAll('\u0000', ''))
    .pipe(z.string().min(1).max(max));

/**
 * Parses each item of a page on its own (F-M10-end-14, -17, S5-20261124-07): one that fails is set
 * aside with a reason, and the rest of the page is kept. The page itself must still parse.
 */
export function parseEach<T>(
  parser: VersionedParser<T>,
  items: readonly unknown[],
  options: {
    /** The item's ID field and its limit: db-main keys a buyer by `<account>:<id>` in 200. */
    id: { field: string; max: number };
    /** The item's lines: none is a reason of its own. */
    linesField: string;
  },
): { items: T[]; setAside: SetAside[] } {
  const out: T[] = [];
  const setAside: SetAside[] = [];
  for (const raw of items) {
    const fields: Readonly<Record<string, unknown>> =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const rawId = fields[options.id.field];
    const externalId = typeof rawId === 'string' && rawId !== '' ? rawId.slice(0, 200) : null;
    const lines = fields[options.linesField];
    if (typeof rawId === 'string' && rawId.length > options.id.max) {
      setAside.push({ externalId, reason: 'id_too_long' });
    } else if (Array.isArray(lines) && lines.length === 0) {
      setAside.push({ externalId, reason: 'no_lines' });
    } else {
      try {
        out.push(parser.parse(raw));
      } catch (err) {
        if (!(err instanceof ProviderParserError)) throw err;
        const reason: SetAsideReason = /(^|\.)currency$/.test(err.path) ? 'not_gbp' : 'unreadable';
        setAside.push({ externalId, reason });
      }
    }
  }
  return { items: out, setAside };
}

/** The platform notice record kind for a parser (`platform.report_failure`); its id is the version. */
export function parserRecordKind(parser: { provider: Provider; name: string }): string {
  return `parser_${parser.provider}_${parser.name}`.slice(0, 40);
}
