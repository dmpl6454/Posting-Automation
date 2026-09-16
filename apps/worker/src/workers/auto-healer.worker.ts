import { prisma } from "@postautomation/db";
import {
  contentGenerateQueue,
  autopilotScheduleQueue,
  postPublishQueue,
} from "@postautomation/queue";
import { getSocialProvider } from "@postautomation/social";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import IORedis from "ioredis";
import { shouldReapPublishing, decideReap, ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE } from "../lib/publish-recovery";
import { localClaimCount } from "../lib/local-claims";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

interface ErrorClassification {
  type: "transient" | "permanent" | "config";
  category: string;
  retryable: boolean;
}

const ERROR_PATTERNS: { pattern: RegExp; classification: ErrorClassification }[] = [
  // Transient - network / infra
  {
    pattern: /getaddrinfo|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up/i,
    classification: { type: "transient", category: "network", retryable: true },
  },
  {
    pattern: /503|502|504|service unavailable|bad gateway|gateway timeout/i,
    classification: { type: "transient", category: "upstream_down", retryable: true },
  },
  {
    pattern: /rate.?limit|too many requests|429|quota exceeded/i,
    classification: { type: "transient", category: "rate_limit", retryable: true },
  },
  {
    pattern: /ENOSPC|disk full|no space left/i,
    classification: { type: "transient", category: "disk_full", retryable: false },
  },
  // Config / API changes - retryable after fix but not auto-retryable
  {
    pattern: /not supported|deprecated|invalid.*api|api.*removed/i,
    classification: { type: "config", category: "api_change", retryable: false },
  },
  {
    pattern: /unauthorized|403|invalid.*token|token.*expired|401/i,
    classification: { type: "config", category: "auth_expired", retryable: false },
  },
  {
    pattern: /invalid.*key|missing.*key|api.?key/i,
    classification: { type: "config", category: "missing_credential", retryable: false },
  },
  // Permanent - logic errors
  {
    pattern: /unique constraint|P2002/i,
    classification: { type: "permanent", category: "duplicate", retryable: false },
  },
  {
    pattern: /not found|P2025|record.*does not exist/i,
    classification: { type: "permanent", category: "missing_record", retryable: false },
  },
];

function classifyError(errorMessage: string): ErrorClassification {
  for (const { pattern, classification } of ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return classification;
    }
  }
  // Unknown errors default to transient + retryable (optimistic)
  return { type: "transient", category: "unknown", retryable: true };
}

// ---------------------------------------------------------------------------
// Service connectivity checks
// ---------------------------------------------------------------------------

interface ServiceCheck {
  name: string;
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

async function checkRedis(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const redis = new IORedis(process.env.REDIS_URL || "redis://redis:6379", {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    await redis.connect();
    await redis.ping();
    await redis.quit();
    return { name: "redis", status: "ok", latencyMs: Date.now() - start };
  } catch (e: any) {
    return { name: "redis", status: "error", latencyMs: Date.now() - start, error: e.message };
  }
}

async function checkPostgres(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { name: "postgres", status: "ok", latencyMs: Date.now() - start };
  } catch (e: any) {
    return { name: "postgres", status: "error", latencyMs: Date.now() - start, error: e.message };
  }
}

async function checkMinio(): Promise<ServiceCheck> {
  const start = Date.now();
  try {
    const s3 = new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
      },
    });
    await s3.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET || "postautomation-media" }));
    s3.destroy();
    return { name: "minio", status: "ok", latencyMs: Date.now() - start };
  } catch (e: any) {
    return { name: "minio", status: "error", latencyMs: Date.now() - start, error: e.message };
  }
}

export async function runServiceHealthChecks(): Promise<ServiceCheck[]> {
  return Promise.all([checkRedis(), checkPostgres(), checkMinio()]);
}

// ---------------------------------------------------------------------------
// Auto-healer: scan + classify + retry failed jobs
// ---------------------------------------------------------------------------

