/**
 * Links from the Campaigns page to the campaign-wise report of the
 * workspace's OWN posts (2026-10-08).
 *
 * That report lives in Insights → Reports and groups posts by
 * `Post.campaignLabel` — the free-text campaign name set in Compose — which is
 * deliberately NOT the monitoring `Campaign` model the Campaigns page manages.
 * People look for "campaign reports" on the Campaigns page, so it links there.
 */

/** Campaign labels shown as direct links before the "+N more" overflow. */
export const CAMPAIGN_REPORT_LINKS_SHOWN = 8;

/**
 * Insights → Reports, optionally opened on one campaign (?campaign=, read by
 * ReportsTab, which also widens to the 30-day window).
 */
export function campaignReportHref(label?: string | null): string {
  const base = "/dashboard/analytics?tab=reports";
  const name = (label ?? "").trim();
  return name ? `${base}&campaign=${encodeURIComponent(name)}` : base;
}
