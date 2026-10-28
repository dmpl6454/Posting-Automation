/**
 * bulk.csvImport had no plan-quota check and no row cap (security audit
 * 2026-09-28, idor-posts cluster).
 *
 * Every other post-creation path (post.create, chat's schedule_post/
 * bulk_schedule) calls enforcePlanLimit(organizationId, "postsPerMonth", ...)
 * before writing. csvImport never did — a single pasted CSV could create an
 * unbounded number of Post + PostTarget rows in one synchronous request,
 * completely bypassing the monthly posts quota (FREE=30, STARTER=500) and,
 * independent of plan, holding the request open for as long as the row count
 * demands (a resource-exhaustion vector even on an unlimited plan).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const postCreate = vi.fn(async (args: any) => ({ id: "post-x", ...args.data }));
const channelFindMany = vi.fn(async (..._a: any[]) => [{ id: "ch-1" }]);
let usageResult = { allowed: true, current: 0, limit: -1, planName: "Unlimited" };
const checkUsageLimit = vi.fn(async (..._a: any[]) => usageResult);

vi.mock("@postautomation/db", () => ({
  prisma: {
    post: { create: (a: any) => postCreate(a) },
    channel: { findMany: (a: any) => channelFindMany(a) },
  },
}));

vi.mock("../middleware/plan-limit.middleware", () => ({
  checkUsageLimit: (...a: any[]) => checkUsageLimit(...a),
  isBillingDisabled: () => false,
}));

import { createCallerFactory } from "../trpc";
import { bulkRouter, MAX_CSV_IMPORT_ROWS } from "../routers/bulk.router";

const ORG_ID = "org-1";

function buildCaller() {
  const prisma = {
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: ORG_ID, role: "OWNER" })) },
    organization: { findUnique: vi.fn(async () => ({ id: ORG_ID, plan: "FREE", planExpiresAt: null })) },
  } as any;
  return createCallerFactory(bulkRouter)({
    session: { user: { id: "u1", email: "u@example.com", isSuperAdmin: false } } as any,
    prisma,
    organizationId: ORG_ID,
  } as any);
}

function csvOf(n: number): string {
  // Two columns (a trailing comma) so papaparse's delimiter auto-detect
  // doesn't warn on a single-column file with no comma anywhere in it.
  return "content,note\n" + Array.from({ length: n }, (_, i) => `row ${i},`).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  usageResult = { allowed: true, current: 0, limit: -1, planName: "Unlimited" };
});

describe("bulk.csvImport row cap", () => {
  it(`refuses a CSV with more than ${MAX_CSV_IMPORT_ROWS} rows before creating anything`, async () => {
    const csvData = csvOf(MAX_CSV_IMPORT_ROWS + 1);
    await expect(buildCaller().csvImport({ csvData, channelIds: ["ch-1"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("accepts exactly the cap", async () => {
    const csvData = csvOf(MAX_CSV_IMPORT_ROWS);
    const res = await buildCaller().csvImport({ csvData, channelIds: ["ch-1"] });
    expect(res.imported).toBe(MAX_CSV_IMPORT_ROWS);
  });
});

describe("bulk.csvImport plan quota", () => {
  it("refuses an import that would exceed the monthly posts quota", async () => {
    usageResult = { allowed: false, current: 28, limit: 30, planName: "Free" };
    const csvData = csvOf(5); // 28 + 5 > 30
    await expect(buildCaller().csvImport({ csvData, channelIds: ["ch-1"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("allows an import that fits within the remaining quota", async () => {
    usageResult = { allowed: true, current: 10, limit: 30, planName: "Free" };
    const csvData = csvOf(5); // 10 + 5 <= 30
    const res = await buildCaller().csvImport({ csvData, channelIds: ["ch-1"] });
    expect(res.imported).toBe(5);
  });

  it("an unlimited plan (-1) is never blocked regardless of current usage", async () => {
    usageResult = { allowed: true, current: 999_999, limit: -1, planName: "Enterprise" };
    const csvData = csvOf(3);
    const res = await buildCaller().csvImport({ csvData, channelIds: ["ch-1"] });
    expect(res.imported).toBe(3);
  });

  it("checks usage BEFORE creating any posts", async () => {
    usageResult = { allowed: false, current: 30, limit: 30, planName: "Free" };
    const csvData = csvOf(1);
    await expect(buildCaller().csvImport({ csvData, channelIds: ["ch-1"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(checkUsageLimit).toHaveBeenCalledWith(ORG_ID, "postsPerMonth", false);
  });
});

describe("bulk.csvImport — TikTok channels (2026-10-28)", () => {
  it("refuses a TikTok channel before creating anything: CSV rows have no video and no TikTok settings", async () => {
    // A SCHEDULED TikTok target created here could only fail at publish ("choose
    // who can see this post"), after the import had reported it imported.
    channelFindMany.mockResolvedValueOnce([
      { id: "ch-1", platform: "INSTAGRAM" },
      { id: "ch-tt", platform: "TIKTOK" },
    ] as any);
    await expect(
      buildCaller().csvImport({ csvData: csvOf(2), channelIds: ["ch-1", "ch-tt"], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/TikTok posts can't be imported from CSV/) });
    expect(postCreate).not.toHaveBeenCalled();
  });

  it("selects the platform so the check is possible", async () => {
    await buildCaller().csvImport({ csvData: csvOf(1), channelIds: ["ch-1"] });
    expect(channelFindMany.mock.calls[0]![0].select).toMatchObject({ id: true, platform: true });
  });
});
