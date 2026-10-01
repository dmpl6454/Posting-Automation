/**
 * The channel.metadata keys a NewsGrid page may receive (security review
 * 2026-10-01).
 *
 * channel.metadata is shared with the platform integrations: Discord keeps its
 * webhook URL there (a full posting credential, plaintext), Facebook the
 * userAccessToken, Telegram the chat id. These are exactly the brand-profile keys
 * the NewsGrid pages read (apps/web/app/dashboard/newsgrid/**); add a key here
 * only when a page starts reading it.
 */
export const NEWSGRID_PROFILE_KEYS = [
  "logo_path",
  "font_family",
  "brand_palette",
  "caption_style",
  "template_type",
  "logo_position",
  "username_position",
  "language_style",
] as const;

export type NewsgridProfileKey = (typeof NEWSGRID_PROFILE_KEYS)[number];
export type NewsgridProfile = Partial<Record<NewsgridProfileKey, unknown>>;

export function toNewsgridProfile(metadata: unknown): NewsgridProfile {
  const out: NewsgridProfile = {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return out;
  for (const key of NEWSGRID_PROFILE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      out[key] = (metadata as Record<string, unknown>)[key];
    }
  }
  return out;
}
