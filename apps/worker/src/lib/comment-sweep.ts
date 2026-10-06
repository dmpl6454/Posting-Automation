/**
 * Comment automation sweep (2026-10-05) — auto-hide rules + new-comment alerts.
 *
 * Every SWEEP_INTERVAL the cron leader calls runCommentSweep. For each workspace
 * that switched on a CommentAutomation feature it reads the FIRST page of
 * comments on its recent published Facebook/Instagram posts, then:
 *
 *   auto-hide  hides comments matching the workspace's blocked words / links,
 *              as the Page / account, and records each one in CommentAutoAction.
 *              A recorded comment is never acted on again — so a person who
 *              unhides it keeps it visible.
 *   alerts     compares each post's newest comment with the watermark stored in
 *              PostTarget.metadata.commentSweep and sends ONE in-app
 *              notification per workspace per run to owners/admins. The first
 *              look at a post only sets the watermark (no flood of "new"
 *              comments for history).
 *
 * Budget — these reads use the same Meta app quota as publishing:
 *   - at most `maxPostsPerRun` posts per run in total and `maxPostsPerOrg` per
 *     workspace, interleaved so one large workspace cannot starve the others;
 *   - stalest first (never-checked first), newest post first on ties;
 *   - Facebook posts are skipped for the rest of the run once the app usage
 *     Meta reports reaches `fbUsageCeiling`%, far below the 95% at which every
 *     publish call starts sleeping;
 *   - at most `maxHidesPerOrg` hides per workspace per run, so an over-broad
 *     rule cannot sweep a whole Page in one go;
 *   - one read at a time.
 *
 * Every step is idempotent (hide is idempotent; the action row is unique per
 * workspace + comment; the watermark only moves forward), so a run killed by a
 * deploy is simply finished by the next one.
 *
 * YouTube (2026-10-06) — comment SENTIMENT only (no auto-hide, no alerts): for
 * workspaces with sentiment on, the sweep also reads the newest page of comment
 * threads on videos published through the app to their YouTube channels, with
 * the channel's own token. That spends YouTube Data API units from the same
 * project quota as uploads (1600 units each), so it is budgeted separately:
 *   - one `commentThreads.list` (1 unit) per video, each video at most once per
 *     `minIntervalMs`, at most `maxVideosPerRun` videos per run;
 *   - a daily unit cap in Redis by Google's Pacific quota day, failing CLOSED
 *     when Redis can't answer; Google's own quotaExceeded stops it for the day.
 *
 * LinkedIn Pages (2026-10-06) — the same, for posts published through the app
 * to LinkedIn PAGE channels (`platformId` "org-…"): `GET
 * /rest/socialActions/{post}/comments` with r_organization_social. Personal
 * profiles are out: reading comments on a member's post needs r_member_social,
 * which LinkedIn grants only to approved partners. One call per post (a
 * second for the newest page when a post has more than one page of comments),
 * under its own daily call cap.
 *
 * X / Twitter (2026-10-06) — replies to tweets the app published: `GET
 * /2/tweets/search/recent?query=conversation_id:{tweet}` as the channel. X's
 * API is pay-per-use (about $0.005 per post read since 2026-02), so this
 * source is the stingiest: it asks only for replies newer than the newest one
 * already seen (`since_id`, kept as the post's cursor), counts its daily cap
 * in replies returned (at least 1 per request), re-reads a post every 3 hours
 * and asks for no author objects (billed separately).
 *
 * All three run through one source-agnostic pass (sweepExternalSentiment).
 */

import {
  commentCapabilities,
  matchCommentRule,
  type CommentPlatform,
  type CommentRules,
  type SocialComment,
  type SocialCommentPage,
} from "@postautomation/social";
import {
  readCommentSentimentConfig,
  scorePendingCommentSentiment,
  sentimentCandidates,
  linkedinSentimentCandidates,
  twitterSentimentCandidates,
  youtubeSentimentCandidates,
  type CommentSentimentConfig,
  type Sentiment,
  type StoredCommentInput,
} from "./comment-sentiment";
import { isPerVideoCommentError, isQuotaError, quotaDay, YT_UNITS } from "./listening-comments";

