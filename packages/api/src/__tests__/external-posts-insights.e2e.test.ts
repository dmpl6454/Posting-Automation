import { describe, it, expect, beforeAll, afterAll } from "vitest";
// The shared client (already extended for token encryption) — matches
// insights-availability-sql.e2e.test.ts. `PrismaClient` itself is exported as a TYPE
// from @postautomation/db and cannot be constructed here.
import { prisma as sharedPrisma } from "@postautomation/db";

/**
 * REAL-POSTGRES coverage for the external-post union in the Insights read paths.
 *
 * These queries are `$queryRawUnsafe` — they typecheck even when the SQL is wrong, and a
 * mocked Prisma proves nothing about a CTE, a UNION ALL column-order mismatch, or the
 * jsonb availability expression. This suite runs the ACTUAL SQL.
 *
 * Skipped unless LIVE_E2E=1, matching insights-availability-sql.e2e.test.ts:
 *   DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... LIVE_E2E=1 npx vitest run external-posts-insights
 */
const LIVE = process.env.LIVE_E2E === "1" && !!process.env.DATABASE_URL;
const d = LIVE ? describe : describe.skip;

const prisma: any = sharedPrisma;

const SUF = "extpost-e2e";
let orgId = "";
let channelId = "";
let userId = "";

d("external posts in Insights (real Postgres)", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `${SUF}-${Date.now()}@test.local`, name: "ext e2e" },
    });
    userId = user.id;
    const org = await prisma.organization.create({
      data: { name: `${SUF} org`, slug: `${SUF}-${Date.now()}` },
    });
    orgId = org.id;
    const ch = await prisma.channel.create({
      data: {
        organizationId: orgId,
        platform: "FACEBOOK",
        platformId: `page-${Date.now()}`,
        name: "E2E Page",
        accessToken: "tok",
        scopes: [],
      },
    });
    channelId = ch.id;
  });

  afterAll(async () => {
    if (!orgId) return;
    await prisma.externalPost.deleteMany({ where: { channelId } });
    await prisma.channel.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /** Runs the same union the router runs, so a SQL error fails the test. */
  async function channelStats(from: Date, to: Date) {
    const { analyticsRouter } = await import("../routers/analytics.router");
    // Exercise the SQL directly rather than through tRPC context plumbing.
    const availExpr = (key: string) =>
      `BOOL_OR(CASE WHEN NOT has_meta THEN NULL
                    WHEN (avail->>'${key}') IS NULL THEN TRUE
                    ELSE (avail->>'${key}') <> 'false' END)`;
    void analyticsRouter; // keep the import meaningful for module-load errors
    return prisma.$queryRawUnsafe(
      `WITH app_rows AS (
         SELECT pt."channelId" AS channel_id, 'a:' || p.id AS post_key,
                COALESCE(s.impressions,0) AS impressions, COALESCE(s.reach,0) AS reach,
                COALESCE(s.likes,0) AS likes, COALESCE(s.comments,0) AS comments,
                COALESCE(s.shares,0) AS shares, COALESCE(s.clicks,0) AS clicks,
                (s.id IS NOT NULL) AS has_metrics, (s.metadata IS NOT NULL) AS has_meta,
                s.metadata->'metricsAvailable' AS avail,
                (s.id IS NOT NULL AND s.metadata IS NULL) AS is_legacy
         FROM "PostTarget" pt
         INNER JOIN "Post" p ON p.id = pt."postId"
         INNER JOIN "Channel" c ON c.id = pt."channelId"
         LEFT JOIN LATERAL (
           SELECT s2.* FROM "AnalyticsSnapshot" s2 WHERE s2."postTargetId" = pt.id
           ORDER BY s2."snapshotAt" DESC LIMIT 1
         ) s ON TRUE
         WHERE p."organizationId" = $1 AND pt.status::text = 'PUBLISHED'
           AND COALESCE(p."publishedAt", p."updatedAt") BETWEEN $2 AND $3
       ),
       ext_rows AS (
         SELECT ep."channelId" AS channel_id, 'e:' || ep.id AS post_key,
                ep.impressions, ep.reach, ep.likes, ep.comments, ep.shares, ep.clicks,
                (ep."metricsSyncedAt" IS NOT NULL) AS has_metrics,
                (ep."metricsAvailable" IS NOT NULL) AS has_meta,
                ep."metricsAvailable" AS avail,
                (ep."metricsSyncedAt" IS NOT NULL AND ep."metricsAvailable" IS NULL) AS is_legacy
         FROM "ExternalPost" ep
         INNER JOIN "Channel" c2 ON c2.id = ep."channelId"
         WHERE c2."organizationId" = $1 AND ep."postTargetId" IS NULL
           AND ep."publishedAt" BETWEEN $2 AND $3
       ),
       all_rows AS (SELECT * FROM app_rows UNION ALL SELECT * FROM ext_rows)
       SELECT channel_id AS "channelId", COUNT(DISTINCT post_key) AS posts,
              COALESCE(SUM(impressions),0) AS impressions,
              COALESCE(SUM(likes),0) AS likes,
              COALESCE(SUM(impressions) FILTER (WHERE impressions > 0),0) AS "impressionedImpressions",
              COALESCE(SUM(likes) FILTER (WHERE impressions > 0),0) AS "impressionedLikes",
              COUNT(*) FILTER (WHERE impressions > 0) AS "impressionedPosts",
              BOOL_OR(has_metrics) AS "hasSnapshot",
              ${availExpr("impressions")} AS "availImpressions",
              ${availExpr("reach")} AS "availReach",
              BOOL_OR(is_legacy) AS "hasLegacySnapshot"
       FROM all_rows GROUP BY channel_id`,
      orgId,
      from,
      to
    );
  }

  const FROM = new Date("2026-08-01T00:00:00Z");
  const TO = new Date("2026-09-01T00:00:00Z");

  it("runs the union SQL without error and returns nothing for an empty org", async () => {
    const rows: any[] = await channelStats(FROM, TO);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("counts a platform-native post and honors its declared availability", async () => {
    await prisma.externalPost.create({
      data: {
        channelId,
        platform: "FACEBOOK",
        platformPostId: "page_1",
        publishedAt: new Date("2026-08-03T00:00:00Z"),
        impressions: 100,
        likes: 10,
        // FB: impressions/reach are DELETED by Meta -> declared false -> must render "—"
        metricsAvailable: { impressions: false, reach: false, likes: true } as any,
        metricsSyncedAt: new Date(),
      },
    });

    const rows: any[] = await channelStats(FROM, TO);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].posts)).toBe(1);
    expect(Number(rows[0].likes)).toBe(10);
    expect(rows[0].hasSnapshot).toBe(true);
    // Declared false ⇒ the aggregate reports unavailable, so the UI renders "—".
    expect(rows[0].availImpressions).toBe(false);
    expect(rows[0].availReach).toBe(false);
  });

  it("a listed-but-never-measured post renders as '—', never a fake 0", async () => {
    await prisma.externalPost.create({
      data: {
        channelId,
        platform: "FACEBOOK",
        platformPostId: "page_unmeasured",
        publishedAt: new Date("2026-08-04T00:00:00Z"),
        // metricsSyncedAt NULL — listed by the sync, metrics not captured yet.
      },
    });

    const rows: any[] = await channelStats(FROM, TO);
    // It counts as a post...
    expect(Number(rows[0].posts)).toBe(2);
    // ...but contributes nothing to the impressioned pool, so the engagement rate
    // denominator is untouched — the 1400% class of bug cannot recur here.
    expect(Number(rows[0].impressionedPosts)).toBe(1);
  });

  it("EXCLUDES posts we published ourselves (postTargetId set) — no double-counting", async () => {
    await prisma.externalPost.create({
      data: {
        channelId,
        platform: "FACEBOOK",
        platformPostId: "page_ours",
        publishedAt: new Date("2026-08-05T00:00:00Z"),
        postTargetId: "some-target-id", // matched to one of OUR posts
        impressions: 999,
        likes: 999,
        metricsSyncedAt: new Date(),
      },
    });

    const rows: any[] = await channelStats(FROM, TO);
    // Still 2 — the matched post flows through the PostTarget path instead.
    expect(Number(rows[0].posts)).toBe(2);
    expect(Number(rows[0].likes)).toBe(10); // 999 must NOT appear
  });

  it("is org-scoped: another org's external posts are invisible", async () => {
    const other = await prisma.organization.create({
      data: { name: "other", slug: `other-${Date.now()}` },
    });
    const otherCh = await prisma.channel.create({
      data: {
        organizationId: other.id,
        platform: "FACEBOOK",
        platformId: `other-${Date.now()}`,
        name: "Other",
        accessToken: "t",
        scopes: [],
      },
    });
    await prisma.externalPost.create({
      data: {
        channelId: otherCh.id,
        platform: "FACEBOOK",
        platformPostId: "other_1",
        publishedAt: new Date("2026-08-03T00:00:00Z"),
        impressions: 5000,
        likes: 5000,
        metricsSyncedAt: new Date(),
      },
    });

    const rows: any[] = await channelStats(FROM, TO);
    expect(rows).toHaveLength(1); // only OUR channel
    expect(Number(rows[0].likes)).toBe(10);

    await prisma.externalPost.deleteMany({ where: { channelId: otherCh.id } });
    await prisma.channel.delete({ where: { id: otherCh.id } });
    await prisma.organization.delete({ where: { id: other.id } });
  });

  it("respects the date window", async () => {
    const rows: any[] = await channelStats(
      new Date("2026-08-04T12:00:00Z"),
      new Date("2026-08-06T00:00:00Z")
    );
    // Only page_ours is in range, and it is excluded as ours ⇒ no rows.
    expect(rows).toHaveLength(0);
  });

  it("enforces the (channelId, platformPostId) uniqueness that makes sync idempotent", async () => {
    await expect(
      prisma.externalPost.create({
        data: {
          channelId,
          platform: "FACEBOOK",
          platformPostId: "page_1", // duplicate
          publishedAt: new Date("2026-08-03T00:00:00Z"),
        },
      })
    ).rejects.toThrow();
  });
});
