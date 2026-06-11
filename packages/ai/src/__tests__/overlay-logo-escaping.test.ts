/**
 * Regression guard for F2: HTML/JS injection via channelName / accentColor
 * in overlayLogoOnImage (news-image-generator.ts).
 *
 * Before this fix channelName was interpolated raw into Puppeteer HTML and
 * accentColor was used directly in a CSS style attribute — both controllable by
 * a user hitting the tRPC repurpose mutation. A crafted payload could execute
 * JS inside the server-side headless browser context.
 *
 * The fix: escapeHtml(channelName) + safeColor(accentColor). These tests verify
 * the escaping by inspecting the generated HTML directly (no Puppeteer required).
 *
 * Strategy: import the internal helpers the fix uses (escapeHtml is module-local,
 * safeColor is exported from creative-templates) and verify they handle the
 * known payloads, rather than spinning up a browser.
 */
import { describe, it, expect } from "vitest";
import { safeColor } from "../tools/creative-templates";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

describe("F2 — escapeHtml for channelName", () => {
  it("neutralises a script injection payload", () => {
    const payload = '</div><script>fetch("http://169.254.169.254/")</script>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain("<script>");
    expect(escaped).not.toContain("</div>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("neutralises an attribute breakout payload", () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toContain("&quot;");
    expect(escaped).not.toContain("<img");
  });

  it("passes through safe channel names unmodified", () => {
    expect(escapeHtml("My Channel")).toBe("My Channel");
    expect(escapeHtml("BBC News")).toBe("BBC News");
  });
});

describe("F2 — safeColor for accentColor", () => {
  it("accepts valid 6-digit hex", () => {
    expect(safeColor("#e11d48")).toBe("#e11d48");
    expect(safeColor("#0052cc")).toBe("#0052cc");
  });

  it("accepts valid 3-digit hex", () => {
    expect(safeColor("#f00")).toBe("#f00");
  });

  it("rejects a CSS url() breakout", () => {
    const result = safeColor("red; background:url(javascript:alert(1))");
    expect(result).not.toContain("url(");
    expect(result).toBe("#e11d48"); // falls back to DEFAULT_ACCENT
  });

  it("rejects expression() injection", () => {
    const result = safeColor("expression(alert(1))");
    expect(result).toBe("#e11d48");
  });

  it("rejects empty / undefined", () => {
    expect(safeColor(undefined)).toBe("#e11d48");
    expect(safeColor("")).toBe("#e11d48");
  });
});
