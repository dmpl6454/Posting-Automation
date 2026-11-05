/**
 * Deleting a post PostAutomation published, from Facebook or Instagram
 * (2026-11-05). Pure: no fetch, no Prisma — every rule here is unit-tested.
 *
 * Graph endpoints (checked on developers.facebook.com, 2026-11-05):
 *  - Facebook: `DELETE /{post-id}` (or `/{video-id}` for a video publish) with
 *    the Page token. Needs `pages_manage_posts` — already approved for the live
 *    app — and a Page task that allows creating content.
 *  - Instagram: `DELETE /{ig-media-id}` with the Facebook USER token, added by
 *    Meta on 2025-12-03 ("Delete Instagram Media"). Needs `instagram_basic` +
 *    `instagram_manage_contents` (a NEW permission — App Review before ordinary
 *    users have it). Supports feed posts, reels, stories and whole carousels;
 *    NOT ads, and never a single item inside a carousel (subcode 2207073).
 *
 * Deleting is IDEMPOTENT, so unlike publishing a retry can never duplicate
 * anything: an unknown outcome (network, 5xx, throttle) is simply retried.
 */

export type PlatformDeletePlatform = "FACEBOOK" | "INSTAGRAM";

export const PLATFORM_DELETE_PLATFORMS: readonly PlatformDeletePlatform[] = ["FACEBOOK", "INSTAGRAM"];

export function isPlatformDeletePlatform(platform: unknown): platform is PlatformDeletePlatform {
  return PLATFORM_DELETE_PLATFORMS.includes(platform as PlatformDeletePlatform);
}

/** Scopes each platform's delete call needs. */
export const PLATFORM_DELETE_SCOPES: Record<PlatformDeletePlatform, readonly string[]> = {
  FACEBOOK: ["pages_manage_posts"],
  INSTAGRAM: ["instagram_basic", "instagram_manage_contents"],
};

export interface PlatformDeleteCapability {
  /** False when the channel has no recorded grant — nothing is guessed. */
  known: boolean;
  canDelete: boolean | null;
  missing: string[];
}

export function platformDeleteCapability(
  platform: PlatformDeletePlatform,
  grantedScopes: readonly string[] | null | undefined
): PlatformDeleteCapability {
  if (!Array.isArray(grantedScopes)) return { known: false, canDelete: null, missing: [] };
  const missing = PLATFORM_DELETE_SCOPES[platform].filter((s) => !grantedScopes.includes(s));
  return { known: true, canDelete: missing.length === 0, missing };
}

export type PlatformDeleteRefusal = "reconnect" | "permission" | "unsupported" | "other";

export type PlatformDeleteOutcome =
  | { kind: "deleted" }
  /** Meta answered "does not exist or cannot be loaded" — gone, or unreachable by this login. */
  | { kind: "not_found"; message: string }
  /** A definite refusal — retrying the same request will not change it. */
  | { kind: "refused"; reason: PlatformDeleteRefusal; message: string }
  /** Unknown or temporary (network, 5xx, throttle). Safe to repeat. */
  | { kind: "retry"; message: string };

/** Meta's throttle / temporary codes. Matched on the CODE, never on a substring. */
const RETRY_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);
const TOKEN_INVALID_CODES = new Set([190, 102, 463, 467]);
const IG_MEDIA_TYPE_NOT_SUPPORTED = 2207073;

function label(platform: PlatformDeletePlatform): string {
  return platform === "FACEBOOK" ? "Facebook" : "Instagram";
}

export function platformDeleteMissingScopeMessage(platform: PlatformDeletePlatform): string {
  return platform === "FACEBOOK"
    ? "PostAutomation doesn't have permission to delete posts on this Page. Reconnect the channel and keep \"Manage and publish content\" ticked; your Facebook role on the Page must allow creating content."
    : "Instagram hasn't given PostAutomation permission to delete posts on this account. Reconnect the channel and allow managing your content. (Until Meta approves this permission for the app, only app admins and testers can grant it.)";
}

export const PLATFORM_DELETE_RETRY_MESSAGE =
  "The platform didn't confirm the delete. Check the post on the platform, then try again if it is still there.";

/**
 * Turns one DELETE response into an outcome. `status` 0 = the request never
 * completed (network error / timeout). Never returns raw Graph JSON as text.
 */
export function classifyPlatformDeleteResponse(
  platform: PlatformDeletePlatform,
  status: number,
  body: unknown
): PlatformDeleteOutcome {
  const name = label(platform);
  if (status === 0) return { kind: "retry", message: PLATFORM_DELETE_RETRY_MESSAGE };

  const data = body && typeof body === "object" ? (body as Record<string, any>) : null;

  if (status >= 200 && status < 300) {
    // Facebook answers {"success":true}; Instagram {"success":true,"deleted_id":…}.
    if (data && data.success === false) {
      return { kind: "refused", reason: "other", message: `${name} didn't delete the post.` };
    }
    return { kind: "deleted" };
  }

  if (status >= 500) return { kind: "retry", message: PLATFORM_DELETE_RETRY_MESSAGE };

  const err = data?.error && typeof data.error === "object" ? (data.error as Record<string, any>) : null;
  if (!err) {
    // A proxy's HTML 429/502 page, or an unreadable body: unknown, and a repeat is safe.
    if (status === 429 || status === 408) return { kind: "retry", message: PLATFORM_DELETE_RETRY_MESSAGE };
    return { kind: "refused", reason: "other", message: `${name} refused to delete the post (HTTP ${status}).` };
  }

  const code = Number(err.code);
  const subcode = Number(err.error_subcode);
  const msg = String(err.message ?? "");

  if (RETRY_CODES.has(code) || err.is_transient === true || status === 429) {
    return { kind: "retry", message: PLATFORM_DELETE_RETRY_MESSAGE };
  }
  if (TOKEN_INVALID_CODES.has(code)) {
    return {
      kind: "refused",
      reason: "reconnect",
      message: `The ${name} login for this channel has expired. Reconnect the channel, then try again.`,
    };
  }
  if (subcode === IG_MEDIA_TYPE_NOT_SUPPORTED) {
    return {
      kind: "refused",
      reason: "unsupported",
      message: "Instagram doesn't allow deleting this kind of post through its API (for example an ad). Delete it in the Instagram app.",
    };
  }
  // #100/33 reads "does not exist, cannot be loaded due to missing permissions"
  // — Meta uses ONE code for both, so the message says both.
  if (code === 100 && subcode === 33) {
    return {
      kind: "not_found",
      message: `${name} says this post doesn't exist or this login can't reach it. It may already be deleted.`,
    };
  }
  if (code === 10 || (code >= 200 && code <= 299) || /permission/i.test(msg)) {
    return { kind: "refused", reason: "permission", message: platformDeleteMissingScopeMessage(platform) };
  }
  return {
    kind: "refused",
    reason: "other",
    message: `${name} refused to delete the post${Number.isFinite(code) ? ` (error ${code})` : ""}.`,
  };
}
