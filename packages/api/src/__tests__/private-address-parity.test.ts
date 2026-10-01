/**
 * isPrivateAddress exists twice: the canonical copy in @postautomation/social
 * (used to vet DNS answers before connecting) and a replica in
 * @postautomation/ai (its URL string guards), because ai has no workspace
 * dependencies. If they ever disagree, one of the guards is wrong. This test
 * lives in api because api depends on both.
 */
import { describe, it, expect } from "vitest";
import { isPrivateAddress as canonical } from "@postautomation/social/src/utils/public-address";
import { isPrivateAddress as replica } from "@postautomation/ai/src/utils/private-address";

function boundaries(): string[] {
  const out: string[] = [];
  const ranges: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  const toInt = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const toIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  for (const [base, prefix] of ranges) {
    const start = toInt(base);
    const end = start + 2 ** (32 - prefix) - 1;
    for (const n of [start - 1, start, start + 1, end - 1, end, end + 1]) {
      if (n >= 0 && n <= 0xffffffff) out.push(toIp(n));
    }
  }
  // Deterministic spread over the whole IPv4 space.
  let x = 12345;
  for (let i = 0; i < 20000; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out.push(toIp(x));
  }
  return out;
}

const V6 = [
  "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:8.8.8.8", "64:ff9b::a9fe:a9fe",
  "64:ff9b::808:808", "2002:a9fe:a9fe::", "2002:808:808::", "fd00::1", "fc00::", "fe80::1", "fec0::1", "ff02::1",
  "100::1", "2001::1", "2001:db8::1", "2001:4860:4860::8888", "2606:4700::1111", "3fff::1", "3fff:1000::1",
  "[2606:4700::1111]", "fe80::1%eth0", "::127.0.0.1", "1:2:3:4:5:6:7:8:9", "2001:db8:::1",
];
const JUNK = ["", "localhost", "example.com", "0x7f000001", "017700000001", "999.1.1.1", "1.2.3", " 8.8.8.8 ", "ffff::g"];

// IPv6: first, last, and the neighbours of every prefix the rules special-case,
// plus a seeded sample biased into those prefixes and embedded-IPv4 forms.
const V6_PREFIXES: Array<[string, number]> = [
  ["::ffff:0:0", 96], ["64:ff9b::", 96], ["2002::", 16], ["2000::", 3], ["2001::", 23], ["2001:db8::", 32],
  ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["100::", 64], ["::", 96],
];
const MASK128 = (1n << 128n) - 1n;
function v6ToBig(addr: string): bigint {
  const [head = "", tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}
function bigToV6(n: bigint): string {
  const g: string[] = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return g.join(":");
}
function v6Corpus(): string[] {
  const out: string[] = [];
  for (const [base, prefix] of V6_PREFIXES) {
    const start = v6ToBig(base);
    const end = start | (MASK128 >> BigInt(prefix));
    for (const n of [start - 1n, start, start + 1n, end - 1n, end, end + 1n]) {
      if (n >= 0n && n <= MASK128) out.push(bigToV6(n));
    }
  }
  let x = 987654321;
  const next16 = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16).toString(16);
  const v4 = () => [0, 0, 0, 0].map(() => (parseInt(next16(), 16) & 255).toString()).join(".");
  for (let i = 0; i < 4000; i++) {
    const g = Array.from({ length: 8 }, next16);
    const [base, prefix] = V6_PREFIXES[i % V6_PREFIXES.length]!;
    const inPrefix = (v6ToBig(base) & ~(MASK128 >> BigInt(prefix))) | (v6ToBig(g.join(":")) & (MASK128 >> BigInt(prefix)));
    out.push(g.join(":"), bigToV6(inPrefix));
  }
  for (let i = 0; i < 2000; i++) {
    const a = v4();
    const [p1, p2] = [next16(), next16()];
    out.push(`::ffff:${a}`, `64:ff9b::${a}`, `2002:${p1}:${p2}::1`, `::${a}`);
  }
  return out;
}

describe("isPrivateAddress: ai replica == social canonical", () => {
  it("agrees on every range boundary and a 20k-address IPv4 sample", () => {
    const diffs = boundaries().filter((ip) => canonical(ip) !== replica(ip));
    expect(diffs).toEqual([]);
  });

  it("agrees on every IPv6 special-prefix boundary and a seeded IPv6 sample", () => {
    const corpus = v6Corpus();
    expect(corpus.length).toBeGreaterThan(15000);
    expect(corpus.filter((ip) => canonical(ip) !== replica(ip))).toEqual([]);
  });

  it("agrees on IPv6 forms and on input that is not an address", () => {
    const diffs = [...V6, ...JUNK].filter((ip) => canonical(ip) !== replica(ip));
    expect(diffs).toEqual([]);
  });
});
