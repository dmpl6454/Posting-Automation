/**
 * Story insights (2026-11-05) — one row per story published THROUGH
 * PostAutomation, built from the stories' analytics snapshots.
 *
 * Pure (no Prisma, no clock of its own) so every honesty rule is unit-testable.
 *
 * Honesty rules, each a lesson this codebase already paid for:
 *  - A number Meta did not report is `null` ("—"), never 0. Snapshots captured
 *    before the story extras existed simply lack them.
 *  - Facebook Page stories have NO usable insights (Meta removed the per-story
 *    metrics in v25.0), so their rows say so instead of showing empty zeros.
 *  - A story under 5 viewers is a quiet story, not a broken channel.
 *  - The snapshot used is the newest CLEAN one, the same clean-first rule the
 *    Reports and Channel Performance queries use, so a later failed capture
 *    never buries real numbers.
 */

export const STORY_LIFETIME_HOURS = 24;

export type StoryInsightStatus =
  /** Metrics captured from Instagram. */
  | "measured"
  /** No capture yet (just published, or the first sync has not run). */
  | "pending"
  /** Meta withheld insights: fewer than 5 people viewed the story. */
  | "low_viewers"
  /** Every capture failed — the channel's login needs reconnecting. */
  | "reconnect"
  /** Facebook Page story: Meta offers no per-story insights. */
  | "not_available";

export interface StorySnapshotInput {
  views: number | null;
  reach: number;
  shares: number;
  impressions: number;
  snapshotAt: Date;
  metadata: unknown;
}

export interface StoryTargetInput {
  targetId: string;
  postId: string;
  platform: string;
  channelId: string;
  channelName: string;
  channelHandle: string | null;
  channelAvatar: string | null;
  publishedAt: Date;
  url: string | null;
  note: string;
  thumbnailUrl: string | null;
  isVideo: boolean;
}

export interface StoryInsightRow extends StoryTargetInput {
  expiresAt: Date;
  live: boolean;
  status: StoryInsightStatus;
  /** True when the reading is the end-of-life capture (~23h after publish). */
  final: boolean;
  capturedAt: Date | null;
  views: number | null;
  reach: number | null;
  shares: number | null;
  replies: number | null;
  totalInteractions: number | null;
  tapsForward: number | null;
  tapsBack: number | null;
  exits: number | null;
  swipeForward: number | null;
  profileVisits: number | null;
  follows: number | null;
  linkClicks: number | null;
}

type Meta = Record<string, unknown>;

function asObject(v: unknown): Meta | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : undefined;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A metric declared unavailable by its capture renders "—", never a fake 0. */
function declared(meta: Meta | undefined, key: string): boolean {
  const avail = asObject(meta?.metricsAvailable);
  return avail?.[key] !== false;
}

function isDegraded(meta: Meta | undefined): boolean {
  return meta?.degraded != null;
}

/**
 * Picks the snapshot a story row is built from: newest clean capture, else the
 * newest degraded one (which still explains why nothing is shown). Input order
 * does not matter.
 */
export function pickStorySnapshot(snapshots: StorySnapshotInput[]): StorySnapshotInput | null {
  if (snapshots.length === 0) return null;
  const sorted = [...snapshots].sort((a, b) => b.snapshotAt.getTime() - a.snapshotAt.getTime());
  return sorted.find((s) => !isDegraded(asObject(s.metadata))) ?? sorted[0]!;
}

export function buildStoryInsightRow(
  target: StoryTargetInput,
  snapshots: StorySnapshotInput[],
  now: Date
): StoryInsightRow {
  const expiresAt = new Date(target.publishedAt.getTime() + STORY_LIFETIME_HOURS * 3_600_000);
  const live = now.getTime() < expiresAt.getTime();
  const empty = {
    capturedAt: null,
    views: null,
    reach: null,
    shares: null,
    replies: null,
    totalInteractions: null,
    tapsForward: null,
    tapsBack: null,
    exits: null,
    swipeForward: null,
    profileVisits: null,
    follows: null,
    linkClicks: null,
    final: false,
  };

  if (target.platform !== "INSTAGRAM") {
    return { ...target, expiresAt, live, status: "not_available", ...empty };
  }

  const snap = pickStorySnapshot(snapshots);
  if (!snap) return { ...target, expiresAt, live, status: "pending", ...empty };

  const meta = asObject(snap.metadata);
  const story = asObject(meta?.story);
  const final = snapshots.some((s) => asObject(s.metadata)?.windowTag === "24h" && !isDegraded(asObject(s.metadata)));

  if (isDegraded(meta)) {
    return { ...target, expiresAt, live, status: "reconnect", ...empty, capturedAt: snap.snapshotAt };
  }

  const views = declared(meta, "views") ? num(snap.views) : null;
  const reach = declared(meta, "reach") ? num(snap.reach) : null;
  const shares = declared(meta, "shares") ? num(snap.shares) : null;

  const metrics = {
    capturedAt: snap.snapshotAt,
    views,
    reach,
    shares,
    replies: num(story?.replies),
    totalInteractions: num(story?.totalInteractions),
    tapsForward: num(story?.tapsForward),
    tapsBack: num(story?.tapsBack),
    exits: num(story?.exits),
    swipeForward: num(story?.swipeForward),
    profileVisits: num(story?.profileVisits),
    follows: num(story?.follows),
    linkClicks: num(story?.linkClicks),
    final,
  };

  const lowViewers = story?.notEnoughViewers === true && views === null && reach === null;
  return { ...target, expiresAt, live, status: lowViewers ? "low_viewers" : "measured", ...metrics };
}

export interface StoryInsightTotals {
  stories: number;
  measured: number;
  live: number;
  views: number | null;
  /** Summed per-story reach — NOT unique people across stories. */
  reachSummed: number | null;
  replies: number | null;
  shares: number | null;
  exits: number | null;
  tapsForward: number | null;
  profileVisits: number | null;
  linkClicks: number | null;
}

/** Sums each metric over the rows that reported it; null when none did. */
export function summarizeStoryInsights(rows: StoryInsightRow[]): StoryInsightTotals {
  const sum = (pick: (r: StoryInsightRow) => number | null): number | null => {
    let total: number | null = null;
    for (const r of rows) {
      const v = pick(r);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };
  return {
    stories: rows.length,
    measured: rows.filter((r) => r.status === "measured").length,
    live: rows.filter((r) => r.live).length,
    views: sum((r) => r.views),
    reachSummed: sum((r) => r.reach),
    replies: sum((r) => r.replies),
    shares: sum((r) => r.shares),
    exits: sum((r) => r.exits),
    tapsForward: sum((r) => r.tapsForward),
    profileVisits: sum((r) => r.profileVisits),
    linkClicks: sum((r) => r.linkClicks),
  };
}
