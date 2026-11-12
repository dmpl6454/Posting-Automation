import { prisma } from "@postautomation/db";
import {
  OVERDUE_GRACE_MS,
  PUBLISH_HEARTBEAT_KEY,
  evaluatePublishingHealth,
  parseHeartbeat,
  redisConnection,
  type PublishingHealth,
} from "@postautomation/queue";

/**
 * Server-side reader for publishing health (2026-11-12). Runs in the WEB
 * container, which stays up when the worker dies — that is the point.
 * See packages/queue/src/publishing-health.ts for the verdict rules.
 *
 * Every read is time-boxed: the shared queue connection uses
 * `maxRetriesPerRequest: null`, so an unbounded await would hang the request
 * forever while Redis is down — exactly when this check matters most.
 */

const READ_TIMEOUT_MS = 2_000;
/** One verdict is shared by every caller for this long (the banner polls from every open dashboard). */
const CACHE_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export interface PublishingHealthDeps {
  readHeartbeat: () => Promise<string | null>;
  readOverdue: (before: Date) => Promise<{ count: number; oldest: Date | null }>;
  now: () => number;
}

const defaultDeps: PublishingHealthDeps = {
  readHeartbeat: () => redisConnection.get(PUBLISH_HEARTBEAT_KEY),
  readOverdue: async (before) => {
    const agg = await prisma.post.aggregate({
      where: { status: "SCHEDULED", scheduledAt: { lt: before } },
      _count: { _all: true },
      _min: { scheduledAt: true },
    });
    return { count: agg._count._all, oldest: agg._min.scheduledAt ?? null };
  },
  now: () => Date.now(),
};

/** Compute a fresh verdict. Never throws. */
export async function computePublishingHealth(deps: PublishingHealthDeps = defaultDeps): Promise<PublishingHealth> {
  const now = deps.now();
  const [hb, overdue] = await Promise.allSettled([
    withTimeout(deps.readHeartbeat(), READ_TIMEOUT_MS),
    withTimeout(deps.readOverdue(new Date(now - OVERDUE_GRACE_MS)), READ_TIMEOUT_MS),
  ]);
  return evaluatePublishingHealth({
    now,
    heartbeatAt: hb.status === "fulfilled" ? parseHeartbeat(hb.value) : undefined,
    overduePosts: overdue.status === "fulfilled" ? overdue.value.count : undefined,
    oldestOverdueAt: overdue.status === "fulfilled" ? overdue.value.oldest?.getTime() ?? null : null,
  });
}

let cached: { at: number; value: PublishingHealth } | null = null;
let inflight: Promise<PublishingHealth> | null = null;

/** Cached verdict (30s), with concurrent callers sharing one computation. Never throws. */
export async function getPublishingHealth(): Promise<PublishingHealth> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (!inflight) {
    inflight = computePublishingHealth()
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
