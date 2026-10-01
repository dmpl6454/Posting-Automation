/**
 * RSS feeds are URLs an app admin types in. Both the create-time check
 * (rss.create) and the sync worker fetched them with plain fetch() behind the
 * string-only isPublicPageUrl, so a public-looking name whose DNS pointed at
 * 172.18.x / 10.x / 127.0.0.1 was fetched, and the create check's messages
 * (HTTP status, "not a feed") answered questions about the internal reply
 * (review, 2026-10-01). Both now go through userHostFetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hostFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("<rss></rss>"));
vi.mock("@postautomation/social/src/utils/user-host-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social/src/utils/user-host-fetch")>();
  return { ...actual, userHostFetch: (...a: any[]) => hostFetch(...a) };
});
const plainFetch = vi.fn(async () => {
  throw new Error("plain fetch() must not be used for a feed URL");
});
vi.stubGlobal("fetch", plainFetch);

vi.mock("@postautomation/queue", () => ({ rssSyncQueue: { add: vi.fn(async () => ({})) } }));
vi.mock("../lib/audit", () => ({ createAuditLog: vi.fn(async () => {}), AUDIT_ACTIONS: { RSS_FEED_CREATED: "x" } }));

const feedCreate = vi.fn(async (...a: any[]) => ({ id: "f1", ...a[0].data }));
vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
    organization: { findUnique: vi.fn(async () => ({ plan: "PROFESSIONAL", planExpiresAt: null })) },
    rssFeed: { create: (...a: any[]) => feedCreate(...a) },
    channel: { findMany: vi.fn(async () => []) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { rssRouter } from "../routers/rss.router";
import { prisma as prismaMock } from "@postautomation/db";
import { UserHostError } from "@postautomation/social/src/utils/user-host-fetch";

const caller = () =>
  createCallerFactory(rssRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "u1", email: "a@b.c", isSuperAdmin: false, appRole: "ADMIN" }, expires: "2099-01-01" } as any,
  });
const create = (url = "https://news.example.com/feed.xml") => caller().create({ name: "News", url });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rss.create — feed check", () => {
  it("checks the feed through userHostFetch and saves it", async () => {
    hostFetch.mockResolvedValueOnce(new Response('<?xml version="1.0"?><rss><channel></channel></rss>'));
    await expect(create()).resolves.toMatchObject({ id: "f1" });
    expect(hostFetch.mock.calls[0]![0]).toBe("https://news.example.com/feed.xml");
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("refuses a feed whose address is not public (checked at connect time, so DNS tricks fail)", async () => {
    hostFetch.mockRejectedValueOnce(new UserHostError("blocked"));
    await expect(create("https://feed.attacker.example/rss")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("publicly accessible"),
    });
    expect(hostFetch).toHaveBeenCalledTimes(1);
    expect(plainFetch).not.toHaveBeenCalled();
    expect(feedCreate).not.toHaveBeenCalled();
  });

  it("refuses a feed URL that redirects, and says so", async () => {
    hostFetch.mockRejectedValueOnce(new UserHostError("redirect", { status: 301, requestSent: true }));
    await expect(create()).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("redirects") });
    expect(feedCreate).not.toHaveBeenCalled();
  });
});

describe("rss-sync worker", () => {
  it("fetches feeds through userHostFetch, never plain fetch()", () => {
    const src = readFileSync(join(__dirname, "../../../../apps/worker/src/workers/rss-sync.worker.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).toMatch(/userHostFetch\(feed\.url,/);
    expect(src).not.toMatch(/(?<!\w)fetch\(\s*feed\.url/);
  });
});
