import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  markTargetFailed,
  shouldReapPublishing,
  mediaRequiredReason,
  terminalizeStuckClaim,
  classifyError,
  isDefiniteAuthFailure,
  releaseClaimAfterPrePublishError,
  decideClaimMiss,
  decideReap,
  ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE,
  countOtherActiveJobsForTarget,
  formatPublishTiming,
  planRateLimitRequeue,
  rateLimitGiveUpMessage,
} from "./publish-recovery";

describe("shouldReapPublishing", () => {
  const now = new Date("2026-06-10T12:00:00.000Z");

  it("reaps a PUBLISHING target last updated 31 min ago", () => {
    const updatedAt = new Date(now.getTime() - 31 * 60 * 1000);
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now)).toBe(true);
  });

  it("does NOT reap a PUBLISHING target last updated 5 min ago", () => {
    const updatedAt = new Date(now.getTime() - 5 * 60 * 1000);
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now)).toBe(false);
  });

  it("does NOT reap a PUBLISHED target even if 31 min old", () => {
    const updatedAt = new Date(now.getTime() - 31 * 60 * 1000);
    expect(shouldReapPublishing({ status: "PUBLISHED", updatedAt }, now)).toBe(false);
  });

  it("honors a custom maxAgeMs threshold", () => {
    const updatedAt = new Date(now.getTime() - 90 * 1000); // 90s ago
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now, 60 * 1000)).toBe(true);
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now, 120 * 1000)).toBe(false);
  });
});

describe("markTargetFailed", () => {
  it("issues a postTarget.update with status FAILED and the message", async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = { postTarget: { update } };

    await markTargetFailed(prisma, "pt_123", "Token expired and refresh failed");

    expect(update).toHaveBeenCalledWith({
      where: { id: "pt_123" },
      data: { status: "FAILED", errorMessage: "Token expired and refresh failed" },
    });
  });

  it("swallows DB errors so the original publish error can propagate", async () => {
    const update = vi.fn().mockRejectedValue(new Error("db down"));
    const prisma = { postTarget: { update } };

    await expect(
      markTargetFailed(prisma, "pt_456", "some message"),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });
});

describe("mediaRequiredReason", () => {
  it("names Instagram in the reason", () => {
    const msg = mediaRequiredReason("INSTAGRAM");
    expect(msg).toContain("Instagram");
    expect(msg.toLowerCase()).toContain("image");
  });

  it("names Facebook in the reason", () => {
    expect(mediaRequiredReason("FACEBOOK")).toContain("Facebook");
  });

  it("falls back to the raw platform for an unmapped platform", () => {
    expect(mediaRequiredReason("THREADS")).toContain("THREADS");
  });

  it("keeps the non-story reason byte-identical", () => {
    expect(mediaRequiredReason("INSTAGRAM")).toBe(
      "Instagram requires an image or video; none was attached and AI generation is off or unavailable. Attach media (or enable AI image generation) and retry."
    );
    expect(mediaRequiredReason("INSTAGRAM", { isStory: false })).toBe(mediaRequiredReason("INSTAGRAM"));
  });

  it("never advises AI image generation for a STORY — the worker never generates one", () => {
    // post-publish.worker.ts skips AI auto-generation for STORY targets on
    // purpose (a story is the user's own media), so the generic remedy
    // "enable AI image generation" could never work and would mislead.
    const msg = mediaRequiredReason("INSTAGRAM", { isStory: true });
    expect(msg).toContain("Instagram story");
    expect(msg.toLowerCase()).toContain("attach");
    expect(msg.toLowerCase()).not.toMatch(/\bai\b/);
    expect(msg.toLowerCase()).not.toContain("generat");
  });

  it("the worker passes the story flag at BOTH media-required call sites", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Comments stripped so an explanatory note quoting the old call cannot satisfy or fail this.
    const src = readFileSync(join(__dirname, "../workers/post-publish.worker.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src.match(/mediaRequiredReason\(platform, \{ isStory: isStoryTarget \}\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/mediaRequiredReason\(platform\)/);
  });
});

describe("terminalizeStuckClaim", () => {
  it("terminalizes when the claim found nothing on the final attempt", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: true })).toBe(true);
  });

  it("does NOT terminalize on a non-final no-op claim (a later attempt may succeed)", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: false })).toBe(false);
  });

  it("does NOT terminalize when the claim succeeded (count > 0)", () => {
    expect(terminalizeStuckClaim({ claimCount: 1, isFinalAttempt: true })).toBe(false);
  });
});

