import { prisma as defaultPrisma } from "@postautomation/db";
import { ensurePageSubscribed, type PageSubscriptionResult } from "@postautomation/social";

/**
 * After a Facebook or Instagram connect, subscribe our Meta app to each granted
 * Page (2026-10-17) so Instagram `mentions` webhooks can arrive. See
 * meta-page-subscription.ts for the Graph contract.
 *
 * - Skipped when the consent's recorded grant is KNOWN and lacks
 *   `pages_manage_metadata` (every call would be refused). Unknown grant ⇒ try.
 * - One attempt per distinct Page, 3 at a time; the Page token lives in memory
 *   only.
 * - The outcome is written to each channel's `metadata.pageSubscription` with an
 *   atomic jsonb MERGE (the worker writes insightsHealth into the same column).
 * - NEVER throws. Callers fire and forget: the channels are already saved.
 *
 * NOTE for web callers: import via
 * `@postautomation/api/src/lib/page-subscriptions` (same bridge as
 * fb-webhook-analytics.ts).
 */

export interface PageToSubscribe {
  pageId: string;
  pageAccessToken: string | undefined;
  /** The channel rows (FB Page or linked IG account) that depend on this Page. */
  channelIds: string[];
}

interface PlannedSubscription {
  pageId: string;
  pageAccessToken: string;
  channelIds: string[];
}

const CONCURRENCY = 3;

export function pageSubscriptionWanted(grantedScopes: unknown): boolean {
  if (!Array.isArray(grantedScopes)) return true; // unknown ⇒ try
  return grantedScopes.includes("pages_manage_metadata");
}

/** Merge entries for the same Page and drop ones with no token. */
export function planPageSubscriptions(items: PageToSubscribe[]): PlannedSubscription[] {
  const byPage = new Map<string, PlannedSubscription>();
  for (const it of items) {
    if (!it.pageId || !it.pageAccessToken) continue;
    const prev = byPage.get(it.pageId);
    if (prev) prev.channelIds.push(...it.channelIds.filter((id) => !prev.channelIds.includes(id)));
    else byPage.set(it.pageId, { pageId: it.pageId, pageAccessToken: it.pageAccessToken, channelIds: [...it.channelIds] });
  }
  return [...byPage.values()];
}

export async function subscribeConnectedPages(
  items: PageToSubscribe[],
  appId: string,
  grantedScopes: unknown,
  deps: {
    prisma?: { $executeRaw: (...args: any[]) => Promise<unknown> };
    subscribe?: typeof ensurePageSubscribed;
    now?: () => Date;
  } = {}
): Promise<PageSubscriptionResult[]> {
  const results: PageSubscriptionResult[] = [];
  try {
    if (!appId || !pageSubscriptionWanted(grantedScopes)) return results;
    const prisma = deps.prisma ?? (defaultPrisma as any);
    const subscribe = deps.subscribe ?? ensurePageSubscribed;
    const queue = planPageSubscriptions(items);

    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const r = await subscribe({ pageId: next.pageId, pageAccessToken: next.pageAccessToken, appId });
        results.push(r);
        const patch = JSON.stringify({
          pageSubscription: {
            status: r.status,
            ...(r.reason ? { reason: r.reason } : {}),
            at: (deps.now?.() ?? new Date()).toISOString(),
          },
        });
        for (const channelId of next.channelIds) {
          try {
            await prisma.$executeRaw`UPDATE "Channel" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${channelId}`;
          } catch (err: any) {
            console.warn(`[page-subscription] could not record the outcome on ${channelId}: ${err?.message ?? err}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const count = (s: string) => results.filter((r) => r.status === s).length;
    console.info(
      `[page-subscription] app ${appId}: ${count("subscribed")} subscribed, ${count("already")} already, ` +
        `${count("missing_permission")} missing permission, ${count("failed")} failed`
    );
  } catch (err: any) {
    console.warn(`[page-subscription] run failed (non-fatal): ${err?.message ?? err}`);
  }
  return results;
}
