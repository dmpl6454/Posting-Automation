/**
 * Full-coverage media-required guard on post.update (closes the create-only gap).
 *
 * post.update can leave a post SCHEDULED (set/keep scheduledAt) and can replace
 * its target channels. If that results in a media-less Instagram/Facebook target
 * with AI image generation OFF, the post can never publish — so update must block
 * it, exactly like create. Dormant by default (aiImages defaults true).
 *
 * Exercises the REAL post.update mutation through a caller against a mocked prisma.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Plan-limit middleware mock (post.update doesn't gate, but the module is imported). ── */
vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

/* ── Queue mock (imported transitively via chat.router → @postautomation/queue). ── */
vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: vi.fn(async () => {}) },
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
}));

const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const postFindFirst = vi.fn();
const postUpdate = vi.fn();
const channelFindMany = vi.fn();
const auditLogCreate = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    post: {
      findFirst: (...a: any[]) => postFindFirst(...a),
      update: (...a: any[]) => postUpdate(...a),
    },
    channel: { findMany: (...a: any[]) => channelFindMany(...a) },
    auditLog: { create: (...a: any[]) => auditLogCreate(...a) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { postRouter } from "../routers/post.router";
import { prisma as prismaMock } from "@postautomation/db";

const ORG_ID = "org-1";

function makeCaller() {
  const createCaller = createCallerFactory(postRouter);
  return createCaller({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: {
      user: { id: "user-1", email: "boss@example.com", isSuperAdmin: true },
      expires: "2099-01-01",
    } as any,
  });
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  channelFindMany.mockResolvedValue([{ platform: "INSTAGRAM" }]);
  postUpdate.mockResolvedValue({ id: "p1", targets: [], mediaAttachments: [], tags: [] });
});

describe("post.update — full-coverage media-required block", () => {
  it("BLOCKS scheduling a media-less Instagram post when AI is off (aiImages:false)", async () => {
    // Existing SCHEDULED post, IG target, NO media.
    postFindFirst.mockResolvedValue({
      id: "p1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      targets: [{ channelId: "c-ig" }],
      _count: { mediaAttachments: 0 },
    });
    await expect(
      makeCaller().update({ id: "p1", content: "edited", aiImages: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("does NOT block by default (aiImages omitted → true → worker auto-generates)", async () => {
    postFindFirst.mockResolvedValue({
      id: "p1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      targets: [{ channelId: "c-ig" }],
      _count: { mediaAttachments: 0 },
    });
    await expect(makeCaller().update({ id: "p1", content: "edited" })).resolves.toBeTruthy();
    expect(postUpdate).toHaveBeenCalled();
    // aiImages defaulted true → the platform query is never issued.
    expect(channelFindMany).not.toHaveBeenCalled();
  });

  it("does NOT block when the post has media, even with AI off", async () => {
    postFindFirst.mockResolvedValue({
      id: "p1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      targets: [{ channelId: "c-ig" }],
      _count: { mediaAttachments: 1 },
    });
    await expect(
      makeCaller().update({ id: "p1", content: "edited", aiImages: false }),
    ).resolves.toBeTruthy();
    expect(postUpdate).toHaveBeenCalled();
  });

  it("does NOT block when unscheduling (scheduledAt:null) even AI-off + no media", async () => {
    postFindFirst.mockResolvedValue({
      id: "p1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      targets: [{ channelId: "c-ig" }],
      _count: { mediaAttachments: 0 },
    });
    await expect(
      makeCaller().update({ id: "p1", scheduledAt: null, aiImages: false }),
    ).resolves.toBeTruthy();
    expect(postUpdate).toHaveBeenCalled();
  });

  it("BLOCKS when ADDING an Instagram channel to a scheduled media-less post with AI off", async () => {
    // Existing scheduled post had only a non-IG target; the update adds IG.
    postFindFirst.mockResolvedValue({
      id: "p1",
      status: "SCHEDULED",
      scheduledAt: new Date(FUTURE),
      targets: [{ channelId: "c-tw" }],
      _count: { mediaAttachments: 0 },
    });
    // channelIds replacement → ownership check (returns 1) + the platform lookup (IG).
    channelFindMany.mockResolvedValueOnce([{ id: "c-ig" }]).mockResolvedValueOnce([{ platform: "INSTAGRAM" }]);
    await expect(
      makeCaller().update({ id: "p1", channelIds: ["c-ig"], aiImages: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(postUpdate).not.toHaveBeenCalled();
  });
});
