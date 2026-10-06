import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma as sharedPrisma } from "@postautomation/db";
import { createCallerFactory } from "../trpc";
import { listeningRouter } from "../routers/listening.router";

/**
 * REAL-POSTGRES coverage for the listening feed's reach sort / minimum reach /
 * period filters (2026-10-06). Cursor pagination over a multi-column order
 * with ties is exactly what a mocked Prisma can't prove: this pages through
 * seeded rows (equal reach values, zero reach, an out-of-window row, another
 * workspace's high-reach rows) and checks every row comes back exactly once,
 * in order.
 *
 * Skipped unless LIVE_E2E=1:
 *   DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... LIVE_E2E=1 npx vitest run listening-mentions-sort.e2e
 */
const LIVE = process.env.LIVE_E2E === "1" && !!process.env.DATABASE_URL;
const d = LIVE ? describe : describe.skip;
const prisma: any = sharedPrisma;

const SUF = `lsort-${Date.now()}`;
const ids = { user: "", org: "", other: "", q1: "", q2: "", otherQ: "" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

d("listening mentions: reach sort, minimum reach, period (real Postgres)", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `${SUF}@test.local`, name: "lsort", isSuperAdmin: true } });
    ids.user = user.id;
    const org = await prisma.organization.create({ data: { name: `${SUF} org`, slug: `${SUF}-a` } });
    const other = await prisma.organization.create({ data: { name: `${SUF} other`, slug: `${SUF}-b` } });
    ids.org = org.id;
    ids.other = other.id;
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: "OWNER" } });
    const mkQ = (orgId: string, name: string) =>
      prisma.listeningQuery.create({ data: { organizationId: orgId, name, keywords: ["acme"], excludeWords: [], platforms: [] } });
    ids.q1 = (await mkQ(org.id, "q1")).id;
    ids.q2 = (await mkQ(org.id, "q2")).id;
    ids.otherQ = (await mkQ(other.id, "foreign")).id;

    const now = Date.now();
    // 14 in-window rows across two queries, with deliberate reach ties.
    const reaches = [5000, 5000, 5000, 120000, 120000, 800, 0, 0, 0, 40, 40, 1000000, 999, 5000];
    const rows = reaches.map((reach, i) => ({
      listeningQueryId: i % 2 ? ids.q2 : ids.q1,
      source: reach > 0 ? "YOUTUBE" : "NEWS",
      content: `m${i}`,
      reach,
      engagements: 0,
      // Some identical timestamps too, so id is the only tiebreak left.
      mentionedAt: new Date(now - (i % 5) * HOUR),
      dedupKey: `${SUF}-${i}`,
    }));
    await prisma.mention.createMany({
      data: [
        ...rows,
        // Outside a 7-day period.
        { listeningQueryId: ids.q1, source: "YOUTUBE", content: "old", reach: 9_000_000, engagements: 0, mentionedAt: new Date(now - 20 * DAY), dedupKey: `${SUF}-old` },
        // Another workspace — never returned, however large.
        { listeningQueryId: ids.otherQ, source: "YOUTUBE", content: "foreign", reach: 50_000_000, engagements: 0, mentionedAt: new Date(now), dedupKey: `${SUF}-foreign` },
      ],
    });
  });

  afterAll(async () => {
    if (!ids.org) return;
    await prisma.mention.deleteMany({ where: { listeningQueryId: { in: [ids.q1, ids.q2, ids.otherQ] } } });
    await prisma.listeningQuery.deleteMany({ where: { id: { in: [ids.q1, ids.q2, ids.otherQ] } } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: ids.org } });
    await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.other] } } });
    await prisma.user.deleteMany({ where: { id: ids.user } });
  });

  const caller = () =>
    createCallerFactory(listeningRouter)({
      prisma,
      session: { user: { id: ids.user, email: `${SUF}@test.local`, isSuperAdmin: true } } as any,
      organizationId: ids.org,
    });

  async function all(input: Record<string, unknown>) {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await caller().mentions({ ...input, limit: 4, cursor } as any);
      out.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  it("reach sort pages through every row once, highest reach first, newest first among equals", async () => {
    const got = await all({ sort: "reach", days: 7 });
    expect(got.map((m) => m.content)).not.toContain("foreign");
    expect(got.map((m) => m.content)).not.toContain("old");
    expect(new Set(got.map((m) => m.id)).size).toBe(got.length);
    expect(got).toHaveLength(14);
    for (let i = 1; i < got.length; i++) {
      const [a, b] = [got[i - 1], got[i]];
      expect(a.reach >= b.reach).toBe(true);
      if (a.reach === b.reach) expect(new Date(a.mentionedAt).getTime() >= new Date(b.mentionedAt).getTime()).toBe(true);
    }
    expect(got[0].reach).toBe(1000000);
  });

  it("minimum reach drops the rest (including sources that report none); period drops old rows", async () => {
    const big = await all({ sort: "reach", minReach: 5000 });
    expect(big.map((m) => m.reach)).toEqual([9000000, 1000000, 120000, 120000, 5000, 5000, 5000, 5000]);
    const recent = await all({ sort: "recent", minReach: 1, days: 7 });
    expect(recent.every((m) => m.reach >= 1)).toBe(true);
    expect(recent).toHaveLength(11);
  });

  it("newest-first paging is complete and ordered too; a query filter narrows it", async () => {
    const got = await all({ sort: "recent" });
    expect(got).toHaveLength(15);
    expect(new Set(got.map((m) => m.id)).size).toBe(15);
    for (let i = 1; i < got.length; i++) {
      expect(new Date(got[i - 1].mentionedAt).getTime() >= new Date(got[i].mentionedAt).getTime()).toBe(true);
    }
    const q2 = await all({ queryId: ids.q2, sort: "reach" });
    expect(q2.every((m) => m.listeningQueryId === ids.q2)).toBe(true);
    expect(q2).toHaveLength(7);
  });
});
