import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma as sharedPrisma } from "@postautomation/db";

/**
 * REAL Postgres (2026-11-10): analytics.platformBreakdown moved from "load
 * every published target and count in JS" to a grouped count. A mocked client
 * cannot prove a groupBy with a relation filter, so this runs the real query.
 *
 *   DATABASE_URL=… TOKEN_ENCRYPTION_KEY=… LIVE_E2E=1 npx vitest run platform-breakdown
 */
const LIVE = process.env.LIVE_E2E === "1" && !!process.env.DATABASE_URL;
const prisma: any = sharedPrisma;

describe.skipIf(!LIVE)("analytics.platformBreakdown (real Postgres)", () => {
  const tag = `pb-${Date.now()}`;
  const orgIds: string[] = [];
  let userId = "";

  async function seedOrg(name: string) {
    const org = await prisma.organization.create({ data: { name, slug: `${tag}-${name}` } });
    orgIds.push(org.id);
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId, role: "OWNER" } });
    const mk = (platform: string, i: number) =>
      prisma.channel.create({
        data: { organizationId: org.id, platform, platformId: `${tag}-${name}-${platform}-${i}`, name: `${platform}${i}`, accessToken: "t", scopes: [] },
      });
    return { org, fb1: await mk("FACEBOOK", 1), fb2: await mk("FACEBOOK", 2), ig: await mk("INSTAGRAM", 1) };
  }

  async function post(orgId: string, publishedAt: Date | null, targets: { channelId: string; status: string }[]) {
    const p = await prisma.post.create({
      data: { organizationId: orgId, createdById: userId, content: "x", status: "PUBLISHED", publishedAt },
    });
    for (const t of targets) await prisma.postTarget.create({ data: { postId: p.id, ...t } });
  }

  let a: Awaited<ReturnType<typeof seedOrg>>;

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { email: `${tag}@example.invalid` } })).id;
    a = await seedOrg("a");
    const b = await seedOrg("b");
    const now = new Date();
    const old = new Date(Date.now() - 90 * 86400_000);
    // Org A, in range: FB 3 (two Pages), IG 1. A FAILED target never counts.
    await post(a.org.id, now, [
      { channelId: a.fb1.id, status: "PUBLISHED" },
      { channelId: a.fb2.id, status: "PUBLISHED" },
      { channelId: a.ig.id, status: "PUBLISHED" },
    ]);
    await post(a.org.id, now, [
      { channelId: a.fb1.id, status: "PUBLISHED" },
      { channelId: a.ig.id, status: "FAILED" },
    ]);
    // Org A, outside the 30-day default window.
    await post(a.org.id, old, [{ channelId: a.ig.id, status: "PUBLISHED" }]);
    // Org B must never leak into org A's numbers.
    await post(b.org.id, now, [{ channelId: b.fb1.id, status: "PUBLISHED" }, { channelId: b.ig.id, status: "PUBLISHED" }]);
  });

  afterAll(async () => {
    await prisma.post.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.channel.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("counts published targets per platform, in range, for the caller's org only", async () => {
    const { createCallerFactory } = await import("../trpc");
    const { analyticsRouter } = await import("../routers/analytics.router");
    const caller = createCallerFactory(analyticsRouter)({
      prisma,
      session: { user: { id: userId, email: `${tag}@example.invalid` } },
      organizationId: a.org.id,
    } as any);
    const res = await caller.platformBreakdown();
    expect(res).toEqual([
      { platform: "FACEBOOK", count: 3 },
      { platform: "INSTAGRAM", count: 1 },
    ]);
  });
});
