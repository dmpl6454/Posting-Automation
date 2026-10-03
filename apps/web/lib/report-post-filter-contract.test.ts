import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level contract for the single-post Reports view (2026-10-03). Owner:
 * the export was "a collective download for all the campaigns — there should be
 * an individual campaign report". The rules locked here are the ones a refactor
 * would most plausibly undo: the post filter reaching ALL THREE server calls
 * (table, export, email), the filename naming its scope, and the post page's
 * deep link.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const tab = read("apps/web/components/analytics/ReportsTab.tsx");
const postPage = read("apps/web/app/dashboard/posts/[id]/page.tsx");

describe("ReportsTab — the post filter reaches every server call", () => {
  it("the table query, the export refetch and the email all pass postId: postFilter", () => {
    expect(tab).toMatch(/postReports\.useQuery\(\s*\{ window: win, mode, platform: platformFilter, campaign: campaignFilter, postId: postFilter \}/);
    expect(tab).toMatch(/postReports\.fetch\(\{[\s\S]*?campaign: campaignFilter,\s*postId: postFilter,/);
    expect(tab).toContain("emailReport.mutate({ to, window: win, mode, platform: platformFilter, campaign: campaignFilter, postId: postFilter });");
  });

  it("postFilter is only honoured when the server's post list contains it (no unexplained empty table)", () => {
    expect(tab).toMatch(/const postFilter =\s*postView && \(windowPosts \?\? \[\]\)\.some\(\(p\) => p\.id === postView\) \? postView : undefined;/);
  });

  it("the picker is fed by the window-scoped server list, never by the capped rows on screen", () => {
    expect(tab).toMatch(/trpc\.analytics\.reportPosts\.useQuery\(\s*\{ window: win, mode \}/);
    expect(tab).toContain("{windowPosts!.map((p) => (");
    expect(tab).not.toMatch(/rows\.map\(\(r\) => r\.postId\)/);
  });

  it("the downloaded file is named for its scope and unchanged when unfiltered", () => {
    expect(tab).toContain("const scope = reportFileScope({ campaign: campaignFilter, postId: postFilter });");
    expect(tab).toContain("`postautomation-report-${scope}${win}-${mode}-${date}${truncated ? \"-truncated\" : \"\"}.csv`");
  });

  it("the ?post= deep link is read inside its own Suspense boundary and can widen the window once", () => {
    expect(tab).toMatch(/<Suspense fallback=\{null\}>\s*<ReportPostDeepLink onPost=\{setPostView\} \/>\s*<\/Suspense>/);
    expect(tab).toContain("const widenedForDeepLink = useRef(false);");
    expect(tab).toMatch(/widenedForDeepLink\.current = true;\s*setWin\("30d"\);/);
  });

  it("a visible scope banner says the export covers only this post, with a way back to all", () => {
    expect(tab).toContain('data-testid="report-post-scope"');
    expect(tab).toContain("Export CSV and Email report cover only this post.");
    expect(tab).toMatch(/onClick=\{\(\) => setPostView\(null\)\}/);
  });

  it("the per-row shortcut never offers a direct (external) post, which has no post id of ours", () => {
    expect(tab).toMatch(/\{!postFilter && !r\.isExternal && \(\s*<button[\s\S]*?onClick=\{\(\) => setPostView\(r\.postId\)\}/);
  });
});

describe("post page → its own report", () => {
  it("links to the Reports tab pre-filtered to this post whenever a channel published", () => {
    expect(postPage).toMatch(/post\.targets\.some\(\(t: any\) => t\.status === "PUBLISHED"\) && \(/);
    expect(postPage).toContain("href={`/dashboard/analytics?tab=reports&post=${encodeURIComponent(post.id)}`}");
  });
});

describe("Download per campaign (ZIP bundle)", () => {
  it("Export CSV and the bundle share ONE fetch + column builder, so per-campaign files cannot drift from the single download", () => {
    expect(tab.match(/const fetchExportRows = async \(\) =>/g)).toHaveLength(1);
    expect(tab.match(/await fetchExportRows\(\)/g)).toHaveLength(2);
    // Exactly one place builds the metric columns / header / row mapper.
    expect(tab.match(/const allMetricCols/g)).toHaveLength(1);
    expect(tab.match(/"Metric captured at \(UTC\)"/g)).toHaveLength(1);
  });

  it("the shared fetch carries every on-screen filter and the full export cap", () => {
    expect(tab).toMatch(
      /utils\.analytics\.postReports\.fetch\(\{[\s\S]*?platform: platformFilter,\s*campaign: campaignFilter,\s*postId: postFilter,\s*window: win,\s*mode,\s*limit: EXPORT_LIMIT \+ 1,/
    );
    expect(tab.match(/utils\.analytics\.postReports\.fetch\(/g)).toHaveLength(1);
  });

  it("the bundle is built from the shared header/toRow and downloaded as a ZIP", () => {
    expect(tab).toContain("buildReportBundle({ rows: exportRows, header, toRow, window: win, mode, date, truncated })");
    expect(tab).toContain("downloadZip(bundle.zipName, buildZip(bundle.files.map((f) => ({ name: f.name, data: f.content }))))");
    expect(tab).toContain('data-testid="report-download-per-campaign"');
    expect(tab).toMatch(/onClick=\{onDownloadBundle\}\s*disabled=\{!rows\.length \|\| bundling\}/);
  });
});
