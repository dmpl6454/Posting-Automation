/**
 * Super text — post.create wiring + the publishNow burn guard.
 *
 * Exercises the REAL post router through a caller against a mocked prisma (same
 * harness as post-archive.test.ts / post-update-media-block.test.ts).
 *
 * The load-bearing case is "no super text → metadata written EXACTLY as before":
 * this feature must be completely inert for ordinary posts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

const superTextAdd = vi.fn(async (..._a: any[]) => ({}));
const captionFanoutAdd = vi.fn(async (..._a: any[]) => ({}));
const enqueueScheduled = vi.fn(async (..._a: any[]) => 0);

vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: vi.fn(async () => {}) },
  captionFanoutQueue: { add: (...a: any[]) => captionFanoutAdd(...(a as [])) },
  superTextQueue: { add: (...a: any[]) => superTextAdd(...(a as [])) },
  enqueueScheduledPublishJobs: (...a: any[]) => enqueueScheduled(...(a as [])),
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
  // Mirrors the real helper — post.publishNow now supplies a deterministic jobId
  // so repeated Retry clicks collapse (2026-08-13 duplicate-post fix).
  buildPublishNowJobId: (targetId: string, nowMs: number) =>
    `pubnow:${targetId}:${Math.floor(nowMs / 60_000)}`,
  PUBLISH_NOW_DEDUPE_WINDOW_MS: 60_000,
}));

const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const channelFindMany = vi.fn();
const mediaFindMany = vi.fn();
const postCreate = vi.fn();
const postFindFirst = vi.fn();
const postUpdate = vi.fn();
const postTargetUpdateMany = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    channel: { findMany: (...a: any[]) => channelFindMany(...a) },
    media: { findMany: (...a: any[]) => mediaFindMany(...a) },
    post: {
      create: (...a: any[]) => postCreate(...a),
      findFirst: (...a: any[]) => postFindFirst(...a),
      update: (...a: any[]) => postUpdate(...a),
    },
    postTarget: { updateMany: (...a: any[]) => postTargetUpdateMany(...a) },
    auditLog: { create: vi.fn() },
  },
  ensurePersonalOrg: vi.fn(),
}));

// NOTE: assertMediaOwned / assertMediaForPlatforms are imported from
// ./chat.router (NOT a lib module), so they run for REAL here. The prisma mocks
// below honour `where.id.in` precisely so those ownership counts line up —
// assertMediaForPlatforms short-circuits anyway (hasMedia || aiEnabled).

import { createCallerFactory } from "../trpc";
import { postRouter } from "../routers/post.router";
import { prisma as prismaMock } from "@postautomation/db";

const ORG_ID = "org-1";
const CHANNEL_A = "chan-a";
const CHANNEL_B = "chan-b";
const FUTURE = "2099-01-01T10:00:00.000Z";

const cfg = {
  version: 1 as const,
  segments: [{ text: "Ranveer" }, { text: "Yalina😍", color: "#EF4444" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

function makeCaller() {
  return createCallerFactory(postRouter)({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: {
      user: { id: "user-1", email: "boss@example.com", isSuperAdmin: false },
      expires: "2099-01-01",
    } as any,
  });
}

/** The `data` object post.create passed to prisma. */
const createdData = () => postCreate.mock.calls[0]![0].data;

