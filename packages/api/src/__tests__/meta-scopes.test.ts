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

  it("INSTAGRAM includes instagram_manage_comments (required for the comment-reply feature)", () => {
    // Re-added 2026-09-19 — see channel.router.ts's comment above this scope for
    // why the 2026-06 App Review rejection doesn't apply anymore: a real
    // reply/moderate feature now backs the request (comment.router.ts).
    expect(getDefaultScopes("INSTAGRAM")).toContain("instagram_manage_comments");
  });

  it("FACEBOOK includes pages_manage_engagement (required to reply to comments as the Page)", () => {
    // Added 2026-09-23 with the Comments inbox (comment.router.ts). Meta lists
    // pages_read_user_content as its DEPENDENCY, so both must stay requested —
    // do not drop either without also removing the reply feature.
    const fb = getDefaultScopes("FACEBOOK");
    expect(fb).toContain("pages_manage_engagement");
    expect(fb).toContain("pages_read_user_content");
  });

  it("INSTAGRAM includes instagram_manage_engagement + its dependency pages_read_user_content (Instagram likes)", () => {
    // Added 2026-09-23 for liking comments/replies and the post itself
    // (POST|DELETE /{ig-user-id}/likes). Meta lists instagram_basic,
    // pages_read_user_content and pages_show_list as dependencies — an
    // Instagram-only connect must request all of them. Do not drop without
    // removing the like feature (comment.router moderate like/unlike + likePost).
    const ig = getDefaultScopes("INSTAGRAM");
    expect(ig).toEqual(
      expect.arrayContaining(["instagram_manage_engagement", "pages_read_user_content", "instagram_basic", "pages_show_list"])
    );
    // Liking is Instagram-only here; a Facebook Page's likes ride on pages_manage_engagement.
    expect(getDefaultScopes("FACEBOOK")).not.toContain("instagram_manage_engagement");
  });

  it("does not request comment scopes the feature does not use (App Review rejects unused permissions)", () => {
    // Comments are read/replied on demand — no webhooks — so pages_manage_metadata
    // is NOT needed, and IG never needs the Facebook-Page WRITE scope
    // (pages_read_user_content IS requested for IG — a like dependency, above).
    expect(getDefaultScopes("FACEBOOK")).not.toContain("pages_manage_metadata");
    expect(getDefaultScopes("INSTAGRAM")).not.toContain("pages_manage_engagement");
    expect(getDefaultScopes("INSTAGRAM")).not.toContain("pages_manage_metadata");
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