export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export interface SweepConfig {
  maxPostsPerRun: number;
  maxPostsPerOrg: number;
  lookbackDays: number;
  fbUsageCeiling: number;
  maxHidesPerOrg: number;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readSweepConfig(env: Record<string, string | undefined> = process.env): SweepConfig {
  return {
    maxPostsPerRun: intEnv(env, "COMMENT_SWEEP_MAX_POSTS", 40, 1, 200),
    maxPostsPerOrg: intEnv(env, "COMMENT_SWEEP_MAX_POSTS_PER_ORG", 15, 1, 100),
    lookbackDays: intEnv(env, "COMMENT_SWEEP_LOOKBACK_DAYS", 3, 1, 14),
    fbUsageCeiling: intEnv(env, "COMMENT_SWEEP_FB_USAGE_CEILING", 75, 10, 90),
    maxHidesPerOrg: intEnv(env, "COMMENT_AUTOHIDE_MAX_PER_RUN", 50, 1, 500),
  };
}

/** Budget of a sentiment-only source (YouTube, LinkedIn Pages). */
export interface ExternalSentimentConfig {
  /** API units (YouTube) / calls (LinkedIn) / posts read (X) this source may spend per day; 0 turns it off. */
  dailyUnits: number;
  /** Posts read per run, across all workspaces. */
  maxPostsPerRun: number;
  /** A post is re-read at most this often. */
  minIntervalMs: number;
  /** Posts published within this many days are read. */
  lookbackDays: number;
}
export type YouTubeSentimentConfig = ExternalSentimentConfig;
export type LinkedInSentimentConfig = ExternalSentimentConfig;
export type TwitterSentimentConfig = ExternalSentimentConfig;

function readExternalConfig(
  env: Record<string, string | undefined>,
  prefix: string,
  keys: { daily: string; max: string },
  defaults: { daily: number; max: number; intervalMin: number; lookbackDays: number; lookbackMax: number } = {
    daily: 300,
    max: 20,
    intervalMin: 60,
    lookbackDays: 7,
    lookbackMax: 30,
  }
): ExternalSentimentConfig {
  return {
    dailyUnits: intEnv(env, `${prefix}_${keys.daily}`, defaults.daily, 0, 5000),
    maxPostsPerRun: intEnv(env, `${prefix}_${keys.max}`, defaults.max, 1, 200),
    minIntervalMs: intEnv(env, `${prefix}_INTERVAL_MIN`, defaults.intervalMin, 15, 24 * 60) * 60 * 1000,
    lookbackDays: intEnv(env, `${prefix}_LOOKBACK_DAYS`, defaults.lookbackDays, 1, defaults.lookbackMax),
  };
}

export function readYouTubeSentimentConfig(env: Record<string, string | undefined> = process.env): YouTubeSentimentConfig {
  return readExternalConfig(env, "COMMENT_SENTIMENT_YT", { daily: "DAILY_UNITS", max: "MAX_VIDEOS" });
}

export function readLinkedInSentimentConfig(env: Record<string, string | undefined> = process.env): LinkedInSentimentConfig {
  return readExternalConfig(env, "COMMENT_SENTIMENT_LI", { daily: "DAILY_CALLS", max: "MAX_POSTS" });
}

/**
 * X: deliberately cheap defaults — 100 posts read a day (about $0.50 at
 * pay-per-use rates), 10 posts a run, each re-read every 3 hours, and a 6-day
 * window because recent search only reaches back 7 days.
 */
export function readTwitterSentimentConfig(env: Record<string, string | undefined> = process.env): TwitterSentimentConfig {
  return readExternalConfig(
    env,
    "COMMENT_SENTIMENT_X",
    { daily: "DAILY_READS", max: "MAX_POSTS" },
    { daily: 100, max: 10, intervalMin: 180, lookbackDays: 6, lookbackMax: 7 }
  );
}

/** A YouTube video id (a community post's id is not one, and has no comment threads to list). */
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** A LinkedIn post URN as /rest/posts returns it (x-restli-id). */
export const LINKEDIN_POST_URN = /^urn:li:(share|ugcPost):\d+$/;
/** Comments per LinkedIn page read. */
export const LINKEDIN_COMMENTS_PAGE = 50;
/** A tweet id. */
export const TWEET_ID = /^\d{5,25}$/;
/** Replies asked for per X read (each one returned is billed). */
export const TWITTER_REPLIES_PAGE = 25;

/** Kill switch: `COMMENT_AUTOMATION_ENABLED=false` stops the sweep. Workspaces opt in individually. */
export function isCommentAutomationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.COMMENT_AUTOMATION_ENABLED !== "false";
}

/** Graph timestamps end in "+0000"; make them strictly ISO before parsing. */
export function parseGraphTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(t) ? t : null;
}

// ── Planning (pure) ────────────────────────────────────────────────────────

export interface SweepCandidate {
  id: string;
  organizationId: string;
  channelId: string;
  publishedAt: Date | null;
  /** PostTarget.metadata.commentSweep.checkedAt (epoch ms), null = never checked. */
  checkedAt: number | null;
}

/**
 * Stalest first within each workspace (never-checked first, then newest post),
 * capped per workspace, then interleaved round-robin across workspaces up to the
 * run cap.
 */
export function planSweepTargets<T extends SweepCandidate>(
  candidates: readonly T[],
  cfg: Pick<SweepConfig, "maxPostsPerRun" | "maxPostsPerOrg">
): T[] {
  const byOrg = new Map<string, T[]>();
  for (const c of candidates) {
    const list = byOrg.get(c.organizationId) ?? [];
    list.push(c);
    byOrg.set(c.organizationId, list);
  }
  const queues = [...byOrg.values()].map((list) =>
    [...list]
      .sort((a, b) => {
        const ca = a.checkedAt ?? -1;
        const cb = b.checkedAt ?? -1;
        if (ca !== cb) return ca - cb;
        return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
      })
      .slice(0, cfg.maxPostsPerOrg)
  );
  const out: T[] = [];
  for (let round = 0; out.length < cfg.maxPostsPerRun; round++) {
    let added = false;
    for (const q of queues) {
      const next = q[round];
      if (!next) continue;
      out.push(next);
      added = true;
      if (out.length >= cfg.maxPostsPerRun) break;
    }
    if (!added) break;
  }
  return out;
}

/** Comments the rules may hide: top-level and embedded replies, not ours, not already hidden. */
export function hideCandidates(comments: readonly SocialComment[]): SocialComment[] {
  const out: SocialComment[] = [];
  for (const c of comments) {
    if (!c.isOwn && !c.hidden && c.canHide) out.push(c);
    for (const r of c.replies) if (!r.isOwn && !r.hidden && r.canHide) out.push(r);
  }
  return out;
}

/**
 * New top-level comments since the watermark. With no watermark (first look)
 * nothing is "new" — only the watermark is set — so switching alerts on never
 * announces a post's whole history.
 */
export function newSinceWatermark(
  comments: readonly SocialComment[],
  watermark: number | null,
  exclude: ReadonlySet<string> = new Set()
): { fresh: SocialComment[]; nextWatermark: number | null } {
  let newest = watermark;
  const fresh: SocialComment[] = [];
  for (const c of comments) {
    if (c.isOwn) continue;
    const t = parseGraphTime(c.createdAt);
    if (t === null) continue;
    if (newest === null || t > newest) newest = t;
    if (watermark !== null && t > watermark && !c.hidden && !exclude.has(c.id)) fresh.push(c);
  }
  return { fresh, nextWatermark: newest };
}

/** The account label stored with an action / shown in an alert. */
export function commenterLabel(c: SocialComment, platform: CommentPlatform): string {
  if (platform === "INSTAGRAM") return c.author.username ? `@${c.author.username}` : "Instagram user";
  return c.author.name ?? "Facebook user";
}

