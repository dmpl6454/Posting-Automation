import { trackBackgroundTask } from "../lib/background-tasks";
import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, createRedisConnection, type CaptionFanoutJobData } from "@postautomation/queue";

/**
 * PR-5 — per-channel unique captions.
 *
 * A post created with `uniqueCaptions` is parked as DRAFT (the publish cron
 * only picks SCHEDULED) with `metadata.captionFanout = { requested: true,
 * pendingSchedule: true }`. This worker:
 *   1. loads the post + its DRAFT/SCHEDULED targets org-scoped via
 *      job.data.organizationId,
 *   2. generates one DISTINCT caption per target that has no override yet
 *      (idempotent — non-null contentOverride targets are skipped on re-runs),
 *      in CHUNKED LLM calls (~10 targets per call) through the existing
 *      text-provider fallback chain,
 *   3. writes each caption to PostTarget.contentOverride (clamped to the
 *      platform char limit),
 *   4. flips the post DRAFT→SCHEDULED exactly once (guarded by post.status +
 *      metadata.captionFanout.pendingSchedule) so the cron publishes it.
 *
 * SAFETY VALVE — captions are best-effort, the post is never lost: any
 * generation failure leaves the affected targets' contentOverride NULL (the
 * publish worker then falls back to the shared caption) and the flip STILL
 * happens, both in the processor and — for a job that exhausts all BullMQ
 * attempts before reaching the flip — in the worker's `failed` handler.
 *
 * Follows the sentiment-analysis.worker pattern: the core logic is an
 * exported, dependency-injected function (`runCaptionFanout`) so tests don't
 * need to mock module resolution or instantiate a real BullMQ worker.
 */

export const CAPTION_CHUNK_SIZE = 10;

/** Fallback when a platform has no known char limit (Instagram's 2200). */
const DEFAULT_CHAR_LIMIT = 2200;

type FanoutTarget = {
  id: string;
  contentOverride: string | null;
  channel: { name: string | null; username: string | null; platform: string };
};

export interface CaptionFanoutDeps {
  prisma: {
    post: {
      findFirst: (args: unknown) => Promise<any>;
      update: (args: unknown) => Promise<any>;
    };
    postTarget: {
      update: (args: unknown) => Promise<any>;
      updateMany: (args: unknown) => Promise<any>;
    };
    /** Optional (present on the real client): used only for the degraded-fallback notification. */
    organizationMember?: {
      findMany: (args: unknown) => Promise<any[]>;
    };
    /** Optional (present on the real client): used only for the degraded-fallback notification. */
    notification?: {
      create: (args: unknown) => Promise<any>;
    };
  };
  /** Provider-chain-wrapped text generation: JSON-array prompt in, raw model text out. */
  generateText: (prompt: string) => Promise<string>;
  /** Per-platform caption char limit (PLATFORM_CHAR_LIMITS in the real worker). */
  charLimitFor: (platform: string) => number | undefined;
  chunkSize?: number;
  /**
   * True when an error means the provider chain is OUT OF CREDIT. Optional so
   * tests and older callers are unaffected. When present the fan-out stops at
   * the first such chunk: every later chunk would make the same call and get
   * the same answer (2026-09-28: 24 chunks x ~97s = ~39 minutes of that).
   */
  isCreditExhausted?: (err: unknown) => boolean;
}

/**
 * Build the chunk prompt: base content + one line per channel. Captions must
 * be distinct from each other (hashtags may repeat) and are returned as a
 * strict JSON array keyed by the chunk-local index.
 */
export function buildCaptionPrompt(
  baseContent: string,
  targets: Array<{ index: number; platform: string; channelName: string; username: string | null; charLimit: number }>
): string {
  const channelLines = targets
    .map(
      (t) =>
        `${t.index}. platform=${t.platform}, channel="${t.channelName}"${t.username ? ` (@${t.username})` : ""}, max ${t.charLimit} characters`
    )
    .join("\n");

  return `Rewrite ONE base social media post into ${targets.length} UNIQUE captions — one per channel listed below.

Rules:
- Every caption must convey the SAME message and facts as the base post. Do NOT invent facts, names, dates, or statistics.
- Each caption must be clearly DISTINCT from the others in wording and angle (hashtags may repeat across captions).
- Match each channel's platform style and stay UNDER that channel's character limit.
- Output ONLY a JSON array — no prose, no markdown fences: [{"index": 0, "caption": "..."}, ...] with exactly one item per channel, using each channel's index number.

Base post:
"""
${baseContent}
"""

Channels:
${channelLines}`;
}

