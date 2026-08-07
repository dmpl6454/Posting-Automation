/**
 * Collapses Channel ROWS into the ACCOUNTS we actually call Meta for.
 *
 * ⚠️ DELIBERATE DUPLICATE of `apps/worker/src/lib/external-sync-accounts.ts`.
 * Do NOT "deduplicate" this by importing the worker's copy — the worker is not a
 * dependency of @postautomation/api, and making it one would drag this package into
 * `docker/Dockerfile.worker`'s two-list requirement (CLAUDE.md quirk #10), which cannot
 * be validated from a working tree because `.dockerignore` is empty and a mistake
 * crash-loops the worker at boot, taking down ALL publishing. Same reasoning already
 * applied to `buildPublishReportCsv` and the CSV formula-injection guard.
 *
 * Keep the two in behavioural step; both are covered by their own tests.
 *
 * Why account-level grouping matters: the same Page/IG account legitimately exists in
 * many orgs (Channel is unique per [organizationId, platform, platformId]). Measured on
 * prod — 975 FB rows → 409 accounts, 364 IG rows → 115. Enqueuing per ROW would roughly
 * triple Graph traffic for identical data.
 */

export interface SyncChannelRow {
  id: string;
  platform: string;
  platformId: string;
  metadata: unknown;
  updatedAt: Date;
}

export interface SyncAccountGroup {
  platform: string;
  platformId: string;
  /** Candidate channel ids, best token FIRST. */
  candidateChannelIds: string[];
  /** EVERY channel id for this account — fan-out targets for the fetched posts. */
  targetChannelIds: string[];
}

function isKnownBroken(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const h = (metadata as Record<string, unknown>).insightsHealth;
  if (!h || typeof h !== "object" || Array.isArray(h)) return false;
  return (h as Record<string, unknown>).status === "needs_reconnect";
}

function dataAccessMsLeft(metadata: unknown, now: Date): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).dataAccessExpiresAt;
  if (typeof raw !== "string") return null;
  const when = Date.parse(raw);
  return Number.isNaN(when) ? null : when - now.getTime();
}

/**
 * Group channel rows into accounts, ranking candidate tokens best-first:
 *   1. not known-broken            (a recorded needs_reconnect verdict is real evidence)
 *   2. data access not yet lapsed  (Meta's 90-day cliff kills reads while posting works)
 *   3. more data-access runway
 *   4. most recently updated       (freshest consent)
 */
export function groupChannelsIntoAccounts(
  rows: SyncChannelRow[],
  now: Date = new Date()
): SyncAccountGroup[] {
  const byAccount = new Map<string, SyncChannelRow[]>();
  for (const row of rows) {
    if (!row.platformId) continue;
    const key = `${row.platform}:${row.platformId}`;
    const list = byAccount.get(key);
    if (list) list.push(row);
    else byAccount.set(key, [row]);
  }

  const out: SyncAccountGroup[] = [];
  for (const [key, list] of byAccount) {
    const ranked = [...list].sort((a, b) => {
      const brokenA = isKnownBroken(a.metadata) ? 1 : 0;
      const brokenB = isKnownBroken(b.metadata) ? 1 : 0;
      if (brokenA !== brokenB) return brokenA - brokenB;

      const leftA = dataAccessMsLeft(a.metadata, now);
      const leftB = dataAccessMsLeft(b.metadata, now);
      const lapsedA = leftA != null && leftA <= 0 ? 1 : 0;
      const lapsedB = leftB != null && leftB <= 0 ? 1 : 0;
      if (lapsedA !== lapsedB) return lapsedA - lapsedB;

      if (leftA != null && leftB != null && leftA !== leftB) return leftB - leftA;
      if (leftA != null && leftB == null) return -1;
      if (leftB != null && leftA == null) return 1;

      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    const sep = key.indexOf(":");
    out.push({
      platform: key.slice(0, sep),
      platformId: key.slice(sep + 1),
      candidateChannelIds: ranked.map((c) => c.id),
      targetChannelIds: list.map((c) => c.id),
    });
  }
  return out;
}
