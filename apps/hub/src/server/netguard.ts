/**
 * Csak belső hálóról: a hub minden kérésnél megnézi a kliens címét.
 *
 * Alapból engedett: loopback, a magánhálózati tartományok (RFC 1918), a
 * link-local, a CGNAT-tartomány (Tailscale / WireGuard szokásos címei) és az
 * IPv6 ULA. A HUB_ALLOWED_CIDRS felülírja. Ez a jelszó MELLETT véd  a Docker
 * userland-proxyja mögött a forráscím lehet a híd átjárója (az is magáncím),
 * ezért a valódi védelem a port kötése (HUB_BIND) és a jelszó.
 */

export const DEFAULT_CIDRS = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"];

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!ip.includes(":")) return null;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  if (!ip.includes("::") && h.length !== 8) return null;
  const groups = [...h, ...new Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** A cím normalizálása: zóna-azonosító és IPv4-leképezett IPv6 (::ffff:1.2.3.4) leválasztva. */
export function normalizeIp(raw: string): string {
  let ip = raw.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return ip;
}

export function ipInCidr(rawIp: string, cidr: string): boolean {
  const ip = normalizeIp(rawIp);
  const [base, bitsStr] = cidr.split("/");
  const v4 = ipv4ToInt(ip);
  const b4 = ipv4ToInt(base);
  if (v4 != null && b4 != null) {
    const bits = bitsStr == null ? 32 : Number(bitsStr);
    if (!(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v4 & mask) === (b4 & mask);
  }
  const v6 = ipv6ToBigInt(ip);
  const b6 = ipv6ToBigInt(base);
  if (v6 == null || b6 == null) return false;
  const bits = bitsStr == null ? 128 : Number(bitsStr);
  if (!(bits >= 0 && bits <= 128)) return false;
  const shift = BigInt(128 - bits);
  return v6 >> shift === b6 >> shift;
}

export function ipAllowed(ip: string, cidrs: string[]): boolean {
  if (!ip) return false;
  const list = cidrs.length ? cidrs : DEFAULT_CIDRS;
  return list.some((c) => ipInCidr(ip, c));
}

/**
 * DNS-rebinding ellen: a Host fejléc csak IP-cím, localhost vagy egy kifejezetten
 * engedett név lehet. (Egy rosszindulatú oldal a saját domainjét a hub címére
 * irányíthatja  a böngésző ilyenkor a saját nevét küldi Hostként.)
 */
export function hostAllowed(hostHeader: string | null, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  // [IPv6]:port
  const v6 = /^\[([0-9a-f:.]+)\](:\d+)?$/.exec(h);
  if (v6) return ipv6ToBigInt(normalizeIp(v6[1])) != null || ipv4ToInt(normalizeIp(v6[1])) != null;
  const m = /^([a-z0-9.-]+)(:\d+)?$/.exec(h);
  if (!m) return false;
  const name = m[1];
  if (ipv4ToInt(name) != null) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  return allowedHosts.includes(name);
}
