/**
 * Pure helpers for Compose's TikTok posting card (2026-10-28). No React, no
 * tRPC — the submit gate, the post.create payload and the draft restore are
 * unit-tested here; TikTokPostSettings.tsx and ComposeTab only wire them up.
 *
 * TikTok's Content Sharing Guidelines (required for the audited app) drive
 * every default below: NO privacy default, every interaction OFF until the
 * user opts in, commercial disclosure OFF, and the creator's live
 * creator_info decides what can be chosen. The rules themselves live in the
 * shared contract (`validateTikTokSettings`), so Compose, the API and the
 * provider cannot disagree about them.
 *
 * ⚠️ Deep import only — the social package's index pulls server code.
 */
import {
  isTikTokPrivacyLevel,
  validateTikTokSettings,
  tiktokConsentText,
  TIKTOK_TITLE_MAX,
  type TikTokCreatorInfo,
  type TikTokPostSettings,
  type TikTokPrivacyLevel,
} from "@postautomation/social/src/utils/tiktok-posting";

/** What one TikTok channel's section of the card holds while composing. */
export interface TikTokDraft {
  /** null = the user has not chosen yet. TikTok forbids a default. */
  privacyLevel: TikTokPrivacyLevel | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** The "Disclose commercial content" toggle. The two brand flags count only while it is on. */
  discloseCommercial: boolean;
  /** "Your brand" */
  brandOrganic: boolean;
  /** "Branded content" */
  brandContent: boolean;
  /** AI-generated content label. */
  isAigc: boolean;
}

export function emptyTikTokDraft(): TikTokDraft {
  return {
    privacyLevel: null,
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    discloseCommercial: false,
    brandOrganic: false,
    brandContent: false,
    isAigc: false,
  };
}

/** One channel's live creator_info, as the card and the gate see it. */
export type TikTokCreatorState =
  | { status: "loading" }
  | { status: "error"; message?: string | null }
  | { status: "cannot-post"; reason?: string | null }
  | { status: "ready"; info: TikTokCreatorInfo };

/** The shape `tiktok.creatorInfo` returns. */
export interface TikTokCreatorInfoResult {
  creator: TikTokCreatorInfo | null;
  canPost: boolean;
  reason: string | null;
}

export interface TikTokMediaSummary {
  count: number;
  videoCount: number;
  imageCount: number;
  /** From the existing first-video probe; null when unknown. */
  durationSec: number | null;
}

/* Fixed copy. TikTok's guideline wording is quoted verbatim where it gives one. */
export const TIKTOK_PRIVACY_PLACEHOLDER = "Who can see this video";
export const TIKTOK_COMMERCIAL_HINT = "You need to indicate if your content promotes yourself, a third party, or both.";
export const TIKTOK_BRANDED_PRIVATE_TEXT = "Branded content visibility cannot be set to private.";
export const TIKTOK_PROCESSING_NOTICE = "TikTok may take a few minutes to process your video.";
export const TIKTOK_INTERACTION_OFF_TEXT = "Turned off in this account's TikTok settings.";
export const TIKTOK_CONNECT_NOTICE =
  "TikTok's sign-in page isn't available in India. Connect from a location where TikTok is available; posting then works from here.";

const LOAD_ERROR_FALLBACK = "couldn't load this account's TikTok settings. Reload the page and try again.";
const CANNOT_POST_FALLBACK = "This TikTok account can't post right now. Try again later.";

/**
 * The server settings for one channel, or null until a privacy level is
 * chosen. The brand flags are sent only while disclosure is ON — a box ticked,
 * then the toggle turned off, must not label the video.
 */
export function tiktokSettingsFromDraft(draft: TikTokDraft): TikTokPostSettings | null {
  if (!draft.privacyLevel || !isTikTokPrivacyLevel(draft.privacyLevel)) return null;
  return {
    privacyLevel: draft.privacyLevel,
    allowComment: draft.allowComment === true,
    allowDuet: draft.allowDuet === true,
    allowStitch: draft.allowStitch === true,
    brandOrganic: draft.discloseCommercial === true && draft.brandOrganic === true,
    brandContent: draft.discloseCommercial === true && draft.brandContent === true,
    isAigc: draft.isAigc === true,
  };
}

function channelBlockReason(
  channel: { id: string; name: string },
  draft: TikTokDraft | undefined,
  creator: TikTokCreatorState | undefined,
  media: TikTokMediaSummary,
  captionLength: number | undefined
): string | null {
  const name = channel.name;
  if (!creator || creator.status === "loading") return `Loading the TikTok settings for ${name}…`;
  if (creator.status === "error") return `${name}: ${creator.message?.trim() || LOAD_ERROR_FALLBACK}`;
  if (creator.status === "cannot-post") return `${name}: ${creator.reason?.trim() || CANNOT_POST_FALLBACK}`;
  const d = draft ?? emptyTikTokDraft();
  if (!d.privacyLevel) return `${name}: choose who can see this video.`;
  if (d.discloseCommercial && !d.brandOrganic && !d.brandContent) return `${name}: ${TIKTOK_COMMERCIAL_HINT}`;
  const settings = tiktokSettingsFromDraft(d);
  if (!settings) return `${name}: choose who can see this video.`;
  const invalid = validateTikTokSettings(settings, creator.info, { videoDurationSec: media.durationSec });
  if (invalid) return `${name}: ${invalid}`;
  if (captionLength != null && captionLength > TIKTOK_TITLE_MAX) {
    return `${name}: TikTok captions can be up to 2,200 characters (this one has ${captionLength.toLocaleString("en-US")}).`;
  }
  return null;
}

/**
 * Why the selected TikTok channels cannot be posted to yet, or null. ONE
 * predicate feeds the submit handler, both buttons' disabled/title and the
 * visible banner (same shape as storyBlockReason/articleBlockReason).
 */