/**
 * Extract the JSON caption array from raw model output (tolerates fences /
 * surrounding prose). Throws when no parseable array is present; silently
 * drops malformed items (their targets keep the shared caption).
 */
export function parseCaptionArray(raw: string): Array<{ index: number; caption: string }> {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("No JSON array found in model output");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Model output is not a JSON array");
  return parsed
    .filter((item): item is { index: unknown; caption: string } =>
      !!item && typeof item === "object" && typeof (item as any).caption === "string"
    )
    .map((item) => ({ index: Number((item as any).index), caption: item.caption.trim() }))
    .filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.caption.length > 0);
}

/** Reason stamped into post.metadata.captionFanout when generation fell back. */
export const DEGRADED_REASON = "caption generation unavailable";

/** Reasons stamped when the post is HELD because no caption could be generated. */
export const HELD_REASON_NO_CREDIT = "every AI provider is out of credit";
export const HELD_REASON_FAILED = "caption generation failed";

/**
 * In-app notification for a degraded fanout: the post's unique captions could
 * not be generated, so it publishes with the shared caption. Recipient = the
 * post CREATOR; falls back to org OWNERs for creatorless system posts (same
 * policy as sendPublishReportEmail). MUST never throw — a notification failure
 * can never be allowed to block the DRAFT→SCHEDULED flip.
 */
async function notifyDegradedFanout(
  deps: Pick<CaptionFanoutDeps, "prisma">,
  postId: string,
  organizationId: string,
  createdById: string | null | undefined
): Promise<void> {
  await notifyFanoutCreator(deps, postId, organizationId, createdById, {
    type: "post.captions_degraded",
    title: "Unique captions unavailable",
    body: "Unique captions couldn't be generated (AI provider unavailable) — the post will publish with your shared caption.",
    reason: DEGRADED_REASON,
  });
}

/**
 * The post was HELD, not published. The copy says so plainly — the whole point
 * of holding is that nothing went out, and a user who reads "unavailable" and
 * assumes it published anyway will not come back to it.
 */
async function notifyHeldFanout(
  deps: Pick<CaptionFanoutDeps, "prisma">,
  postId: string,
  organizationId: string,
  createdById: string | null | undefined,
  reason: string
): Promise<void> {
  await notifyFanoutCreator(deps, postId, organizationId, createdById, {
    type: "post.captions_held",
    title: "Post not published — unique captions failed",
    body:
      reason === HELD_REASON_NO_CREDIT
        ? "Unique captions couldn't be generated because every AI provider is out of credit, so this post was NOT published. Open it to retry the captions or publish with your shared caption."
        : "Unique captions couldn't be generated, so this post was NOT published. Open it to retry the captions or publish with your shared caption.",
    reason,
  });
}

/** Creator-first, org-OWNER fallback. MUST never throw. */
async function notifyFanoutCreator(
  deps: Pick<CaptionFanoutDeps, "prisma">,
  postId: string,
  organizationId: string,
  createdById: string | null | undefined,
  message: { type: string; title: string; body: string; reason: string }
): Promise<void> {
  try {
    if (!deps.prisma.notification?.create) return; // injected mock without notifications — skip
    let recipientIds: string[] = createdById ? [createdById] : [];
    if (recipientIds.length === 0 && deps.prisma.organizationMember?.findMany) {
      const owners = await deps.prisma.organizationMember.findMany({
        where: { organizationId, role: "OWNER" },
        select: { userId: true },
      });
      recipientIds = owners.map((m: any) => m.userId).filter(Boolean);
    }
    for (const userId of recipientIds) {
      await deps.prisma.notification.create({
        data: {
          userId,
          organizationId,
          type: message.type,
          title: message.title,
          body: message.body,
          link: `/dashboard/posts/${postId}`,
          metadata: { postId, reason: message.reason },
        },
      });
    }
  } catch (notifyErr: any) {
    console.warn(
      `[caption-fanout] ${message.type} notification failed for post ${postId}:`,
      notifyErr?.message ?? notifyErr
    );
  }
}