interface HealerResult {
  scanned: number;
  retried: number;
  skipped: number;
  permanent: number;
  byCategory: Record<string, number>;
  serviceChecks: ServiceCheck[];
}

/** Max age of failed posts to consider for retry (3 days) */
const MAX_RETRY_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** Max number of retries per autopilot post before giving up */
const MAX_RETRIES = 3;
/** Batch size per healer run */
const BATCH_SIZE = 50;

export async function runAutoHealer(): Promise<HealerResult> {
  const result: HealerResult = {
    scanned: 0,
    retried: 0,
    skipped: 0,
    permanent: 0,
    byCategory: {},
    serviceChecks: [],
  };

  // 1. Run service health checks first
  result.serviceChecks = await runServiceHealthChecks();
  const failedServices = result.serviceChecks.filter((s) => s.status === "error");

  if (failedServices.length > 0) {
    console.log(
      `[AutoHealer] Service check failures: ${failedServices.map((s) => `${s.name}: ${s.error}`).join(", ")}`,
    );
    // Don't retry if core infra is down — retries will just fail again
    const criticalDown = failedServices.some((s) => s.name === "redis" || s.name === "postgres");
    if (criticalDown) {
      console.log("[AutoHealer] Critical services down, skipping retry cycle");
      return result;
    }
  }

  const minioDown = failedServices.some((s) => s.name === "minio");

  // 2. Find recent FAILED autopilot posts
  const cutoff = new Date(Date.now() - MAX_RETRY_AGE_MS);
  const failedPosts = await prisma.autopilotPost.findMany({
    where: {
      status: "FAILED",
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      organizationId: true,
      errorMessage: true,
      createdAt: true,
      retryCount: true,
    },
  });

  result.scanned = failedPosts.length;

  if (failedPosts.length === 0) {
    // Step 5 is about PUBLISH targets, not autopilot posts, so it must not
    // depend on there being failed autopilot posts. This early return used to
    // skip it on nearly every cycle (2026-09-16). Steps 3-4 keep their old
    // behaviour and are still skipped here.
    await reapStuckPublishingTargets();
    return result;
  }

  console.log(`[AutoHealer] Found ${failedPosts.length} failed autopilot posts to evaluate`);

  // 3. Classify and retry
  for (const post of failedPosts) {
    const errorMsg = post.errorMessage || "Unknown error";
    const classification = classifyError(errorMsg);
    result.byCategory[classification.category] = (result.byCategory[classification.category] || 0) + 1;

    // Skip if already retried too many times
    if ((post.retryCount ?? 0) >= MAX_RETRIES) {
      result.skipped++;
      continue;
    }

    // Skip non-retryable errors
    if (!classification.retryable) {
      result.permanent++;
      continue;
    }

    // Skip minio-related retries if minio is still down
    if (minioDown && classification.category === "network" && /minio/i.test(errorMsg)) {
      result.skipped++;
      continue;
    }

    // Retry: reset status and re-queue
    try {
      await prisma.autopilotPost.update({
        where: { id: post.id },
        data: {
          status: "GENERATING",
          errorMessage: null,
          retryCount: { increment: 1 },
        },
      });

      await contentGenerateQueue.add(
        `autohealer-${post.id}`,
        {
          autopilotPostId: post.id,
          organizationId: post.organizationId,
          // ⚠️ NO pipelineRunId — a healer retry has no pipeline run behind it.
          // This used to be `autohealer-${Date.now()}`, an id that never exists
          // (PipelineRun.id is @default(cuid()) and nothing creates one), so every
          // healed job threw P2025. It also DEFEATED the downstream existence
          // guards, which test truthiness — see ContentGenerateJobData.
          // Do not reintroduce a placeholder value here.
        },
        {
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );

      result.retried++;
    } catch (err: any) {
      console.error(`[AutoHealer] Failed to retry post ${post.id}:`, err.message);
      result.skipped++;
    }
  }

  // 4. Also check for stuck SCHEDULED posts (scheduled > 2hrs ago but not published)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stuckScheduled = await prisma.autopilotPost.findMany({
    where: {
      status: "SCHEDULED",
      updatedAt: { lt: twoHoursAgo },
      postId: { not: null },
    },
    select: { id: true, postId: true, organizationId: true },
    take: 20,
  });

  if (stuckScheduled.length > 0) {
    console.log(`[AutoHealer] Found ${stuckScheduled.length} stuck SCHEDULED posts, re-queuing`);
    for (const stuck of stuckScheduled) {
      try {
        await autopilotScheduleQueue.add(
          `autohealer-schedule-${stuck.id}`,
          {
            autopilotPostId: stuck.id,
            organizationId: stuck.organizationId,
            // ⚠️ NO pipelineRunId — see the note on the contentGenerateQueue.add
            // above. This site is the DANGEROUS one: a fabricated id passes
            // autopilot-schedule.worker's `if (pipelineRunId)` guard and throws
            // AFTER the post + targets are already SCHEDULED, so the outer catch
            // stamps the post FAILED while it quietly publishes.
          },
          { removeOnComplete: true, removeOnFail: 100 },
        );
      } catch {}
    }
  }

  // 5. Reap stuck PUBLISHING post targets.
  await reapStuckPublishingTargets();

  return result;
}

