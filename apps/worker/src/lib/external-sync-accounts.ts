/**
 * Collapses Channel ROWS into the ACCOUNTS we actually call Meta for, and ranks the
 * candidate tokens within each account.
 *
 * Why this exists
 * ───────────────
 * The same Page / IG account legitimately exists in many organizations — `Channel` is
 * unique per `[organizationId, platform, platformId]`, and users connect the same Page
 * from several workspaces. Measured on prod 2026-08-06:
 *
 *     FACEBOOK   975 channel rows -> 409 distinct platformIds
 *     INSTAGRAM  364 channel rows -> 115 distinct platformIds
 *
 * Syncing per ROW would triple the Graph traffic for identical data. Syncing per
 * ACCOUNT and fanning the result out to every row is the single biggest optimization
 * available here, and it is what keeps this feature cheap under simultaneous user load.
 *
 * Token ranking
 * ─────────────
 * Rows for one account hold DIFFERENT tokens (measured: 375/375 multi-row FB accounts had
 * distinct tokens, connected a mean of ~134 days apart), and they do not fail together in
 * any predictable way — so which row we pick decides whether the account is reachable at
 * all. We try the likeliest-healthy row first and fall back to siblings.
 *
 * ⚠️ Calibration, so nobody over-invests here: sibling failover is a ~0-5% edge case, NOT
 * a coverage strategy. Meta error 190/460 ("the user changed their password or Facebook
 * has changed the session") is a USER-level event, so a user's tokens usually die
 * together. An unbiased 30-Page sample measured 7/30 reachable with failover and 7/30
 * without — identical. Ranking still matters (19/20 succeeded on the FIRST ranked token in
 * a separate sample); failover just recovers the occasional same-Page-different-user case.
 * The only real fix for the other ~77% is the owner reconnecting.
 *
 * Pure + synchronous so it is unit-testable without Prisma.
 */

export interface ChannelRowLike {
  id: string;
  organizationId: string;
  platform: string;
  platformId: string;
  accessToken: string;
  metadata: unknown;
  updatedAt: Date;
}

export interface SyncAccount {
  platform: string;
  platformId: string;
  /** Candidate channel rows, best token first. Try in order, stop at the first success. */
  candidates: ChannelRowLike[];
  /** EVERY channel row for this account — the fan-out targets for the fetched posts. */
  allRows: ChannelRowLike[];
}

/** True when a stored verdict says this channel's token is known-broken. */
function isKnownBroken(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const h = (metadata as Record<string, unknown>).insightsHealth;
  if (!h || typeof h !== "object" || Array.isArray(h)) return false;
  return (h as Record<string, unknown>).status === "needs_reconnect";
}

/** Milliseconds until this channel's Meta data-access window closes; null when unknown. */
function dataAccessMsLeft(metadata: unknown, now: Date): number | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).dataAccessExpiresAt;
  if (typeof raw !== "string") return null;
  const when = Date.parse(raw);
  return Number.isNaN(when) ? null : when - now.getTime();
}

/**
 * Rank candidate rows for one account, best first:
 *   1. not known-broken            (a recorded needs_reconnect verdict is real evidence)
 *   2. data access not yet lapsed  (Meta's 90-day cliff kills reads while posting works)
 *   3. more data-access runway     (prefer the token that will keep working longest)
 *   4. most recently updated       (freshest consent)
 */
export function rankCandidates(rows: ChannelRowLike[], now: Date = new Date()): ChannelRowLike[] {
  return [...rows].sort((a, b) => {
    const brokenA = isKnownBroken(a.metadata) ? 1 : 0;
    const brokenB = isKnownBroken(b.metadata) ? 1 : 0;
    if (brokenA !== brokenB) return brokenA - brokenB;

    const leftA = dataAccessMsLeft(a.metadata, now);
    const leftB = dataAccessMsLeft(b.metadata, now);
    const lapsedA = leftA != null && leftA <= 0 ? 1 : 0;
    const lapsedB = leftB != null && leftB <= 0 ? 1 : 0;
    if (lapsedA !== lapsedB) return lapsedA - lapsedB;

    // Both live (or both unknown): prefer the longer remaining window. A known window
    // beats an unknown one, since "unknown" often means never stamped.
    if (leftA != null && leftB != null && leftA !== leftB) return leftB - leftA;
    if (leftA != null && leftB == null) return -1;
    if (leftB != null && leftA == null) return 1;

    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

/**
 * Group channel rows into accounts to sync. Rows are keyed by `platform:platformId`, so
 * one Graph call serves every org that connected the same account.
 */
export function groupIntoAccounts(
  rows: ChannelRowLike[],
  now: Date = new Date()
): SyncAccount[] {
  const byAccount = new Map<string, ChannelRowLike[]>();
  for (const row of rows) {
    if (!row.platformId) continue;
    const key = `${row.platform}:${row.platformId}`;
    const list = byAccount.get(key);
    if (list) list.push(row);
    else byAccount.set(key, [row]);
  }

  const accounts: SyncAccount[] = [];
  for (const [key, list] of byAccount) {
    const sep = key.indexOf(":");
    accounts.push({
      platform: key.slice(0, sep),
      platformId: key.slice(sep + 1),
      candidates: rankCandidates(list, now),
      allRows: list,
    });
  }
  return accounts;
}

/**
 * Deterministic shard selector, so a cron that can only afford N accounts per run still
 * covers every account over time instead of hammering the same prefix forever.
 *
 * Uses a stable hash of the account key rather than Math.random (which is unavailable in
 * some execution contexts here and would make runs unreproducible).
 */
export function selectShard<T extends { platform: string; platformId: string }>(
  accounts: T[],
  shardIndex: number,
  shardCount: number
): T[] {
  if (shardCount <= 1) return accounts;
  return accounts.filter((a) => {
    let h = 5381;
    const key = `${a.platform}:${a.platformId}`;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
    return h % shardCount === shardIndex;
  });
}
