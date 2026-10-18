import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.ts';

describe('ApiError', () => {
  it('[NFR-1] carries an HTTP error status and a stable code', () => {
    const error = new ApiError({ status: 404, code: 'not_found', detail: 'No order.' });
    expect(error).toMatchObject({ status: 404, code: 'not_found', detail: 'No order.' });
    expect(() => new ApiError({ status: 302, code: 'conflict' })).toThrow(RangeError);
    expect(() => new ApiError({ status: 600, code: 'internal_error' })).toThrow(RangeError);
  });
});
