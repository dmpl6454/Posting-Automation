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
 *  - SAFETY VALVE (PARTIAL failure): the failed channels keep a NULL override
 *    and the flip still happens (shared caption for those — degraded, never lost);
 *  - HOLD (TOTAL failure, owner decision 2026-09-28): when NO channel gets a
 *    unique caption, the post is HELD as a draft and the creator is told it was
 *    NOT published. This REVERSES the original "always flip" rule: on
 *    2026-09-28 a 240-Page Facebook post was minutes from publishing identical
 *    text to every Page because both AI providers were out of credit;
 *  - OUT OF CREDIT stops the loop: every later chunk would get the same answer;
 *  - PROVIDER EXHAUSTION surfacing: a degraded flip stamps
 *    metadata.captionFanout {degraded, degradedAt, reason} and writes ONE
 *    in-app Notification for the post creator (org-OWNER fallback for
 *    creatorless posts) — best-effort, a notification failure never blocks
 *    the flip;
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
  holdPendingFanoutPost,
  parseCaptionArray,
  buildCaptionPrompt,
  HELD_REASON_NO_CREDIT,
  HELD_REASON_FAILED,
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
  createdById?: string | null;
  scheduledAt?: Date | null;
}) {
  const state = {
    post: { createdById: "creator-1", ...post, targets: post.targets.map((t) => ({ ...t })) },
    notifications: [] as any[],
  };
  const prisma = {
    organizationMember: {
      findMany: vi.fn(async (_args: any) => [{ userId: "owner-1" }]),
    },
    notification: {
      create: vi.fn(async (args: any) => {
        state.notifications.push(args.data);
        return args.data;
      }),
    },
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

// A parked post ALWAYS has scheduledAt in production: planCaptionFanout only
// sets pendingSchedule when scheduledAt != null.
const pendingFanoutPost = (targets: MockTarget[]) => ({
  id: "post-1",
  organizationId: "org-1",
  status: "DRAFT",
  scheduledAt: new Date("2099-01-01T10:00:00.000Z") as Date | null,
  content: "Big launch today — our new feature is live!",
  metadata: { captionFanout: { requested: true, pendingSchedule: true } } as Record<string, unknown> | null,
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

  it("HOLD: when no channel gets a caption, the post stays a DRAFT and is NOT published", async () => {
    // Was "SAFETY VALVE: generation failure still flips DRAFT→SCHEDULED". Owner
    // decision 2026-09-28: total failure holds instead of publishing the shared
    // caption to every channel.
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY"), target("t2", "TWITTER")]));
    const generateText = vi.fn(async () => {
      throw new Error("every provider is down");
    });

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toEqual({ generated: 0, skippedExisting: 0, flipped: false, degraded: true, held: true });
    expect(state.post.status).toBe("DRAFT");
    expect(state.post.targets.every((t) => t.status === "DRAFT")).toBe(true);
    expect(prisma.postTarget.updateMany).not.toHaveBeenCalled();
    expect(prisma.postTarget.update).not.toHaveBeenCalled();
    const fanoutMeta = (state.post.metadata as any).captionFanout;
    expect(fanoutMeta).toMatchObject({ requested: true, pendingSchedule: false, held: true, reason: HELD_REASON_FAILED });
    expect(typeof fanoutMeta.heldAt).toBe("string");
  });

  it("PROVIDER EXHAUSTION end-to-end: every chunk throws → HELD, not published, creator told it did NOT publish, never throws", async () => {
    // 3 targets with chunkSize 2 → 2 chunks, BOTH exhaust every provider.
    const { prisma, state } = statefulPrisma(
      pendingFanoutPost([target("t1", "BLUESKY"), target("t2", "TWITTER"), target("t3", "INSTAGRAM")])
    );
    const generateText = vi.fn(async () => {
      throw new Error("All AI providers failed. Last error (anthropic): overloaded");
    });

    // (e) the worker core never throws unhandled on total provider exhaustion.
    await expect(
      runCaptionFanout(
        { postId: "post-1", organizationId: "org-1" },
        { prisma: prisma as any, generateText, charLimitFor, chunkSize: 2 }
      )
    ).resolves.toEqual({ generated: 0, skippedExisting: 0, flipped: false, degraded: true, held: true });

    // No credit classifier injected → a generic failure: every chunk is still tried.
    expect(generateText).toHaveBeenCalledTimes(2);
    // (a) NOT published: post and every target remain DRAFT.
    expect(state.post.status).toBe("DRAFT");
    expect(state.post.targets.every((t) => t.status === "DRAFT")).toBe(true);
    // (b) no override was written.
    expect(state.post.targets.every((t) => t.contentOverride === null)).toBe(true);
    // (c) the hold is recorded, and it is a publish gate (pendingSchedule cleared, held set).
    const fanoutMeta = (state.post.metadata as any).captionFanout;
    expect(fanoutMeta).toMatchObject({ pendingSchedule: false, held: true, reason: HELD_REASON_FAILED });
    // (d) one notification for the CREATOR that says, plainly, it was NOT published.
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]).toMatchObject({
      userId: "creator-1",
      organizationId: "org-1",
      type: "post.captions_held",
      link: "/dashboard/posts/post-1",
    });
    expect(state.notifications[0].body).toMatch(/NOT published/);
    expect(prisma.organizationMember.findMany).not.toHaveBeenCalled();
  });

  it("OUT OF CREDIT stops at the first chunk instead of repeating a call that cannot succeed", async () => {
    // 2026-09-28: 24 chunks x ~97s. With the classifier, one call is enough.
    const targets = Array.from({ length: 30 }, (_, i) => target(`t${i}`, "FACEBOOK"));
    const { prisma, state } = statefulPrisma(pendingFanoutPost(targets));
    const noCredit = Object.assign(new Error("400 Your credit balance is too low to access the Anthropic API."), {
      status: 400,
    });
    const generateText = vi.fn(async () => {
      throw noCredit;
    });
    const isCreditExhausted = vi.fn((e: unknown) => e === noCredit);

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor, isCreditExhausted }
    );

    expect(generateText).toHaveBeenCalledTimes(1); // not 3
    expect(result).toMatchObject({ generated: 0, flipped: false, held: true });
    expect((state.post.metadata as any).captionFanout.reason).toBe(HELD_REASON_NO_CREDIT);
    expect(state.notifications[0].body).toMatch(/out of credit/);
    expect(state.post.status).toBe("DRAFT");
  });

  it("an ordinary failure does NOT stop the loop — later chunks may still succeed", async () => {
    const targets = Array.from({ length: 4 }, (_, i) => target(`t${i}`, "FACEBOOK"));
    const { prisma, state } = statefulPrisma(pendingFanoutPost(targets));
    const generateText = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 overloaded"))
      .mockResolvedValueOnce('[{"index":0,"caption":"C"},{"index":1,"caption":"D"}]');

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor, chunkSize: 2, isCreditExhausted: () => false }
    );

    expect(generateText).toHaveBeenCalledTimes(2);
    // Partial success still publishes (the failed channels use the shared caption).
    expect(result).toEqual({ generated: 2, skippedExisting: 0, flipped: true, degraded: true });
    expect(state.post.status).toBe("SCHEDULED");
  });

  it("a model that returns no usable captions at all also HOLDS (nothing unique was produced)", async () => {
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY"), target("t2", "TWITTER")]));
    const generateText = vi.fn(async () => "[]");

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toMatchObject({ generated: 0, flipped: false, held: true });
    expect(state.post.status).toBe("DRAFT");
  });

  it("a plain draft (no schedule) is never held — it was never going to publish", async () => {
    const { prisma, state } = statefulPrisma({
      ...pendingFanoutPost([target("t1", "BLUESKY"), target("t2", "TWITTER")]),
      metadata: { captionFanout: { requested: true, pendingSchedule: false } },
    });
    const generateText = vi.fn(async () => {
      throw new Error("every provider is down");
    });

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toMatchObject({ flipped: false });
    expect(result).not.toHaveProperty("held");
    expect(state.post.status).toBe("DRAFT");
    expect((state.post.metadata as any).captionFanout.held).toBeUndefined();
  });

  it("a notification failure NEVER blocks the hold (best-effort, never throws)", async () => {
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY")]));
    prisma.notification.create.mockRejectedValue(new Error("db write failed"));
    const generateText = vi.fn(async () => {
      throw new Error("all providers exhausted");
    });

    await expect(
      runCaptionFanout({ postId: "post-1", organizationId: "org-1" }, { prisma: prisma as any, generateText, charLimitFor })
    ).resolves.toMatchObject({ held: true });
    expect((state.post.metadata as any).captionFanout.held).toBe(true);
    expect(state.post.status).toBe("DRAFT");
  });

  it("partial failure: successful chunk's overrides are KEPT, failed chunk falls back, degraded=true + notification", async () => {
    // chunkSize 2, 4 targets → chunk 1 (t0,t1) succeeds, chunk 2 (t2,t3) throws.
    const targets = Array.from({ length: 4 }, (_, i) => target(`t${i}`, "INSTAGRAM"));
    const { prisma, state } = statefulPrisma(pendingFanoutPost(targets));
    const generateText = vi
      .fn()
      .mockResolvedValueOnce('[{"index":0,"caption":"unique A"},{"index":1,"caption":"unique B"}]')
      .mockRejectedValueOnce(new Error("every provider is down"));

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor, chunkSize: 2 }
    );

    expect(result).toEqual({ generated: 2, skippedExisting: 0, flipped: true, degraded: true });
    // Successful chunk's captions kept; failed chunk's targets stay null (shared caption).
    expect(state.post.targets.find((t) => t.id === "t0")!.contentOverride).toBe("unique A");
    expect(state.post.targets.find((t) => t.id === "t1")!.contentOverride).toBe("unique B");
    expect(state.post.targets.find((t) => t.id === "t2")!.contentOverride).toBeNull();
    expect(state.post.targets.find((t) => t.id === "t3")!.contentOverride).toBeNull();
    expect(state.post.status).toBe("SCHEDULED");
    expect((state.post.metadata as any).captionFanout.degraded).toBe(true);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].type).toBe("post.captions_degraded");
  });

  it("degraded notification falls back to org OWNERs when the post has no creator", async () => {
    const { prisma, state } = statefulPrisma({
      ...pendingFanoutPost([target("t1", "BLUESKY")]),
      createdById: null,
    });
    const generateText = vi.fn(async () => {
      throw new Error("all providers exhausted");
    });

    await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(prisma.organizationMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: "org-1", role: "OWNER" }) })
    );
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].userId).toBe("owner-1");
  });

  it("a notification failure NEVER blocks the flip (best-effort, never throws)", async () => {
    // A PARTIAL failure — total failure now holds instead of flipping.
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY"), target("t2", "TWITTER")]));
    prisma.notification.create.mockRejectedValue(new Error("db write failed"));
    const generateText = vi
      .fn()
      .mockResolvedValueOnce('[{"index":0,"caption":"ok"}]')
      .mockRejectedValueOnce(new Error("all providers exhausted"));

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor, chunkSize: 1 }
    );

    expect(result).toMatchObject({ flipped: true, degraded: true });
    expect(state.post.status).toBe("SCHEDULED");
  });

  it("a SUCCESSFUL fanout creates NO degraded notification", async () => {
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY")]));
    const generateText = vi.fn(async () => '[{"index":0,"caption":"clean"}]');

    await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(state.post.status).toBe("SCHEDULED");
    expect(state.notifications).toHaveLength(0);
    expect((state.post.metadata as any).captionFanout.degraded).toBeUndefined();
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

describe("holdPendingFanoutPost", () => {
  it("never holds a post whose fan-out is not pending (no write at all)", async () => {
    const { prisma } = statefulPrisma({
      ...pendingFanoutPost([target("t1", "BLUESKY")]),
      metadata: { captionFanout: { requested: true, pendingSchedule: false } },
    });
    await expect(holdPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1", HELD_REASON_FAILED)).resolves.toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  // Review follow-up 2026-10-01: leaving pendingSchedule set on a post that
  // left DRAFT made it a permanent publish gate (Retry refused forever).
  it.each(["SCHEDULED", "FAILED", "CANCELLED", "PUBLISHED"])(
    "a %s post is never held, but its stale pending flag is cleared",
    async (status) => {
      const { prisma, state } = statefulPrisma({ ...pendingFanoutPost([target("t1", "BLUESKY")]), status });
      await expect(holdPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1", HELD_REASON_FAILED)).resolves.toBe(false);

      const fanoutMeta = (state.post.metadata as any).captionFanout;
      expect(fanoutMeta.pendingSchedule).toBe(false);
      expect(fanoutMeta.held).toBeUndefined();
      expect(state.post.status).toBe(status);
      expect(state.notifications).toHaveLength(0);
    }
  );

  it("is org-scoped: a foreign organization can never hold the post", async () => {
    const { prisma } = statefulPrisma(pendingFanoutPost([target("t1", "BLUESKY")]));
    await expect(holdPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-EVIL", HELD_REASON_FAILED)).resolves.toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});

describe("flipPendingFanoutPost", () => {
  it("no-ops (no write) for a post whose fan-out is not pending", async () => {
    const { prisma } = statefulPrisma({
      ...pendingFanoutPost([target("t1", "TWITTER")]),
      metadata: { captionFanout: { requested: true, pendingSchedule: false } },
    });
    await expect(flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1")).resolves.toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  // Review follow-up 2026-10-01: a post moved out of DRAFT (bulk Cancel, a
  // publish that already ran) kept pendingSchedule:true forever, and Retry
  // refused it with a false "will publish automatically".
  it.each(["SCHEDULED", "FAILED", "CANCELLED", "PUBLISHED"])(
    "a %s post is never flipped, but its stale pending flag is cleared",
    async (status) => {
      const { prisma, state } = statefulPrisma({ ...pendingFanoutPost([target("t1", "TWITTER")]), status });
      await expect(
        flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1", { degraded: true })
      ).resolves.toBe(false);

      expect(state.post.status).toBe(status);
      expect(prisma.postTarget.updateMany).not.toHaveBeenCalled();
      expect((state.post.metadata as any).captionFanout.pendingSchedule).toBe(false);
      // Nothing is going to publish from here, so no "will publish" notification.
      expect(state.notifications).toHaveLength(0);
    }
  );

  // A DRAFT whose schedule was removed while captions were being written
  // (bulk "Move to Draft" clears scheduledAt). Flipping it would produce a
  // SCHEDULED post with no scheduledAt, which the cron never picks up.
  it("a DRAFT with no scheduledAt is not flipped; its pending flag is cleared", async () => {
    const { prisma, state } = statefulPrisma({ ...pendingFanoutPost([target("t1", "TWITTER")]), scheduledAt: null });
    await expect(
      flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1", { degraded: true })
    ).resolves.toBe(false);

    expect(state.post.status).toBe("DRAFT");
    expect(state.post.targets[0]!.status).toBe("DRAFT");
    expect(prisma.postTarget.updateMany).not.toHaveBeenCalled();
    expect((state.post.metadata as any).captionFanout.pendingSchedule).toBe(false);
    expect(state.notifications).toHaveLength(0);
  });

  it("end to end: a post cancelled mid fan-out keeps its captions, is not scheduled, and loses the stale flag", async () => {
    const { prisma, state } = statefulPrisma({ ...pendingFanoutPost([target("t1", "TWITTER")]), status: "CANCELLED" });
    const generateText = vi.fn(async () => '[{"index":0,"caption":"Unique"}]');

    const result = await runCaptionFanout(
      { postId: "post-1", organizationId: "org-1" },
      { prisma: prisma as any, generateText, charLimitFor }
    );

    expect(result).toMatchObject({ generated: 1, flipped: false });
    expect(state.post.status).toBe("CANCELLED");
    expect(state.post.targets[0]!.contentOverride).toBe("Unique");
    expect((state.post.metadata as any).captionFanout.pendingSchedule).toBe(false);
  });

  it("with NO super-text metadata the flip is unchanged (byte-identical legacy path)", async () => {
    const { prisma, state } = statefulPrisma(pendingFanoutPost([target("t1", "TWITTER")]));
    await expect(flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1")).resolves.toBe(true);
    expect(state.post.status).toBe("SCHEDULED");
    expect(state.post.targets[0]!.status).toBe("SCHEDULED");
    expect((state.post.metadata as any).captionFanout.pendingSchedule).toBe(false);
  });
});

/**
 * Super-text gate coordination (2026-07-27). Both features park a post as DRAFT.
 * Whichever finishes LAST performs the flip — captions must never flip a post
 * whose video strip is still being burned, or the cron would publish the
 * ORIGINAL, un-burned video.
 */
describe("flipPendingFanoutPost × super-text gate", () => {
  const withBurnPending = (pendingBurn: boolean) => ({
    ...pendingFanoutPost([target("t1", "TWITTER"), target("t2", "INSTAGRAM")]),
    // A parked post ALWAYS has scheduledAt in production — both planCaptionFanout
    // and planSuperText only set their pending flags when scheduledAt != null —
    // and flipParkedPostIfReady refuses to flip without one (it must never
    // schedule a post the user saved as a plain draft).
    scheduledAt: new Date("2099-01-01T10:00:00.000Z"),
    metadata: {
      captionFanout: { requested: true, pendingSchedule: true },
      superText: { requested: true, pendingBurn, parkedSchedule: true },
    },
  });

  it("does NOT flip while the burn is pending, but DOES clear its own caption flag", async () => {
    const { prisma, state } = statefulPrisma(withBurnPending(true));

    await expect(flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1")).resolves.toBe(false);

    // Our own gate is released…
    expect((state.post.metadata as any).captionFanout.pendingSchedule).toBe(false);
    // …but the post and its targets stay DRAFT until the burn lands.
    expect(state.post.status).toBe("DRAFT");
    expect(state.post.targets.every((t) => t.status === "DRAFT")).toBe(true);
  });

  it("flips normally once the burn has already completed", async () => {
    const { prisma, state } = statefulPrisma(withBurnPending(false));

    await expect(flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1")).resolves.toBe(true);

    expect(state.post.status).toBe("SCHEDULED");
    expect(state.post.targets.every((t) => t.status === "SCHEDULED")).toBe(true);
  });

  it("post-write re-check flips when the burn finishes between our read and our write", async () => {
    // Simulates the race: at read time the burn is pending, but it completes
    // before we re-check — flipParkedPostIfReady (fresh read) must catch it, so
    // the post can never be stranded in DRAFT with no gate left to flip it.
    const { prisma, state } = statefulPrisma(withBurnPending(true));
    const realFindFirst = prisma.post.findFirst;
    let call = 0;
    prisma.post.findFirst = vi.fn(async (args: any) => {
      call++;
      if (call > 1) {
        // The burn worker cleared its flag in the meantime.
        (state.post.metadata as any).superText.pendingBurn = false;
      }
      return realFindFirst(args);
    }) as any;

    await flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1");

    expect(state.post.status).toBe("SCHEDULED");
    expect(state.post.targets.every((t) => t.status === "SCHEDULED")).toBe(true);
  });

  it("a degraded flip still defers to the burn (never publishes un-burned video)", async () => {
    const { prisma, state } = statefulPrisma(withBurnPending(true));

    await flipPendingFanoutPost({ prisma: prisma as any }, "post-1", "org-1", { degraded: true });

    expect(state.post.status).toBe("DRAFT");
    expect((state.post.metadata as any).captionFanout.degraded).toBe(true);
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
