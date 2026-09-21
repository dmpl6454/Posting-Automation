import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { statusForReplacedTarget } from "../../../../packages/api/src/lib/caption-overrides";
import { PUBLISH_CLAIM_STATUSES } from "../lib/publish-recovery";
import { CANCELLABLE_TARGET_STATUSES } from "@postautomation/queue";

/**
 * "Stop remaining channels" (2026-09-21). A cancel works by moving targets to
 * CANCELLED, which is NOT in PUBLISH_CLAIM_STATUSES — so the claim cannot pick
 * them up. What CAN undo it is any OTHER write that sets a target's status
 * without checking for CANCELLED first.
 *
 * Asserted at the SOURCE level (house pattern): these are single lines inside
 * long worker paths, and what must not regress is that the predicate EXISTS. A
 * mocked-Prisma test would exercise one happy path and miss a removed guard.
 */
const ROOT = join(__dirname, "..", "..", "..", "..");
const publishWorker = readFileSync(
  join(ROOT, "apps/worker/src/workers/post-publish.worker.ts"),
  "utf8"
);
const autopilotWorker = readFileSync(
  join(ROOT, "apps/worker/src/workers/autopilot-schedule.worker.ts"),
  "utf8"
);
const cronJobs = readFileSync(join(ROOT, "apps/worker/src/scheduler/cron-jobs.ts"), "utf8");
const postRouter = readFileSync(join(ROOT, "packages/api/src/routers/post.router.ts"), "utf8");

describe("THE safety property: a cancelled target is outside the publish claim", () => {
  it("🔴 CANCELLED is not a claimable status — asserted against the REAL constant", () => {
    // This is the whole safety argument for the feature. Asserted here rather
    // than in packages/queue, which must not import from apps/worker — a copy of
    // the literal there would be tautologically true and prove nothing.
    expect([...PUBLISH_CLAIM_STATUSES]).not.toContain("CANCELLED");
  });

  it("🔴 nothing is both cancellable and claimable in a way that could race", () => {
    // The cancellable set is a SUBSET of the claimable set: a target is stopped
    // exactly while it is still eligible to be picked up. What makes that safe is
    // that the cancel WRITES a status outside the claim, atomically, in one
    // updateMany — so either the claim wins (target publishes) or the cancel wins
    // (target is unclaimable). There is no interleaving that yields both.
    for (const s of CANCELLABLE_TARGET_STATUSES) {
      expect([...PUBLISH_CLAIM_STATUSES]).toContain(s);
    }
  });
});

describe("post.publishNow cannot re-arm a stopped channel", () => {
  it("🔴 both branches are ALLOWLISTS, not denylists", () => {
    // The explicit-targetIds branch was `!== PUBLISHED && !== PUBLISHING`, so
    // every status added later silently became publishable through it —
    // CANCELLED did exactly that, and a stopped channel named explicitly was
    // re-armed to SCHEDULED and published.
    expect(postRouter).toMatch(/const PUBLISHABLE = \["FAILED", "DRAFT", "SCHEDULED"\] as const/);
    expect(postRouter).not.toMatch(/t\.status !== "PUBLISHED" && t\.status !== "PUBLISHING"/);
  });

  it("refuses an explicitly-named CANCELLED target instead of silently dropping it", () => {
    expect(postRouter).toMatch(/blockedAsCancelled/);
    expect(postRouter).toMatch(/were stopped for this post and will not be published/);
  });

  it("the arming write carries the same allowlist as defence in depth", () => {
    expect(postRouter).toMatch(/status: \{ in: \[\.\.\.PUBLISHABLE\] \}/);
  });
});

describe("nothing re-arms a CANCELLED target", () => {
  it("🔴 the three defer/retry paths that write SCHEDULED are status-guarded", () => {
    // Each of these releases a target back to SCHEDULED and re-queues a delayed
    // job. Unguarded, a cancel landing during the wait would be overwritten and
    // the channel would publish anyway.
    const guarded = publishWorker.match(
      /where: \{ id: postTargetId, status: \{ not: "CANCELLED" \} \}/g
    );
    expect(guarded?.length).toBe(3);
  });

  it("🔴 the failed-handler cannot relabel a cancelled target as FAILED", () => {
    // It runs asynchronously AFTER the job fails, so the user may have cancelled
    // in between — reporting a deliberate stop as a malfunction.
    expect(publishWorker).toMatch(
      /where: \{ id: job\.data\.postTargetId, status: \{ not: "CANCELLED" \} \}/
    );
  });

  it("🔴 autopilot scheduling cannot flip CANCELLED back to SCHEDULED", () => {
    // An unfiltered updateMany here would re-arm every withdrawn channel and the
    // 30s cron would publish them.
    expect(autopilotWorker).toMatch(/status: \{ in: \["DRAFT", "SCHEDULED", "FAILED"\] \}/);
    expect(autopilotWorker).toMatch(/ambiguousAt: null/);
  });

  it("🔴 the parked-draft gate only ever promotes DRAFT targets", () => {
    // caption-fanout / super-text flip parked posts. Scoped to DRAFT, so a
    // CANCELLED target is untouched — asserted so it stays that way.
    const gates = readFileSync(join(ROOT, "apps/worker/src/lib/publish-gates.ts"), "utf8");
    expect(gates).toMatch(/where: \{ postId, status: "DRAFT" \}/);
  });
});

