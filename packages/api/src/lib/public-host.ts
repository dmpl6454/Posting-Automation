/**
 * Resolved-address SSRF checks for user-supplied server URLs.
 *
 * isPublicPageUrl (@postautomation/ai) only inspects the hostname STRING, so a
 * DNS name that resolves to an internal address (a Docker service name such as
 * `minio` / `web`, or an attacker's domain pointed at 10.x) passes it. These
 * helpers check every address the name actually resolves to.
 *
 * Residual: the fetch re-resolves the name, so a DNS-rebinding answer that
 * flips between this check and the connect is not covered.
 */
import { isIP } from "node:net";
import * as dns from "node:dns";

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number) as [number, number, number, number];
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

// Everything that is not public unicast IPv4 (RFC 6890 special-purpose space).
const V4_NON_PUBLIC: Array<[base: string, prefix: number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (also Alibaba's 100.100.100.200 metadata)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // includes Docker bridge networks
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];
const V4_RANGES = V4_NON_PUBLIC.map(([base, prefix]) => {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return { net: (ipv4ToInt(base) & mask) >>> 0, mask };
});

function isPrivateV4(n: number): boolean {
  return V4_RANGES.some(({ net, mask }) => ((n & mask) >>> 0) === net);
}

/** Parse a valid IPv6 literal (no zone) into 8 16-bit groups. */
function parseIPv6(addr: string): number[] | null {
  let s = addr;
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const v4 = s.slice(i + 1);
    if (isIP(v4) !== 4) return null;
    const n = ipv4ToInt(v4);
    s = `${s.slice(0, i + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  let groups = head;
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPrivateV6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => ((g[hi]! << 16) >>> 0) + g[lo]!;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // Forms that carry an IPv4 address: judge the embedded address.
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateV4(v4(6, 7)); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateV4(v4(6, 7)); // NAT64
  if (g[0] === 0x2002) return isPrivateV4(v4(1, 2)); // 6to4
  // Only global unicast 2000::/3 is public. This rejects ::, ::1, IPv4-compatible,
  // fc00::/7 (unique-local), fe80::/10 (link-local), fec0::/10, ff00::/8 and 100::/64.
  if ((g[0]! & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true; // 2001::/23 incl. Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x3fff && g[1]! < 0x1000) return true; // documentation (3fff::/20)
  return false;
}

/**
 * True unless `ip` is a public unicast address. Anything that does not parse as
 * an IP (hostnames, octal/hex tricks, garbage) is treated as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = isIP(addr);
  if (kind === 4) return isPrivateV4(ipv4ToInt(addr));
  if (kind === 6) {
    const groups = parseIPv6(addr);
    return groups ? isPrivateV6(groups) : true;
  }
  return true;
}

export type HostCheck = "public" | "private" | "unresolved";

/** Resolve `hostname` and refuse if ANY address it resolves to is non-public. */
export async function checkHostIsPublic(hostname: string): Promise<HostCheck> {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return "unresolved";
  if (isIP(host)) return isPrivateAddress(host) ? "private" : "public";
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    return "unresolved";
  }
  if (!addresses.length) return "unresolved";
  return addresses.some((a) => isPrivateAddress(a.address)) ? "private" : "public";
}