/**
 * The post stopped being a parked schedule while the captions were written
 * (moved out of DRAFT, or unscheduled). Drop our gate flag and change nothing
 * else: left set, pendingSchedule is a publish gate that makes Retry refuse
 * forever with "will publish automatically".
 */
async function clearStalePendingFlag(
  deps: Pick<CaptionFanoutDeps, "prisma">,
  postId: string,
  meta: Record<string, any>,
  fanoutMeta: Record<string, any>,
  why: string
): Promise<void> {
  await deps.prisma.post.update({
    where: { id: postId },
    data: { metadata: { ...meta, captionFanout: { ...fanoutMeta, pendingSchedule: false } } },
  });
  console.warn(`[caption-fanout] Post ${postId} ${why} — cleared its pending-caption flag without scheduling it`);
}

/**
 * Flip a pending-fanout post DRAFT→SCHEDULED (targets first, then the post)
 * exactly once. No-op unless metadata.captionFanout.pendingSchedule === true —
 * safe to call from both the processor and the final-failure handler. A post
 * no longer DRAFT, or a DRAFT with no scheduledAt (flipping it would produce a
 * SCHEDULED post the cron never picks up), only has the flag cleared.
 *
 * On a DEGRADED flip (some/all captions fell back to the shared caption) the
 * metadata is stamped `{ degraded, degradedAt, reason }` and the post creator
 * (or org owners) gets an in-app notification — best-effort, never throws.
 */
export async function flipPendingFanoutPost(
  deps: Pick<CaptionFanoutDeps, "prisma">,
  postId: string,
  organizationId: string,
  opts?: { degraded?: boolean }
): Promise<boolean> {
  const post = await deps.prisma.post.findFirst({
    where: { id: postId, organizationId },
    select: { id: true, status: true, scheduledAt: true, metadata: true, createdById: true },
  });
  if (!post) return false;
  const meta = (post.metadata ?? {}) as Record<string, any>;
  const fanoutMeta = (meta.captionFanout ?? {}) as Record<string, any>;
  if (fanoutMeta.pendingSchedule !== true) return false;
  if (post.status !== "DRAFT") {
    await clearStalePendingFlag(deps, postId, meta, fanoutMeta, `is ${post.status}, no longer a draft`);
    return false;
  }
  if (!post.scheduledAt) {
    await clearStalePendingFlag(deps, postId, meta, fanoutMeta, "has no scheduledAt any more");
    return false;
  }

  // Super-text gate: if the strip burn is still running, this post must STAY a
  // DRAFT — flipping it now would let the cron publish the ORIGINAL, un-burned
  // video. Clear our own flag either way; whichever gate finishes LAST performs
  // the flip (flipParkedPostIfReady re-reads fresh metadata, so a burn that
  // completes between our read and our write cannot strand the post).
  // With no super-text metadata this is `false` and the behaviour below is
  // byte-identical to the pre-super-text flip.
  const superTextPending = (meta as Record<string, any>).superText?.pendingBurn === true;

  if (!superTextPending) {
    await deps.prisma.postTarget.updateMany({
      where: { postId, status: "DRAFT" },
      data: { status: "SCHEDULED" },
    });
  }
  await deps.prisma.post.update({
    where: { id: postId },
    data: {
      ...(superTextPending ? {} : { status: "SCHEDULED" }),
      metadata: {
        ...meta,
        captionFanout: {
          ...fanoutMeta,
          pendingSchedule: false,
          completedAt: new Date().toISOString(),
          ...(opts?.degraded
            ? { degraded: true, degradedAt: new Date().toISOString(), reason: DEGRADED_REASON }
            : {}),
        },
      },
    },
  });

  if (opts?.degraded) {
    await notifyDegradedFanout(deps, postId, organizationId, post.createdById);
  }

  if (superTextPending) {
    // Post-write re-check closes the simultaneous-completion race.
    const { flipParkedPostIfReady } = await import("../lib/publish-gates");
    await flipParkedPostIfReady(deps.prisma as any, postId, organizationId);
    return false;
  }
  return true;
}

/**
 * HOLD a pending-fanout post instead of publishing it (owner decision
 * 2026-09-28): no unique caption could be generated for ANY channel, and
 * publishing the shared caption to every channel is not what the user asked
 * for — on 240 Facebook Pages it is identical text in one burst. The post stays
 * a DRAFT; `captionFanout.held` is a publish GATE (publish-gates.ts), so no
 * other worker can flip it. A human resolves it: retry the captions, or use the
 * shared caption.
 *
 * Guarded like the flip: only a DRAFT that is still pending (a post that left
 * DRAFT just has the stale flag cleared). Returns true only when THIS call
 * held it.
 */
