/**
 * Shared reconciliation primitives for "did this post already land?".
 *
 * Lives in ONE place because Instagram and Facebook must agree on what counts as
 * the same post. If the two matchers ever drift, one platform starts adopting
 * posts the other would re-create — which is the duplicate bug again, wearing a
 * different hat. See ambiguous-publish.ts for the incident this comes from.
 */

/**
 * Clock-skew allowance when opening a reconciliation window. Meta timestamps are
 * second-granular and its clock is not ours, so the window starts slightly before
 * the write attempt rather than exactly at it.
 */
export const RECONCILE_SKEW_MS = 120_000;

/** Listing pages scanned while reconciling. Bounded — this runs on a failure path. */
export const RECONCILE_MAX_PAGES = 4;

/** Collapse whitespace so a caption survives a round trip through Graph. */
export function normalizeCaption(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Is `listed` (as returned by a platform listing edge) the text we just published?
 *
 * Exact match after whitespace normalisation covers essentially every real case.
 * The prefix branch exists ONLY because the listing edges truncate the message
 * (2000 chars) while a caption may be longer — and it demands 200+ characters of
 * agreement, so a shared opening line can never cause a false adoption.
 */
export const LISTING_MESSAGE_MAX = 2000;

export function captionsMatch(listed: string, published: string): boolean {
  const a = normalizeCaption(listed);
  const b = normalizeCaption(published);
  if (!a || !b) return false;
  if (a === b) return true;

  // ⚠️ The prefix branch is ONLY for the listing edges' 2000-char truncation, and
  // it is deliberately one-directional. A symmetric "either side is a prefix of
  // the other" test would adopt a DIFFERENT post whose caption merely EXTENDS
  // ours — e.g. the operator publishes "…text" and later "…text + a tail", both
  // to the same account. This client posts near-identical copy routinely, so that
  // is a live risk, and a false adoption records someone else's post id as ours.
  //
  // So: the LISTED value must be the short one, and short specifically because it
  // was truncated (i.e. sitting exactly at the cap).
  if (a.length !== LISTING_MESSAGE_MAX) return false;
  if (b.length <= a.length) return false;
  return b.startsWith(a);
}

/**
 * How long to let the platform index a just-created post before asking whether it
 * exists. Without a pause, a post created seconds ago can be missing from the
 * listing, and "not listed" would be read as "not published" — the exact
 * conflation that produces duplicates.
 *
 * Env-tunable because it trades wall-clock on a failure path against the odds of
 * auto-resolving an ambiguity instead of asking the user to check.
 */
export function reconcileSettleMs(envVar: string, fallbackMs = 8_000): number {
  const raw = parseInt(process.env[envVar] || "", 10);
  return Math.max(0, Number.isFinite(raw) && raw >= 0 ? raw : fallbackMs);
}
