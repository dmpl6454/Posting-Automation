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
  type CommentSentimentConfig,
  type Sentiment,
} from "./comment-sentiment";

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
export function planSweepTargets<T extends SweepCandidate>(candidates: readonly T[], cfg: SweepConfig): T[] {
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
}

const NOT_A_STORY = [{ format: null }, { format: { not: "STORY" as const } }];

function readCheckedAt(metadata: unknown): { checkedAt: number | null; lastSeenAt: number | null } {
  const sweep = (metadata as any)?.commentSweep;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { checkedAt: num(sweep?.checkedAt), lastSeenAt: num(sweep?.lastSeenAt) };
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
      const found = sentimentCandidates(page.comments, platform);
      if (found.length > 0) {
        try {
          const existing: any[] = await prisma.commentSentiment.findMany({
            where: { organizationId: target.organizationId, commentId: { in: found.map((f) => f.commentId) } },
            select: { commentId: true },
          });
          const known = new Set(existing.map((e) => e.commentId));
          const fresh = found.filter((f) => !known.has(f.commentId));
          if (fresh.length > 0) {
            await prisma.commentSentiment.createMany({
              data: fresh.map((f) => ({
                organizationId: target.organizationId,
                postTargetId: target.id,
                channelId: channel.id,
                platform,
                ...f,
              })),
              skipDuplicates: true,
            });
            summary.sentimentStored = (summary.sentimentStored ?? 0) + fresh.length;
          }
        } catch (err: any) {
          log.warn(`[CommentSweep] sentiment store failed for target ${target.id}: ${String(err?.message ?? err).slice(0, 160)}`);
        }
      }
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

  await scoreSentimentForRun(deps, automations, summaries, log);
  await finishOrgs(prisma, automations, summaries, now, log);
  const totals = Object.values(summaries).reduce(
    (t, s) => ({ posts: t.posts + s.postsChecked, hidden: t.hidden + s.hidden, fresh: t.fresh + s.newComments, errors: t.errors + s.errors }),
    { posts: 0, hidden: 0, fresh: 0, errors: 0 }
  );
  log.log(
    `[CommentSweep] orgs=${automations.length} posts=${totals.posts}/${candidates.length} hidden=${totals.hidden} new=${totals.fresh} errors=${totals.errors}${fbPaused ? " fb=paused" : ""}`
  );
  return summaries;
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
