import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripSourceComments } from "./source-lock";
import { TIKTOK_CONNECT_NOTICE } from "./tiktok-post";

/**
 * Channels page ↔ OAuth callback contract (2026-10-28), at the SOURCE level.
 *
 * The callback redirects with opaque `?error=<code>`; the page maps codes to
 * messages. The two drifted: the session-check codes the callback emits
 * (`auth_not_authenticated`, `auth_user_mismatch`, `auth_not_a_member`) and the
 * consent-cancelled `oauth_provider_error` had no entry, so every one showed
 * "Could not connect the channel." This test derives the codes FROM the route,
 * so a new code without a message fails here.
 */
const ROOT = join(__dirname, "..", "..", "..");
const route = stripSourceComments(readFileSync(join(ROOT, "apps/web/app/api/oauth/callback/[provider]/route.ts"), "utf8"));
const page = stripSourceComments(readFileSync(join(ROOT, "apps/web/app/dashboard/channels/page.tsx"), "utf8"));

function callbackErrorCodes(): string[] {
  const codes = new Set<string>();
  for (const m of route.matchAll(/genericErrorRedirect\("([a-z_]+)"\)/g)) codes.add(m[1]!);
  for (const m of route.matchAll(/\?error=([a-z_]+)/g)) codes.add(m[1]!);
  // The catch block's mapped codes: ` ? "state_expired"` / ` : "oauth_failed"` (a
  // ternary has whitespace before ?/:, an object key like `reason: "x"` does not).
  for (const m of route.matchAll(/\s[?:]\s*"([a-z]+_[a-z_]+)"/g)) codes.add(m[1]!);
  // `auth_${sessionCheck.reason}` — the reasons assertSessionMatchesState returns.
  if (/genericErrorRedirect\(`auth_\$\{sessionCheck\.reason\}`\)/.test(route)) {
    for (const m of route.matchAll(/reason: "([a-z_]+)"/g)) codes.add(`auth_${m[1]}`);
  }
  return [...codes].sort();
}

function pageErrorKeys(): Set<string> {
  const block = /const OAUTH_ERROR_MESSAGES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(page);
  expect(block).not.toBeNull();
  return new Set([...block![1]!.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]!));
}

describe("every callback error code has a message", () => {
  it("the route's codes are found (the parser itself works)", () => {
    const codes = callbackErrorCodes();
    for (const c of ["auth_not_authenticated", "auth_user_mismatch", "auth_not_a_member", "oauth_provider_error", "oauth_failed", "missing_params"]) {
      expect(codes).toContain(c);
    }
  });
  it("OAUTH_ERROR_MESSAGES covers each one", () => {
    const keys = pageErrorKeys();
    const missing = callbackErrorCodes().filter((c) => !keys.has(c));
    expect(missing).toEqual([]);
  });
});

describe("platform names in the toasts", () => {
  it("come from PLATFORM_DISPLAY (TikTok, YouTube, LinkedIn), not first-letter capitalisation", () => {
    // Capitalisation is only the fallback for a platform PLATFORM_DISPLAY does not know.
    expect(page).toMatch(/const platformLabel = platform\s*\?\s*PLATFORM_DISPLAY\[platform\.toUpperCase\(\)\]\?\.name \?\? /);
  });
});

describe("TikTok connect notice", () => {
  it("has the agreed wording", () => {
    expect(TIKTOK_CONNECT_NOTICE).toBe(
      "TikTok's sign-in page isn't available in India. Connect from a location where TikTok is available; posting then works from here."
    );
  });
  it("is shown before EVERY TikTok OAuth redirect, and Continue resumes the connect", () => {
    // Both getOAuthUrl redirects in handleConnect sit behind the notice check.
    const handler = /const handleConnect = async[\s\S]*?\n {2}\};/.exec(page)?.[0] ?? "";
    expect(handler).not.toBe("");
    const redirects = [...handler.matchAll(/getOAuthUrl\.mutateAsync/g)].map((m) => m.index!);
    const checks = [...handler.matchAll(/if \(needsTikTokNotice\(platform, opts\)\) \{\s*setTiktokNoticeOpen\(true\);\s*return;\s*\}/g)].map((m) => m.index!);
    expect(redirects.length).toBe(2);
    expect(checks.length).toBe(2);
    expect(checks[0]!).toBeLessThan(redirects[0]!);
    expect(checks[1]!).toBeLessThan(redirects[1]!);
    expect(checks[1]!).toBeGreaterThan(redirects[0]!);
    expect(page).toMatch(/platform === "TIKTOK" && !opts\.tiktokNoticeAccepted/);
    expect(page).toMatch(/handleConnect\("TIKTOK", \{ tiktokNoticeAccepted: true \}\)/);
  });
  it("renders in the existing dialog style with Continue / Cancel", () => {
    expect(page).toMatch(/<Dialog\s+open=\{tiktokNoticeOpen\}/);
    expect(page).toMatch(/\{TIKTOK_CONNECT_NOTICE\}/);
    const dialog = page.slice(page.indexOf("open={tiktokNoticeOpen}"));
    expect(dialog.slice(0, 2000)).toMatch(/>\s*Cancel\s*</);
    expect(dialog.slice(0, 2000)).toMatch(/>\s*Continue\s*</);
  });
});