export async function holdPendingFanoutPost(
  deps: Pick<CaptionFanoutDeps, "prisma">,
  postId: string,
  organizationId: string,
  reason: string
): Promise<boolean> {
  const post = await deps.prisma.post.findFirst({
    where: { id: postId, organizationId },
    select: { id: true, status: true, metadata: true, createdById: true },
  });
  if (!post) return false;
  const meta = (post.metadata ?? {}) as Record<string, any>;
  const fanoutMeta = (meta.captionFanout ?? {}) as Record<string, any>;
  if (fanoutMeta.pendingSchedule !== true) return false;
  if (post.status !== "DRAFT") {
    await clearStalePendingFlag(deps, postId, meta, fanoutMeta, `is ${post.status}, no longer a draft`);
    return false;
  }

  await deps.prisma.post.update({
    where: { id: postId },
    data: {
      metadata: {
        ...meta,
        captionFanout: {
          ...fanoutMeta,
          pendingSchedule: false,
          held: true,
          heldAt: new Date().toISOString(),
          reason,
        },
      },
    },
  });
  await notifyHeldFanout(deps, postId, organizationId, post.createdById, reason);
  return true;
}

export async function runCaptionFanout(
  data: CaptionFanoutJobData,
  deps: CaptionFanoutDeps
): Promise<
  | { generated: number; skippedExisting: number; flipped: boolean; degraded: boolean; held?: boolean }
  | { skipped: string }
> {
  const { postId, organizationId } = data;

  // Org-scoped load — a job with a foreign/unknown org can never touch the post.
  const post = await deps.prisma.post.findFirst({
    where: { id: postId, organizationId },
    include: {
      targets: {
        where: { status: { in: ["DRAFT", "SCHEDULED"] } },
        include: { channel: { select: { name: true, username: true, platform: true } } },
      },
    },
  });
  if (!post) {
    console.warn(`[caption-fanout] Post ${postId} not found in org ${organizationId} — skipping`);
    return { skipped: "post_not_found" };
  }

  const targets: FanoutTarget[] = post.targets ?? [];
  // Idempotency: a re-run (BullMQ retry) never regenerates a caption that was
  // already written — only NULL-override targets are pending.
  const pending = targets.filter((t) => t.contentOverride == null);
  let generated = 0;
  let degraded = false;
  let outOfCredit = false;

  const chunkSize = deps.chunkSize ?? CAPTION_CHUNK_SIZE;
  for (let i = 0; i < pending.length; i += chunkSize) {
    const chunk = pending.slice(i, i + chunkSize);
    const described = chunk.map((t, j) => ({
      index: j,
      platform: t.channel.platform,
      channelName: t.channel.name || t.channel.platform,
      username: t.channel.username,
      charLimit: deps.charLimitFor(t.channel.platform) ?? DEFAULT_CHAR_LIMIT,
    }));
    try {
      const raw = await deps.generateText(buildCaptionPrompt(post.content, described));
      const byIndex = new Map(parseCaptionArray(raw).map((item) => [item.index, item.caption]));
      for (let j = 0; j < chunk.length; j++) {
        const caption = byIndex.get(j);
        if (!caption) {
          // Missing/malformed item → this target publishes the shared caption.
          degraded = true;
          continue;
        }
        const limit = described[j]!.charLimit;
        await deps.prisma.postTarget.update({
          where: { id: chunk[j]!.id },
          data: { contentOverride: caption.length > limit ? caption.slice(0, limit) : caption },
        });
        generated++;
      }
    } catch (err: any) {
      // SAFETY VALVE (per chunk): generation failure is never fatal — the
      // affected targets keep a NULL override, so the publish worker falls
      // back to the shared caption. Degraded, never lost.
      degraded = true;
      console.error(
        `[caption-fanout] Caption generation failed for post ${postId} (chunk at ${i}): ${err?.message ?? err} — affected channels will use the shared caption`
      );
      if (deps.isCreditExhausted?.(err)) {
        outOfCredit = true;
        const remaining = pending.length - (i + chunk.length);
        if (remaining > 0) {
          console.error(
            `[caption-fanout] Post ${postId}: the AI providers are out of credit — not attempting the remaining ${remaining} channel(s)`
          );
        }
        break;
      }
    }
  }

  // Nothing unique could be written for ANY pending channel: hold, don't publish.
  // (Partial success still publishes — the failed channels use the shared caption.)
  const fanoutMeta = (((post.metadata ?? {}) as Record<string, any>).captionFanout ?? {}) as Record<string, any>;
  if (pending.length > 0 && generated === 0 && fanoutMeta.pendingSchedule === true) {
    const reason = outOfCredit ? HELD_REASON_NO_CREDIT : HELD_REASON_FAILED;
    const held = await holdPendingFanoutPost(deps, postId, organizationId, reason);
    console.error(
      `[caption-fanout] Post ${postId}: no unique caption for any of ${pending.length} channel(s) — ${held ? "HELD as a draft, NOT published" : "hold skipped (post no longer pending)"} (${reason})`
    );
    return { generated: 0, skippedExisting: targets.length - pending.length, flipped: false, degraded: true, held };
  }

  const flipped = await flipPendingFanoutPost(deps, postId, organizationId, { degraded });
  if (flipped) {
    console.log(
      `[caption-fanout] Post ${postId}: ${generated} caption(s) generated, ${targets.length - pending.length} already present — flipped DRAFT→SCHEDULED${degraded ? " (degraded: some channels use the shared caption)" : ""}`
    );
  }
  return { generated, skippedExisting: targets.length - pending.length, flipped, degraded };
}