describe("watchdog reap invariant", () => {
  it("reaps a target orphaned at PUBLISHING whose updatedAt was NOT refreshed by no-op retries", () => {
    // A no-op claim (count===0) writes no row, so @updatedAt is not bumped — the
    // orphan keeps aging and crosses the 30-min threshold.
    const now = new Date("2026-06-13T12:00:00.000Z");
    const orphanedAt = new Date(now.getTime() - 31 * 60 * 1000); // last real write 31 min ago
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt: orphanedAt }, now)).toBe(true);
  });

  it("does NOT reap a target that the worker just terminalized to FAILED", () => {
    const now = new Date("2026-06-13T12:00:00.000Z");
    const justFailed = new Date(now.getTime() - 31 * 60 * 1000);
    // FAILED is terminal — the reaper's status:PUBLISHING filter excludes it.
    expect(shouldReapPublishing({ status: "FAILED", updatedAt: justFailed }, now)).toBe(false);
  });
});

describe("classifyError (moved from the worker, 2026-09-16)", () => {
  it("treats our own 'Validation failed' verdict as unknown — never a platform rate limit", () => {
    // The exact message an 11-image Instagram post produced. "too many" used to
    // route it to rate_limit ("Platform rate limit hit. Will retry automatically.").
    expect(classifyError("Validation failed: Too many media attachments. Instagram allows max 10.")).toBe("unknown");
    expect(classifyError("VALIDATION FAILED: token expired (401)")).toBe("unknown");
    expect(classifyError("  validation failed: Content is too long")).toBe("unknown");
  });

  it("keeps every other classification exactly as before", () => {
    const cases: Array<[string, ReturnType<typeof classifyError>]> = [
      ["We limit how often you can post", "rate_limit"],
      ["Facebook rate limit reached", "rate_limit"],
      ["Too many requests", "rate_limit"],
      ['{"error":{"code":368}}', "rate_limit"],
      ['{"errors":[{"code":32}]}', "rate_limit"],
      ["Access token has expired", "token_expired"],
      ["invalid token", "token_expired"],
      ['{"error":{"code":190}}', "token_expired"],
      ["HTTP 401", "token_expired"],
      ["Token expired and refresh failed: fetch failed. Reconnect this channel in Settings.", "token_expired"],
      ["Missing permission pages_manage_posts", "permission"],
      ['{"error":{"code":10}}', "permission"],
      ["HTTP 403 Forbidden", "permission"],
      ["Please reduce the amount of data", "content_too_large"],
      ["Caption too long", "content_too_large"],
      ["File too large", "content_too_large"],
      ["Instagram requires at least one image or video to publish a post.", "media_required"],
      ["media required", "media_required"],
      ["boom", "unknown"],
      ["", "unknown"],
    ];
    for (const [msg, expected] of cases) expect(classifyError(msg), msg).toBe(expected);
  });

  it("keeps the orphaned-claim message verbatim (unknown) so the failed handler does not rewrite it", () => {
    expect(classifyError(ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE)).toBe("unknown");
  });

  it("the worker no longer defines its own copy", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../workers/post-publish.worker.ts"), "utf8");
    expect(src).not.toMatch(/function classifyError\(/);
    expect(src).toMatch(/\bclassifyError,/);
  });
});

