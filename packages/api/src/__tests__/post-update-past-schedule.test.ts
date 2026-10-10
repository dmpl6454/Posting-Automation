/**
 * post.update refuses a NEW schedule time in the past (2026-10-10).
 *
 * The post page seeded its picker from a UTC slice, so for an IST user every
 * Save re-sent a time 5½ hours early; with no past check on update the post
 * became due at once and published. create already had the check — update
 * now mirrors it, judging only a CHANGED time so a caption edit that resends
 * the existing value (even an already-due one) still saves.
 *
 * Same harness as post-update-media-block.test.ts: the REAL mutation through a
 * caller against a mocked prisma.
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
  enqueueScheduledPublishJobs: vi.fn(async () => 0),
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

describe("post.update — a changed schedule time cannot be in the past", () => {
  const existing = (scheduledAt: Date | null) => ({
    id: "p1",
    status: scheduledAt ? "SCHEDULED" : "DRAFT",
    scheduledAt,
    targets: [{ channelId: "c-ig" }],
    _count: { mediaAttachments: 1 },
    metadata: {},
  });

  it("REFUSES moving the schedule to a time in the past", async () => {
    postFindFirst.mockResolvedValue(existing(new Date(FUTURE)));
    const past = new Date(Date.now() - 5.5 * 3_600_000).toISOString(); // the IST-offset shift
    await expect(makeCaller().update({ id: "p1", scheduledAt: past })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Scheduled time cannot be in the past.",
    });
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("REFUSES scheduling a draft for a past time", async () => {
    postFindFirst.mockResolvedValue(existing(null));
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    await expect(makeCaller().update({ id: "p1", scheduledAt: past })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("still saves a caption edit that resends the UNCHANGED time, even when that time is already due", async () => {
    const due = new Date(Date.now() - 10 * 60_000); // due; the cron has not flipped it yet
    postFindFirst.mockResolvedValue(existing(due));
    await expect(makeCaller().update({ id: "p1", content: "edited", scheduledAt: due.toISOString() })).resolves.toBeTruthy();
    expect(postUpdate).toHaveBeenCalled();
  });

  it("accepts a future time and the 60s clock-skew allowance, and unscheduling", async () => {
    postFindFirst.mockResolvedValue(existing(new Date(FUTURE)));
    await expect(makeCaller().update({ id: "p1", scheduledAt: new Date(Date.now() + 7_200_000).toISOString() })).resolves.toBeTruthy();
    await expect(makeCaller().update({ id: "p1", scheduledAt: new Date(Date.now() - 30_000).toISOString() })).resolves.toBeTruthy();
    await expect(makeCaller().update({ id: "p1", scheduledAt: null })).resolves.toBeTruthy();
  });
});
