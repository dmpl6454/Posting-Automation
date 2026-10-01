import { describe, it, expect, vi, beforeEach } from "vitest";

const lookupMock = vi.fn(async (..._a: any[]): Promise<Array<{ address: string; family: number }>> => []);
vi.mock("node:dns", () => {
  const promises = { lookup: (...a: any[]) => lookupMock(...a) };
  return { promises, default: { promises } };
});

import { isPrivateAddress, checkHostIsPublic } from "../lib/public-host";

describe("isPrivateAddress — IPv4", () => {
  it.each([
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.17.0.2", // default Docker bridge
    "172.18.0.5", // compose network
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "100.64.0.1", // CGNAT
    "100.100.100.200", // Alibaba metadata (inside 100.64/10)
    "100.127.255.255",
    "192.0.0.1",
    "192.0.2.10",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
  ])("%s is private / non-public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.0", // just above 172.16/12
    "100.63.255.255", // just below 100.64/10
    "100.128.0.0", // just above 100.64/10
    "192.169.0.1",
    "169.255.0.1",
    "11.0.0.1",
    "223.255.255.254",
  ])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("isPrivateAddress — IPv6", () => {
  it.each([
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fd00:ec2::254", // AWS IMDS over IPv6
    "fdff:ffff::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1", // deprecated site-local
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:172.17.0.2",
    "::ffff:192.168.1.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1", // hex form of ::ffff:127.0.0.1
    "::ffff:a9fe:a9fe", // hex form of ::ffff:169.254.169.254
    "::ffff:0.0.0.0",
    "::127.0.0.1", // deprecated IPv4-compatible
    "64:ff9b::10.0.0.1", // NAT64 to a private v4
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::1", // 6to4 wrapping 127.0.0.1
    "2002:c0a8:101::1", // 6to4 wrapping 192.168.1.1
    "2001:db8::1", // documentation
    "2001::1", // Teredo
    "100::1", // discard
  ])("%s is private / non-public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:808:808::1", // 6to4 wrapping 8.8.8.8
  ])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("isPrivateAddress — anything that is not an IP fails closed", () => {
  it.each(["", "localhost", "minio", "example.com", "1.2.3", "1.2.3.4.5", "256.0.0.1", "0x7f.0.0.1", "::gggg"])(
    "%j",
    (v) => {
      expect(isPrivateAddress(v)).toBe(true);
    },
  );
});

describe("checkHostIsPublic", () => {
  beforeEach(() => lookupMock.mockReset());

  it("resolves every address and accepts only an all-public answer", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    await expect(checkHostIsPublic("example.com")).resolves.toBe("public");
    expect(lookupMock).toHaveBeenCalledWith("example.com", expect.objectContaining({ all: true }));
  });

  it("refuses when ANY resolved address is private", async () => {
    lookupMock.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);
    await expect(checkHostIsPublic("mixed.example.com")).resolves.toBe("private");
  });

  it("refuses a single-label Docker service name that resolves to the bridge network", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "172.18.0.4", family: 4 }]);
    await expect(checkHostIsPublic("minio")).resolves.toBe("private");
  });

  it("reports a name that does not resolve", async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(checkHostIsPublic("nope.invalid")).resolves.toBe("unresolved");
    lookupMock.mockResolvedValueOnce([]);
    await expect(checkHostIsPublic("empty.example.com")).resolves.toBe("unresolved");
  });

  it("checks IP literals directly (brackets stripped) without a DNS query", async () => {
    await expect(checkHostIsPublic("[::1]")).resolves.toBe("private");
    await expect(checkHostIsPublic("127.0.0.1")).resolves.toBe("private");
    await expect(checkHostIsPublic("8.8.8.8")).resolves.toBe("public");
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
