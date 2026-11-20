import { BlockList, isIP } from 'node:net';

/**
 * The networks the platform console may be used from (PLAT-1: "IP allowlist via VPN"). Checked
 * against `request.ip`, the client address Fastify resolves through TRUSTED_PROXIES (the same one
 * the sign-in limits use), never a raw X-Forwarded-For. An empty list allows nobody.
 */
export interface IpAllowlist {
  allows(ip: string): boolean;
}

/** Nobody: the default when PLATFORM_IP_ALLOWLIST is unset or empty. */
export const DENY_ALL: IpAllowlist = { allows: () => false };

/**
 * Parses a comma-separated list of addresses and CIDRs, e.g. `10.8.0.0/24,::1/128`. A bare address
 * is one host. Anything that does not parse throws, so a typo stops the boot instead of opening
 * or closing the console by surprise.
 */
export function parseIpAllowlist(text: string | undefined): IpAllowlist {
  const entries = (text ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  if (entries.length === 0) return DENY_ALL;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefixText, ...rest] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || rest.length > 0) {
      throw new Error(`PLATFORM_IP_ALLOWLIST: "${entry}" is not an address or CIDR`);
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    const max = family === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText ?? String(max)) || prefix > max) {
      throw new Error(`PLATFORM_IP_ALLOWLIST: "${entry}" has a bad prefix length`);
    }
    list.addSubnet(address, prefix, type);
  }
  return {
    allows(ip: string): boolean {
      // An IPv4 client on a dual-stack socket arrives as ::ffff:a.b.c.d.
      const plain = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
      const family = isIP(plain);
      if (family === 0) return false;
      return list.check(plain, family === 4 ? 'ipv4' : 'ipv6');
    },
  };
}
