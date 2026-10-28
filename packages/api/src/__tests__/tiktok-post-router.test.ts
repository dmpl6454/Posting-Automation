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
const postTargetFindUnique = vi.fn();
const postTargetUpdate = vi.fn(async (...a: any[]) => ({ id: a[0].where.id, contentOverride: a[0].data.contentOverride }));
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
    postTarget: {
      updateMany: (...a: any[]) => postTargetUpdateMany(...a),
      findUnique: (...a: any[]) => postTargetFindUnique(...a),
      update: (...a: any[]) => postTargetUpdate(...a),
    },
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

  it("STRIPS a client-written publish checkpoint, @handle and video length (only the server/worker write those)", async () => {
    // A forged tiktokPublish made the provider RESUME an unrelated publish and
    // mark this post PUBLISHED without sending the new video.
    await makeCaller().create({
      content: "hello",
      channelIds: [TT],
      metadata: {
        title: "T",
        tiktokPublish: { publishId: "v_pub_url~v2-1.forged", createdAt: "2026-10-01T00:00:00Z", source: "PULL_FROM_URL" },
        channelUsername: "someone.else",
        videoDurationSec: 1,
      } as any,
    });
    expect(createdData().metadata).toEqual({ title: "T" });
  });

  it("refuses a TikTok caption over 2,200 characters, naming the channel — never cut at publish", async () => {
    const long = "x".repeat(2195) + " #brand #ad"; // 2,206
    await expect(
      makeCaller().create({ content: long, channelIds: [TT, IG], mediaIds: ["vid"], tiktok: { byChannel: { [TT]: settings() } as any } })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The caption for Studio One (TikTok) is 2,206 characters — TikTok allows up to 2,200. Shorten it and try again.",
    });
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("a TikTok channel with its OWN short caption is fine even when the shared one is long", async () => {
    await makeCaller().create({
      content: "x".repeat(3000),
      channelIds: [TT, IG],
      mediaIds: ["vid"],
      captionOverrides: { [TT]: "short TikTok caption" },
    } as any);
    expect(postCreate).toHaveBeenCalled();
  });

  it("AI unique captions never fan out for TikTok: only the OTHER channels count", async () => {
    // The caption fan-out worker never writes a TikTok caption (the user must see
    // the exact text posted), so TikTok + one other channel has nothing to vary —
    // the post must not be parked waiting on a fan-out.
    await makeCaller().create({
      content: "hello",
      channelIds: [TT, TT2, IG],
      mediaIds: ["vid"],
      uniqueCaptions: true,
      scheduledAt: FUTURE,
      tiktok: { byChannel: { [TT]: settings(), [TT2]: settings() } as any },
    } as any);
    expect(createdData().metadata?.captionFanout).toBeUndefined();
    expect(createdData().status).toBe("SCHEDULED");
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
    // An existing post: no screen edits its TikTok settings, so the message says
    // where they are chosen instead of pointing at a missing control.
    await expect(makeCaller().update({ id: "post-1", scheduledAt: FUTURE })).rejects.toMatchObject({
      message: "This post has no TikTok settings for Studio One (who can see the video). They're chosen when the post is created — create this TikTok post again in Content Studio.",
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
      message: "This post has no TikTok settings for Studio Two (who can see the video). They're chosen when the post is created — create this TikTok post again in Content Studio.",
    });
    await expect(
      makeCaller().update({ id: "post-1", channelIds: [TT, TT2], tiktok: { byChannel: { [TT2]: settings() } as any } })
    ).resolves.toBeTruthy();
  });
});

describe("post.update — TikTok captions (2026-10-28)", () => {
  const ttPost = (over: Record<string, unknown> = {}) => ({
    id: "post-1",
    status: "DRAFT",
    scheduledAt: null,
    content: "short",
    contentVariants: null,
    metadata: { tiktokByChannel: { [TT]: settings() } },
    targets: [{ channelId: TT, status: "DRAFT", format: null, contentOverride: null, metadata: null, ambiguousAt: null, ambiguousReason: null, channel: { platform: "TIKTOK", name: "Studio One" } }],
    _count: { mediaAttachments: 1 },
    ...over,
  });

  it("refuses an edit that makes a TikTok channel's caption longer than 2,200", async () => {
    postFindFirst.mockResolvedValue(ttPost());
    await expect(makeCaller().update({ id: "post-1", content: "y".repeat(2300) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The caption for Studio One (TikTok) is 2,300 characters — TikTok allows up to 2,200. Shorten it and try again.",
    });
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("a TikTok-specific variant is checked too (the worker publishes it over the shared caption)", async () => {
    postFindFirst.mockResolvedValue(ttPost());
    await expect(makeCaller().update({ id: "post-1", contentVariants: { TIKTOK: "z".repeat(2201) } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("a TikTok target with its own caption is not affected by a long shared caption", async () => {
    postFindFirst.mockResolvedValue(
      ttPost({ targets: [{ ...ttPost().targets[0], contentOverride: "own words" }] })
    );
    await expect(makeCaller().update({ id: "post-1", content: "y".repeat(2300) })).resolves.toBeTruthy();
  });
});

describe("post.update — channels can't change once a target is publishing or published", () => {
  it.each(["PUBLISHED", "PUBLISHING"])("refuses channel replacement while a target is %s (it would be recreated and posted again)", async (status) => {
    // publishNow sets the post SCHEDULED before the 30 s cron flips it to
    // PUBLISHING, so a partly published post is editable for a moment; channel
    // replacement deletes and recreates EVERY target as SCHEDULED.
    postFindFirst.mockResolvedValue({
      id: "post-1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      content: "hi",
      contentVariants: null,
      metadata: null,
      targets: [
        { channelId: IG, status, format: null, contentOverride: null, metadata: null, ambiguousAt: null, ambiguousReason: null, channel: { platform: "INSTAGRAM", name: "Insta" } },
      ],
      _count: { mediaAttachments: 1 },
    });
    // Even re-sending the SAME channel list recreates the target as SCHEDULED.
    await expect(makeCaller().update({ id: "post-1", channelIds: [IG] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/Channels can't be changed/),
    });
    expect(postUpdate).not.toHaveBeenCalled();
  });
});

describe("post.updateTargetContent — TikTok", () => {
  it("refuses a TikTok channel caption over 2,200 characters", async () => {
    postTargetFindUnique.mockResolvedValue({
      id: "t-tt",
      status: "SCHEDULED",
      post: { organizationId: ORG_ID, content: "shared" },
      channel: { platform: "TIKTOK", name: "Studio One" },
    });
    await expect(makeCaller().updateTargetContent({ targetId: "t-tt", contentOverride: "x".repeat(2201) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The caption for Studio One (TikTok) is 2,201 characters — TikTok allows up to 2,200. Shorten it and try again.",
    });
    expect(postTargetUpdate).not.toHaveBeenCalled();
  });

  it("another platform's long caption is untouched by the TikTok rule", async () => {
    postTargetFindUnique.mockResolvedValue({
      id: "t-ig",
      status: "SCHEDULED",
      post: { organizationId: ORG_ID, content: "shared" },
      channel: { platform: "FACEBOOK", name: "Page" },
    });
    await makeCaller().updateTargetContent({ targetId: "t-ig", contentOverride: "x".repeat(5000) });
    expect(postTargetUpdate).toHaveBeenCalled();
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
      message: "This post has no TikTok settings for Studio One (who can see the video). They're chosen when the post is created — create this TikTok post again in Content Studio.",
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