export function tiktokBlockReason(input: {
  selectedTikTok: Array<{ id: string; name: string }>;
  drafts: Record<string, TikTokDraft>;
  creators: Record<string, TikTokCreatorState | undefined>;
  media: TikTokMediaSummary;
  /** Effective caption length per channel (shared caption or its own override). */
  captionLengths?: Record<string, number>;
}): string | null {
  if (input.selectedTikTok.length === 0) return null;
  const { media } = input;
  if (media.imageCount > 0) return "TikTok posts a video only — remove the images, or deselect the TikTok channels.";
  if (media.videoCount === 0) return "TikTok needs a video. Attach one MP4, MOV or WebM.";
  if (media.count > 1 || media.videoCount > 1) return "TikTok posts one video at a time — keep a single video attached.";
  for (const ch of input.selectedTikTok) {
    const reason = channelBlockReason(
      ch,
      Object.prototype.hasOwnProperty.call(input.drafts, ch.id) ? input.drafts[ch.id] : undefined,
      Object.prototype.hasOwnProperty.call(input.creators, ch.id) ? input.creators[ch.id] : undefined,
      media,
      input.captionLengths?.[ch.id]
    );
    if (reason) return reason;
  }
  return null;
}

/**
 * post.create's `tiktok` input: `{ byChannel }` for the STILL-selected TikTok
 * channels that have a privacy choice, or null when there is none (so a post
 * without TikTok is sent exactly as before). The draft map is never pruned on
 * deselect, so the selection is the filter.
 */
export function buildTikTokPayload(
  drafts: Record<string, TikTokDraft>,
  selectedTikTokIds: string[]
): { byChannel: Record<string, TikTokPostSettings> } | null {
  const byChannel: Record<string, TikTokPostSettings> = {};
  for (const id of selectedTikTokIds) {
    if (!Object.prototype.hasOwnProperty.call(drafts, id)) continue;
    const settings = tiktokSettingsFromDraft(drafts[id]!);
    if (settings) byChannel[id] = settings;
  }
  return Object.keys(byChannel).length > 0 ? { byChannel } : null;
}

/** TikTok's label for a commercial post, or null when nothing is disclosed yet. */
export function tiktokCommercialLabel(draft: TikTokDraft): string | null {
  if (!draft.discloseCommercial) return null;
  if (draft.brandContent) return "Your video will be labeled as 'Paid partnership'";
  if (draft.brandOrganic) return "Your video will be labeled as 'Promotional content'";
  return null;
}

/**
 * The consent line shown above the Publish/Schedule buttons whenever a TikTok
 * channel is selected — the branded wording once ANY selected channel is
 * marked Branded content. Null without a TikTok channel.
 */
export function tiktokConsentLine(drafts: Record<string, TikTokDraft>, selectedTikTokIds: string[]): string | null {
  if (selectedTikTokIds.length === 0) return null;
  const branded = selectedTikTokIds.some((id) => {
    if (!Object.prototype.hasOwnProperty.call(drafts, id)) return false;
    const d = drafts[id]!;
    return d.discloseCommercial && d.brandContent;
  });
  return tiktokConsentText({ brandContent: branded });
}

/** Map one `tiktok.creatorInfo` query to the card/gate state. */
export function creatorStateFromQuery(q: {
  isPending: boolean;
  errorMessage?: string | null;
  data?: TikTokCreatorInfoResult | null;
}): TikTokCreatorState {
  if (q.errorMessage != null) return { status: "error", message: q.errorMessage };
  if (q.isPending || !q.data) return { status: "loading" };
  if (!q.data.canPost) return { status: "cannot-post", reason: q.data.reason };
  if (!q.data.creator) return { status: "error", message: null };
  return { status: "ready", info: q.data.creator };
}

/** Only the given channels' drafts (what the active-task draft persists). */
export function pickTikTokDrafts(drafts: Record<string, TikTokDraft>, ids: string[]): Record<string, TikTokDraft> {
  const out: Record<string, TikTokDraft> = {};
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(drafts, id)) out[id] = drafts[id]!;
  }
  return out;
}

const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESTORED_CHANNELS = 200;

/**
 * Re-validate a persisted draft map field by field. Anything malformed is
 * dropped or reset to "not chosen" — never guessed: an unknown privacy level
 * becomes null (the gate then asks again) and only a literal `true` turns a
 * toggle on.
 */
export function sanitizeRestoredTikTok(raw: unknown): Record<string, TikTokDraft> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TikTokDraft> = {};
  let kept = 0;
  for (const key of Object.keys(raw)) {
    if (kept >= MAX_RESTORED_CHANNELS) break;
    // `__proto__` matches the id pattern; assigning it would swap `out`'s prototype.
    if (!CHANNEL_ID_RE.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const entry = (raw as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    out[key] = {
      privacyLevel: isTikTokPrivacyLevel(e.privacyLevel) ? e.privacyLevel : null,
      allowComment: e.allowComment === true,
      allowDuet: e.allowDuet === true,
      allowStitch: e.allowStitch === true,
      discloseCommercial: e.discloseCommercial === true,
      brandOrganic: e.brandOrganic === true,
      brandContent: e.brandContent === true,
      isAigc: e.isAigc === true,
    };
    kept++;
  }
  return out;
}

/**
 * The progress label for a TikTok target that is PUBLISHING (post page). The
 * worker reports TikTok's downloaded/uploaded bytes as a percent; with no
 * percent — or once the transfer is done — TikTok is processing the video.
 */
export function tiktokPublishingLabel(pct: number | null | undefined): string {
  return pct == null || pct >= 100 ? "Processing on TikTok…" : "Uploading…";
}