export function alertCopy(
  orgNew: Array<{ comment: SocialComment; channelName: string; platform: CommentPlatform }>,
  postCount: number,
  hidden: number
): { title: string; body: string } {
  const n = orgNew.length;
  const first = orgNew[0]!;
  const sample = (first.comment.text || "(no text)").replace(/\s+/g, " ").slice(0, 90);
  const title = n === 1 ? `New comment on ${first.channelName}` : `${n} new comments`;
  const parts = [
    `${commenterLabel(first.comment, first.platform)}: “${sample}${(first.comment.text ?? "").length > 90 ? "…" : ""}”`,
  ];
  if (n > 1) parts.push(`and ${n - 1} more across ${postCount} ${postCount === 1 ? "post" : "posts"}.`);
  if (hidden > 0) parts.push(`${hidden} ${hidden === 1 ? "comment was" : "comments were"} hidden by your rules.`);
  return { title, body: parts.join(" ") };
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface SweepDeps {
  prisma: any;
  readComments: (
    platform: CommentPlatform,
    tokens: { accessToken: string; refreshToken?: string; metadata?: Record<string, unknown> },
    objectId: string,
    account: { platformId: string; igUserId: string | null; username: string | null }
  ) => Promise<SocialCommentPage>;
  hideComment: (
    platform: CommentPlatform,
    tokens: { accessToken: string; refreshToken?: string; metadata?: Record<string, unknown> },
    commentId: string,
    pageId: string
  ) => Promise<void>;
  facebookUsagePeak: () => number;
  /**
   * One model call scoring up to 20 comment texts (comment sentiment). When
   * absent, comments are still stored but left unscored until a run has it.
   */
  scoreSentimentBatch?: (texts: string[]) => Promise<Map<number, { sentiment: Sentiment; score: number }>>;
  sentimentConfig?: CommentSentimentConfig;
  /**
   * YouTube comment sentiment: one `commentThreads.list` page for a video with
   * the channel's token. When absent (or without `reserveYouTubeUnits`), the
   * YouTube pass is skipped.
   */
  readYouTubeComments?: (accessToken: string, videoId: string) => Promise<{ status: number; body: unknown }>;
  /** Reserve units against the daily cap; false = cap reached or the counter is unavailable. */
  reserveYouTubeUnits?: (units: number) => Promise<boolean>;
  youtubeConfig?: YouTubeSentimentConfig;
  /**
   * LinkedIn Page comment sentiment: one page of `socialActions/{post}/comments`
   * with the Page channel's token. Skipped when absent (or without
   * `reserveLinkedInCalls`).
   */
  readLinkedInComments?: (accessToken: string, postUrn: string, start: number, count: number) => Promise<{ status: number; body: unknown }>;
  /** Reserve calls against LinkedIn's daily cap; false = cap reached or the counter is unavailable. */
  reserveLinkedInCalls?: (calls: number) => Promise<boolean>;
  linkedinConfig?: LinkedInSentimentConfig;
  /**
   * X reply sentiment: one recent-search page of a tweet's conversation, as the
   * channel (OAuth 1.0a). Skipped when absent (or without the reserve/refund pair).
   */
  readTwitterReplies?: (
    tokens: { accessToken: string; tokenSecret: string },
    tweetId: string,
    opts: { sinceId: string | null; maxResults: number }
  ) => Promise<{ status: number; body: unknown }>;
  /** Reserve posts read against X's daily cap; false = cap reached or the counter is unavailable. */
  reserveTwitterReads?: (reads: number) => Promise<boolean>;
  /** Give back what a reservation didn't use (fewer replies returned than asked for). */
  refundTwitterReads?: (reads: number) => Promise<void>;
  twitterConfig?: TwitterSentimentConfig;
  now?: () => Date;
  log?: Pick<Console, "log" | "warn">;
}

export interface OrgRunSummary {
  postsChecked: number;
  hidden: number;
  newComments: number;
  errors: number;
  skippedForQuota: number;
  /** Channels whose token lacks the permission to hide (auto-hide could not act). */
  hidePermissionMissing: string[];
  alerted: boolean;
  /** Comment sentiment (only when switched on). */
  sentimentStored?: number;
  sentimentScored?: number;
  sentimentNegative?: number;
  sentimentPending?: number;
  /** YouTube videos whose comments were read for sentiment this run. */
  youtubeVideosChecked?: number;
  /** LinkedIn Page posts whose comments were read for sentiment this run. */
  linkedinPostsChecked?: number;
  /** X posts whose replies were read for sentiment this run. */
  twitterPostsChecked?: number;
}

const NOT_A_STORY = [{ format: null }, { format: { not: "STORY" as const } }];

function readCheckedAt(metadata: unknown): { checkedAt: number | null; lastSeenAt: number | null; cursor: string | null } {
  const sweep = (metadata as any)?.commentSweep;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    checkedAt: num(sweep?.checkedAt),
    lastSeenAt: num(sweep?.lastSeenAt),
    cursor: typeof sweep?.cursor === "string" && sweep.cursor ? sweep.cursor : null,
  };
}

function rulesOf(a: { blockedWords: string[]; hideLinks: boolean }): CommentRules {
  return { blockedWords: a.blockedWords ?? [], hideLinks: !!a.hideLinks };
}

