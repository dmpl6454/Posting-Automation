import { describe, it, expect } from "vitest";
import { commentCapabilities } from "../utils/social-comments";

/**
 * What a channel's token may do with comments, derived from the scopes Meta
 * GRANTED it (debug_token). Requested ≠ granted — the 2026-09-23 report was a
 * channel connected four days before the scope was added.
 */
describe("commentCapabilities", () => {
  const OLD_FB_TOKEN = [
    "business_management", "pages_manage_posts", "pages_read_engagement",
    "pages_read_user_content", "pages_show_list", "public_profile", "read_insights",
  ];

  it("unknown grant → nothing is guessed", () => {
    expect(commentCapabilities("FACEBOOK", null)).toEqual({
      known: false, canRead: null, canReply: null, canModerate: null, namesHidden: null, missing: [],
    });
    expect(commentCapabilities("INSTAGRAM", undefined).known).toBe(false);
  });

  it("Facebook token minted before pages_manage_engagement: can read, cannot reply or moderate", () => {
    expect(commentCapabilities("FACEBOOK", OLD_FB_TOKEN)).toEqual({
      known: true, canRead: true, canReply: false, canModerate: false, namesHidden: false,
      missing: ["pages_manage_engagement"],
    });
  });

  it("Facebook with everything granted", () => {
    const c = commentCapabilities("FACEBOOK", [...OLD_FB_TOKEN, "pages_manage_engagement"]);
    expect(c).toMatchObject({ canRead: true, canReply: true, canModerate: true, missing: [] });
  });

  it("Facebook without pages_read_user_content cannot read the thread", () => {
    const c = commentCapabilities("FACEBOOK", ["pages_read_engagement", "pages_show_list"]);
    expect(c.canRead).toBe(false);
    expect(c.missing).toEqual(["pages_read_user_content", "pages_manage_engagement"]);
  });

  it("Instagram without instagram_manage_comments: still lists, but names hidden and no writes", () => {
    const c = commentCapabilities("INSTAGRAM", ["instagram_basic", "pages_read_engagement", "pages_show_list"]);
    expect(c).toEqual({
      known: true, canRead: true, canReply: false, canModerate: false, namesHidden: true,
      missing: ["instagram_manage_comments"],
    });
  });

  it("Instagram with instagram_manage_comments", () => {
    const c = commentCapabilities("INSTAGRAM", ["instagram_basic", "instagram_manage_comments"]);
    expect(c).toMatchObject({ canReply: true, canModerate: true, namesHidden: false, missing: [] });
  });
});
