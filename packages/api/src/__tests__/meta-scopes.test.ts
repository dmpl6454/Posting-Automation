import { describe, it, expect } from "vitest";
import { getDefaultScopesForTest as getDefaultScopes } from "../routers/channel.router";

// Locks the Meta analytics scopes. Without these two, /{post}/insights (FB) and
// /{ig-media}/insights (IG) 403 and the impressions/reach/shares columns are
// stored as permission-failure zeros. See
// docs/INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md §6.
describe("Meta insights scopes", () => {
  it("INSTAGRAM includes instagram_manage_insights (required for media insights)", () => {
    expect(getDefaultScopes("INSTAGRAM")).toContain("instagram_manage_insights");
  });

  it("FACEBOOK includes read_insights (required for post insights)", () => {
    expect(getDefaultScopes("FACEBOOK")).toContain("read_insights");
  });

  it("FACEBOOK includes pages_read_user_content (required for reactions/comments on external tokens)", () => {
    // Live-verified 2026-07-23: external users 400 (#10) reading reactions.summary/
    // comments.summary without this scope.
    expect(getDefaultScopes("FACEBOOK")).toContain("pages_read_user_content");
  });

  it("keeps the existing publishing scopes intact", () => {
    const fb = getDefaultScopes("FACEBOOK");
    expect(fb).toEqual(expect.arrayContaining(["pages_manage_posts", "pages_read_engagement"]));
    const ig = getDefaultScopes("INSTAGRAM");
    expect(ig).toEqual(
      expect.arrayContaining(["instagram_basic", "instagram_content_publish", "business_management"])
    );
  });
});
