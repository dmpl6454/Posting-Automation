import { describe, it, expect } from "vitest";
import { sanitizeErrorMessage, checkMcpActionLimit } from "./mcp-guards";

/**
 * Guards between an AI client and a side effect (2026-09-22).
 *
 * Both of these exist because of a review finding, so the tests are written
 * against the failure, not the feature.
 */

describe("sanitizeErrorMessage", () => {
  it("keeps an actionable platform message intact", () => {
    // The whole value of surfacing the real error is that the model can act on
    // it. Over-redaction would be its own bug.
    const msg = "Instagram requires an image; none attached. Add a caption or media and retry.";
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it("redacts our own issued access and refresh tokens", () => {
    const out = sanitizeErrorMessage("failed for mcp_at_AbCdEf0123456789xyz");
    expect(out).not.toContain("AbCdEf0123456789xyz");
    expect(out).toContain("[redacted");
  });

  it("redacts a stored encrypted channel credential", () => {
    // Channel tokens are stored as enc:v1:… — a Prisma error can quote the row.
    const out = sanitizeErrorMessage("Unique constraint on enc:v1:9aBcD3fGh1JkLmN0pQrS");
    expect(out).not.toContain("9aBcD3fGh1JkLmN0pQrS");
  });

  it("redacts a Meta access_token quoted back from a request URL", () => {
    // The realistic leak: a provider error echoing the request it sent.
    const out = sanitizeErrorMessage(
      "Request failed: https://graph.facebook.com/v18.0/me?access_token=EAAB1ZCZA9xKZBsomethinglong123456"
    );
    expect(out).not.toContain("EAAB1ZCZA9xKZBsomethinglong123456");
  });

  it("redacts a bearer header echoed into a message", () => {
    const out = sanitizeErrorMessage("upstream said: Authorization: Bearer ya29.A0ARrdaM9someverylongvalue");
    expect(out).not.toContain("ya29.A0ARrdaM9someverylongvalue");
  });

  it("leaves an ordinary cuid post id readable", () => {
    // 25-char cuids must survive: the model needs the id to explain what failed.
    const msg = "Post cmsrxo9tq0003nq0itqw1nuw9 is already published.";
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it("truncates an enormous message", () => {
    // A huge message is itself evidence that a payload got spliced in.
    // ⚠️ Prose, not one giant token: a single 5000-char run is swallowed whole
    // by the long-value pattern before truncation is ever reached, which is
    // correct ordering (redact, then trim) but tests nothing about the cap.
    const out = sanitizeErrorMessage("the upstream request body was rejected. ".repeat(200));
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("truncated");
  });

  it("never returns empty or non-string for junk input", () => {
    expect(sanitizeErrorMessage(undefined)).toBe("The request failed.");
    expect(sanitizeErrorMessage(null)).toBe("The request failed.");
    expect(sanitizeErrorMessage({})).toBe("The request failed.");
    expect(sanitizeErrorMessage("   ")).toBe("The request failed.");
  });
});

describe("checkMcpActionLimit", () => {
  it("never limits reads", () => {
    for (let i = 0; i < 100; i++) {
      expect(checkMcpActionLimit("mcp:read", "reads").ok).toBe(true);
    }
  });

  it("stops a publish loop before it reaches the platform", () => {
    // The failure this exists for: a model reading "did it work?" as "do it
    // again" and fanning the same content out repeatedly to live accounts.
    const key = "publish-loop-test";
    let allowed = 0;
    for (let i = 0; i < 40; i++) {
      if (checkMcpActionLimit("mcp:publish", key).ok) allowed++;
    }
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(40);
  });

  it("keys the limit per client+user, so one runaway client cannot lock out another", () => {
    const hot = "noisy-client";
    for (let i = 0; i < 40; i++) checkMcpActionLimit("mcp:publish", hot);
    expect(checkMcpActionLimit("mcp:publish", hot).ok).toBe(false);
    expect(checkMcpActionLimit("mcp:publish", "quiet-client").ok).toBe(true);
  });

  it("explains itself and points at the dashboard when it refuses a publish", () => {
    const key = "publish-message-test";
    let res = checkMcpActionLimit("mcp:publish", key);
    for (let i = 0; i < 40 && res.ok; i++) res = checkMcpActionLimit("mcp:publish", key);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("dashboard");
  });

  it("limits writes on their own budget, not the publish one", () => {
    // Separate buckets: exhausting replies must not disarm the publish guard's
    // headroom, and vice versa.
    const key = "separate-budgets";
    for (let i = 0; i < 40; i++) checkMcpActionLimit("mcp:write", key);
    expect(checkMcpActionLimit("mcp:write", key).ok).toBe(false);
    expect(checkMcpActionLimit("mcp:publish", key).ok).toBe(true);
  });
});
