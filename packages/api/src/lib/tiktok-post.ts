import { z } from "zod";
// By FILE, not the package root: the contract module is dependency-free, and the
// root pulls in every provider.
import {
  TIKTOK_PRIVACY_LEVELS,
  TIKTOK_BY_CHANNEL_KEY,
  TIKTOK_CANNOT_POST_CODES,
  readTikTokSettingsForChannel,
  parseCreatorInfo,
  type TikTokCreatorInfo,
  type TikTokPostSettings,
} from "@postautomation/social/src/utils/tiktok-posting";

/**
 * Server-side rules for TikTok video posts (2026-10-28).
 *
 * TikTok's Content Sharing Guidelines require the USER to choose who can see a
 * post — there is no default — and each creator allows a different set of
 * options, so the choices are stored PER CHANNEL in
 * `Post.metadata.tiktokByChannel` (TIKTOK_BY_CHANNEL_KEY), written only from the
 * `tiktok` input of post.create / post.update. A raw client copy is stripped.
 *
 * A DRAFT may be saved without them; arming a post (scheduling, publishNow, bulk
 * schedule) requires them for every TikTok channel. The publish worker and the
 * provider check them again against fresh creator_info right before posting.
 */

/** A hostile payload must not be able to make the map large. */
export const TIKTOK_MAX_CHANNELS_PER_POST = 500;

export const tiktokSettingsInputSchema = z.object({
  // No default: the guidelines forbid one.
  privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS),
  // Every switch starts OFF — interactions are allowed only when the user opts in.
  allowComment: z.boolean().default(false),
  allowDuet: z.boolean().default(false),
  allowStitch: z.boolean().default(false),
  brandOrganic: z.boolean().default(false),
  brandContent: z.boolean().default(false),
  isAigc: z.boolean().default(false),
});

export const tiktokInputSchema = z.object({
  byChannel: z
    .record(z.string().min(1).max(64), tiktokSettingsInputSchema)
    .refine((m) => Object.keys(m).length <= TIKTOK_MAX_CHANNELS_PER_POST, {
      message: "Too many TikTok channels on one post.",
    }),
});
export type TikTokInput = z.infer<typeof tiktokInputSchema>;

type ChannelRef = { id: string; platform: string; name?: string | null };

export const TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE = "TikTok posts need exactly one video.";

/** Chat actions are unattended: an LLM must never pick a TikTok privacy level. */
export const TIKTOK_CHAT_REFUSAL_MESSAGE =
  "TikTok posts need their privacy settings chosen in Content Studio — schedule this one there.";

export const TIKTOK_RECONNECT_MESSAGE = "Reconnect this TikTok account, then try again.";
export const TIKTOK_UNREACHABLE_MESSAGE = "Couldn't reach TikTok — try again.";

export function tiktokSettingsMissingMessage(channelName: string): string {
  return `Choose who can see this post on ${channelName} (TikTok).`;
}

function channelLabel(c: ChannelRef): string {
  return (c.name ?? "").trim() || "your account";
}

