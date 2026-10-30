/**
 * Refresh a channel's OAuth token WITHOUT racing the other refreshers
 * (2026-10-28, TikTok work).
 *
 * Four places refresh tokens with no coordination: the 30-minute cron, the
 * publish worker's pre-publish check, its token_expired branch and the admin
 * button. The publish paths used the refresh token read at JOB START. TikTok
 * (and others) ROTATE the refresh token: if the cron refreshed in between, this
 * job's copy is already spent, the refresh fails `invalid_grant`, and the worker
 * reads that as a dead credential — "reconnect the channel". For TikTok a
 * reconnect needs a VPN from India.
 *
 * So, every time:
 *  1. Re-read the channel row. If someone else already produced a different,
 *     still-valid access token, use it — no refresh at all.
 *  2. Otherwise refresh with the FRESH refresh token.
 *  3. Persist only if the row did not change underneath us (optimistic lock on
 *     tokenExpiresAt — token columns are encrypted at rest, so they cannot be
 *     compared in a WHERE). If it did, re-read and use the winner's token.
 *
 * Pure orchestration over injected deps so it is unit-testable.
 */
import type { OAuthTokens } from "@postautomation/social";

export interface TokenRow {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
}

export interface ChannelTokenRefreshDeps {
  readRow(): Promise<TokenRow | null>;
  /** Persist new tokens only while tokenExpiresAt still equals `expected`; returns rows written. */
  writeIfUnchanged(expected: Date | null, data: { accessToken: string; refreshToken: string | null; tokenExpiresAt: Date | null }): Promise<number>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  now?(): number;
}

export type ChannelTokenRefreshResult =
  | { kind: "reused"; accessToken: string; refreshToken: string | null }
  | { kind: "refreshed"; accessToken: string; refreshToken: string | null }
  | { kind: "lost_race"; accessToken: string; refreshToken: string | null };

const STILL_VALID_MS = 5 * 60 * 1000;

/**
 * @param usedAccessToken the token this job has been using. A row holding a
 *   DIFFERENT, unexpired token means another refresher already won.
 * Throws whatever the provider's refresh throws (e.g. an invalid_grant message).
 */
export async function refreshChannelToken(usedAccessToken: string, deps: ChannelTokenRefreshDeps): Promise<ChannelTokenRefreshResult> {
  const now = deps.now ?? Date.now;
  const row = await deps.readRow();
  if (!row) throw new Error("Channel not found while refreshing its token.");

  const freshEnough = !!row.tokenExpiresAt && row.tokenExpiresAt.getTime() > now() + STILL_VALID_MS;
  if (row.accessToken && row.accessToken !== usedAccessToken && freshEnough) {
    return { kind: "reused", accessToken: row.accessToken, refreshToken: row.refreshToken };
  }
  if (!row.refreshToken) throw new Error("This channel has no refresh token — reconnect it.");

  let refreshed: OAuthTokens;
  try {
    refreshed = await deps.refresh(row.refreshToken);
  } catch (err) {
    // The race can also land BETWEEN our read and our refresh: another refresher
    // spent the same rotating refresh token first, so ours fails invalid_grant —
    // which the worker reads as a dead credential ("reconnect"). If the row now
    // holds a newer, still-valid token, that refresher won: use its token.
    const after = await deps.readRow().catch(() => null);
    const winnerFresh = !!after?.tokenExpiresAt && after.tokenExpiresAt.getTime() > now() + STILL_VALID_MS;
    if (after && after.accessToken && after.accessToken !== row.accessToken && after.accessToken !== usedAccessToken && winnerFresh) {
      return { kind: "reused", accessToken: after.accessToken, refreshToken: after.refreshToken };
    }
    throw err;
  }
  const data = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? row.refreshToken,
    tokenExpiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : row.tokenExpiresAt,
  };
  const written = await deps.writeIfUnchanged(row.tokenExpiresAt, data);
  if (written > 0) return { kind: "refreshed", accessToken: data.accessToken, refreshToken: data.refreshToken };

  // Someone else refreshed between our read and our write. Their tokens are in
  // the row now; ours are valid too (we still use the fresh access token for
  // THIS call) but the stored refresh token must be theirs.
  const winner = await deps.readRow();
  return {
    kind: "lost_race",
    accessToken: refreshed.accessToken,
    refreshToken: winner?.refreshToken ?? data.refreshToken,
  };
}

/**
 * Prisma-backed deps. Reads the token columns with a DIRECT channel read (that
 * is what decrypts them — a relation read returns ciphertext) and writes only
 * while the row is unchanged AND still connected: a disconnect replaces the
 * token with a placeholder and clears the refresh token but leaves
 * tokenExpiresAt alone, so without `disconnectedAt: null` an in-flight refresh
 * wrote live credentials back onto a channel the user had just disconnected.
 */
export function prismaChannelTokenRefreshDeps(
  db: {
    channel: {
      findUnique(args: {
        where: { id: string };
        select: { accessToken: true; refreshToken: true; tokenExpiresAt: true };
      }): Promise<TokenRow | null>;
      updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    };
  },
  channelId: string,
  refresh: ChannelTokenRefreshDeps["refresh"]
): ChannelTokenRefreshDeps {
  return {
    readRow: () =>
      db.channel.findUnique({
        where: { id: channelId },
        select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
      }),
    writeIfUnchanged: async (expected, data) =>
      (
        await db.channel.updateMany({
          where: { id: channelId, tokenExpiresAt: expected, disconnectedAt: null },
          data,
        })
      ).count,
    refresh,
  };
}