/** How many stuck targets one healer cycle may reap (oldest first). */
const REAP_BATCH_SIZE = 100;
export const STUCK_PUBLISHING_MESSAGE = "Publishing stuck for over 30 minutes — please retry";

/**
 * Reap PostTargets stuck in PUBLISHING for more than 30 minutes.
 *
 * Do NOT re-queue: the publish worker's claim guard only transitions
 * SCHEDULED/FAILED/DRAFT → PUBLISHING, so a re-queued job on a PUBLISHING
 * target is silently skipped (claim.count === 0) and never rescues anything.
 * The target is orphaned, so mark it FAILED with an actionable message instead.
 *
 * 2026-09-16 hardening:
 *   - runs on EVERY cycle (it used to be skipped whenever there were no failed
 *     autopilot posts — prod happens to have some, but that was luck);
 *   - LIVENESS: a target that a running publish job still holds (BullMQ's
 *     active list, or this process's own claims) is never reaped, and nothing
 *     is reaped when the active list cannot be read;
 *   - an unheld target on a platform with NO duplicate check (anything but
 *     Instagram/Facebook) is parked as ambiguous instead of plain FAILED — its
 *     dead holder may already have published;
 *   - oldest first, 100 per cycle (was an unordered 20), so a large backlog
 *     like the 60-target orphan of 2026-09-16 clears in one cycle;
 *   - the write is CONDITIONAL on the row still being PUBLISHING and still
 *     stale, so a target whose job finished between the read and the write is
 *     never clobbered back to FAILED;
 *   - it increments retryCount. The job that held this claim may have
 *     published before it died, and retryCount > 0 is what makes a later human
 *     Retry run the duplicate pre-flight. errorMessage alone is not durable:
 *     post.publishNow clears it. (The 2026-09-15 deploy victims were reaped
 *     with retryCount 0, so a Retry would have skipped that check.)
 */
