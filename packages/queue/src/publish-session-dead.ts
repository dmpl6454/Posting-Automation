import { createHash } from "node:crypto";

/**
 * Dead Meta session on a channel (owner decision 2026-11-10).
 *
 * When Meta answers a publish with error 190 (subcode 460 "session has been
 * invalidated", or another definite credential failure) and no refresh can
 * fix it, the token can never work again until the user reconnects. Before
 * this, every LATER post to that channel still called Meta, failed the same
 * way, and only said "Token expired and refresh failed" in the target row.
 *
 * The publish worker now records the failure on the channel:
 *   Channel.metadata.publishSessionDead = { at, fingerprint, platform, reason }
 * and every later publish to that channel fails at once, before any platform
 * call, with a reconnect message. The Channels page and Compose show
 * "Reconnect to post".
 *
 * The record names the TOKEN it was observed on (a sha256 fingerprint, never
 * the token). A reconnect stores a new token, so the fingerprint stops matching
 * and the record is ignored — even if a slow job writes it after the reconnect.
 * (The OAuth callback also replaces metadata wholesale, which drops it.)
 *
 * Lives in packages/queue because both containers read it: the worker writes
 * and enforces, the web container shows the badge.
 */

export const PUBLISH_SESSION_DEAD_KEY = "publishSessionDead";

export const DEAD_SESSION_PLATFORMS: ReadonlySet<string> = new Set(["FACEBOOK", "INSTAGRAM"]);

export interface PublishSessionDeadRecord {
  at: string;
  fingerprint: string;
  platform: string;
  reason: string;
}

/** Stable, non-reversible id of a token. */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24);
}

export function buildPublishSessionDeadRecord(
  token: string,
  platform: string,
  reason: string,
  now: Date = new Date()
): PublishSessionDeadRecord {
  return {
    at: now.toISOString(),
    fingerprint: tokenFingerprint(token),
    platform,
    // Never the raw provider body: keep it short and free of tokens.
    reason: reason.replace(/access_token=[^&\s"']+/gi, "access_token=[Filtered]").slice(0, 300),
  };
}

/**
 * The record, only when it applies to the token the channel holds NOW.
 * Anything malformed, for another platform, or for an older token ⇒ null.
 */
export function readPublishSessionDead(
  metadata: unknown,
  currentToken: string | null | undefined,
  platform: string
): PublishSessionDeadRecord | null {
  if (!DEAD_SESSION_PLATFORMS.has(platform)) return null;
  if (!currentToken) return null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const rec = (metadata as Record<string, unknown>)[PUBLISH_SESSION_DEAD_KEY];
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.fingerprint !== "string" || typeof r.at !== "string") return null;
  if (r.fingerprint !== tokenFingerprint(currentToken)) return null;
  return {
    at: r.at,
    fingerprint: r.fingerprint,
    platform: typeof r.platform === "string" ? r.platform : platform,
    reason: typeof r.reason === "string" ? r.reason : "",
  };
}

export function deadSessionPublishMessage(platform: string): string {
  const label = platform === "INSTAGRAM" ? "Instagram" : platform === "FACEBOOK" ? "Facebook" : platform;
  return `${label} ended this channel's session (usually a password change or a security check), so nothing was posted. Reconnect the channel on the Channels page, then use Retry.`;
}
