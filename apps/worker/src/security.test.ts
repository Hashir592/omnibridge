import { describe, expect, it } from 'vitest';
import { DEFAULT_SECURITY_THRESHOLDS, securityThresholdsFromEnv } from './security.ts';

describe('security alert thresholds', () => {
  it('[SEC-12] defaults apply when unset; set values are whole positive numbers, anything else stops the worker', () => {
    expect(securityThresholdsFromEnv({})).toEqual(DEFAULT_SECURITY_THRESHOLDS);
    expect(DEFAULT_SECURITY_THRESHOLDS).toEqual({
      loginFailures: 5,
      exportsPerHour: 10,
      piiViewsPerHour: 50,
    });
    expect(
      securityThresholdsFromEnv({
        SECURITY_LOGIN_FAILURES: '3',
        SECURITY_EXPORTS_PER_HOUR: '20',
        SECURITY_PII_VIEWS_PER_HOUR: '',
      }),
    ).toEqual({ loginFailures: 3, exportsPerHour: 20, piiViewsPerHour: 50 });
    for (const bad of ['0', '-1', '2.5', 'ten', '1e3', '1000000']) {
      expect(() => securityThresholdsFromEnv({ SECURITY_EXPORTS_PER_HOUR: bad })).toThrow(
        /SECURITY_EXPORTS_PER_HOUR/,
      );
    }
  });
});