export async function runCommentSweep(deps: SweepDeps, cfg: SweepConfig = readSweepConfig()): Promise<Record<string, OrgRunSummary>> {
  const log = deps.log ?? console;
  const now = (deps.now ?? (() => new Date()))();
  const prisma = deps.prisma;

  const automations: any[] = await prisma.commentAutomation.findMany({
    where: { OR: [{ autoHideEnabled: true }, { alertsEnabled: true }, { sentimentEnabled: true }] },
  });
  if (automations.length === 0) return {};
  const automationByOrg = new Map<string, any>(automations.map((a) => [a.organizationId, a]));

  const since = new Date(now.getTime() - cfg.lookbackDays * 24 * 60 * 60 * 1000);
  const candidates: Array<SweepCandidate & { publishedId: string; metadata: unknown }> = [];
  for (const a of automations) {
    const rows: any[] = await prisma.postTarget.findMany({
      where: {
        post: { organizationId: a.organizationId },
        status: "PUBLISHED",
        publishedId: { not: null },
        publishedAt: { gte: since },
        OR: NOT_A_STORY,
        channel: {
          organizationId: a.organizationId,
          disconnectedAt: null,
          isActive: true,
          platform: { in: ["FACEBOOK", "INSTAGRAM"] },
          ...(a.channelIds?.length ? { id: { in: a.channelIds } } : {}),
        },
      },
      orderBy: [{ publishedAt: "desc" }],
      take: 500,
      select: { id: true, channelId: true, publishedId: true, publishedAt: true, metadata: true },
    });
    for (const r of rows) {
      candidates.push({
        id: r.id,
        organizationId: a.organizationId,
        channelId: r.channelId,
        publishedAt: r.publishedAt,
        publishedId: r.publishedId,
        metadata: r.metadata,
        checkedAt: readCheckedAt(r.metadata).checkedAt,
      });
    }
  }

  const planned = planSweepTargets(candidates, cfg);
  const summaries: Record<string, OrgRunSummary> = {};
  for (const a of automations) {
    summaries[a.organizationId] = {
      postsChecked: 0,
      hidden: 0,
      newComments: 0,
      errors: 0,
      skippedForQuota: 0,
      hidePermissionMissing: [],
      alerted: false,
      ...(a.sentimentEnabled ? { sentimentStored: 0, sentimentScored: 0, sentimentNegative: 0, sentimentPending: 0 } : {}),
    };
  }
  if (planned.length === 0) {
    await sweepExternalSources(deps, automations, summaries, now, log);
    // Comments stored on an earlier run may still be waiting for a verdict.
    await scoreSentimentForRun(deps, automations, summaries, log);
    await finishOrgs(prisma, automations, summaries, now, log);
    return summaries;
  }

  // ⚠️ DIRECT channel.findMany — the only read shape that decrypts accessToken.
  const channelIds = [...new Set(planned.map((p) => p.channelId))];
  const channels: any[] = await prisma.channel.findMany({
    where: { id: { in: channelIds }, disconnectedAt: null },
  });
  const channelById = new Map<string, any>(channels.map((c) => [c.id, c]));

  const newByOrg = new Map<string, Array<{ comment: SocialComment; channelName: string; platform: CommentPlatform; targetId: string }>>();
  let fbPaused = false;

  for (const target of planned) {
    const summary = summaries[target.organizationId]!;
    const automation = automationByOrg.get(target.organizationId);
    const channel = channelById.get(target.channelId);
    if (!automation || !channel || channel.organizationId !== target.organizationId) continue;
    const platform = channel.platform as CommentPlatform;

    if (platform === "FACEBOOK" && (fbPaused || deps.facebookUsagePeak() >= cfg.fbUsageCeiling)) {
      if (!fbPaused) log.warn(`[CommentSweep] Facebook app usage ≥${cfg.fbUsageCeiling}% — skipping Facebook posts for the rest of this run`);
      fbPaused = true;
      summary.skippedForQuota++;
      continue;
    }

    const metadata = (channel.metadata ?? undefined) as Record<string, unknown> | undefined;
    const tokens = { accessToken: channel.accessToken, refreshToken: channel.refreshToken ?? undefined, metadata };
    const igUserId =
      platform === "INSTAGRAM"
        ? (typeof metadata?.igUserId === "string" ? (metadata.igUserId as string) : null) ?? channel.platformId ?? null
        : null;

    let page: SocialCommentPage | null = null;
    try {
      page = await deps.readComments(platform, tokens, target.publishedId, {
        platformId: channel.platformId,
        igUserId,
        username: channel.username ?? null,
      });
    } catch (err: any) {
      summary.errors++;
      log.warn(`[CommentSweep] read failed for target ${target.id} (${platform}): ${String(err?.message ?? err).slice(0, 160)}`);
    }
    summary.postsChecked++;

    const justHidden = new Set<string>();
    if (page && automation.autoHideEnabled) {
      const rules = rulesOf(automation);
      const hasRules = rules.blockedWords.length > 0 || rules.hideLinks;
      const grant = Array.isArray((metadata as any)?.grantedScopes) ? ((metadata as any).grantedScopes as string[]) : null;
      const canModerate = commentCapabilities(platform, grant).canModerate;
      if (hasRules && canModerate === false) {
        if (!summary.hidePermissionMissing.includes(channel.name)) summary.hidePermissionMissing.push(channel.name);
      } else if (hasRules) {
        const matches = hideCandidates(page.comments)
          .map((c) => ({ c, m: matchCommentRule(c.text, rules) }))
          .filter((x): x is { c: SocialComment; m: { reason: string } } => x.m !== null);
        if (matches.length > 0) {
          const already: any[] = await prisma.commentAutoAction.findMany({
            where: { organizationId: target.organizationId, commentId: { in: matches.map((x) => x.c.id) } },
            select: { commentId: true },
          });
          const done = new Set(already.map((r) => r.commentId));
          for (const { c, m } of matches) {
            if (done.has(c.id)) continue;
            if (summary.hidden >= cfg.maxHidesPerOrg) break;
            try {
              await deps.hideComment(platform, tokens, c.id, channel.platformId);
            } catch (err: any) {
              summary.errors++;
              const msg = String(err?.message ?? err);
              if (/hasn't (been )?granted comment/i.test(msg) && !summary.hidePermissionMissing.includes(channel.name)) {
                summary.hidePermissionMissing.push(channel.name);
              }
              log.warn(`[CommentSweep] hide failed for comment on target ${target.id}: ${msg.slice(0, 160)}`);
              continue;
            }
            justHidden.add(c.id);
            summary.hidden++;
            try {
              await prisma.commentAutoAction.create({
                data: {
                  organizationId: target.organizationId,
                  postTargetId: target.id,
                  channelId: channel.id,
                  platform,
                  commentId: c.id,
                  commentText: (c.text ?? "").slice(0, 500),
                  authorLabel: commenterLabel(c, platform),
                  reason: m.reason,
                  status: "HIDDEN",
                },
              });
            } catch (err: any) {
              // P2002 = another run (or the same Page in this workspace twice) already logged it.
              if (err?.code !== "P2002") log.warn(`[CommentSweep] action log write failed: ${String(err?.message ?? err).slice(0, 160)}`);
            }
          }
        }
      }
    }

    // Comment sentiment: remember every comment on this page we haven't stored
    // yet (comments the rules just hid included — they are still feedback).
    if (page && automation.sentimentEnabled) {
      await storeSentimentRows(prisma, target, channel.id, platform, sentimentCandidates(page.comments, platform), summary, log);
    }

    const { lastSeenAt } = readCheckedAt(target.metadata);
    let nextWatermark = lastSeenAt;
    if (page) {
      const { fresh, nextWatermark: wm } = newSinceWatermark(page.comments, lastSeenAt, justHidden);
      nextWatermark = wm ?? (lastSeenAt === null ? now.getTime() : lastSeenAt);
      if (automation.alertsEnabled && fresh.length > 0) {
        summary.newComments += fresh.length;
        const list = newByOrg.get(target.organizationId) ?? [];
        for (const c of fresh) list.push({ comment: c, channelName: channel.name, platform, targetId: target.id });
        newByOrg.set(target.organizationId, list);
      }
    }

    const patch = JSON.stringify({ commentSweep: { checkedAt: now.getTime(), lastSeenAt: nextWatermark } });
    try {
      // Atomic jsonb MERGE — never a whole-column rewrite: publish and analytics
      // write other keys of PostTarget.metadata concurrently.
      await prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${target.id}`;
    } catch (err: any) {
      log.warn(`[CommentSweep] watermark write failed for ${target.id}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }

  // One notification per workspace per run, to owners and admins.
  for (const [orgId, list] of newByOrg) {
    const summary = summaries[orgId]!;
    try {
      const members: any[] = await prisma.organizationMember.findMany({
        where: { organizationId: orgId, role: { in: ["OWNER", "ADMIN"] } },
        select: { userId: true },
      });
      const posts = new Set(list.map((x) => x.targetId)).size;
      const { title, body } = alertCopy(list, posts, summary.hidden);
      for (const m of members) {
        await prisma.notification.create({
          data: {
            organizationId: orgId,
            userId: m.userId,
            type: "comment.new",
            title,
            body,
            link: "/dashboard/comments?view=unanswered",
            metadata: { newComments: list.length, posts, hidden: summary.hidden },
          },
        });
      }
      summary.alerted = members.length > 0;
    } catch (err: any) {
      log.warn(`[CommentSweep] alert failed for org ${orgId}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }

  const external = await sweepExternalSources(deps, automations, summaries, now, log);
  await scoreSentimentForRun(deps, automations, summaries, log);
  await finishOrgs(prisma, automations, summaries, now, log);
  const totals = Object.values(summaries).reduce(
    (t, s) => ({ posts: t.posts + s.postsChecked, hidden: t.hidden + s.hidden, fresh: t.fresh + s.newComments, errors: t.errors + s.errors }),
    { posts: 0, hidden: 0, fresh: 0, errors: 0 }
  );
  log.log(
    `[CommentSweep] orgs=${automations.length} posts=${totals.posts}/${candidates.length} hidden=${totals.hidden} new=${totals.fresh} errors=${totals.errors}${external.YOUTUBE ? ` yt=${external.YOUTUBE}` : ""}${external.LINKEDIN ? ` li=${external.LINKEDIN}` : ""}${external.TWITTER ? ` x=${external.TWITTER}` : ""}${fbPaused ? " fb=paused" : ""}`
  );
  return summaries;
}

/** Store the comments not seen before for sentiment scoring; never throws. */
async function storeSentimentRows(
  prisma: any,
  target: { id: string; organizationId: string },
  channelId: string,
  platform: string,
  found: StoredCommentInput[],
  summary: OrgRunSummary,
  log: Pick<Console, "warn">
): Promise<void> {
  if (found.length === 0) return;
  try {
    const existing: any[] = await prisma.commentSentiment.findMany({
      where: { organizationId: target.organizationId, commentId: { in: found.map((f) => f.commentId) } },
      select: { commentId: true },
    });
    const known = new Set(existing.map((e) => e.commentId));
    const fresh = found.filter((f) => !known.has(f.commentId));
    if (fresh.length === 0) return;
    await prisma.commentSentiment.createMany({
      data: fresh.map((f) => ({ organizationId: target.organizationId, postTargetId: target.id, channelId, platform, ...f })),
      skipDuplicates: true,
    });
    summary.sentimentStored = (summary.sentimentStored ?? 0) + fresh.length;
  } catch (err: any) {
    log.warn(`[CommentSweep] sentiment store failed for target ${target.id}: ${String(err?.message ?? err).slice(0, 160)}`);
  }
}

// ── Sentiment-only sources (YouTube, LinkedIn Pages) ──────────────────────

/** What reading one post's comments came to. */
export type ExternalRead =
  /** Comments read (possibly none); `cursor` = where the next read should start (kept on the post). */
  | { kind: "ok"; found: StoredCommentInput[]; cursor?: string | null }
  /** Comments off / post gone — the post's state, not an error. The post rotates. */
  | { kind: "postState" }
  /** Any other failure: counted; the post rotates. */
  | { kind: "failed"; detail: string }
  /** The token was refused: counted; the channel is skipped this run, the post not stamped. */
  | { kind: "tokenRefused" }
  /** The token lacks the read permission: counted; the channel is parked for 24h. */
  | { kind: "scopeMissing" }
  /** The platform throttled us: stop this source for the run. */
  | { kind: "rateLimited" }
  /** The platform's daily quota is spent (or the app has no access): stop this source until its quota day turns. */
  | { kind: "quotaExhausted"; detail?: string }
  /** Our own daily cap said no (or its counter is unavailable): stop this source. */
  | { kind: "budget" };

type ExternalPlatform = "YOUTUBE" | "LINKEDIN" | "TWITTER";

interface ExternalSource {
  platform: ExternalPlatform;
  tag: string;
  cfg: ExternalSentimentConfig;
  /** Extra channel filter (beyond workspace, live, active and the account scope). */
  channelWhere: Record<string, unknown>;
  isPostId: (id: string) => boolean;
  /** The platform's quota day, for quotaExhausted. */
  quotaDay: (now: Date) => string;
  /** Second line behind `channelWhere`, on the loaded channel (default: any of this platform). */
  accepts?: (channel: any) => boolean;
  /** A pre-check from what the channel recorded at connect time; "scopeMissing" spends nothing. */
  precheck?: (channel: any) => "ok" | "scopeMissing";
  /** `cursor`: what the last read of this post left (see ExternalRead "ok"). */
  read: (channel: any, postId: string, cursor: string | null) => Promise<ExternalRead>;
  summaryKey: "youtubeVideosChecked" | "linkedinPostsChecked" | "twitterPostsChecked";
}

/** Platform → quota day on which its quota ran out. */
const quotaExhaustedOn = new Map<ExternalPlatform, string>();

/**
 * Channels whose token lacks the read permission (a YouTube channel connected
 * before youtube.readonly was requested, a LinkedIn Page without
 * r_organization_social or no longer administered) → epoch ms to try again.
 * Reconnecting fixes it; until then they would spend a call on every run.
 */
const scopeMissingUntil = new Map<string, number>();
const SCOPE_MISSING_PAUSE_MS = 24 * 60 * 60 * 1000;

/** Test seam. */
export function __resetExternalSweepState(): void {
  quotaExhaustedOn.clear();
  scopeMissingUntil.clear();
}

/** A commentThreads.list response → what it means. Pure. */
export function classifyYouTubeRead(res: { status: number; body: unknown }, ownChannelId: string | null): ExternalRead {
  const reason = (res.body as any)?.error?.errors?.[0]?.reason;
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") return { kind: "quotaExhausted" };
  if (isQuotaError(res.body)) return { kind: "rateLimited" };
  if (res.status === 401) return { kind: "tokenRefused" };
  if (res.status === 403 && (reason === "insufficientPermissions" || /insufficient/i.test(JSON.stringify((res.body as any)?.error?.message ?? "")))) {
    return { kind: "scopeMissing" };
  }
  if (res.status >= 200 && res.status < 300) return { kind: "ok", found: youtubeSentimentCandidates(res.body, ownChannelId) };
  if (isPerVideoCommentError(res.body)) return { kind: "postState" };
  return { kind: "failed", detail: `HTTP ${res.status} ${JSON.stringify(reason ?? null)}` };
}

/** A socialActions/{post}/comments response → what it means (`found` left empty). Pure. */
export function classifyLinkedInRead(res: { status: number; body: unknown }): ExternalRead {
  const body = res.body as any;
  if (res.status === 429) {
    // "Resource level throttle APPLICATION DAY limit … is reached" = the day is spent.
    return /\bDAY\b/.test(String(body?.message ?? "")) ? { kind: "quotaExhausted" } : { kind: "rateLimited" };
  }
  if (res.status === 401) return { kind: "tokenRefused" };
  // ACCESS_DENIED: the token lacks r_organization_social, or its member no longer administers the Page.
  if (res.status === 403) return { kind: "scopeMissing" };
  if (res.status === 404 || res.status === 410) return { kind: "postState" };
  if (res.status >= 200 && res.status < 300) return { kind: "ok", found: [] };
  return { kind: "failed", detail: `HTTP ${res.status} ${JSON.stringify(body?.code ?? body?.serviceErrorCode ?? null)}` };
}

function youtubeSource(deps: SweepDeps): ExternalSource | null {
  const readComments = deps.readYouTubeComments;
  const reserve = deps.reserveYouTubeUnits;
  if (!readComments || !reserve) return null;
  return {
    platform: "YOUTUBE",
    tag: "YouTube",
    cfg: deps.youtubeConfig ?? readYouTubeSentimentConfig(),
    channelWhere: { platform: "YOUTUBE" },
    isPostId: (id) => YOUTUBE_VIDEO_ID.test(id),
    quotaDay,
    summaryKey: "youtubeVideosChecked",
    read: async (channel, videoId) => {
      if (!(await reserve(YT_UNITS.commentThreads))) return { kind: "budget" };
      const res = await readComments(channel.accessToken, videoId);
      return classifyYouTubeRead(res, typeof channel.platformId === "string" ? channel.platformId : null);
    },
  };
}

/** The Page's organization URN from its channel ("org-123" / metadata.orgId). */
export function linkedinOrgUrn(channel: { platformId?: unknown; metadata?: unknown }): string | null {
  const fromMeta = (channel.metadata as any)?.orgId;
  const id = typeof fromMeta === "string" || typeof fromMeta === "number" ? String(fromMeta) : String(channel.platformId ?? "").replace(/^org-/, "");
  return /^\d+$/.test(id) ? `urn:li:organization:${id}` : null;
}

function linkedinSource(deps: SweepDeps): ExternalSource | null {
  const readPage = deps.readLinkedInComments;
  const reserve = deps.reserveLinkedInCalls;
  if (!readPage || !reserve) return null;
  return {
    platform: "LINKEDIN",
    tag: "LinkedIn",
    cfg: deps.linkedinConfig ?? readLinkedInSentimentConfig(),
    // Pages only — LinkedIn doesn't let apps read comments on personal profiles' posts.
    channelWhere: { platform: "LINKEDIN", platformId: { startsWith: "org-" } },
    isPostId: (id) => LINKEDIN_POST_URN.test(id),
    // LinkedIn's API limits reset at midnight UTC.
    quotaDay: (now) => now.toISOString().slice(0, 10),
    summaryKey: "linkedinPostsChecked",
    accepts: (channel) => String(channel.platformId ?? "").startsWith("org-") && linkedinOrgUrn(channel) !== null,
    precheck: (channel) =>
      Array.isArray(channel.scopes) && channel.scopes.length > 0 && !channel.scopes.includes("r_organization_social")
        ? "scopeMissing"
        : "ok",
    read: async (channel, postUrn) => {
      const orgUrn = linkedinOrgUrn(channel);
      if (!(await reserve(1))) return { kind: "budget" };
      const first = await readPage(channel.accessToken, postUrn, 0, LINKEDIN_COMMENTS_PAGE);
      const firstRead = classifyLinkedInRead(first);
      if (firstRead.kind !== "ok") return firstRead;
      const found = linkedinSentimentCandidates(first.body, orgUrn);
      // Order-agnostic: with more than one page, also read the LAST page, so
      // the newest comments are covered whichever end LinkedIn returns first.
      const total = Number((first.body as any)?.paging?.total);
      if (Number.isFinite(total) && total > LINKEDIN_COMMENTS_PAGE && (await reserve(1))) {
        const last = await readPage(channel.accessToken, postUrn, Math.max(0, total - LINKEDIN_COMMENTS_PAGE), LINKEDIN_COMMENTS_PAGE);
        if (classifyLinkedInRead(last).kind === "ok") {
          const seen = new Set(found.map((f) => f.commentId));
          for (const f of linkedinSentimentCandidates(last.body, orgUrn)) if (!seen.has(f.commentId)) found.push(f);
        }
      }
      return { kind: "ok", found };
    },
  };
}

/** A recent-search response → what it means (`found` left empty). Pure. */
export function classifyTwitterRead(res: { status: number; body: unknown }): ExternalRead {
  const body = res.body as any;
  const what = `${body?.title ?? ""} ${body?.reason ?? ""} ${body?.type ?? ""} ${body?.detail ?? ""}`;
  // 402 = no credits left on a pay-per-use account; UsageCapExceeded = a
  // plan's monthly cap. Either way nothing will work until someone tops up.
  if (res.status === 402 || /UsageCapExceeded|CreditsDepleted/i.test(what)) {
    return { kind: "quotaExhausted", detail: "X API credits or usage cap exhausted" };
  }
  if (res.status === 429) return { kind: "rateLimited" };
  if (res.status === 401) return { kind: "tokenRefused" };
  // The app (not one account) isn't allowed this endpoint — stop X for the day.
  if (res.status === 403 && /client-not-enrolled|client-forbidden/i.test(what)) {
    return { kind: "quotaExhausted", detail: "the X app has no access to recent search" };
  }
  if (res.status === 403) return { kind: "scopeMissing" };
  if (res.status >= 200 && res.status < 300) return { kind: "ok", found: [] };
  return { kind: "failed", detail: `HTTP ${res.status} ${JSON.stringify(body?.title ?? null)}` };
}

function twitterSource(deps: SweepDeps): ExternalSource | null {
  const readReplies = deps.readTwitterReplies;
  const reserve = deps.reserveTwitterReads;
  const refund = deps.refundTwitterReads;
  if (!readReplies || !reserve || !refund) return null;
  return {
    platform: "TWITTER",
    tag: "X",
    cfg: deps.twitterConfig ?? readTwitterSentimentConfig(),
    channelWhere: { platform: "TWITTER" },
    isPostId: (id) => TWEET_ID.test(id),
    quotaDay: (now) => now.toISOString().slice(0, 10),
    summaryKey: "twitterPostsChecked",
    read: async (channel, tweetId, cursor) => {
      // Reserve the most this read can be billed for; give back the unused part.
      // A request counts as at least 1 so empty polls are budgeted too.
      if (!(await reserve(TWITTER_REPLIES_PAGE))) return { kind: "budget" };
      let used = 1;
      try {
        const res = await readReplies(
          { accessToken: channel.accessToken, tokenSecret: channel.refreshToken ?? "" },
          tweetId,
          { sinceId: cursor && TWEET_ID.test(cursor) ? cursor : null, maxResults: TWITTER_REPLIES_PAGE }
        );
        const read = classifyTwitterRead(res);
        if (read.kind !== "ok") return read;
        const count = Number((res.body as any)?.meta?.result_count);
        used = Math.max(1, Number.isFinite(count) ? Math.min(count, TWITTER_REPLIES_PAGE) : TWITTER_REPLIES_PAGE);
        const newest = (res.body as any)?.meta?.newest_id;
        return {
          kind: "ok",
          found: twitterSentimentCandidates(res.body, typeof channel.platformId === "string" ? channel.platformId : null, tweetId),
          cursor: typeof newest === "string" && TWEET_ID.test(newest) ? newest : cursor,
        };
      } finally {
        await refund(TWITTER_REPLIES_PAGE - used).catch(() => {});
      }
    },
  };
}

/** Run every configured sentiment-only source; returns posts read per platform. Never throws. */
async function sweepExternalSources(
  deps: SweepDeps,
  automations: any[],
  summaries: Record<string, OrgRunSummary>,
  now: Date,
  log: Pick<Console, "log" | "warn">
): Promise<Partial<Record<ExternalPlatform, number>>> {
  const out: Partial<Record<ExternalPlatform, number>> = {};
  for (const source of [youtubeSource(deps), linkedinSource(deps), twitterSource(deps)]) {
    if (source) out[source.platform] = await sweepExternalSentiment(source, deps.prisma, automations, summaries, now, log);
  }
  return out;
}

/**
 * Read the newest comments on the sentiment workspaces' recent app-published
 * posts on one source's platform, and store them for scoring. Returns how
 * many posts were read; never throws.
 */
async function sweepExternalSentiment(
  source: ExternalSource,
  prisma: any,
  automations: any[],
  summaries: Record<string, OrgRunSummary>,
  now: Date,
  log: Pick<Console, "log" | "warn">
): Promise<number> {
  const orgs = automations.filter((a) => a.sentimentEnabled);
  const { cfg, tag } = source;
  if (orgs.length === 0 || cfg.dailyUnits <= 0) return 0;
  if (quotaExhaustedOn.get(source.platform) === source.quotaDay(now)) return 0;
  let checked = 0;
  try {
    const since = new Date(now.getTime() - cfg.lookbackDays * 24 * 60 * 60 * 1000);
    const dueBefore = now.getTime() - cfg.minIntervalMs;
    const candidates: Array<SweepCandidate & { publishedId: string; cursor: string | null }> = [];
    for (const a of orgs) {
      const rows: any[] = await prisma.postTarget.findMany({
        where: {
          post: { organizationId: a.organizationId },
          status: "PUBLISHED",
          publishedId: { not: null },
          publishedAt: { gte: since },
          channel: {
            organizationId: a.organizationId,
            disconnectedAt: null,
            isActive: true,
            ...source.channelWhere,
            ...(a.channelIds?.length ? { id: { in: a.channelIds } } : {}),
          },
        },
        orderBy: [{ publishedAt: "desc" }],
        take: 200,
        select: { id: true, channelId: true, publishedId: true, publishedAt: true, metadata: true },
      });
      for (const r of rows) {
        if (!source.isPostId(r.publishedId ?? "")) continue;
        const { checkedAt, cursor } = readCheckedAt(r.metadata);
        if (checkedAt !== null && checkedAt > dueBefore) continue;
        candidates.push({
          id: r.id,
          organizationId: a.organizationId,
          channelId: r.channelId,
          publishedAt: r.publishedAt,
          publishedId: r.publishedId,
          checkedAt,
          cursor,
        });
      }
    }
    const planned = planSweepTargets(candidates, { maxPostsPerRun: cfg.maxPostsPerRun, maxPostsPerOrg: cfg.maxPostsPerRun });
    if (planned.length === 0) return 0;

    // ⚠️ DIRECT channel.findMany — the only read shape that decrypts accessToken.
    const channels: any[] = await prisma.channel.findMany({
      where: { id: { in: [...new Set(planned.map((p) => p.channelId))] }, disconnectedAt: null },
    });
    const channelById = new Map<string, any>(channels.map((c) => [c.id, c]));
    const unusable = new Set<string>();

    for (const target of planned) {
      const summary = summaries[target.organizationId]!;
      const channel = channelById.get(target.channelId);
      if (!channel || channel.organizationId !== target.organizationId || channel.platform !== source.platform) continue;
      if (source.accepts && !source.accepts(channel)) continue;
      if (unusable.has(channel.id)) continue;
      if ((scopeMissingUntil.get(channel.id) ?? 0) > now.getTime()) continue;
      const expiresAt = channel.tokenExpiresAt ? new Date(channel.tokenExpiresAt).getTime() : null;
      if (!channel.accessToken || (expiresAt !== null && expiresAt <= now.getTime())) {
        // The token-refresh cron renews it (or the channel needs reconnecting); spend nothing on a certain 401.
        unusable.add(channel.id);
        log.warn(`[CommentSweep:${tag}] token for channel ${channel.id} is missing or expired — skipping its posts this run`);
        continue;
      }
      if (source.precheck?.(channel) === "scopeMissing") {
        unusable.add(channel.id);
        log.warn(`[CommentSweep:${tag}] channel ${channel.id} wasn't granted read access to comments — reconnect it`);
        continue;
      }

      let read: ExternalRead;
      try {
        read = await source.read(channel, target.publishedId, target.cursor);
      } catch (err: any) {
        summary.errors++;
        log.warn(`[CommentSweep:${tag}] read failed for target ${target.id}: ${String(err?.message ?? err).slice(0, 160)}`);
        continue;
      }
      if (read.kind === "budget") {
        log.warn(`[CommentSweep:${tag}] daily cap (${cfg.dailyUnits}) reached or the counter is unavailable — stopping`);
        break;
      }
      if (read.kind === "quotaExhausted") {
        quotaExhaustedOn.set(source.platform, source.quotaDay(now));
        log.warn(`[CommentSweep:${tag}] ${read.detail ?? "the platform reports today's API quota is used up"} — stopping for the day`);
        break;
      }
      if (read.kind === "rateLimited") {
        log.warn(`[CommentSweep:${tag}] rate limited — stopping for this run`);
        break;
      }
      if (read.kind === "tokenRefused") {
        summary.errors++;
        unusable.add(channel.id);
        log.warn(`[CommentSweep:${tag}] token for channel ${channel.id} was refused — skipping its posts this run`);
        continue;
      }
      if (read.kind === "scopeMissing") {
        summary.errors++;
        unusable.add(channel.id);
        scopeMissingUntil.set(channel.id, now.getTime() + SCOPE_MISSING_PAUSE_MS);
        log.warn(`[CommentSweep:${tag}] channel ${channel.id} isn't allowed to read comments — reconnect it; paused for 24h`);
        continue;
      }

      checked++;
      summary[source.summaryKey] = (summary[source.summaryKey] ?? 0) + 1;
      if (read.kind === "ok") {
        await storeSentimentRows(prisma, target, channel.id, source.platform, read.found, summary, log);
      } else if (read.kind === "failed") {
        summary.errors++;
        log.warn(`[CommentSweep:${tag}] comments failed for target ${target.id}: ${read.detail}`);
      }

      // The cursor survives every outcome: a failed read must not make the next one start over (and pay again).
      const cursor = read.kind === "ok" && read.cursor !== undefined ? read.cursor : target.cursor;
      const patch = JSON.stringify({ commentSweep: { checkedAt: now.getTime(), ...(cursor ? { cursor } : {}) } });
      try {
        await prisma.$executeRaw`UPDATE "PostTarget" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${target.id}`;
      } catch (err: any) {
        log.warn(`[CommentSweep:${tag}] checkedAt write failed for ${target.id}: ${String(err?.message ?? err).slice(0, 160)}`);
      }
    }
  } catch (err: any) {
    log.warn(`[CommentSweep:${tag}] pass failed: ${String(err?.message ?? err).slice(0, 160)}`);
  }
  return checked;
}

/** Score what the sentiment workspaces have pending; never throws. */
async function scoreSentimentForRun(
  deps: SweepDeps,
  automations: any[],
  summaries: Record<string, OrgRunSummary>,
  log: Pick<Console, "log" | "warn">
): Promise<void> {
  const orgIds = automations.filter((a) => a.sentimentEnabled).map((a) => a.organizationId as string);
  if (orgIds.length === 0 || !deps.scoreSentimentBatch) return;
  try {
    const results = await scorePendingCommentSentiment(
      { prisma: deps.prisma, scoreBatch: deps.scoreSentimentBatch, now: deps.now, log },
      orgIds,
      deps.sentimentConfig ?? readCommentSentimentConfig()
    );
    for (const [orgId, r] of Object.entries(results)) {
      const summary = summaries[orgId];
      if (!summary) continue;
      summary.sentimentScored = r.scored;
      summary.sentimentNegative = r.negative;
      summary.sentimentPending = r.pending;
    }
  } catch (err: any) {
    log.warn(`[CommentSweep] sentiment scoring failed: ${String(err?.message ?? err).slice(0, 160)}`);
  }
}

async function finishOrgs(
  prisma: any,
  automations: any[],
  summaries: Record<string, OrgRunSummary>,
  now: Date,
  log: Pick<Console, "warn">
): Promise<void> {
  for (const a of automations) {
    try {
      await prisma.commentAutomation.update({
        where: { id: a.id },
        data: { lastRunAt: now, lastRunSummary: summaries[a.organizationId] ?? null },
      });
    } catch (err: any) {
      log.warn(`[CommentSweep] summary write failed for org ${a.organizationId}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
}