export async function reapStuckPublishingTargets(now: Date = new Date()): Promise<number> {
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
  const stuckPublishing = await prisma.postTarget.findMany({
    where: {
      status: "PUBLISHING",
      updatedAt: { lt: thirtyMinAgo },
    },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      channel: { select: { platform: true } },
    },
    orderBy: { updatedAt: "asc" },
    take: REAP_BATCH_SIZE,
  });

  let reaped = 0;
  if (stuckPublishing.length === 0) return reaped;

  // LIVENESS (adversarial review, 2026-09-16): a publish job can legitimately
  // hold a claim for a long time without touching updatedAt (queued behind
  // shared video prep, a long IG container wait, same-post dispatch pacing).
  // Reaping it would make a LIVE publish re-claimable — and the next Retry
  // would publish it a second time. Only targets that NO running job holds
  // are reaped, and that needs positive evidence: if the active list cannot
  // be read, nothing is reaped this cycle (the next cycle tries again).
  let heldTargets: Set<string>;
  try {
    const active = await postPublishQueue.getActive();
    heldTargets = new Set(
      active
        .map((j) => (j?.data as { postTargetId?: unknown } | undefined)?.postTargetId)
        .filter((id): id is string => typeof id === "string")
    );
  } catch (err: any) {
    console.warn(`[AutoHealer] could not read active publish jobs — skipping the stuck-PUBLISHING reap this cycle: ${err?.message ?? err}`);
    return reaped;
  }

  console.log(`[AutoHealer] Found ${stuckPublishing.length} stuck PUBLISHING post targets (${heldTargets.size} publish job(s) active)`);
  for (const target of stuckPublishing) {
    if (!shouldReapPublishing(target, now)) continue;
    let providerSupportsReconcile = false;
    try {
      providerSupportsReconcile =
        typeof getSocialProvider(target.channel.platform as any).findExistingPost === "function";
    } catch {
      providerSupportsReconcile = false;
    }
    const decision = decideReap({
      heldByActiveJob: heldTargets.has(target.id) || localClaimCount(target.id) > 0,
      providerSupportsReconcile,
    });
    if (decision === "skip") {
      console.log(`[AutoHealer] target ${target.id} is still held by a running publish job — not reaping`);
      continue;
    }
    const staleRow = { id: target.id, status: "PUBLISHING" as const, updatedAt: { lt: thirtyMinAgo } };
    try {
      const res = await prisma.postTarget.updateMany({
        where: staleRow,
        data:
          decision === "fail-retryable"
            ? {
                status: "FAILED",
                errorMessage: STUCK_PUBLISHING_MESSAGE,
                retryCount: { increment: 1 },
              }
            : {
                // No duplicate check exists for this platform and the dead
                // holder may already have published: a person checks first.
                status: "FAILED",
                errorMessage: ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE,
                ambiguousAt: now,
                ambiguousReason: ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE,
                retryCount: { increment: 1 },
              },
      });
      reaped += res.count;
    } catch {}
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// Summary logging + alerting
// ---------------------------------------------------------------------------

export async function runAutoHealerWithLogging(): Promise<void> {
  console.log("[AutoHealer] Starting auto-heal cycle...");
  const start = Date.now();

  try {
    const result = await runAutoHealer();
    const elapsed = Date.now() - start;

    console.log(
      `[AutoHealer] Completed in ${elapsed}ms: ` +
        `scanned=${result.scanned} retried=${result.retried} skipped=${result.skipped} permanent=${result.permanent}`,
    );

    if (Object.keys(result.byCategory).length > 0) {
      console.log(`[AutoHealer] Error breakdown: ${JSON.stringify(result.byCategory)}`);
    }

    // Log service health
    for (const svc of result.serviceChecks) {
      if (svc.status === "error") {
        console.error(`[AutoHealer] Service ${svc.name} UNHEALTHY: ${svc.error} (${svc.latencyMs}ms)`);
      }
    }

    // If there are persistent errors, create an ErrorLog entry for visibility
    if (result.permanent > 0) {
      const topCategory = Object.entries(result.byCategory)
        .sort((a, b) => b[1] - a[1])[0];

      try {
        await prisma.errorLog.create({
          data: {
            source: "auto-healer",
            severity: "warning",
            message: `${result.permanent} permanent failures detected. Top category: ${topCategory?.[0]} (${topCategory?.[1]}). ${result.retried} posts retried.`,
            fingerprint: `autohealer-${new Date().toISOString().slice(0, 10)}`,
            metadata: {
              scanned: result.scanned,
              retried: result.retried,
              permanent: result.permanent,
              categories: result.byCategory,
              serviceHealth: result.serviceChecks.map((s) => ({
                name: s.name,
                status: s.status,
                latencyMs: s.latencyMs,
              })),
            },
          },
        });
      } catch {
        // ErrorLog table might not exist — non-critical
      }
    }
  } catch (err: any) {
    console.error("[AutoHealer] Cycle failed:", err.message);
  }
}
