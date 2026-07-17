import { describe, it, expect } from "vitest";
import { buildPublishEmail, escapeHtml, safeHref, fmtWhen } from "./publish-email";

const base = {
  postId: "post_1",
  appUrl: "https://postautomation.co.in",
};

const okTarget = {
  platform: "FACEBOOK",
  channelName: "My Page",
  channelUsername: "mypage",
  status: "PUBLISHED",
  publishedUrl: "https://facebook.com/123/posts/456",
  publishedAt: new Date("2026-07-17T09:30:00Z"),
};

describe("buildPublishEmail", () => {
  it("HTML-escapes user-controlled post content (script injection)", () => {
    const { html } = buildPublishEmail({
      ...base,
      postContent: `<script>alert(1)</script> & "quotes"`,
      targets: [okTarget],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("renders one row per channel with name, handle, UTC+IST timestamp, and platform URL", () => {
    const { html, text } = buildPublishEmail({
      ...base,
      postContent: "Hello world",
      targets: [
        okTarget,
        { ...okTarget, platform: "INSTAGRAM", channelName: "IG Brand", channelUsername: "igbrand", publishedUrl: "https://instagram.com/p/xyz" },
      ],
    });
    expect(html).toContain("My Page");
    expect(html).toContain("@mypage");
    expect(html).toContain("https://facebook.com/123/posts/456");
    expect(html).toContain("IG Brand");
    expect(html).toContain("2026-07-17 09:30 UTC");
    expect(html).toContain("15:00 IST"); // 09:30Z = 15:00 Asia/Kolkata
    expect(text).toContain("[OK] FACEBOOK · My Page (@mypage)");
  });

  it("subject reflects full / partial / failed outcomes with counts", () => {
    const ok = buildPublishEmail({ ...base, postContent: "Post A", targets: [okTarget] });
    expect(ok.subject).toMatch(/^✅ Published: "Post A" — 1\/1 channel$/);

    const partial = buildPublishEmail({
      ...base,
      postContent: "Post B",
      targets: [okTarget, { ...okTarget, status: "FAILED", publishedUrl: null }],
    });
    expect(partial.subject).toMatch(/^⚠️ Partially published: "Post B" — 1\/2 channels$/);

    const failed = buildPublishEmail({
      ...base,
      postContent: "Post C",
      targets: [{ ...okTarget, status: "FAILED", publishedUrl: null }],
    });
    expect(failed.subject).toMatch(/^❌ Publish failed: "Post C" — 0\/1 channel$/);
  });

  it("refuses non-http(s) publishedUrl as an href (falls back to dashboard link)", () => {
    const { html } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [{ ...okTarget, publishedUrl: "javascript:alert(1)" }],
    });
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("https://postautomation.co.in/dashboard/posts/post_1");
  });
});

describe("helpers", () => {
  it("escapeHtml covers the critical five", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
  it("safeHref allows only http(s)", () => {
    expect(safeHref("https://x.com/1")).toBe("https://x.com/1");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
  it("fmtWhen handles null and invalid dates", () => {
    expect(fmtWhen(null)).toBe("—");
    expect(fmtWhen("not-a-date")).toBe("—");
  });
});
