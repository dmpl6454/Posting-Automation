/**
 * TikTok — post.create / post.update / post.publishNow wiring (2026-10-28).
 *
 * Exercises the REAL post router through a caller against a mocked prisma (same
 * harness as super-text-create.test.ts). Two things are load-bearing:
 *   1. A post with no TikTok channel is written EXACTLY as before.
 *   2. A TikTok target is never armed without the user's own choices (TikTok's
 *      guidelines forbid a default privacy level) and exactly one video.
 * Plus the channel-replacement carry-over: a KEPT target keeps its metadata and
 * its ambiguity flag, or a TikTok publish checkpoint / a "Needs check" park is
 * lost and the next publish can post a duplicate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

const postPublishAdd = vi.fn(async (..._a: any[]) => ({}));
const enqueueScheduled = vi.fn(async (..._a: any[]) => 0);

vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: (...a: any[]) => postPublishAdd(...(a as [])) },
  captionFanoutQueue: { add: vi.fn(async () => {}) },
  superTextQueue: { add: vi.fn(async () => {}) },
  enqueueScheduledPublishJobs: (...a: any[]) => enqueueScheduled(...(a as [])),
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
  buildPublishNowJobId: (targetId: string, nowMs: number) => `pubnow:${targetId}:${Math.floor(nowMs / 60_000)}`,
  PUBLISH_NOW_DEDUPE_WINDOW_MS: 60_000,
  pendingPublishGates: () => [],
}));

const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const channelFindMany = vi.fn();
const mediaFindMany = vi.fn();
const postMediaFindMany = vi.fn();
const postCreate = vi.fn();
const postFindFirst = vi.fn();
const postUpdate = vi.fn();
const postTargetUpdateMany = vi.fn();
const executeRaw = vi.fn(async (..._a: any[]) => 1);

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    channel: { findMany: (...a: any[]) => channelFindMany(...a) },
    media: { findMany: (...a: any[]) => mediaFindMany(...a) },
    postMedia: { findMany: (...a: any[]) => postMediaFindMany(...a) },
    post: {
      create: (...a: any[]) => postCreate(...a),
      findFirst: (...a: any[]) => postFindFirst(...a),
      update: (...a: any[]) => postUpdate(...a),
    },
    postTarget: { updateMany: (...a: any[]) => postTargetUpdateMany(...a) },
    auditLog: { create: vi.fn() },
    $executeRaw: (...a: any[]) => executeRaw(...a),
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { postRouter } from "../routers/post.router";
import { prisma as prismaMock } from "@postautomation/db";

const ORG_ID = "org-1";
const TT = "chan-tt";
const TT2 = "chan-tt2";
const IG = "chan-ig";
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

const ALL_CHANNELS = [
  { id: TT, platform: "TIKTOK", name: "Studio One" },
  { id: TT2, platform: "TIKTOK", name: "Studio Two" },
  { id: IG, platform: "INSTAGRAM", name: "Insta" },
];

const settings = (over: Record<string, unknown> = {}) => ({
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  brandOrganic: false,
  brandContent: false,
  isAigc: false,
  ...over,
});

function makeCaller() {
  return createCallerFactory(postRouter)({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: { user: { id: "user-1", email: "boss@example.com", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });
}

const createdData = () => postCreate.mock.calls[0]![0].data;

function setMediaRows(rows: Array<{ id: string; fileType: string }>) {
  mediaFindMany.mockImplementation(async (args: any) => {
    const want: string[] | undefined = args?.where?.id?.in;
    const full = rows.map((r) => ({ ...r, fileName: "f", fileSize: BigInt(1000), metadata: null }));
    return want ? full.filter((r) => want.includes(r.id)) : full;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  channelFindMany.mockImplementation(async (args: any) => {
    const want: string[] = args?.where?.id?.in ?? [];
    return ALL_CHANNELS.filter((c) => want.includes(c.id));
  });
  setMediaRows([
    { id: "vid", fileType: "video/mp4" },
    { id: "img", fileType: "image/png" },
  ]);
  postCreate.mockResolvedValue({ id: "post-1", status: "DRAFT", scheduledAt: null, targets: [] });
  postUpdate.mockResolvedValue({ id: "post-1", status: "DRAFT", scheduledAt: null, targets: [], mediaAttachments: [], tags: [] });
  postTargetUpdateMany.mockResolvedValue({ count: 1 });
});

describe("post.create — a post without TikTok is written exactly as before", () => {
  it("byte-identical data for an Instagram post with passthrough metadata", async () => {
    await makeCaller().create({
      content: "hello",
      channelIds: [IG],
      mediaIds: ["img"],
      metadata: { title: "T", privacyStatus: "public" },
    });
    const { createdById: _u, ...data } = createdData();
    expect(data).toEqual({
      organizationId: ORG_ID,
      content: "hello",
      contentVariants: undefined,
      scheduledAt: null,
      status: "DRAFT",
      aiGenerated: false,
      aiProvider: undefined,
      aiPrompt: undefined,
      campaignLabel: undefined,
      metadata: { title: "T", privacyStatus: "public" },
      targets: { create: [{ channelId: IG, status: "DRAFT", format: null }] },
      mediaAttachments: { create: [{ mediaId: "img", order: 0 }] },
    });
  });

  it("no metadata ⇒ metadata undefined, and a TikTok input for no TikTok channel writes nothing", async () => {
    await makeCaller().create({ content: "hello", channelIds: [IG], tiktok: { byChannel: { [IG]: settings() } } as any });
    expect(createdData().metadata).toBeUndefined();
  });
});

describe("post.create — TikTok", () => {
  it("writes the per-channel settings, server-side, for TikTok channels only", async () => {
    await makeCaller().create({
      content: "hello",
      channelIds: [TT, IG],
      mediaIds: ["vid"],
      scheduledAt: FUTURE,
      tiktok: { byChannel: { [TT]: settings({ allowComment: true }), [IG]: settings(), ghost: settings() } as any },
    });
    expect(createdData().metadata).toEqual({ tiktokByChannel: { [TT]: settings({ allowComment: true }) } });
  });

  it("STRIPS a client-written tiktokByChannel / tiktok / legacy privacyLevel from the passthrough", async () => {
    await makeCaller().create({
      content: "hello",
      channelIds: [IG],
      metadata: {
        title: "T",
        tiktokByChannel: { [TT]: settings() },
        tiktok: settings(),
        privacyLevel: "PUBLIC_TO_EVERYONE",
      } as any,
    });
    expect(createdData().metadata).toEqual({ title: "T" });
  });

  it("refuses to SCHEDULE a TikTok channel whose visibility was not chosen — naming it", async () => {
    await expect(
      makeCaller().create({
        content: "hello",
        channelIds: [TT, TT2],
        mediaIds: ["vid"],
        scheduledAt: FUTURE,
        tiktok: { byChannel: { [TT]: settings() } as any },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Choose who can see this post on Studio Two (TikTok)." });
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("refuses to schedule a TikTok post without exactly one video", async () => {
    const base = { content: "hello", channelIds: [TT], scheduledAt: FUTURE, tiktok: { byChannel: { [TT]: settings() } as any } };
    await expect(makeCaller().create({ ...base, mediaIds: ["img"] })).rejects.toMatchObject({
      message: "TikTok posts need exactly one video.",
    });
    await expect(makeCaller().create({ ...base })).rejects.toMatchObject({ message: "TikTok posts need exactly one video." });
    await expect(makeCaller().create({ ...base, mediaIds: ["vid", "img"] })).rejects.toMatchObject({
      message: "TikTok posts need exactly one video.",
    });
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("lets a TikTok DRAFT be saved without settings", async () => {
    await makeCaller().create({ content: "hello", channelIds: [TT] });
    expect(createdData().metadata).toBeUndefined();
  });

  it("checks channel ownership BEFORE the TikTok rules (a foreign id is never named back)", async () => {
    await expect(
      makeCaller().create({ content: "hello", channelIds: [TT, "foreign"], scheduledAt: FUTURE })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("post.update — TikTok settings", () => {
  const existingPost = (over: Record<string, unknown> = {}) => ({
    id: "post-1",
    status: "DRAFT",
    scheduledAt: null,
    metadata: { superText: { pendingBurn: true }, tiktokByChannel: { [TT]: settings() } },
    targets: [{ channelId: TT, format: null, contentOverride: null, metadata: null, ambiguousAt: null, ambiguousReason: null, channel: { platform: "TIKTOK", name: "Studio One" } }],
    _count: { mediaAttachments: 1 },
    ...over,
  });

  it("merges the new choices with an ATOMIC jsonb merge — other metadata keys untouched", async () => {
    postFindFirst.mockResolvedValue(existingPost());
    await makeCaller().update({ id: "post-1", tiktok: { byChannel: { [TT]: settings({ privacyLevel: "SELF_ONLY" }) } as any } });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0]!;
    expect((strings as string[]).join("?")).toMatch(/\|\|/);
    expect(values).toContain(JSON.stringify({ tiktokByChannel: { [TT]: settings({ privacyLevel: "SELF_ONLY" }) } }));
    // The Post row write never carries a whole-column metadata.
    expect(postUpdate.mock.calls[0]![0].data).not.toHaveProperty("metadata");
  });

  it("a post without TikTok never touches metadata", async () => {
    postFindFirst.mockResolvedValue({
      id: "post-1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      metadata: { title: "x" },
      targets: [{ channelId: IG, format: null, contentOverride: null, channel: { platform: "INSTAGRAM", name: "Insta" } }],
      _count: { mediaAttachments: 1 },
    });
    await makeCaller().update({ id: "post-1", content: "edited" });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(postMediaFindMany).not.toHaveBeenCalled();
    expect(postUpdate.mock.calls[0]![0].data).not.toHaveProperty("metadata");
  });

  it("refuses to ARM a TikTok post whose settings are missing", async () => {
    postFindFirst.mockResolvedValue(existingPost({ metadata: null }));
    postMediaFindMany.mockResolvedValue([{ media: { fileType: "video/mp4" } }]);
    await expect(makeCaller().update({ id: "post-1", scheduledAt: FUTURE })).rejects.toMatchObject({
      message: "Choose who can see this post on Studio One (TikTok).",
    });
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("refuses to arm a TikTok post whose only media is an image", async () => {
    postFindFirst.mockResolvedValue(existingPost());
    postMediaFindMany.mockResolvedValue([{ media: { fileType: "image/jpeg" } }]);
    await expect(makeCaller().update({ id: "post-1", scheduledAt: FUTURE })).rejects.toMatchObject({
      message: "TikTok posts need exactly one video.",
    });
  });

  it("arms a TikTok post with settings and one video", async () => {
    postFindFirst.mockResolvedValue(existingPost());
    postMediaFindMany.mockResolvedValue([{ media: { fileType: "video/mp4" } }]);
    await expect(makeCaller().update({ id: "post-1", scheduledAt: FUTURE })).resolves.toBeTruthy();
  });

  it("validates a TikTok channel ADDED by channel replacement, using the settings sent with it", async () => {
    postFindFirst.mockResolvedValue(existingPost({ status: "SCHEDULED", scheduledAt: new Date(FUTURE) }));
    postMediaFindMany.mockResolvedValue([{ media: { fileType: "video/mp4" } }]);
    await expect(makeCaller().update({ id: "post-1", channelIds: [TT, TT2] })).rejects.toMatchObject({
      message: "Choose who can see this post on Studio Two (TikTok).",
    });
    await expect(
      makeCaller().update({ id: "post-1", channelIds: [TT, TT2], tiktok: { byChannel: { [TT2]: settings() } as any } })
    ).resolves.toBeTruthy();
  });
});

describe("post.update — channel replacement carries a KEPT target's state", () => {
  it("keeps metadata (TikTok checkpoint) and the ambiguity park on a kept channel; a new one starts clean", async () => {
    const parkedAt = new Date("2026-10-27T10:00:00.000Z");
    postFindFirst.mockResolvedValue({
      id: "post-1",
      status: "DRAFT",
      scheduledAt: null,
      metadata: null,
      targets: [
        {
          channelId: IG,
          format: "REEL",
          contentOverride: "own caption",
          metadata: { tiktokPublish: { publishId: "v_pub_1", createdAt: "2026-10-27T10:00:00.000Z", source: "PULL_FROM_URL" } },
          ambiguousAt: parkedAt,
          ambiguousReason: "may already be live",
          channel: { platform: "INSTAGRAM", name: "Insta" },
        },
      ],
      _count: { mediaAttachments: 1 },
    });
    channelFindMany.mockImplementation(async (args: any) => {
      const want: string[] = args?.where?.id?.in ?? [];
      return [{ id: IG, platform: "INSTAGRAM", name: "Insta" }, { id: "chan-x", platform: "TWITTER", name: "X" }].filter((c) =>
        want.includes(c.id)
      );
    });
    await makeCaller().update({ id: "post-1", channelIds: [IG, "chan-x"] });
    const created = postUpdate.mock.calls[0]![0].data.targets.create;
    expect(created[0]).toEqual({
      channelId: IG,
      status: "DRAFT",
      format: "REEL",
      contentOverride: "own caption",
      metadata: { tiktokPublish: { publishId: "v_pub_1", createdAt: "2026-10-27T10:00:00.000Z", source: "PULL_FROM_URL" } },
      ambiguousAt: parkedAt,
      ambiguousReason: "may already be live",
    });
    // A new channel is written exactly as before.
    expect(created[1]).toEqual({ channelId: "chan-x", status: "DRAFT", format: null, contentOverride: null });
  });
});

describe("post.publishNow — TikTok", () => {
  const post = (metadata: unknown) => ({
    id: "post-1",
    status: "FAILED",
    metadata,
    targets: [{ id: "t-tt", status: "FAILED", channelId: TT, ambiguousAt: null, channel: { platform: "TIKTOK", name: "Studio One" } }],
    _count: { mediaAttachments: 1 },
  });

  it("refuses a TikTok target without settings", async () => {
    postFindFirst.mockResolvedValue(post(null));
    postMediaFindMany.mockResolvedValue([{ media: { fileType: "video/mp4" } }]);
    await expect(makeCaller().publishNow({ id: "post-1" })).rejects.toMatchObject({
      message: "Choose who can see this post on Studio One (TikTok).",
    });
    expect(postPublishAdd).not.toHaveBeenCalled();
    expect(postTargetUpdateMany).not.toHaveBeenCalled();
  });

  it("publishes a TikTok target with settings and one video", async () => {
    postFindFirst.mockResolvedValue(post({ tiktokByChannel: { [TT]: settings() } }));
    postMediaFindMany.mockResolvedValue([{ media: { fileType: "video/mp4" } }]);
    await makeCaller().publishNow({ id: "post-1" });
    expect(postPublishAdd).toHaveBeenCalledTimes(1);
  });

  it("does not look up media for a post without TikTok", async () => {
    postFindFirst.mockResolvedValue({
      ...post(null),
      targets: [{ id: "t-ig", status: "FAILED", channelId: IG, ambiguousAt: null, channel: { platform: "INSTAGRAM", name: "Insta" } }],
    });
    await makeCaller().publishNow({ id: "post-1" });
    expect(postMediaFindMany).not.toHaveBeenCalled();
    expect(postPublishAdd).toHaveBeenCalledTimes(1);
  });
});
