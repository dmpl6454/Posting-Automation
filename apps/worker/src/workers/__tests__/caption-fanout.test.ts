/**
 * PR-5 — caption-fanout worker core (runCaptionFanout) + the publish-worker
 * precedence contract.
 *
 * Follows the sentiment-analysis.test.ts pattern: the worker core is an
 * exported, dependency-injected function, so these tests exercise the REAL
 * fanout/flip/safety-valve logic against stateful in-memory mocks — no BullMQ
 * worker instantiation, no module-resolution mocking.
 *
 * Locked behaviors:
 *  - idempotency: targets with a non-null contentOverride are NEVER
 *    regenerated on a re-run (BullMQ retry);
 *  - the DRAFT→SCHEDULED flip happens exactly once (guarded by post.status +
 *    metadata.captionFanout.pendingSchedule);
 *  - SAFETY VALVE: when generation fails, overrides stay NULL but the flip
 *    still happens (shared caption publishes — degraded, never lost);
 *  - captions are clamped to the platform char limit;
 *  - chunking: >chunkSize pending targets → multiple LLM calls;
 *  - the post-publish worker's content precedence one-liner stays
 *    `contentOverride ?? contentVariants?.[platform] ?? post.content`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runCaptionFanout,
  flipPendingFanoutPost,
  parseCaptionArray,
  buildCaptionPrompt,
} from "../caption-fanout.worker";

const CHAR_LIMITS: Record<string, number> = { BLUESKY: 300, TWITTER: 25000, INSTAGRAM: 2200 };
const charLimitFor = (p: string) => CHAR_LIMITS[p];

type MockTarget = {
  id: string;
  status: string;
  contentOverride: string | null;
  channel: { name: string | null; username: string | null; platform: string };
};

/** Stateful in-memory prisma stand-in: updates mutate the fixture. */
function statefulPrisma(post: {
  id: string;
  organizationId: string;
  status: string;
  content: string;
  metadata: Record<string, unknown> | null;
  targets: MockTarget[];
}) {
  const state = { post: { ...post, targets: post.targets.map((t) => ({ ...t })) } };
  const prisma = {
    post: {
      findFirst: vi.fn(async (args: any) => {
        if (args?.where?.id !== state.post.id) return null;
        if (args?.where?.organizationId && args.where.organizationId !== state.post.organizationId) return null;
        return { ...state.post, targets: state.post.targets };
      }),
      update: vi.fn(async (args: any) => {
        Object.assign(state.post, args.data);
        return state.post;
      }),
    },
    postTarget: {
      update: vi.fn(async (args: any) => {
        const target = state.post.targets.find((t) => t.id === args.where.id)!;
        Object.assign(target, args.data);
        return target;
      }),
      updateMany: vi.fn(async (_args: any) => {
        let count = 0;
        for (const t of state.post.targets) {
          if (t.status === "DRAFT") {
            t.status = "SCHEDULED";
            count++;
          }
        }
        return { count };
      }),
    },
  };
  return { prisma, state };
}

const pendingFanoutPost = (targets: MockTarget[]) => ({
  id: "post-1",
  organizationId: "org-1",
  status: "DRAFT",
  content: "Big launch today — our new feature is live!",
  metadata: { captionFanout: { requested: true, pendingSchedule: true } },
  targets,
});

const target = (id: string, platform: string, override: string | null = null): MockTarget => ({
  id,
  status: "DRAFT",
  contentOverride: override,
  channel: { name: `chan-${id}`, username: `handle_${id}`, platform },
});

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("parseCaptionArray", () => {
  it("parses a clean JSON array", () => {
    expect(parseCaptionArray('[{"index":0,"caption":"Hello"}]')).toEqual([{ index: 0, caption: "Hello" }]);
  });

  it("tolerates markdown fences and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n[{"index": 0, "caption": "A"}, {"index": 1, "caption": "B"}]\n```\nDone!';
    expect(parseCaptionArray(raw)).toEqual([
      { index: 0, caption: "A" },
      { index: 1, caption: "B" },
    ]);
  });

  it("drops malformed items but keeps valid ones", () => {
    const raw = '[{"index":0,"caption":"ok"},{"index":"x","caption":"bad idx"},{"index":1},{"index":2,"caption":"  "}]';
    expect(parseCaptionArray(raw)).toEqual([{ index: 0, caption: "ok" }]);
  });

  it("throws when there is no JSON array at all", () => {
    expect(() => parseCaptionArray("Sorry, I cannot help with that.")).toThrow();
  });
});

