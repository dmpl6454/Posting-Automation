import { describe, it, expect, afterEach } from "vitest";
import {
  resolveIncludeExternalPosts,
  insightsIncludeExternalPosts,
} from "../insights-population";

/**
 * Which POPULATION Insights measures and reports on.
 *
 * Owner decision 2026-08-19: Insights covers posts published THROUGH
 * PostAutomation only. Posts made directly on a connected Facebook Page or
 * Instagram account are neither fetched nor displayed.
 *
 * ⚠️ This switch must be read by BOTH containers — the worker decides what is
 * ingested, the web container decides what is displayed. If they disagree the
 * product either burns Graph quota on rows nobody can see (worker on, web off)
 * or renders a population it has stopped refreshing (worker off, web on). Same
 * reason `EXTERNAL_POST_FLOOR` lives in this package.
 */
describe("resolveIncludeExternalPosts", () => {
  it("EXCLUDES direct posts when unset — the app-published-only default", () => {
    expect(resolveIncludeExternalPosts(undefined)).toBe(false);
  });

  it("EXCLUDES direct posts on an EMPTY string", () => {
    // ⚠️ This is the load-bearing case, not a curiosity. docker-compose.prod.yml
    // uses an explicit `environment:` allowlist, so a key present only in
    // .env.prod arrives as "". A fail-OPEN check (`!== "false"`) would read that
    // as ENABLED and silently restore the whole external population — the exact
    // shape of the PR #166 incident.
    expect(resolveIncludeExternalPosts("")).toBe(false);
    expect(resolveIncludeExternalPosts("   ")).toBe(false);
  });

  it("INCLUDES direct posts only on the exact string 'true'", () => {
    expect(resolveIncludeExternalPosts("true")).toBe(true);
    expect(resolveIncludeExternalPosts("  true  ")).toBe(true);
  });

  it("EXCLUDES on anything else — no truthy synonyms", () => {
    // Strict, like FB_MEDIA_VIEW_METRICS_ENABLED and FB_ANALYTICS_SYNC_ENABLED.
    // Re-enabling an expensive ingestion pipeline must be a deliberate,
    // unambiguous act, so a typo can only fail toward the cheap side.
    for (const raw of ["TRUE", "True", "1", "yes", "on", "false", "no", "0", "enabled"]) {
      expect(resolveIncludeExternalPosts(raw), `raw=${raw}`).toBe(false);
    }
  });
});

describe("insightsIncludeExternalPosts reads the env at CALL time", () => {
  const KEY = "INSIGHTS_INCLUDE_EXTERNAL_POSTS";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("defaults to app-published only", () => {
    delete process.env[KEY];
    expect(insightsIncludeExternalPosts()).toBe(false);
  });

  it("honors the flag without a module reload", () => {
    // Read at call time (not module load) so a container restart is enough to
    // change it and tests need no module-cache games.
    process.env[KEY] = "true";
    expect(insightsIncludeExternalPosts()).toBe(true);
    process.env[KEY] = "false";
    expect(insightsIncludeExternalPosts()).toBe(false);
  });
});
