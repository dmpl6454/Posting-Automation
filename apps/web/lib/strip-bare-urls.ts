/**
 * Strip bare http(s) URLs out of a free-text string.
 *
 * Used at send-time on the Repurpose "Aesthetic / style notes" textarea so a URL
 * a user pastes into the NOTES box doesn't leak into the AI background prompt as
 * literal text (URLs belong in the dedicated "paste an image / post URL" input,
 * which the backend fetches + extracts an og:image from). The user-visible field
 * is left untouched — only the value SENT to the mutation is sanitized.
 */
export function stripBareUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
}
