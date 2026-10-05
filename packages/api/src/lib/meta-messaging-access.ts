import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  getSocialProvider,
  fetchMetaTokenWindow,
  resolveMetaCredentials,
  messagingCapabilities,
  messagingFailureOf,
  MESSAGING_PAGE_LINK_MISSING_MESSAGE,
  type FacebookProvider,
  type MessagingPlatform,
} from "@postautomation/social";

/**
 * Turning a connected channel into what Meta's messaging APIs need: a PAGE
 * access token and the ids the account appears under (2026-10-05).
 *
 *   Facebook   the channel's own token IS the Page token; platformId is the Page.
 *   Instagram  the channel stores the Facebook USER token. Messaging needs the
 *              token of the Facebook Page the Instagram account is linked to,
 *              looked up with that user token (one call when we remember the
 *              Page, a me/accounts walk otherwise).
 *
 * The Page token is cached in memory only (30 minutes, keyed by a hash of the
 * user token so a reconnect starts fresh) and NEVER written to the database.
 * The linked Page id IS remembered on the channel (`metadata.linkedPageId`,
 * atomic jsonb merge) so the next lookup is a single call.
 */

export interface MessagingChannel {
  id: string;
  platform: string;
  platformId: string;
  accessToken: string;
  metaAppId: string | null;
  metadata: Record<string, unknown> | null | undefined;
}

export interface MessagingAccess {
  platform: MessagingPlatform;
  channelId: string;
  /** The Page whose token we use (FB: the channel; IG: the linked Page). */
  pageId: string;
  pageToken: string;
  /** Private replies are sent AS this id (FB: the Page; IG: the IG account). */
  senderId: string;
  /** Every id the account itself appears under in a conversation. */
  ownIds: string[];
}

const PAGE_TOKEN_TTL_MS = 30 * 60 * 1000;
const PAGE_TOKEN_CACHE_MAX = 500;
const pageTokenCache = new Map<string, { pageId: string; pageToken: string; at: number }>();

function cacheKey(channelId: string, userToken: string): string {
  return `${channelId}:${createHash("sha256").update(userToken).digest("hex").slice(0, 16)}`;
}

/** Drop a cached Page token after Meta refused it (dead token / lost role). */
export function forgetMessagingAccess(channelId: string): void {
  for (const key of pageTokenCache.keys()) if (key.startsWith(`${channelId}:`)) pageTokenCache.delete(key);
}

/** For tests. */
export function __resetMessagingAccessCache(): void {
  pageTokenCache.clear();
}

export function isMessagingPlatform(p: unknown): p is MessagingPlatform {
  return p === "FACEBOOK" || p === "INSTAGRAM";
}

export async function resolveMessagingAccess(prisma: any, channel: MessagingChannel): Promise<MessagingAccess> {
  if (!isMessagingPlatform(channel.platform)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Messages are available for Facebook Pages and Instagram accounts only." });
  }
  if (channel.platform === "FACEBOOK") {
    return {
      platform: "FACEBOOK",
      channelId: channel.id,
      pageId: channel.platformId,
      pageToken: channel.accessToken,
      senderId: channel.platformId,
      ownIds: [channel.platformId],
    };
  }

  const meta = channel.metadata ?? {};
  const igUserId = (typeof meta.igUserId === "string" && meta.igUserId) || channel.platformId;
  const key = cacheKey(channel.id, channel.accessToken);
  const cached = pageTokenCache.get(key);
  if (cached && Date.now() - cached.at < PAGE_TOKEN_TTL_MS) {
    return {
      platform: "INSTAGRAM",
      channelId: channel.id,
      pageId: cached.pageId,
      pageToken: cached.pageToken,
      senderId: igUserId,
      ownIds: [igUserId, cached.pageId],
    };
  }

  const hint = typeof meta.linkedPageId === "string" ? meta.linkedPageId : null;
  let found: { pageId: string; pageToken: string } | null;
  try {
    found = await (getSocialProvider("FACEBOOK") as FacebookProvider).resolveInstagramPage(channel.accessToken, igUserId, hint);
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? MESSAGING_PAGE_LINK_MISSING_MESSAGE });
  }
  if (!found) throw new TRPCError({ code: "BAD_REQUEST", message: MESSAGING_PAGE_LINK_MISSING_MESSAGE });

  if (pageTokenCache.size >= PAGE_TOKEN_CACHE_MAX) {
    const oldest = pageTokenCache.keys().next().value;
    if (oldest !== undefined) pageTokenCache.delete(oldest);
  }
  pageTokenCache.set(key, { ...found, at: Date.now() });

  if (found.pageId !== hint) {
    try {
      const patch = JSON.stringify({ linkedPageId: found.pageId });
      await prisma.$executeRaw`UPDATE "Channel" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${channel.id}`;
    } catch (err: any) {
      console.error("[messaging] could not remember the linked Page:", err?.message ?? err);
    }
  }

  return {
    platform: "INSTAGRAM",
    channelId: channel.id,
    pageId: found.pageId,
    pageToken: found.pageToken,
    senderId: igUserId,
    ownIds: [igUserId, found.pageId],
  };
}