/** Install media rows behind a filter-aware findMany (see beforeEach). */
function setMediaRows(rows: any[]) {
  mediaFindMany.mockImplementation(async (args: any) => {
    const want: string[] | undefined = args?.where?.id?.in;
    return want ? rows.filter((r) => want.includes(r.id)) : rows;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  // Both mocks HONOUR `where.id.in` — post.create validates ownership by
  // comparing the returned count against the requested id set, so a filter-blind
  // mock would fail every test with "channels are no longer available".
  const allChannels = [
    { id: CHANNEL_A, platform: "INSTAGRAM" },
    { id: CHANNEL_B, platform: "FACEBOOK" },
  ];
  channelFindMany.mockImplementation(async (args: any) => {
    const want: string[] = args?.where?.id?.in ?? [];
    return allChannels.filter((c) => want.includes(c.id));
  });
  setMediaRows([
    { id: "media-1", fileType: "video/mp4", fileSize: BigInt(5_000_000), fileName: "v.mp4", metadata: null },
  ]);
  postCreate.mockResolvedValue({
    id: "post-1",
    status: "DRAFT",
    scheduledAt: null,
    targets: [{ id: "t1", channelId: CHANNEL_A, channel: { platform: "INSTAGRAM" } }],
  });
});

describe("post.create — super text parks the post and enqueues ONE burn job", () => {
  it("scheduled + video config → DRAFT, pendingBurn metadata, deduped burn job, no publish enqueue", async () => {
    await makeCaller().create({
      content: "hello",
      channelIds: [CHANNEL_A],
      scheduledAt: FUTURE,
      mediaIds: ["media-1"],
      metadata: { superText: { "media-1": cfg } },
    });

    const data = createdData();
    // Parked as DRAFT — the publish cron only picks SCHEDULED, so nothing can
    // publish the un-burned video.
    expect(data.status).toBe("DRAFT");
    expect(data.targets.create[0].status).toBe("DRAFT");

    expect(data.metadata.superText).toMatchObject({
      requested: true,
      pendingBurn: true,
      parkedSchedule: true,
    });
    expect(data.metadata.superText.byMediaId["media-1"]).toMatchObject({ version: 1 });

    // Exactly one burn job, with the 3-segment deduping id.
    expect(superTextAdd).toHaveBeenCalledTimes(1);
    const jobId = superTextAdd.mock.calls[0]![2].jobId as string;
    expect(jobId).toBe("supertext:post-1:v1");
    expect(jobId.split(":")).toHaveLength(3);

    // The post is a DRAFT, so no publish jobs are scheduled yet.
    expect(enqueueScheduled).not.toHaveBeenCalled();
  });

  it("unscheduled draft + config → still burns, but parkedSchedule is false", async () => {
    await makeCaller().create({
      content: "hello",
      channelIds: [CHANNEL_A],
      mediaIds: ["media-1"],
      metadata: { superText: { "media-1": cfg } },
    });

    const data = createdData();
    expect(data.metadata.superText.pendingBurn).toBe(true);
    expect(data.metadata.superText.parkedSchedule).toBe(false);
    expect(superTextAdd).toHaveBeenCalledTimes(1);
  });

  it("strips the RAW client map — only the normalized, attached-video block is persisted", async () => {
    // "ghost" is not attached to this post and must never reach the DB.
    await makeCaller().create({
      content: "hello",
      channelIds: [CHANNEL_A],
      scheduledAt: FUTURE,
      mediaIds: ["media-1"],
      metadata: { superText: { "media-1": cfg, ghost: cfg } },
    });

    const st = createdData().metadata.superText;
    expect(Object.keys(st.byMediaId)).toEqual(["media-1"]);
    expect(st.byMediaId.ghost).toBeUndefined();
  });

  it("an IMAGE-only post ignores the config entirely (no park, no job)", async () => {
    setMediaRows([
      { id: "media-1", fileType: "image/png", fileSize: BigInt(1000), fileName: "i.png", metadata: null },
    ]);
    postCreate.mockResolvedValue({ id: "post-1", status: "SCHEDULED", scheduledAt: new Date(FUTURE), targets: [] });

    await makeCaller().create({
      content: "hello",
      channelIds: [CHANNEL_A],
      scheduledAt: FUTURE,
      mediaIds: ["media-1"],
      metadata: { superText: { "media-1": cfg } },
    });

    const data = createdData();
    expect(data.status).toBe("SCHEDULED"); // normal scheduling, not parked
    expect(data.metadata?.superText).toBeUndefined();
    expect(superTextAdd).not.toHaveBeenCalled();
  });

  it("refuses a source over the 950MB cap without creating the post", async () => {
    setMediaRows([
      {
        id: "media-1",
        fileType: "video/mp4",
        fileSize: BigInt(951 * 1024 * 1024),
        fileName: "huge.mp4",
        metadata: null,
      },
    ]);

    await expect(
      makeCaller().create({
        content: "hello",
        channelIds: [CHANNEL_A],
        scheduledAt: FUTURE,
        mediaIds: ["media-1"],
        metadata: { superText: { "media-1": cfg } },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /950MB/ });

    expect(postCreate).not.toHaveBeenCalled();
    expect(superTextAdd).not.toHaveBeenCalled();
  });
});

describe("post.create — WITHOUT super text nothing changes (regression lock)", () => {
  it("no metadata at all → metadata stays undefined and the post schedules normally", async () => {
    postCreate.mockResolvedValue({
      id: "post-1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      targets: [{ id: "t1", channelId: CHANNEL_A, channel: { platform: "INSTAGRAM" } }],
    });

    await makeCaller().create({
      content: "hello",
      channelIds: [CHANNEL_A],
      scheduledAt: FUTURE,
      mediaIds: ["media-1"],
    });

    const data = createdData();
    expect(data.status).toBe("SCHEDULED");
    expect(data.metadata).toBeUndefined();
    expect(superTextAdd).not.toHaveBeenCalled();
    expect(enqueueScheduled).toHaveBeenCalledTimes(1); // exact-time path intact
  });

  it("unrelated metadata (YouTube title) is preserved verbatim, with no superText key", async () => {
    postCreate.mockResolvedValue({
      id: "post-1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      targets: [{ id: "t1", channelId: CHANNEL_A, channel: { platform: "INSTAGRAM" } }],
    });

    await makeCaller().create({
      content: "hello",
      channelIds: [CHANNEL_A],
      scheduledAt: FUTURE,
      metadata: { title: "My video", privacyStatus: "unlisted" },
    });

    expect(createdData().metadata).toEqual({ title: "My video", privacyStatus: "unlisted" });
  });

  it("super text and unique captions can park the same post together", async () => {
    await makeCaller().create({
      content: "hello",
      channelIds: [CHANNEL_A, CHANNEL_B],
      scheduledAt: FUTURE,
      mediaIds: ["media-1"],
      uniqueCaptions: true,
      metadata: { superText: { "media-1": cfg } },
    });

    const data = createdData();
    expect(data.status).toBe("DRAFT");
    expect(data.metadata.captionFanout.pendingSchedule).toBe(true);
    expect(data.metadata.superText.pendingBurn).toBe(true);
    expect(superTextAdd).toHaveBeenCalledTimes(1);
    expect(captionFanoutAdd).toHaveBeenCalledTimes(1);
  });
});

describe("post.publishNow — refuses while a burn is in flight", () => {
  it("blocks publishing the un-burned original", async () => {
    postFindFirst.mockResolvedValue({
      id: "post-1",
      status: "DRAFT",
      metadata: { superText: { pendingBurn: true } },
      targets: [{ id: "t1", status: "DRAFT", channelId: CHANNEL_A, channel: { platform: "INSTAGRAM" } }],
    });

    await expect(makeCaller().publishNow({ id: "post-1" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postTargetUpdateMany).not.toHaveBeenCalled();
  });

  it("allows publishing once the burn has completed", async () => {
    postFindFirst.mockResolvedValue({
      id: "post-1",
      status: "DRAFT",
      metadata: { superText: { pendingBurn: false } },
      targets: [{ id: "t1", status: "DRAFT", channelId: CHANNEL_A, channel: { platform: "INSTAGRAM" } }],
    });
    postUpdate.mockResolvedValue({ id: "post-1" });
    postTargetUpdateMany.mockResolvedValue({ count: 1 });

    await makeCaller().publishNow({ id: "post-1" });
    expect(postUpdate).toHaveBeenCalled();
  });

  it("a post with no super text is unaffected", async () => {
    postFindFirst.mockResolvedValue({
      id: "post-1",
      status: "DRAFT",
      metadata: null,
      targets: [{ id: "t1", status: "DRAFT", channelId: CHANNEL_A, channel: { platform: "INSTAGRAM" } }],
    });
    postUpdate.mockResolvedValue({ id: "post-1" });
    postTargetUpdateMany.mockResolvedValue({ count: 1 });

    await makeCaller().publishNow({ id: "post-1" });
    expect(postUpdate).toHaveBeenCalled();
  });
});
