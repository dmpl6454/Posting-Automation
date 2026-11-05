import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  claimTargetsForPlatformDelete,
  updatePlatformDeleteRecord,
  readPlatformDeleteRecord,
} from "@postautomation/queue";

/**
 * REAL Postgres (2026-11-05): the delete-request claim and record merge are raw
 * SQL — a mocked client cannot prove the jsonb merge, the ANY($1::text[])
 * array binding, the stale comparison or the platformDeletedAt stamp.
 *
 *   DATABASE_URL=… TOKEN_ENCRYPTION_KEY=… LIVE_E2E=1 npx vitest run platform-delete-state
 */
const LIVE = process.env.LIVE_E2E === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!LIVE)("platform-delete state SQL (real Postgres)", () => {
  let prisma: any;
  const tag = `pdel-${Date.now()}`;
  let orgId = "";
  let userId = "";
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const db = await import("@postautomation/db");
    prisma = db.prisma;
    const user = await prisma.user.create({ data: { email: `${tag}@example.invalid` } });
    userId = user.id;
    const org = await prisma.organization.create({ data: { name: tag, slug: tag } });
    orgId = org.id;
    const ch = await prisma.channel.create({
      data: { organizationId: orgId, platform: "INSTAGRAM", platformId: tag, name: tag, accessToken: "tok", scopes: [] },
    });
    const post = await prisma.post.create({
      data: { organizationId: orgId, createdById: userId, content: "x", status: "PUBLISHED" },
    });
    const mk = async (key: string, data: any) => {
      // One post per target keeps @@unique([postId, channelId]) happy.
      const p = key === "pub" ? post : await prisma.post.create({ data: { organizationId: orgId, createdById: userId, content: key } });
      const t = await prisma.postTarget.create({ data: { postId: p.id, channelId: ch.id, ...data } });
      ids[key] = t.id;
    };
    await mk("pub", { status: "PUBLISHED", publishedId: "1", metadata: { resolvedPostId: "keep-me" } });
    await mk("nullmeta", { status: "PUBLISHED", publishedId: "2" });
    await mk("draft", { status: "DRAFT" });
    await mk("deleted", { status: "PUBLISHED", publishedId: "3", platformDeletedAt: new Date() });
    await mk("busy", {
      status: "PUBLISHED",
      publishedId: "4",
      metadata: { platformDelete: { status: "deleting", requestedAt: new Date().toISOString() } },
    });
    await mk("stale", {
      status: "PUBLISHED",
      publishedId: "5",
      metadata: { platformDelete: { status: "queued", requestedAt: "2020-01-01T00:00:00.000Z" } },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.post.deleteMany({ where: { organizationId: orgId } });
    await prisma.channel.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("claims only published, not-deleted, not-in-flight targets — and keeps sibling metadata", async () => {
    const claimed = await claimTargetsForPlatformDelete(prisma, Object.values(ids), { requestedAt: new Date(), requestedBy: "u1" });
    expect(claimed.sort()).toEqual([ids.pub, ids.nullmeta, ids.stale].sort());

    const pub = await prisma.postTarget.findUnique({ where: { id: ids.pub } });
    expect(pub.metadata.resolvedPostId).toBe("keep-me");
    expect(readPlatformDeleteRecord(pub.metadata)?.status).toBe("queued");
    expect(readPlatformDeleteRecord((await prisma.postTarget.findUnique({ where: { id: ids.nullmeta } })).metadata)?.requestedBy).toBe("u1");

    // A second request claims nothing — all three are now in flight.
    expect(await claimTargetsForPlatformDelete(prisma, Object.values(ids), { requestedAt: new Date(), requestedBy: "u2" })).toEqual([]);
  });

  it("compare-and-set moves queued → deleting once, then stamps platformDeletedAt", async () => {
    expect(await updatePlatformDeleteRecord(prisma, ids.pub!, { status: "deleting" }, { onlyIfStatus: ["queued", "deleting"] })).toBe(1);
    expect(await updatePlatformDeleteRecord(prisma, ids.draft!, { status: "deleting" }, { onlyIfStatus: ["queued", "deleting"] })).toBe(0);

    const at = new Date("2026-11-05T10:00:00.000Z");
    await updatePlatformDeleteRecord(prisma, ids.pub!, { status: "deleted", finishedAt: at.toISOString() }, { deletedAt: at });
    const pub = await prisma.postTarget.findUnique({ where: { id: ids.pub } });
    expect(pub.platformDeletedAt.toISOString()).toBe(at.toISOString());
    expect(pub.status).toBe("PUBLISHED");
    const rec = readPlatformDeleteRecord(pub.metadata)!;
    expect(rec).toMatchObject({ status: "deleted", requestedBy: "u1" });
    expect(pub.metadata.resolvedPostId).toBe("keep-me");

    // A finished delete is no longer claimable at all.
    expect(await updatePlatformDeleteRecord(prisma, ids.pub!, { status: "deleting" }, { onlyIfStatus: ["queued", "deleting"] })).toBe(0);
    expect(await claimTargetsForPlatformDelete(prisma, [ids.pub!], { requestedAt: new Date(), requestedBy: "u3" })).toEqual([]);
  });
});