describe("post.update channel replacement keeps a cancel", () => {
  it("selects status on the existing targets and carries it", () => {
    expect(postRouter).toMatch(
      /targets: \{ select: \{ channelId: true, format: true, contentOverride: true, status: true \} \}/
    );
    expect(postRouter).toMatch(
      /status: statusForReplacedTarget\(channelId, existing\.targets, existing\.status\)/
    );
  });

  it("a CANCELLED channel stays cancelled through a replacement", () => {
    const existing = [
      { channelId: "cancelled", status: "CANCELLED" },
      { channelId: "live", status: "SCHEDULED" },
    ];
    expect(statusForReplacedTarget("cancelled", existing, "SCHEDULED")).toBe("CANCELLED");
  });

  it("🔴 an already-PUBLISHED channel stays published — re-arming it republishes", () => {
    // post.update recreates targets with deleteMany + create, which DESTROYS
    // publishedId. The worker's "already published" short-circuit keys on that
    // column, so a recreated PUBLISHED target comes back SCHEDULED with no
    // publishedId and publishes a SECOND time to a live account. Reachable via
    // Retry-All-Failed (which sets the POST to SCHEDULED while leaving PUBLISHED
    // targets alone) followed by one click of "Add channel".
    const existing = [{ channelId: "done", status: "PUBLISHED" }];
    expect(statusForReplacedTarget("done", existing, "SCHEDULED")).toBe("PUBLISHED");
  });

  it("a FAILED channel still takes the post's status, so Retry keeps working", () => {
    const existing = [{ channelId: "bad", status: "FAILED" }];
    expect(statusForReplacedTarget("bad", existing, "SCHEDULED")).toBe("SCHEDULED");
  });

  it("every other kept channel, and every NEW channel, takes the post's status", () => {
    const existing = [{ channelId: "live", status: "SCHEDULED" }];
    expect(statusForReplacedTarget("live", existing, "SCHEDULED")).toBe("SCHEDULED");
    expect(statusForReplacedTarget("brand-new", existing, "SCHEDULED")).toBe("SCHEDULED");
    expect(statusForReplacedTarget("brand-new", [], "DRAFT")).toBe("DRAFT");
  });
});

describe("one shared finalization rule", () => {
  it("both publish-worker finalizers use the shared verdict", () => {
    const uses = publishWorker.match(/resolvePostStatusFromTargets\(allTargets\)/g) ?? [];
    expect(uses.length).toBe(2);
    // The old open-coded pair is what produced a PUBLISHED verdict for a
    // FAILED+CANCELLED post.
    expect(publishWorker).not.toMatch(/const allFailed = allTargets\.every/);
  });

  it("the watchdog uses it too, so a cancelled post is not reaped as FAILED", () => {
    expect(cronJobs).toMatch(/resolvePostStatusFromTargets\(/);
    expect(cronJobs).not.toMatch(/const newStatus = anyPublished \? "PUBLISHED" : "FAILED"/);
  });
});

describe("post.cancelRemaining", () => {
  it("cancels only the queued statuses, never PUBLISHING or PUBLISHED", () => {
    expect(postRouter).toMatch(/status: \{ in: \[\.\.\.CANCELLABLE_TARGET_STATUSES\] \}/);
    expect(postRouter).toMatch(/publishedId: null/);
    expect(postRouter).toMatch(/ambiguousAt: null/);
  });

  it("🔴 finalizes the post itself, or a fully-cancelled post spins at PUBLISHING", () => {
    // Without this the post sits at PUBLISHING (no job will ever claim anything)
    // until the 45-minute watchdog reaps it — reporting a deliberate cancel as a
    // failure.
    expect(postRouter).toMatch(/const verdict = resolvePostStatusFromTargets\(after\)/);
    expect(postRouter).toMatch(/if \(verdict\.settled\) \{/);
  });

  it("clears scheduledAt ONLY when settled", () => {
    // A partially cancelled post still has targets that must publish at their
    // scheduled time; clearing it unconditionally would strand them.
    const block = postRouter.slice(postRouter.indexOf("cancelRemaining: orgProcedure"));
    const settledBlock = block.slice(block.indexOf("if (verdict.settled)"), block.indexOf("createAuditLog"));
    expect(settledBlock).toMatch(/scheduledAt: null/);
  });

  it("the 30s publish cron cannot stamp PUBLISHING over a settled cancel", () => {
    // The cron reads due posts, then issues one Redis add per target before
    // writing the post status — a window of hundreds of ms on a large fan-out,
    // opening exactly when the schedule fires. An unconditional write there would
    // strand a just-cancelled post at PUBLISHING until the 45-min watchdog.
    expect(cronJobs).toMatch(/where: \{ id: post\.id, status: "SCHEDULED" \}/);
  });

  it("bulk.bulkSchedule cannot arm a post that can no longer publish", () => {
    const bulk = readFileSync(join(ROOT, "packages/api/src/routers/bulk.router.ts"), "utf8");
    expect(bulk).toMatch(/status: \{ in: \["DRAFT", "SCHEDULED", "FAILED"\] \}/);
    expect(bulk).toMatch(/if \(armed\.count === 0\) continue/);
  });

  it("super-text failure cannot relabel a cancelled post as FAILED", () => {
    const st = readFileSync(join(ROOT, "apps/worker/src/workers/super-text.worker.ts"), "utf8");
    expect(st).toMatch(/where: \{ id: postId, status: \{ not: "CANCELLED" \} \}/);
  });

  it("is org-scoped and audit-logged", () => {
    const block = postRouter.slice(
      postRouter.indexOf("cancelRemaining: orgProcedure"),
      postRouter.indexOf("/** Recent post target activity")
    );
    expect(block).toMatch(/organizationId: ctx\.organizationId/);
    expect(block).toMatch(/createAuditLog\(/);
  });
});