export function createCaptionFanoutWorker() {
  const worker = new Worker<CaptionFanoutJobData>(
    QUEUE_NAMES.CAPTION_FANOUT,
    async (job: Job<CaptionFanoutJobData>) => {
      console.log(`[caption-fanout] Processing job ${job.id} for post ${job.data.postId}`);
      // Lazy-load @postautomation/ai (mirrors sentiment-analysis.worker) so the
      // worker's module graph stays light at boot.
      const { generateContent, withTextProviderFallback, PLATFORM_CHAR_LIMITS, isProviderCreditExhausted } = await import(
        "@postautomation/ai"
      );
      return runCaptionFanout(job.data, {
        prisma: prisma as any,
        generateText: (prompt) =>
          withTextProviderFallback(
            undefined,
            (provider) =>
              generateContent({
                provider: provider as Parameters<typeof generateContent>[0]["provider"],
                // `platform` only seeds the default tone; the real per-channel
                // platforms + limits are spelled out inside the prompt and the
                // response is a JSON array, so give the CALL a generous limit.
                platform: "INSTAGRAM",
                charLimit: 6000,
                tone: "platform-native, engaging",
                userPrompt: prompt,
              }),
            (failed, next, e) =>
              console.warn(
                `[caption-fanout] Provider ${failed} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), trying ${next}`
              )
          ),
        charLimitFor: (platform) => PLATFORM_CHAR_LIMITS[platform],
        isCreditExhausted: isProviderCreditExhausted,
      });
    },
    {
      connection: createRedisConnection(),
      // Each job fans out chunked LLM calls — keep parallelism gentle.
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[caption-fanout] Job ${job?.id} failed:`, err.message);
    // FINAL-failure safety valve: if every BullMQ attempt died before the
    // processor reached the flip (e.g. DB hiccup), still move the post to
    // SCHEDULED with whatever overrides exist — shared captions publish,
    // the post is never stranded in DRAFT.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      // Tracked so a graceful drain waits for this safety valve
      // (lib/background-tasks.ts) instead of stranding the post in DRAFT.
      trackBackgroundTask(flipPendingFanoutPost({ prisma: prisma as any }, job.data.postId, job.data.organizationId, { degraded: true })
        .then((flipped) => {
          if (flipped) {
            console.warn(
              `[caption-fanout] Post ${job.data.postId} flipped to SCHEDULED after final job failure — publishing with shared caption(s)`
            );
          }
        })
        .catch((e) =>
          console.error(`[caption-fanout] Final-failure flip failed for post ${job.data.postId}:`, e?.message ?? e)
        ));
    }
  });

  worker.on("completed", (job) => {
    console.log(`[caption-fanout] Job ${job.id} completed`);
  });

  return worker;
}
