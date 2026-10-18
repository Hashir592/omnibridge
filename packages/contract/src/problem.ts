import { ERROR_CODES } from '@omnibridge/core';
import { z } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * RFC 9457 problem details, plus a stable `code` that clients branch on. `type` is
 * `about:blank`, so `title` is the HTTP status phrase. Never carries buyer PII or internals.
 */
export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: z.enum(ERROR_CODES),
    detail: z.string().optional(),
    /** Quote it to support; it matches the server's log line. */
    request_id: z.string().optional(),
    /** Present on `validation_failed`: one entry per invalid field. */
    errors: z
      .array(
        z.object({
          location: z.enum(['params', 'query', 'body', 'headers']),
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof ProblemSchema>;
