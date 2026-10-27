/**
 * bulk.bulkSchedule — a TikTok post that cannot be armed is SKIPPED and COUNTED,
 * never armed (2026-10-28). The Bulk tab lists every DRAFT, and a TikTok draft
 * may be saved without the user's privacy choice or its video; arming one would
 * flip it to SCHEDULED and fail minutes later, after the toast said "scheduled".
 * Same discipline as skippedStories.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const postUpdate = vi.fn(async (_args: any) => ({ id: "post-1" }));
const postFindFirst = vi.fn();
const postTargetUpdateMany = vi.fn(async (_args: any) => ({ count: 1 }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    post: {
      findFirst: (a: any) => postFindFirst(a),
      update: (a: any) => postUpdate(a),
    },
    postTarget: { updateMany: (a: any) => postTargetUpdateMany(a) },
  },
}));

import { createCallerFactory } from "../trpc";
import { bulkRouter } from "../routers/bulk.router";

const ORG_ID = "org-1";
const settings = { privacyLevel: "FOLLOWER_OF_CREATOR", allowComment: false, allowDuet: false, allowStitch: false, brandOrganic: false, brandContent: false, isAigc: false };

function caller() {
  const prisma = {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: "u1", organizationId: ORG_ID, role: "OWNER" })),
      findFirst: vi.fn(async () => ({ organizationId: ORG_ID })),
    },
    organization: { findUnique: vi.fn(async () => ({ id: ORG_ID, plan: "FREE", planExpiresAt: null })) },
  } as any;
  return createCallerFactory(bulkRouter)({
    session: { user: { id: "u1", email: "u@example.com", isSuperAdmin: false } } as any,
    prisma,
    organizationId: ORG_ID,
  } as any);
}

const tiktokPost = (metadata: unknown, fileTypes: string[]) => ({
  id: "post-1",
  status: "DRAFT",
  metadata,
  _count: { mediaAttachments: fileTypes.length },
  targets: [{ channelId: "tt", status: "DRAFT", ambiguousAt: null, channel: { platform: "TIKTOK", name: "Studio" } }],
  mediaAttachments: fileTypes.map((fileType) => ({ media: { fileType } })),
});

const WHEN = "2099-01-01T10:00:00.000Z";

describe("bulk.bulkSchedule — TikTok", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips and counts a TikTok post whose visibility was never chosen", async () => {
    postFindFirst.mockResolvedValue(tiktokPost(null, ["video/mp4"]));
    const res = await caller().bulkSchedule({ items: [{ postId: "post-1", scheduledAt: WHEN }] });
    expect(res).toEqual({ scheduled: 0, skippedStories: 0, skippedPending: 0, skippedTikTok: 1 });
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postTargetUpdateMany).not.toHaveBeenCalled();
  });

  it("skips and counts a TikTok post without exactly one video", async () => {
    postFindFirst.mockResolvedValue(tiktokPost({ tiktokByChannel: { tt: settings } }, ["image/png"]));
    const res = await caller().bulkSchedule({ items: [{ postId: "post-1", scheduledAt: WHEN }] });
    expect(res.skippedTikTok).toBe(1);
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("arms a TikTok post with its settings and one video", async () => {
    postFindFirst.mockResolvedValue(tiktokPost({ tiktokByChannel: { tt: settings } }, ["video/mp4"]));
    const res = await caller().bulkSchedule({ items: [{ postId: "post-1", scheduledAt: WHEN }] });
    expect(res).toEqual({ scheduled: 1, skippedStories: 0, skippedPending: 0, skippedTikTok: 0 });
  });

  it("ignores a TikTok target that is already published (it is not being armed)", async () => {
    postFindFirst.mockResolvedValue({
      ...tiktokPost(null, []),
      targets: [{ channelId: "tt", status: "PUBLISHED", ambiguousAt: null, channel: { platform: "TIKTOK", name: "S" } }],
    });
    const res = await caller().bulkSchedule({ items: [{ postId: "post-1", scheduledAt: WHEN }] });
    expect(res.scheduled).toBe(1);
  });

  it("reads the target platforms and media types in the SAME post query", async () => {
    postFindFirst.mockResolvedValue(tiktokPost({ tiktokByChannel: { tt: settings } }, ["video/mp4"]));
    await caller().bulkSchedule({ items: [{ postId: "post-1", scheduledAt: WHEN }] });
    const include = postFindFirst.mock.calls[0]![0].include;
    expect(include.targets.select.channel).toEqual({ select: { platform: true, name: true } });
    expect(include.mediaAttachments).toEqual({ select: { media: { select: { fileType: true } } } });
  });
});
