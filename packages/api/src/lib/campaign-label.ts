import { z } from "zod";

/**
 * Internal campaign name on a Post (2026-09-21, owner request: "whenever we are
 * posting there option put campaign name just for internal purpose for report
 * insight on posted link with views, likes comment and reach").
 *
 * It is a LABEL, not a relation to the `Campaign` model — see the schema comment
 * on `Post.campaignLabel` for why. Never sent to any platform.
 */

/** Long enough for a real campaign name, short enough to render in a table cell. */
export const CAMPAIGN_LABEL_MAX = 120;

export const campaignLabelSchema = z.string().max(CAMPAIGN_LABEL_MAX);

/**
 * Trim, collapse inner whitespace, and treat blank as absent.
 *
 * ⚠️ Used by BOTH post.create and post.update. `post.update` spreads its input
 * straight into `prisma.post.update({ data })`, so without normalising there the
 * two paths would store different strings for the same typed name — and grouping
 * is an exact-match on this column, so `"Diwali "` and `"Diwali"` would render as
 * two separate campaigns.
 *
 * Returns `null` for blank so the column goes back to "ungrouped" when a user
 * clears the box, and `undefined` when the caller sent nothing at all (leave the
 * stored value alone).
 */
export function normalizeCampaignLabel(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  return collapsed.length > 0 ? collapsed : null;
}