function isOwn(obj: unknown, key: string): boolean {
  return !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/** A plain, fixed-shape copy — nothing the client sent beyond these fields survives. */
function copySettings(s: TikTokPostSettings): TikTokPostSettings {
  return {
    privacyLevel: s.privacyLevel,
    allowComment: s.allowComment === true,
    allowDuet: s.allowDuet === true,
    allowStitch: s.allowStitch === true,
    brandOrganic: s.brandOrganic === true,
    brandContent: s.brandContent === true,
    isAigc: s.isAigc === true,
  };
}

/**
 * The `tiktokByChannel` map to store for a post: the input's entries for TikTok
 * channels this post targets, nothing else. Undefined when nothing applies, so a
 * post without TikTok writes exactly the metadata it always did.
 */
export function buildTikTokByChannel(
  input: TikTokInput | undefined,
  channels: ChannelRef[]
): Record<string, TikTokPostSettings> | undefined {
  if (!input?.byChannel) return undefined;
  const out: Record<string, TikTokPostSettings> = {};
  for (const c of channels) {
    if (c.platform !== "TIKTOK" || !isOwn(input.byChannel, c.id)) continue;
    const s = readTikTokSettingsForChannel({ [TIKTOK_BY_CHANNEL_KEY]: input.byChannel }, c.id);
    if (s) out[c.id] = copySettings(s);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * post.update: the stored map, restricted to TikTok channels the post (still)
 * targets and to well-formed entries, with the input's choices laid over it.
 * A channel the post no longer targets loses its settings — re-adding it later
 * means choosing again, which is what the guidelines ask for.
 */
export function mergeTikTokByChannel(
  stored: unknown,
  input: TikTokInput | undefined,
  channels: ChannelRef[]
): Record<string, TikTokPostSettings> {
  const out: Record<string, TikTokPostSettings> = {};
  for (const c of channels) {
    if (c.platform !== "TIKTOK") continue;
    const s = readTikTokSettingsForChannel({ [TIKTOK_BY_CHANNEL_KEY]: stored }, c.id);
    if (s) out[c.id] = copySettings(s);
  }
  return { ...out, ...(buildTikTokByChannel(input, channels) ?? {}) };
}

/** The stored map, read off post metadata (or undefined). */
export function storedTikTokByChannel(postMetadata: unknown): unknown {
  return isOwn(postMetadata, TIKTOK_BY_CHANNEL_KEY)
    ? (postMetadata as Record<string, unknown>)[TIKTOK_BY_CHANNEL_KEY]
    : undefined;
}

export function hasTikTokChannel(channels: Array<{ platform: string }>): boolean {
  return channels.some((c) => c.platform === "TIKTOK");
}

/**
 * Returns an actionable message, or null when the post may go out.
 *
 * `scheduling` = the post will actually publish (create with a scheduledAt, an
 * update that leaves it scheduled, publishNow, bulk schedule). A DRAFT may be
 * saved without settings or media so the user can finish it later.
 *
 * `byChannel` is the stored/sanitized map; every entry is re-read defensively, so
 * a malformed one counts as "not chosen" rather than being trusted.
 */
export function validateTikTokPost(input: {
  channels: ChannelRef[];
  byChannel: unknown;
  media: Array<{ fileType: string | null | undefined }>;
  scheduling: boolean;
}): string | null {
  const tiktok = input.channels.filter((c) => c.platform === "TIKTOK");
  if (tiktok.length === 0 || !input.scheduling) return null;

  const settingsById = new Map<string, TikTokPostSettings>();
  for (const c of tiktok) {
    const s = readTikTokSettingsForChannel({ [TIKTOK_BY_CHANNEL_KEY]: input.byChannel }, c.id);
    if (!s) return tiktokSettingsMissingMessage(channelLabel(c));
    settingsById.set(c.id, s);
  }

  if (input.media.length !== 1 || !(input.media[0]?.fileType ?? "").startsWith("video/")) {
    return TIKTOK_EXACTLY_ONE_VIDEO_MESSAGE;
  }

  for (const c of tiktok) {
    const s = settingsById.get(c.id)!;
    if (s.brandContent && s.privacyLevel === "SELF_ONLY") {
      return (
        `Branded content can't be private on TikTok. Choose another visibility for ` +
        `${channelLabel(c)} (TikTok), or turn off Branded content.`
      );
    }
  }
  return null;
}

/* ─────────────────────────────── creator_info ─────────────────────────────── */

const CANNOT_POST_REASONS: Record<string, string> = {
  spam_risk_too_many_posts: "This TikTok account has reached TikTok's posting limit for now. Try again later.",
  spam_risk_user_banned_from_posting: "TikTok has stopped this account from posting right now. Check the account in the TikTok app.",
  reached_active_user_cap: "TikTok isn't accepting more posts from PostAutomation today. Try again tomorrow.",
  spam_risk_too_many_pending_share: "This TikTok account has too many posts waiting to finish. Try again once they're done.",
  spam_risk: "TikTok isn't accepting posts from this account right now. Try again later.",
};

/**
 * Fixed text for a creator who cannot post right now, or null when the code is
 * not one of those. Never TikTok's own message.
 */
export function tiktokCannotPostReason(code: string): string | null {
  if (Object.prototype.hasOwnProperty.call(CANNOT_POST_REASONS, code)) return CANNOT_POST_REASONS[code]!;
  if ((TIKTOK_CANNOT_POST_CODES as readonly string[]).includes(code) || code.startsWith("spam_risk")) {
    return CANNOT_POST_REASONS.spam_risk!;
  }
  return null;
}

export const TIKTOK_CREATOR_INFO_URL = "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const RECONNECT_CODES = new Set(["access_token_invalid", "scope_not_authorized"]);

export type TikTokCreatorInfoResult =
  | { kind: "ok"; creator: TikTokCreatorInfo }
  | { kind: "cannot_post"; code: string; creator: TikTokCreatorInfo | null }
  | { kind: "reconnect" }
  | { kind: "unreachable" };

/**
 * POST creator_info/query for one token. Classifies the answer; never returns or
 * throws TikTok's body (its `log_id` digits and messages must not reach a user or
 * the error classifiers).
 *
 * ⚠️ Success is `error.code === "ok"` — TikTok v2 ALWAYS includes an `error`
 * object, so "has an error field" is not a failure test.
 */
export async function queryTikTokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfoResult> {
  let res: Response;
  let body: { data?: unknown; error?: { code?: unknown } } | null;
  try {
    res = await fetch(TIKTOK_CREATOR_INFO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      signal: AbortSignal.timeout(15_000),
    });
    body = (await res.json().catch(() => null)) as typeof body;
  } catch {
    return { kind: "unreachable" };
  }
  const code = body && typeof body.error?.code === "string" ? body.error.code : "";
  if (RECONNECT_CODES.has(code)) return { kind: "reconnect" };
  if (code && code !== "ok" && tiktokCannotPostReason(code)) {
    return { kind: "cannot_post", code, creator: parseCreatorInfo(body?.data) };
  }
  if (res.ok && code === "ok") {
    const creator = parseCreatorInfo(body?.data);
    if (creator) return { kind: "ok", creator };
  }
  return { kind: "unreachable" };
}
