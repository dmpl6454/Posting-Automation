import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAMPAIGN_REPORT_LINKS_SHOWN, campaignReportHref } from "./campaign-report-link";

/**
 * Campaign-wise report of the workspace's own posts, linked from the Campaigns
 * page (2026-10-08). The report itself (Insights → Reports, "Download per
 * campaign") shipped 2026-10-03; these links make it findable.
 */
const read = (p: string) => readFileSync(join(__dirname, p), "utf8");
const reportsTab = read("../components/analytics/ReportsTab.tsx");
const card = read("../components/campaigns/own-campaign-reports.tsx");
const campaignsPage = read("../app/dashboard/campaigns/page.tsx");

describe("campaignReportHref", () => {
  it("opens Insights → Reports, on one campaign when named (URL-encoded)", () => {
    expect(campaignReportHref()).toBe("/dashboard/analytics?tab=reports");
    expect(campaignReportHref("  ")).toBe("/dashboard/analytics?tab=reports");
    expect(campaignReportHref("Diwali 2026")).toBe("/dashboard/analytics?tab=reports&campaign=Diwali%202026");
    expect(campaignReportHref("A&B / launch?")).toBe("/dashboard/analytics?tab=reports&campaign=A%26B%20%2F%20launch%3F");
    const u = new URL(campaignReportHref("दिवाली & more"), "https://x.test");
    expect(u.searchParams.get("tab")).toBe("reports");
    expect(u.searchParams.get("campaign")).toBe("दिवाली & more");
  });
});

describe("Reports tab reads ?campaign=", () => {
  it("has its own Suspense-isolated reader beside the ?post= one", () => {
    expect(reportsTab).toMatch(/<Suspense fallback=\{null\}>\s*<ReportCampaignDeepLink onCampaign=\{openCampaignFromLink\} \/>\s*<\/Suspense>/);
    // Keyed on the value, so a re-render never re-applies the link.
    expect(reportsTab).toMatch(/const label = useSearchParams\(\)\.get\("campaign"\);\s*useEffect\(\(\) => \{\s*if \(label\) onCampaign\(label\);\s*\}, \[label, onCampaign\]\);/);
    // The ?post= reader is unchanged.
    expect(reportsTab).toMatch(/<Suspense fallback=\{null\}>\s*<ReportPostDeepLink onPost=\{setPostView\} \/>\s*<\/Suspense>/);
  });

  it("selects the campaign over the 30-day window, with a stable callback (a later window choice is not undone)", () => {
    expect(reportsTab).toMatch(
      /const openCampaignFromLink = useCallback\(\(label: string\) => \{\s*setCampaignView\(label\.slice\(0, 120\)\);\s*setWin\("30d"\);\s*\}, \[\]\);/
    );
    // An unknown label still falls back to All (existing guard).
    expect(reportsTab).toMatch(/campaignView && \(orgCampaigns \?\? \[\]\)\.includes\(campaignView\) \? campaignView : undefined/);
  });
});

describe("Campaigns page links the report", () => {
  it("renders the card right after the how-it-works note", () => {
    expect(campaignsPage).toContain('import { OwnCampaignReports } from "~/components/campaigns/own-campaign-reports";');
    expect(campaignsPage).toMatch(/Brand Outreach\.\s*<\/p>\s*<\/div>\s*\{\/\*[^]*?\*\/\}\s*<OwnCampaignReports \/>/);
  });

  it("lists campaign names as links (capped), an All link, and an empty state", () => {
    expect(card).toMatch(/trpc\.analytics\.campaignLabels\.useQuery\(\)/);
    expect(card).toMatch(/href=\{campaignReportHref\(label\)\}/);
    expect(card).toMatch(/href=\{campaignReportHref\(\)\}/);
    expect(card).toMatch(/\.slice\(0, CAMPAIGN_REPORT_LINKS_SHOWN\)/);
    expect(CAMPAIGN_REPORT_LINKS_SHOWN).toBe(8);
    expect(card).toContain('data-testid="own-campaign-reports-empty"');
    expect(card).toMatch(/Download per campaign/);
  });
});
