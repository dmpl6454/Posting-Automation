import { describe, it, expect } from "vitest";
import { safeCallbackPath, isSafeInAppLink } from "./safe-redirect";

/**
 * Where the login page may send a user afterwards (security audit 2026-09-28).
 *
 * `?callbackUrl=` went straight into `window.location.href`, so a link to the
 * real login page could redirect a freshly signed-in user to another site — or,
 * with `javascript:`, run script on our own origin with their new session.
 * Only same-origin paths survive; everything else falls back to the dashboard.
 */
describe("safeCallbackPath", () => {
  it("keeps ordinary in-app destinations, including query and hash", () => {
    expect(safeCallbackPath("/dashboard")).toBe("/dashboard");
    expect(safeCallbackPath("/admin")).toBe("/admin");
    expect(safeCallbackPath("/invite/abc123")).toBe("/invite/abc123");
    expect(safeCallbackPath("/dashboard/posts/p1?tab=reports#top")).toBe("/dashboard/posts/p1?tab=reports#top");
  });

  it("falls back when absent", () => {
    expect(safeCallbackPath(null)).toBe("/dashboard");
    expect(safeCallbackPath(undefined)).toBe("/dashboard");
    expect(safeCallbackPath("")).toBe("/dashboard");
  });

  it("refuses script and data URLs", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x"]) {
      expect(safeCallbackPath(bad)).toBe("/dashboard");
    }
  });

  it("refuses other origins, however they are spelled", () => {
    for (const bad of [
      "https://evil.example",
      "http://evil.example/dashboard",
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "\t//evil.example",
      "/\t/evil.example",
    ]) {
      expect(safeCallbackPath(bad)).toBe("/dashboard");
    }
  });

  it("THE invariant: whatever comes in, navigating to the result stays on our origin", () => {
    // "https:evil.example" (no slashes) is a RELATIVE path to the URL parser, so
    // it becomes "/evil.example" on our own site — a harmless 404, not a
    // redirect. This asserts the property that matters rather than a spelling.
    const site = "https://postautomation.co.in";
    for (const input of [
      "https:evil.example",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "\t//evil.example",
      "javascript:alert(1)",
      "/%2F%2Fevil.example",
      "/..//evil.example",
      "/./..//evil.example",
      "/%2e%2e//evil.example",
      "/a/../..//evil.example",
      "/dashboard",
    ]) {
      expect(new URL(safeCallbackPath(input), site).origin).toBe(site);
    }
  });

  it("uses the caller's fallback", () => {
    expect(safeCallbackPath("https://evil.example", "/home")).toBe("/home");
  });
});

describe("isSafeInAppLink", () => {
  it("accepts ordinary in-app paths", () => {
    expect(isSafeInAppLink("/dashboard/posts/p1")).toBe(true);
    expect(isSafeInAppLink("/dashboard")).toBe(true);
  });

  it("refuses everything safeCallbackPath would have to fall back from", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/..//evil.example",
    ]) {
      expect(isSafeInAppLink(bad)).toBe(false);
    }
  });
});
