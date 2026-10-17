/**
 * Subscribe the Pages behind channels connected BEFORE automatic Page
 * subscription shipped (2026-10-17). New connects do this in the OAuth callback
 * (packages/api/src/lib/page-subscriptions.ts); this daily job catches up the rest
 * so Instagram `mentions` webhooks can arrive without asking everyone to reconnect.
 *
 * Budget discipline (the data-access backfill lessons):
 *   - FRESHEST FIRST — the oldest channels are the dead ones.
 *   - Skip, without a call, every channel that cannot succeed: dead token
 *     (insightsHealth needs_reconnect), a recorded grant without
 *     pages_manage_metadata, an unconfigured Meta app.
 *   - Dedupe: one subscription per (app, Page), however many workspaces hold it;
 *     one `me/accounts` listing per IG user token.
 *   - Hard caps per run; a failure cools down for a week; a success is re-checked
 *     monthly (a GET only — an existing subscription is never rewritten).
 *
 * Every outcome is merged into `Channel.metadata.pageSubscription`, the same key
 * the connect path writes. NEVER throws.
 */
import type { LinkedPage, PageSubscriptionResult } from "@postautomation/social";

export const BACKFILL_MAX_PAGES = 60;
export const BACKFILL_MAX_LISTINGS = 20;
export const RETRY_AFTER_FAILURE_MS = 7 * 24 * 60 * 60 * 1000;
export const RECHECK_AFTER_SUCCESS_MS = 30 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 3;

export interface BackfillChannel {
  id: string;
  platform: string;
  platformId: string;
  accessToken: string | null;
  metaAppId: string | null;
  metadata: unknown;
}

export interface BackfillDeps {
  /** Active, not disconnected FB/IG channels, freshest first. */
  channels: BackfillChannel[];
  /** The Meta app id that minted this channel's token, or null when unconfigured. */
  resolveAppId: (platform: string, metaAppId: string | null) => string | null;
  subscribe: (input: { pageId: string; pageAccessToken: string; appId: string }) => Promise<PageSubscriptionResult>;
  listLinkedPages: (userAccessToken: string) => Promise<{ ok: boolean; pages: LinkedPage[]; reason?: string }>;
  /** Merge `{ pageSubscription }` into the channel's metadata. */
  record: (channelId: string, outcome: { status: string; reason?: string; at: string }) => Promise<void>;
  now?: () => Date;
}

export interface BackfillSummary {
  considered: number;
  eligible: number;
  listings: number;
  subscribed: number;
  already: number;
  missingPermission: number;
  failed: number;
  deferred: number;
}

const metaOf = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};

/** Does this channel need a (re)attempt now? Pure. */
export function backfillWanted(channel: BackfillChannel, now: Date): boolean {
  const token = channel.accessToken;
  // "disconnected" = DISCONNECTED_TOKEN (@postautomation/db), literal here so this
  // module stays db-free for tests; "enc:" = a token that failed to decrypt.
  if (!token || token.startsWith("enc:") || token === "disconnected") return false;
  const md = metaOf(channel.metadata);
  if (md.insightsHealth?.status === "needs_reconnect") return false;
  if (Array.isArray(md.grantedScopes) && !md.grantedScopes.includes("pages_manage_metadata")) return false;
  const prev = md.pageSubscription;
  if (!prev || typeof prev !== "object") return true;
  const at = Date.parse(String(prev.at ?? ""));
  if (!Number.isFinite(at)) return true;
  const age = now.getTime() - at;
  if (prev.status === "subscribed" || prev.status === "already") return age >= RECHECK_AFTER_SUCCESS_MS;
  return age >= RETRY_AFTER_FAILURE_MS;
}

interface PageJob {
  appId: string;
  pageId: string;
  pageAccessToken: string;
  channelIds: string[];
}

export async function runPageSubscriptionBackfill(deps: BackfillDeps): Promise<BackfillSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: BackfillSummary = {
    considered: deps.channels.length,
    eligible: 0,
    listings: 0,
    subscribed: 0,
    already: 0,
    missingPermission: 0,
    failed: 0,
    deferred: 0,
  };
  const record = async (channelIds: string[], status: string, reason?: string) => {
    const outcome = { status, ...(reason ? { reason } : {}), at: now().toISOString() };
    for (const id of channelIds) {
      try {
        await deps.record(id, outcome);
      } catch (err: any) {
        console.warn(`[page-subscription-backfill] could not record ${id}: ${err?.message ?? err}`);
      }
    }
  };

  try {
    const SEP = "\u0000";
    const jobs = new Map<string, PageJob>();
    const addJob = (appId: string, pageId: string, pageAccessToken: string, channelId: string) => {
      const key = `${appId}${SEP}${pageId}`;
      const job = jobs.get(key);
      if (job) {
        if (!job.channelIds.includes(channelId)) job.channelIds.push(channelId);
      } else {
        jobs.set(key, { appId, pageId, pageAccessToken, channelIds: [channelId] });
      }
    };

    // IG channels grouped by (app, user token) → one listing each.
    const igGroups = new Map<string, { appId: string; token: string; channels: BackfillChannel[] }>();

    for (const c of deps.channels) {
      if (!backfillWanted(c, now())) continue;
      const appId = deps.resolveAppId(c.platform, c.metaAppId);
      if (!appId) continue;
      summary.eligible++;
      if (c.platform === "FACEBOOK") {
        const pageId = String(metaOf(c.metadata).pageId ?? c.platformId);
        addJob(appId, pageId, c.accessToken!, c.id);
      } else if (c.platform === "INSTAGRAM") {
        const key = `${appId}${SEP}${c.accessToken}`;
        const g = igGroups.get(key) ?? { appId, token: c.accessToken!, channels: [] };
        g.channels.push(c);
        igGroups.set(key, g);
      }
    }

    for (const g of igGroups.values()) {
      if (summary.listings >= BACKFILL_MAX_LISTINGS) {
        summary.deferred += g.channels.length;
        continue;
      }
      summary.listings++;
      const listed = await deps
        .listLinkedPages(g.token)
        .catch(() => ({ ok: false, pages: [] as LinkedPage[], reason: "request did not complete" }));
      if (!listed.ok) {
        summary.failed += g.channels.length;
        await record(g.channels.map((c) => c.id), "failed", `could not list Pages (${listed.reason ?? "unknown"})`);
        continue;
      }
      for (const c of g.channels) {
        const page = listed.pages.find((p) => p.igUserId === c.platformId);
        if (!page) {
          summary.failed++;
          await record([c.id], "failed", "linked Page not granted to this login");
          continue;
        }
        addJob(g.appId, page.pageId, page.pageAccessToken, c.id);
      }
    }

    const queue = [...jobs.values()];
    const work = queue.slice(0, BACKFILL_MAX_PAGES);
    for (const j of queue.slice(BACKFILL_MAX_PAGES)) summary.deferred += j.channelIds.length;

    const worker = async () => {
      for (let job = work.shift(); job; job = work.shift()) {
        let r: PageSubscriptionResult;
        try {
          r = await deps.subscribe({ pageId: job.pageId, pageAccessToken: job.pageAccessToken, appId: job.appId });
        } catch {
          r = { pageId: job.pageId, status: "failed", reason: "request did not complete" };
        }
        if (r.status === "subscribed") summary.subscribed++;
        else if (r.status === "already") summary.already++;
        else if (r.status === "missing_permission") summary.missingPermission++;
        else summary.failed++;
        await record(job.channelIds, r.status, r.reason);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (err: any) {
    console.warn(`[page-subscription-backfill] run failed (non-fatal): ${err?.message ?? err}`);
  }
  return summary;
}
