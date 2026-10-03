import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reportFileScope } from "../lib/report-file-scope";
import { reportFileScope as webReportFileScope } from "../../../../apps/web/lib/report-file-scope";

/**
 * Single-POST report view (2026-10-03). Owner: the Reports export was "a
 * collective download for all the campaigns — there should be an individual
 * campaign report". One fan-out is one report; the optional campaignLabel could
 * not isolate it because most posts carry none.
 *
 * Source-level, like insights-app-published-only.test.ts: the rows query is a
 * $queryRawUnsafe template, and the contract that matters is WHERE the new
 * placeholder lands and that it lands on BOTH arms.
 */
const src = readFileSync(join(__dirname, "..", "routers", "analytics.router.ts"), "utf8");

function fnBody(name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = src.indexOf("\nasync function ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("fetchPostReportRows — the post filter", () => {
  const body = fnBody("fetchPostReportRows");

  it("takes postId as the LAST optional argument, after campaign", () => {
    expect(body).toMatch(/campaign\?: string,[\s\S]*?postId\?: string\n\): Promise<PostReportRow\[\]>/);
  });

  it("pushes the param unconditionally and AFTER campaign, so $1..$campaign keep their meaning", () => {
    const campaignPush = body.indexOf("params.push(campaign ?? null);");
    const postPush = body.indexOf("params.push(postId ?? null);");
    expect(campaignPush).toBeGreaterThan(0);
    expect(postPush).toBeGreaterThan(campaignPush);
    // Not inside any `if`: the placeholder is interpolated unconditionally, so a
    // conditional push would desync param count and placeholder count ("bind
    // message supplies N parameters but prepared statement requires M").
    const line = body.slice(body.lastIndexOf("\n", postPush) + 1, postPush + 30);
    expect(line.trim().startsWith("params.push")).toBe(true);
    expect(body).toContain("const postIdx = params.length;");
  });

  it("filters the app arm by p.id and makes the external arm empty under a post filter", () => {
    expect(body).toContain("const postFilterApp = `AND ($${postIdx}::text IS NULL OR p.id = $${postIdx})`;");
    expect(body).toContain("const postFilterExt = `AND $${postIdx}::text IS NULL`;");
  });

  it("interpolates the filter on BOTH union arms, next to the campaign filter", () => {
    expect(body).toMatch(/\$\{campaignFilterExt\}\s*\$\{postFilterExt\}`/);
    expect(body).toMatch(/\$\{campaignFilterApp\}\s*\$\{postFilterApp\}\s*\$\{externalUnion\}/);
  });

  it("keeps organizationId on $1 and the boundary on $2", () => {
    expect(body).toContain('WHERE p."organizationId" = $1');
    expect(body).toContain('WHERE c2."organizationId" = $1');
    expect(body).toMatch(/const params: any\[\] = \[organizationId, boundary\];/);
  });

  it("derives the window boundary from the ONE shared helper the post picker also uses", () => {
    expect(body).toContain("const boundary = reportWindowBoundary(window);");
    expect(src).toMatch(/function reportWindowBoundary\(window: ReportWindow\): Date \{/);
    const reportPosts = src.slice(src.indexOf("reportPosts: orgProcedure"), src.indexOf("emailReport:"));
    expect(reportPosts).toContain("const boundary = reportWindowBoundary(input.window);");
    // Same current/at_age comparison as publishedAtFilter (>= vs <=).
    expect(reportPosts).toContain('input.mode === "current" ? { gte: boundary } : { lte: boundary }');
  });
});

describe("postReports / emailReport thread postId through, and the email CSV matches the download", () => {
  it("both procedures accept postId and pass it as the LAST argument", () => {
    const postReports = src.slice(src.indexOf("postReports: orgProcedure"), src.indexOf("campaignLabels:"));
    const emailReport = src.slice(src.indexOf("emailReport: emailReportRateLimited"));
    for (const proc of [postReports, emailReport]) {
      expect(proc).toContain("postId: z.string().optional()");
      expect(proc).toMatch(/input\.platform,\s*input\.campaign,\s*input\.postId\s*\)/);
    }
  });

  it("reportPosts is org-scoped and lists only posts with a PUBLISHED target in the window", () => {
    const reportPosts = src.slice(src.indexOf("reportPosts: orgProcedure"), src.indexOf("emailReport:"));
    expect(reportPosts).toContain("organizationId: ctx.organizationId,");
    expect(reportPosts).toContain('targets: { some: { status: "PUBLISHED", publishedAt } }');
    // The channel count shown in the picker is the PUBLISHED-in-window count,
    // never total targets (a failed channel has no report row).
    expect(reportPosts).toContain('_count: { select: { targets: { where: { status: "PUBLISHED", publishedAt } } } }');
  });

  it("the emailed CSV carries the Campaign column in the same position as the downloaded one", () => {
    const emailReport = src.slice(src.indexOf("emailReport: emailReportRateLimited"));
    expect(emailReport).toMatch(/"Post URL",[\s\S]{0,400}"Campaign",\s*\.\.\.metricCols\.map/);
    expect(emailReport).toMatch(/r\.publishedUrl \?\? "",\s*r\.campaignLabel \?\? "",\s*\.\.\.metricCols\.map/);
  });

  it("names the emailed file with reportFileScope, unfiltered name unchanged", () => {
    const emailReport = src.slice(src.indexOf("emailReport: emailReportRateLimited"));
    expect(emailReport).toContain("const scope = reportFileScope({ campaign: input.campaign, postId: input.postId });");
    expect(emailReport).toContain("`postautomation-report-${scope}${input.window}-${input.mode}-${day}${truncated ? \"-truncated\" : \"\"}.csv`");
  });
});

describe("reportFileScope", () => {
  it("is empty when unfiltered (historical filename byte-identical)", () => {
    expect(reportFileScope({})).toBe("");
    expect(reportFileScope({ campaign: null, postId: null })).toBe("");
  });

  it("names a post view by the id tail, which wins over a campaign", () => {
    expect(reportFileScope({ postId: "cmuldd50u02urqg0i7huh5g82", campaign: "Diwali 2026" })).toBe("post-7huh5g82-");
  });

  it("slugs a campaign label safely for a filename", () => {
    expect(reportFileScope({ campaign: "Diwali 2026 / Reels!" })).toBe("diwali-2026-reels-");
    expect(reportFileScope({ campaign: "   " })).toBe("");
    expect(reportFileScope({ campaign: "x".repeat(80) })).toBe(`${"x".repeat(40)}-`);
  });

  it("the web replica behaves identically (the two name the same file)", () => {
    const cases = [
      {},
      { postId: "cmuldd50u02urqg0i7huh5g82" },
      { campaign: "Diwali 2026 / Reels!" },
      { campaign: "ÉTÉ 2026" },
      { campaign: "a".repeat(100), postId: null },
    ];
    for (const c of cases) expect(webReportFileScope(c)).toBe(reportFileScope(c));
  });
});
