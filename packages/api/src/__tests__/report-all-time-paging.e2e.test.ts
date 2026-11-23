/**
 * Real-Postgres lock for the Excel export's "All time" window + keyset paging
 * (2026-11-23). The paging lives in `$queryRawUnsafe`, so a mocked Prisma
 * cannot catch a bad placeholder, a wrong row-value comparison, or a page
 * boundary that drops or repeats rows.
 *
 * Skipped unless LIVE_E2E=1:
 *   DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... LIVE_E2E=1 npx vitest run report-all-time-paging
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@postautomation/db";
import { appRouter } from "../root";

const LIVE = process.env.LIVE_E2E === "1" && !!process.env.DATABASE_URL;
const TAG = `paging-${Date.now()}`;

let userId = "";
let orgId = "";
let otherOrgId = "";
const DAY = 86_400_000;

function caller(org: string) {
  return appRouter.createCaller({
    prisma,
    session: { user: { id: userId, email: "e2e@example.test", isSuperAdmin: false, appRole: "ADMIN" } },
    organizationId: org,
    membership: { role: "OWNER" },
    isSuperAdmin: false,
    headers: new Headers(),
  } as any);
}

async function seedOrg(name: string, publishedAts: Date[]) {
  const org = await prisma.organization.create({
    data: { name, slug: `${TAG}-${name}`, members: { create: { userId, role: "OWNER" } } },
  });
  const channel = await prisma.channel.create({
    data: { organizationId: org.id, platform: "INSTAGRAM", name: `${name}-ch`, platformId: `${TAG}-${name}`, accessToken: "tok", isActive: true },
  });
  for (const at of publishedAts) {
    // (postId, channelId) is unique, so one post per row.
    const post = await prisma.post.create({
      data: { organizationId: org.id, content: `${name} post`, status: "PUBLISHED", publishedAt: at, createdById: userId },
    });
    await prisma.postTarget.create({
      data: { postId: post.id, channelId: channel.id, status: "PUBLISHED", publishedAt: at, publishedUrl: `https://example.test/${at.getTime()}` },
    });
  }
  return org.id;
}

describe.skipIf(!LIVE)("Reports — all-time window and keyset paging (real Postgres)", () => {
  const now = Date.now();
  // 7 rows: 5 share ONE timestamp (the tie case), one 2 years old, one recent.
  const tie = new Date(now - 3 * DAY);
  const times = [new Date(now - DAY), tie, tie, tie, tie, tie, new Date(now - 730 * DAY)];

  beforeAll(async () => {
    const u = await prisma.user.create({ data: { email: `${TAG}@example.test`, name: "E2E" } });
    userId = u.id;
    orgId = await seedOrg("mine", times);
    otherOrgId = await seedOrg("other", [new Date(now - DAY), tie]);
  }, 60_000);

  afterAll(async () => {
    for (const id of [orgId, otherOrgId].filter(Boolean)) {
      await prisma.postTarget.deleteMany({ where: { post: { organizationId: id } } });
      await prisma.post.deleteMany({ where: { organizationId: id } });
      await prisma.channel.deleteMany({ where: { organizationId: id } });
      await prisma.organizationMember.deleteMany({ where: { organizationId: id } });
      await prisma.organization.delete({ where: { id } });
    }
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  }, 60_000);

  it("'all' includes the 2-year-old post; 30d does not", async () => {
    const all = await caller(orgId).analytics.postReports({ window: "all", mode: "current", limit: 100 });
    const d30 = await caller(orgId).analytics.postReports({ window: "30d", mode: "current", limit: 100 });
    expect(all.rows).toHaveLength(7);
    expect(d30.rows).toHaveLength(6);
  });

  it("pages of 2 return every row exactly once, through the tie, in order", async () => {
    const seen: string[] = [];
    let cursor: { publishedAt: string; targetId: string } | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await caller(orgId).analytics.postReports({ window: "all", mode: "current", limit: 2, cursor });
      if (page.rows.length === 0) break;
      seen.push(...page.rows.map((r) => r.targetId));
      const last = page.rows[page.rows.length - 1]!;
      cursor = { publishedAt: new Date(last.publishedAt as any).toISOString(), targetId: last.targetId };
    }
    const full = await caller(orgId).analytics.postReports({ window: "all", mode: "current", limit: 100 });
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7); // no duplicates
    expect(seen).toEqual(full.rows.map((r) => r.targetId)); // same order as one big page
  });

  it("never returns another organization's rows (placeholders kept their meaning)", async () => {
    const page = await caller(orgId).analytics.postReports({
      window: "all", mode: "current", limit: 100,
      cursor: { publishedAt: new Date(now).toISOString(), targetId: "zzzz" },
    });
    expect(page.rows.every((r) => r.channelName === "mine-ch")).toBe(true);
    expect(page.rows).toHaveLength(7);
  });

  it("rejects 'all' with the at-age mode", async () => {
    await expect(caller(orgId).analytics.postReports({ window: "all", mode: "at_age", limit: 10 })).rejects.toThrow(
      /only available for current/
    );
  });
});
