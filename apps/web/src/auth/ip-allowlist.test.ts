import { describe, expect, it } from 'vitest';
import { DENY_ALL, parseIpAllowlist } from './ip-allowlist.ts';

describe('platform console IP allowlist (PLAT-1)', () => {
  it('[PLAT-1] an unset or empty list denies every address', () => {
    for (const text of [undefined, '', ' , ']) {
      const list = parseIpAllowlist(text);
      expect(list.allows('127.0.0.1')).toBe(false);
      expect(list.allows('::1')).toBe(false);
    }
    expect(DENY_ALL.allows('10.0.0.1')).toBe(false);
  });

  it('[PLAT-1] matches addresses and CIDRs of both families', () => {
    const list = parseIpAllowlist('127.0.0.1/32, ::1/128, 10.8.0.0/24, 2001:db8::/64, 192.0.2.7');
    expect(list.allows('127.0.0.1')).toBe(true);
    expect(list.allows('::ffff:127.0.0.1')).toBe(true);
    expect(list.allows('::1')).toBe(true);
    expect(list.allows('10.8.0.200')).toBe(true);
    expect(list.allows('10.8.1.1')).toBe(false);
    expect(list.allows('2001:db8::1234')).toBe(true);
    expect(list.allows('2001:db8:0:1::1')).toBe(false);
    expect(list.allows('192.0.2.7')).toBe(true);
    expect(list.allows('192.0.2.8')).toBe(false);
    expect(list.allows('not an ip')).toBe(false);
  });

  it('[PLAT-1] a malformed entry stops the boot', () => {
    expect(() => parseIpAllowlist('10.0.0.0/33')).toThrow(/prefix/);
    expect(() => parseIpAllowlist('example.test')).toThrow(/not an address/);
    expect(() => parseIpAllowlist('10.0.0.0/8/1')).toThrow(/not an address/);
    expect(() => parseIpAllowlist('10.0.0.0/x')).toThrow(/prefix/);
  });
});