describe("runCaptionFanout", () => {
  it("generates only for NULL-override targets (idempotency) and flips exactly once", async () => {
    const { prisma, state } = statefulPrisma(
      pendingFanoutPost([target("t1", "BLUESKY"), target("t2", "TWITTER", "already written")])
    );
    const generateText = vi.fn(async (_prompt: string) => '[{"index":0,"caption":"Fresh unique caption"}]');

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toEqual({ generated: 1, skippedExisting: 1, flipped: true, degraded: false });
    expect(generateText).toHaveBeenCalledTimes(1);
    // Prompt describes ONLY the pending target — the pre-written one is skipped.
    const prompt = generateText.mock.calls[0]![0];
    expect(prompt).toContain("chan-t1");
    expect(prompt).not.toContain("chan-t2");
    // Override written; post + targets flipped to SCHEDULED; flag cleared.
    expect(state.post.targets.find((t) => t.id === "t1")!.contentOverride).toBe("Fresh unique caption");
    expect(state.post.targets.find((t) => t.id === "t2")!.contentOverride).toBe("already written");
    expect(state.post.status).toBe("SCHEDULED");
    expect(state.post.targets.every((t) => t.status === "SCHEDULED")).toBe(true);
    expect((state.post.metadata as any).captionFanout.pendingSchedule).toBe(false);

    // Re-run (retry after completion): nothing regenerated, no second flip.
    const rerun = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );
    expect(rerun).toEqual({ generated: 0, skippedExisting: 2, flipped: false, degraded: false });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("SAFETY VALVE: generation failure still flips DRAFT→SCHEDULED with null overrides", async () => {
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY"), target("t2", "TWITTER")]));
    const generateText = vi.fn(async () => {
      throw new Error("every provider is down");
    });

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toEqual({ generated: 0, skippedExisting: 0, flipped: true, degraded: true });
    expect(state.post.status).toBe("SCHEDULED"); // degraded, never lost
    expect(state.post.targets.every((t) => t.contentOverride === null)).toBe(true);
    expect((state.post.metadata as any).captionFanout.degraded).toBe(true);
    expect(prisma.postTarget.update).not.toHaveBeenCalled();
  });

  it("clamps captions to the platform char limit", async () => {
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY")]));
    const long = "x".repeat(400);
    const generateText = vi.fn(async () => JSON.stringify([{ index: 0, caption: long }]));

    await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(state.post.targets[0]!.contentOverride).toHaveLength(300);
  });

  it("chunks pending targets into multiple LLM calls", async () => {
    const targets = Array.from({ length: 7 }, (_, i) => target(`t${i}`, "INSTAGRAM"));
    const { prisma, state } = statefulPrisma(pendingFanoutPost(targets));
    const generateText = vi.fn(async (prompt: string) => {
      const count = (prompt.match(/platform=INSTAGRAM/g) || []).length;
      return JSON.stringify(Array.from({ length: count }, (_, i) => ({ index: i, caption: `caption ${i}` })));
    });

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor, chunkSize: 5 }
    );

    expect(generateText).toHaveBeenCalledTimes(2); // 5 + 2
    expect(result).toMatchObject({ generated: 7, flipped: true });
    expect(state.post.targets.every((t) => t.contentOverride !== null)).toBe(true);
  });

  it("a plain-draft fanout (pendingSchedule=false) writes captions but never flips", async () => {
    const { prisma, state } = statefulPrisma({
      ...pendingFanoutPost([target("t1", "TWITTER"), target("t2", "BLUESKY")]),
      metadata: { captionFanout: { requested: true, pendingSchedule: false } },
    });
    const generateText = vi.fn(async () => '[{"index":0,"caption":"A"},{"index":1,"caption":"B"}]');

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toMatchObject({ generated: 2, flipped: false });
    expect(state.post.status).toBe("DRAFT");
  });

  it("is org-scoped: a foreign organizationId never touches the post", async () => {
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "TWITTER"), target("t2", "BLUESKY")]));
    const generateText = vi.fn();

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-EVIL" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toEqual({ skipped: "post_not_found" });
    expect(generateText).not.toHaveBeenCalled();
    expect(state.post.status).toBe("DRAFT");
  });
});

describe("flipPendingFanoutPost", () => {
  it("no-ops for a post that is not DRAFT-pending-fanout", async () => {
    const { prisma } = statefulPrisma({
      ...pendingFanoutPost([target("t1", "TWITTER")]),
      status: "SCHEDULED",
    });
    await expect(flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1")).resolves.toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});

describe("post-publish worker content precedence (wiring lock)", () => {
  it("keeps the exact one-liner: contentOverride ?? contentVariants?.[platform] ?? post.content", () => {
    const src = readFileSync(join(__dirname, "..", "post-publish.worker.ts"), "utf8");
    expect(src).toMatch(
      /const content = postTarget\.contentOverride \?\? contentVariants\?\.\[platform\] \?\? postTarget\.post\.content;/
    );
  });

  it("semantics: override wins; null falls through to variant, then shared content", () => {
    const resolve = (
      contentOverride: string | null,
      contentVariants: Record<string, string> | null,
      platform: string,
      postContent: string
    ) => contentOverride ?? contentVariants?.[platform] ?? postContent;

    expect(resolve("unique", { TWITTER: "variant" }, "TWITTER", "shared")).toBe("unique");
    expect(resolve(null, { TWITTER: "variant" }, "TWITTER", "shared")).toBe("variant");
    expect(resolve(null, { TWITTER: "variant" }, "BLUESKY", "shared")).toBe("shared");
    expect(resolve(null, null, "TWITTER", "shared")).toBe("shared");
  });
});

describe("buildCaptionPrompt", () => {
  it("names every channel with platform + handle + char limit and demands distinct captions", () => {
    const prompt = buildCaptionPrompt("Base content here", [
      { index: 0, platform: "TWITTER", channelName: "News X", username: "newsx", charLimit: 25000 },
      { index: 1, platform: "BLUESKY", channelName: "News B", username: null, charLimit: 300 },
    ]);
    expect(prompt).toContain("Base content here");
    expect(prompt).toContain('0. platform=TWITTER, channel="News X" (@newsx), max 25000 characters');
    expect(prompt).toContain('1. platform=BLUESKY, channel="News B", max 300 characters');
    expect(prompt).toMatch(/DISTINCT/);
    expect(prompt).toMatch(/hashtags may repeat/);
  });
});
