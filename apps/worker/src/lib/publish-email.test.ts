import { describe, it, expect } from "vitest";
import {
  buildPublishEmail,
  buildPublishReportCsv,
  escapeHtml,
  safeHref,
  fmtWhen,
} from "./publish-email";

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

  it("shows the raw URL as VISIBLE text (not just an href attribute) for published rows", () => {
    const { html } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [okTarget],
    });
    // The URL must appear as element TEXT content (>url<), not only inside
    // href="..." — the old assertion passed via the attribute alone, which is
    // exactly the regression this locks out (owner ask 2026-07-18).
    expect(html).toContain(">https://facebook.com/123/posts/456</div>");
  });
});

describe("buildPublishReportCsv", () => {
  const input = {
    ...base,
    postContent: "Hello",
    targets: [
      okTarget,
      { ...okTarget, platform: "TWITTER", channelName: "X Acct", channelUsername: null, status: "FAILED", publishedUrl: null, publishedAt: null },
    ],
  };

  it("emits the exact header and one row per target, in order", () => {
    const lines = buildPublishReportCsv(input).split("\n");
    expect(lines[0]).toBe('"platform","channel","handle","url","status","published_at_utc","published_at_ist"');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"FACEBOOK"');
    expect(lines[1]).toContain('"https://facebook.com/123/posts/456"');
    expect(lines[1]).toContain('"2026-07-17 09:30"');
    expect(lines[1]).toContain('"15:00"');
    expect(lines[2]).toContain('"TWITTER"');
    expect(lines[2]).toContain('"FAILED"');
  });

  it("neutralizes formula injection in user-controlled fields (leading ' before = + - @)", () => {
    const csv = buildPublishReportCsv({
      ...input,
      targets: [{ ...okTarget, channelName: '=HYPERLINK("http://evil","x")' }],
    });
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).not.toContain('"=HYPERLINK');
  });

  it("falls back to the dashboard URL and never emits javascript: values", () => {
    const csv = buildPublishReportCsv({
      ...input,
      targets: [{ ...okTarget, publishedUrl: "javascript:alert(1)" }],
    });
    expect(csv).toContain('"https://postautomation.co.in/dashboard/posts/post_1"');
    expect(csv).not.toContain("javascript:");
  });

  it("keeps commas/quotes/newlines inside one quoted cell", () => {
    const csv = buildPublishReportCsv({
      ...input,
      targets: [{ ...okTarget, channelName: 'My, "Fancy"\nPage' }],
    });
    // The embedded newline lives INSIDE quotes; parsing rows by naive split is
    // expected to see it — assert the quoted-escaped form is present instead.
    expect(csv).toContain('"My, ""Fancy""\nPage"');
    expect(csv.startsWith('"platform"')).toBe(true);
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