/** The scopes recorded at connect (or by a later check); null when never checked. */
export function cachedGrantedScopes(metadata: Record<string, unknown> | undefined | null): string[] | null {
  const raw = metadata?.grantedScopes;
  return Array.isArray(raw) && raw.every((s) => typeof s === "string") ? (raw as string[]) : null;
}

const GRANT_RECHECK_IF_MISSING_MS = 60 * 60 * 1000;
const GRANT_RECHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Re-read the grant when never read, when the inbox scopes look missing (hourly), or weekly. */
export function messagingGrantNeedsRefresh(
  platform: MessagingPlatform,
  metadata: Record<string, unknown> | undefined | null,
  now: number
): boolean {
  const scopes = cachedGrantedScopes(metadata);
  if (!scopes) return true;
  const raw = metadata?.grantedScopesCheckedAt;
  const checkedAt = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(checkedAt)) return true;
  const age = now - checkedAt;
  if (age > GRANT_RECHECK_MAX_AGE_MS) return true;
  return messagingCapabilities(platform, scopes).canUseInbox === false && age > GRANT_RECHECK_IF_MISSING_MS;
}

/**
 * Ask Meta which scopes the channel's token was GRANTED (one debug_token) and
 * remember it — atomic jsonb merge, never a whole-column write (the worker
 * writes insightsHealth into the same column). Only from a VALID token: a dead
 * token reports no scopes, which must not read as "granted nothing".
 * Best-effort; never throws.
 */
export async function refreshChannelGrant(prisma: any, channel: MessagingChannel): Promise<string[] | null> {
  try {
    if (!isMessagingPlatform(channel.platform)) return null;
    const creds = resolveMetaCredentials(channel.platform, channel.metaAppId);
    if (!creds) return null;
    const win = await fetchMetaTokenWindow(channel.accessToken, creds.clientId, creds.clientSecret);
    if (!win || !win.valid) return null;
    const patch = JSON.stringify({ grantedScopes: win.scopes, grantedScopesCheckedAt: new Date().toISOString() });
    await prisma.$executeRaw`UPDATE "Channel" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${channel.id}`;
    return win.scopes;
  } catch (err: any) {
    console.error("[messaging] granted-scope check failed:", err?.message ?? err);
    return null;
  }
}

/**
 * After a refused messaging call: forget a Page token Meta rejected, and say
 * whether the grant should be re-read.
 */
export function afterMessagingFailure(channelId: string, err: unknown): { refreshGrant: boolean } {
  const failure = messagingFailureOf(err);
  if (failure === "token" || failure === "permission" || failure === "page_link_missing") forgetMessagingAccess(channelId);
  return { refreshGrant: failure === "permission" };
}
