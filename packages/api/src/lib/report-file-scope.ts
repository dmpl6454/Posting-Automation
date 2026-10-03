/**
 * Filename fragment naming what a filtered Insights report covers (2026-10-03):
 * "post-<id tail>-" for a single-post view, "<campaign slug>-" for a campaign
 * view, "" when unfiltered — so the historical unfiltered filename is unchanged
 * and a folder of downloads is not ten identical
 * "postautomation-report-7d-current-…" files.
 *
 * ⚠️ Deliberately REPLICATED in apps/web/lib/report-file-scope.ts (the web
 * client cannot import this package at runtime — the same reason csv.ts
 * replicates report-csv.ts). report-file-scope-parity.test.ts locks the two
 * together; change both or neither.
 */
export function reportFileScope(opts: { campaign?: string | null; postId?: string | null }): string {
  if (opts.postId) return `post-${opts.postId.slice(-8)}-`;
  if (opts.campaign) {
    const slug = opts.campaign
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    return slug ? `${slug}-` : "";
  }
  return "";
}