describe("isDefiniteAuthFailure", () => {
  it("recognises the exact production dead-session string", () => {
    expect(
      isDefiniteAuthFailure(
        'Instagram long-lived token exchange failed: {"error":{"message":"Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.","type":"OAuthException","code":190,"error_subcode":460}}'
      )
    ).toBe(true);
  });

  it("recognises other definite credential failures", () => {
    for (const m of [
      '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
      '{"error":{"code" : 190}}',
      '{"error":{"code":102,"message":"API Session"}}',
      '{"error":{"code":463}}',
      "The access token has been revoked",
      "unauthorized_client",
      "invalid_client",
      '{"error":"invalid_token"}',
    ]) {
      expect(isDefiniteAuthFailure(m), m).toBe(true);
    }
  });

  it("a bare OAuthException is NOT evidence — Meta stamps it on transient errors and rate limits too (review finding)", () => {
    for (const m of [
      "OAuthException: whatever",
      'Instagram long-lived token exchange failed: {"error":{"message":"An unexpected error has occurred. Please retry your request later.","type":"OAuthException","is_transient":true,"code":2}}',
      '{"error":{"message":"(#4) Application request limit reached","type":"OAuthException","code":4}}',
      '{"error":{"message":"(#17) User request limit reached","type":"OAuthException","code":17}}',
      '{"error":{"message":"(#32) Page request limit reached","type":"OAuthException","code":32}}',
      // A credential-looking body that Meta itself marks transient stays retryable.
      '{"error":{"message":"Error validating access token","type":"OAuthException","code":190,"is_transient":true}}',
    ]) {
      expect(isDefiniteAuthFailure(m), m).toBe(false);
    }
  });

  it("does not mistake other codes that merely start with 190/102 for credential codes", () => {
    expect(isDefiniteAuthFailure('{"error":{"code":1905}}')).toBe(false);
    expect(isDefiniteAuthFailure('{"error":{"code":10200}}')).toBe(false);
  });

  it("is false for transient / network / upstream failures", () => {
    for (const m of [
      "fetch failed",
      "Request timed out",
      "HTTP 503 upstream",
      "The operation was aborted due to timeout",
      "connect ETIMEDOUT 157.240.1.1:443",
      "read ECONNRESET",
      "getaddrinfo ENOTFOUND graph.facebook.com",
      "getaddrinfo EAI_AGAIN graph.facebook.com",
      "socket hang up",
    ]) {
      expect(isDefiniteAuthFailure(m), m).toBe(false);
    }
  });

  it("a transient hint VETOES an auth marker — doubt resolves to 'retry'", () => {
    expect(isDefiniteAuthFailure('OAuthException {"code":190} (HTTP 500)')).toBe(false);
    expect(isDefiniteAuthFailure("invalid_grant after request timeout")).toBe(false);
    expect(isDefiniteAuthFailure("Error validating access token: fetch failed")).toBe(false);
  });

  it("is false for ordinary errors and empty input", () => {
    expect(isDefiniteAuthFailure("HTTP 401 Unauthorized")).toBe(false); // no definite marker
    expect(isDefiniteAuthFailure("Access token has expired")).toBe(false);
    expect(isDefiniteAuthFailure("boom")).toBe(false);
    expect(isDefiniteAuthFailure("")).toBe(false);
    expect(isDefiniteAuthFailure(null)).toBe(false);
    expect(isDefiniteAuthFailure(undefined)).toBe(false);
  });
});

describe("releaseClaimAfterPrePublishError", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("conditionally moves PUBLISHING → FAILED with the error's message", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await releaseClaimAfterPrePublishError({ postTarget: { updateMany } }, "t1", new Error("db connection lost"));
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "t1", status: "PUBLISHING" },
      data: { status: "FAILED", errorMessage: "db connection lost" },
    });
  });

  it("trims the message and caps it at 1000 characters", async () => {
    const updateMany = vi.fn(async (_a: any) => ({ count: 1 }));
    await releaseClaimAfterPrePublishError({ postTarget: { updateMany } }, "t1", new Error(`  ${"x".repeat(5000)}  `));
    const msg = (updateMany.mock.calls[0]![0] as any).data.errorMessage as string;
    expect(msg).toBe("x".repeat(1000));
  });

  it("handles non-Error throwables and empty messages", async () => {
    const updateMany = vi.fn(async (_a: any) => ({ count: 1 }));
    await releaseClaimAfterPrePublishError({ postTarget: { updateMany } }, "t1", "string thrown");
    await releaseClaimAfterPrePublishError({ postTarget: { updateMany } }, "t1", new Error("   "));
    await releaseClaimAfterPrePublishError({ postTarget: { updateMany } }, "t1", undefined);
    const msgs = updateMany.mock.calls.map((c: any[]) => c[0].data.errorMessage);
    expect(msgs[0]).toBe("string thrown");
    expect(msgs[1]).toMatch(/before anything was sent/);
    expect(msgs[2]).toMatch(/before anything was sent/);
  });

  it("is a harmless no-op when another branch already wrote a terminal state", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    await expect(
      releaseClaimAfterPrePublishError({ postTarget: { updateMany } }, "t1", new Error("x"))
    ).resolves.toBeUndefined();
  });

  it("never throws — the caller must rethrow the ORIGINAL error", async () => {
    const updateMany = vi.fn(async () => {
      throw new Error("db down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      releaseClaimAfterPrePublishError({ postTarget: { updateMany } }, "t1", new Error("x"))
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("decideClaimMiss — park unheld orphans, never auto-republish", () => {
  const orphan = { status: "PUBLISHING", hasPublishedId: false, otherActiveJobs: 0 };

  it("parks an unheld, id-less PUBLISHING target", () => {
    expect(decideClaimMiss(orphan)).toBe("park-orphan");
  });

  it("skips when another job holds it", () => {
    expect(decideClaimMiss({ ...orphan, otherActiveJobs: 1 })).toBe("skip");
    expect(decideClaimMiss({ ...orphan, otherActiveJobs: 3 })).toBe("skip");
  });

  it("skips when the holder check did not run (null) — parking needs positive evidence", () => {
    expect(decideClaimMiss({ ...orphan, otherActiveJobs: null })).toBe("skip");
  });

  it("skips anything that is not an id-less PUBLISHING row", () => {
    for (const status of ["PUBLISHED", "FAILED", "SCHEDULED", "DRAFT", null]) {
      expect(decideClaimMiss({ ...orphan, status }), String(status)).toBe("skip");
    }
    expect(decideClaimMiss({ ...orphan, hasPublishedId: true })).toBe("skip");
  });

  it("the park message keeps its text through worker.on('failed')", () => {
    expect(classifyError(ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE)).toBe("unknown");
    expect(isDefiniteAuthFailure(ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE)).toBe(false);
  });
});

describe("decideReap", () => {
  it("never reaps a target a running job still holds; parks every unheld one", () => {
    expect(decideReap({ heldByActiveJob: true })).toBe("skip");
    expect(decideReap({ heldByActiveJob: false })).toBe("park");
  });
});

describe("countOtherActiveJobsForTarget", () => {
  const active = [
    { id: "self", data: { postTargetId: "t1" } },
    { id: "a", data: { postTargetId: "t1" } },
    { id: "b", data: { postTargetId: "t2" } },
    undefined,
    null,
    { id: "c", data: null },
    { id: "d" },
  ];

  it("counts other jobs on the same target, excluding this job and missing entries", () => {
    expect(countOtherActiveJobsForTarget(active, "self", "t1")).toBe(1);
    expect(countOtherActiveJobsForTarget(active, "self", "t2")).toBe(1);
    expect(countOtherActiveJobsForTarget(active, "self", "t3")).toBe(0);
  });

  it("adds this process's own in-flight holders (a re-run of the same job id is invisible otherwise)", () => {
    expect(countOtherActiveJobsForTarget([{ id: "self", data: { postTargetId: "t1" } }], "self", "t1")).toBe(0);
    expect(countOtherActiveJobsForTarget([{ id: "self", data: { postTargetId: "t1" } }], "self", "t1", 1)).toBe(1);
    expect(countOtherActiveJobsForTarget([], "self", "t1", -3)).toBe(0);
  });

  it("does not exclude anything when this job has no id", () => {
    expect(countOtherActiveJobsForTarget(active, undefined, "t1")).toBe(2);
  });
});

describe("formatPublishTiming", () => {
  it("prints all three durations", () => {
    expect(
      formatPublishTiming({ postTargetId: "t1", platform: "INSTAGRAM", timestamp: 1_000, processedOn: 31_000, delay: 20_000, now: 41_000 })
    ).toBe("[PublishTiming] target=t1 platform=INSTAGRAM queueWaitMs=10000 runMs=10000 sinceEnqueueMs=40000");
  });

  it("treats a missing delay as 0", () => {
    expect(formatPublishTiming({ postTargetId: "t1", platform: "X", timestamp: 1_000, processedOn: 3_000, now: 4_000 })).toBe(
      "[PublishTiming] target=t1 platform=X queueWaitMs=2000 runMs=1000 sinceEnqueueMs=3000"
    );
  });

  it("omits fields whose inputs are missing instead of printing NaN", () => {
    expect(formatPublishTiming({ postTargetId: "t1", platform: "X", timestamp: 1_000, now: 4_000 })).toBe(
      "[PublishTiming] target=t1 platform=X sinceEnqueueMs=3000"
    );
    expect(formatPublishTiming({ postTargetId: "t1", platform: "X", processedOn: 2_000, timestamp: null, now: 4_000 })).toBe(
      "[PublishTiming] target=t1 platform=X runMs=2000"
    );
    expect(formatPublishTiming({ postTargetId: "t1", platform: "X", now: 4_000 })).toBe("[PublishTiming] target=t1 platform=X");
  });
});

describe("classifyError routes Meta THROTTLES to the rate-limit re-queue", () => {
  const PROD_RATE_LIMIT =
    'Facebook story publish failed: {"error":{"message":"(#4) Application request limit reached",' +
    '"type":"OAuthException","is_transient":true,"code":4,"fbtrace_id":"A_OWQTXoJ2E4Sl3hFwg9rlW"}}';

  it("🔴 classifies the real production #4 body as rate_limit, not unknown", () => {
    // Meta says "request limit", never "rate limit", so none of the sibling
    // patterns matched and #4 burned three fast BullMQ attempts.
    expect(classifyError(PROD_RATE_LIMIT)).toBe("rate_limit");
  });

  it("covers the user (#17) and application (#341) throttles too", () => {
    expect(classifyError('{"error":{"message":"(#17) User request limit reached","code":17}}')).toBe("rate_limit");
    expect(classifyError('{"error":{"message":"(#341) Application limit reached","code":341}}')).toBe("rate_limit");
  });

  it("⚠️ a dead token is NOT mistaken for a throttle", () => {
    // The reason the match is on the MESSAGE and never on `code":4`:
    // "code":463 and "code":467 both contain that substring.
    expect(
      classifyError('{"error":{"message":"Error validating access token: session invalid","code":463}}')
    ).toBe("token_expired");
    expect(
      classifyError('{"error":{"message":"The access token is invalid","code":467}}')
    ).toBe("token_expired");
  });

  it("keeps our own pre-publish verdict out of the rate-limit branch", () => {
    expect(classifyError("Validation failed: Too many media attachments. Instagram allows max 10.")).toBe("unknown");
  });
});

describe("planRateLimitRequeue — the backoff climbs and then STOPS (2026-10-30)", () => {
  // Every rate-limit re-queue is a brand-new BullMQ job, so job.attemptsMade was
  // always 0: Instagram retried every 2 min and Facebook every 30 min, forever.
  // Measured on prod: 13 Instagram targets x ~15 tries in 30 min (code 4 /
  // 2207051 "action is blocked"), and 8 Facebook targets x 73 tries over 11 days
  // (code 368 / 1404132). The count now rides in the job data.
  const MIN = 60_000;

  function chain(platform: string): Array<number | "give_up"> {
    const out: Array<number | "give_up"> = [];
    let n: number | undefined = undefined;
    for (let i = 0; i < 20; i++) {
      const plan = planRateLimitRequeue(platform, n);
      if (plan.action === "give_up") {
        out.push("give_up");
        return out;
      }
      out.push(plan.delayMs / MIN);
      n = plan.requeues;
    }
    throw new Error("never gave up");
  }

  it("Instagram (and every non-Facebook platform): 2, 4, 8, 10, 10, 10 min, then gives up", () => {
    expect(chain("INSTAGRAM")).toEqual([2, 4, 8, 10, 10, 10, "give_up"]);
    expect(chain("TWITTER")).toEqual([2, 4, 8, 10, 10, 10, "give_up"]);
  });

  it("Facebook: 30 min, 2 h, 6 h, then gives up (the ~8.5h chain the watchdog already assumes)", () => {
    expect(chain("FACEBOOK")).toEqual([30, 120, 360, "give_up"]);
  });

  it("each re-queue carries the next count forward", () => {
    expect(planRateLimitRequeue("INSTAGRAM", 2)).toEqual({ action: "requeue", delayMs: 8 * MIN, requeues: 3 });
    expect(planRateLimitRequeue("FACEBOOK", 1)).toEqual({ action: "requeue", delayMs: 120 * MIN, requeues: 2 });
  });

  it("a job with no count (queued before this change, or a user's Retry) starts from the beginning", () => {
    for (const legacy of [undefined, null, -1, 1.5, "3", Number.NaN]) {
      expect(planRateLimitRequeue("INSTAGRAM", legacy)).toEqual({ action: "requeue", delayMs: 2 * MIN, requeues: 1 });
    }
  });

  it("reports how many refused attempts the chain made when it gives up", () => {
    expect(planRateLimitRequeue("INSTAGRAM", 6)).toEqual({ action: "give_up", attempts: 7 });
    expect(planRateLimitRequeue("FACEBOOK", 3)).toEqual({ action: "give_up", attempts: 4 });
    expect(planRateLimitRequeue("FACEBOOK", 99)).toEqual({ action: "give_up", attempts: 100 });
  });
});

describe("rateLimitGiveUpMessage", () => {
  // Verbatim production bodies (2026-10-28/29).
  const IG_BLOCKED =
    'Instagram publish failed: {"error":{"message":"Application request limit reached","type":"OAuthException",' +
    '"is_transient":false,"code":4,"error_subcode":2207051,"error_user_title":"action is blocked","error_user_msg":' +
    '"We restrict certain activity to protect our community. Tell us if you think we made a mistake.","fbtrace_id":"A8r3vMuN6q2noRGoCtQJlvX"}}';
  const FB_BLOCKED =
    'Facebook multi-photo post failed: {"error":{"message":"You\'re temporarily blocked from using this feature because ' +
    'you shared something that isn\'t allowed on Facebook. Learn more.","type":"OAuthException","code":368,"error_data":' +
    '{"sentry_block_data":"AetgFJTn94","help_center_id":0,"is_silent":false},"error_subcode":1404132,"error_user_msg":"",' +
    '"fbtrace_id":"AvsmUEU833tt8d_qjhnbLYI"}}';

  it("names the platform, the platform's own reason and the attempt count — never raw JSON", () => {
    const msg = rateLimitGiveUpMessage("INSTAGRAM", 7, IG_BLOCKED);
    expect(msg).toBe(
      'Instagram refused this post 7 times ("Application request limit reached — action is blocked"), so automatic ' +
        "retries have stopped. It was not published. Wait for the restriction to lift, then use Retry on the post page."
    );
    expect(msg).not.toContain("{");
  });

  it("Facebook's policy block", () => {
    const msg = rateLimitGiveUpMessage("FACEBOOK", 4, FB_BLOCKED);
    expect(msg).toContain("Facebook refused this post 4 times");
    expect(msg).toContain("You're temporarily blocked from using this feature");
    expect(msg).not.toContain("sentry_block_data");
  });

  it("a non-JSON throttle message still yields a clean sentence", () => {
    expect(rateLimitGiveUpMessage("TWITTER", 7, "429 Too Many Requests")).toBe(
      "X refused this post 7 times (rate limit), so automatic retries have stopped. It was not published. " +
        "Wait for the restriction to lift, then use Retry on the post page."
    );
  });
});
