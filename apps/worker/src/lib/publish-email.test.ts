import { describe, it, expect } from "vitest";
import {
  buildPublishEmail,
  buildPublishReportCsv,
  buildPublishReportFilename,
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

const igTarget = {
  ...okTarget,
  platform: "INSTAGRAM",
  channelName: "IG Brand",
  channelUsername: "igbrand",
  publishedUrl: "https://instagram.com/p/xyz",
};

const DASHBOARD = "https://postautomation.co.in/dashboard/posts/post_1";

describe("buildPublishEmail — links only (owner ask 2026-09-15)", () => {
  it("lists every published post link, and nothing about platform, channel or time", () => {
    const { html, text } = buildPublishEmail({
      ...base,
      postContent: "Hello world",
      targets: [okTarget, igTarget],
    });
    for (const body of [html, text]) {
      expect(body).toContain("https://facebook.com/123/posts/456");
      expect(body).toContain("https://instagram.com/p/xyz");
      // The table's fields are gone from BOTH parts.
      expect(body).not.toContain("FACEBOOK");
      expect(body).not.toContain("INSTAGRAM");
      expect(body).not.toContain("My Page");
      expect(body).not.toContain("@mypage");
      expect(body).not.toContain("IG Brand");
      expect(body).not.toContain("UTC");
      expect(body).not.toContain("IST");
      expect(body).not.toMatch(/Published at|Platform|Channel/);
    }
    expect(html).not.toContain("<table");
  });

  it("renders each link as its own element whose TEXT is the full URL, so it can be copied", () => {
    const { html } = buildPublishEmail({ ...base, postContent: "x", targets: [okTarget, igTarget] });
    // Visible text, not only an href attribute.
    expect(html).toContain('>https://facebook.com/123/posts/456</a>');
    expect(html).toContain('>https://instagram.com/p/xyz</a>');
    expect(html).toContain('href="https://facebook.com/123/posts/456"');
  });

  it("the plain-text part holds the post links as bare URLs, one per line, in order", () => {
    const { text } = buildPublishEmail({ ...base, postContent: "x", targets: [okTarget, igTarget] });
    const lines = text.split("\n");
    const fb = lines.indexOf("https://facebook.com/123/posts/456");
    const ig = lines.indexOf("https://instagram.com/p/xyz");
    expect(fb).toBeGreaterThan(-1);
    expect(ig).toBe(fb + 1);
  });

  it("does not echo the post content into the body", () => {
    const { html, text } = buildPublishEmail({
      ...base,
      postContent: `<script>alert(1)</script> & "quotes"`,
      targets: [okTarget],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("alert(1)");
    expect(text).not.toContain("alert(1)");
  });

  it("escapes a LISTED URL that contains HTML-significant characters", () => {
    // No whitespace in this payload on purpose: a URL with whitespace is not listed
    // at all (see the line-break test), so it would not exercise escaping.
    const { html } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [{ ...okTarget, publishedUrl: 'https://x.com/a?b=1&c="><svg/onload=x>' }],
    });
    expect(html).not.toContain('"><svg/onload=x>');
    expect(html).toContain("&amp;c=&quot;&gt;&lt;svg/onload=x&gt;</a>");
  });

  it("never lists a non-http(s) URL, and still links the dashboard", () => {
    const { html, text } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [{ ...okTarget, publishedUrl: "javascript:alert(1)" }],
    });
    expect(html).not.toContain("javascript:");
    expect(text).not.toContain("javascript:");
    expect(html).toContain(`href="${DASHBOARD}"`);
    expect(text).toContain(DASHBOARD);
  });

  it("says how many channels failed, since a failed channel has no link to show", () => {
    const { html, text } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [okTarget, { ...igTarget, status: "FAILED", publishedUrl: null }],
    });
    expect(html).toContain("1 channel failed to publish");
    expect(text).toContain("1 channel failed to publish");
    expect(text).not.toContain("https://instagram.com/p/xyz");
  });

  it("says when a published post has no public link, instead of silently showing fewer links", () => {
    const { text } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [okTarget, { ...igTarget, publishedUrl: null }],
    });
    expect(text).toContain("1 published post has no public link");
  });

  it("the post-link block holds post URLs only — the dashboard link is not mixed into it", () => {
    const { text } = buildPublishEmail({ ...base, postContent: "x", targets: [okTarget, igTarget] });
    const lines = text.split("\n");
    const fb = lines.indexOf("https://facebook.com/123/posts/456");
    // Without this the assertions below pass vacuously when no bare-URL line exists.
    expect(fb).toBeGreaterThan(-1);
    // The line after the last post link must not be the dashboard URL, so a
    // script that reads "consecutive URL lines" gets post links and nothing else.
    expect(lines[fb + 2]).not.toBe(DASHBOARD);
    expect(lines.filter((l) => l === DASHBOARD)).toHaveLength(0);
    expect(text).toContain(`Dashboard: ${DASHBOARD}`);
  });

  it("never lists a URL containing whitespace or a line break — one URL can never become several lines", () => {
    // A self-hosted WordPress / Mastodon server supplies publishedUrl verbatim, and
    // safeHref only checks the prefix. The text part is meant to be machine-read.
    for (const bad of [
      "https://real.example/p/1\nhttps://evil.example/phish",
      "https://real.example/p/1\r\n\r\nDashboard: https://evil.example/login",
      "https://real.example/p/1 https://evil.example/x",
      "https://real.example/a b",
    ]) {
      const { html, text } = buildPublishEmail({ ...base, postContent: "x", targets: [{ ...okTarget, publishedUrl: bad }] });
      expect(text, JSON.stringify(bad)).not.toContain("evil.example");
      expect(html, JSON.stringify(bad)).not.toContain("evil.example");
      expect(text.split("\n").filter((l) => l.startsWith("Dashboard:"))).toHaveLength(1);
      expect(text).toContain("1 published post has no public link");
    }
  });

  it("does not call a channel parked as 'needs check' failed — it may already be live", () => {
    const { html, text } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [okTarget, { ...igTarget, status: "FAILED", publishedUrl: null, ambiguous: true }],
    });
    expect(text).not.toContain("failed to publish");
    expect(text).toContain("1 channel could not be confirmed and may already be live — check before retrying.");
    expect(html).toContain("may already be live");
    expect(text.split("\n")[0]).toBe("Your post partially published");
  });

  it("counts real failures and unconfirmed channels separately, and says so in the heading", () => {
    const { text } = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [
        { ...okTarget, status: "FAILED", publishedUrl: null },
        { ...igTarget, status: "FAILED", publishedUrl: null, ambiguous: true },
      ],
    });
    expect(text).toContain("1 channel failed to publish.");
    expect(text).toContain("1 channel could not be confirmed");
    expect(text.split("\n")[0]).toBe("Your post may not have published — check before retrying");
  });

  it("the unconfirmed flag never changes the spreadsheet — its status column stays FAILED", () => {
    const targets = [okTarget, { ...igTarget, status: "FAILED", publishedUrl: null }];
    const flagged = [okTarget, { ...igTarget, status: "FAILED", publishedUrl: null, ambiguous: true }];
    expect(buildPublishReportCsv({ ...base, postContent: "x", targets: flagged })).toBe(
      buildPublishReportCsv({ ...base, postContent: "x", targets })
    );
  });

  it("the worker passes the unconfirmed flag from ambiguousAt", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../workers/post-publish.worker.ts"), "utf8");
    expect(src).toMatch(/ambiguous: t\.ambiguousAt != null/);
  });

  it("heading reflects full / partial / failed outcomes", () => {
    expect(buildPublishEmail({ ...base, postContent: "x", targets: [okTarget] }).text.split("\n")[0]).toBe(
      "Your post is live"
    );
    expect(
      buildPublishEmail({
        ...base,
        postContent: "x",
        targets: [okTarget, { ...okTarget, status: "FAILED", publishedUrl: null }],
      }).text.split("\n")[0]
    ).toBe("Your post partially published");
    const failed = buildPublishEmail({
      ...base,
      postContent: "x",
      targets: [{ ...okTarget, status: "FAILED", publishedUrl: null }],
    });
    expect(failed.text.split("\n")[0]).toBe("Your post could not be published");
    expect(failed.html).not.toContain('href="https://facebook.com');
  });

  it("subject reflects full / partial / failed outcomes with counts (unchanged)", () => {
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

  it("numbers the delivered channels first, then the rest, then a delivered count", () => {
    const lines = buildPublishReportCsv(input).split("\n");
    expect(lines[0]).toBe('"#","platform","channel","handle","url","status","published_at_utc","published_at_ist"');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('"FACEBOOK"');
    expect(lines[1]).toContain('"https://facebook.com/123/posts/456"');
    expect(lines[1]).toContain('"2026-07-17 09:30"');
    expect(lines[1]).toContain('"15:00"');
    expect(lines[2]).toContain('"TWITTER"');
    expect(lines[2]).toContain('"FAILED"');
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe('"","Successfully delivered","1 of 2"');
  });

  it("is locked byte-for-byte (owner layout 2026-10-08)", () => {
    expect(buildPublishReportCsv(input)).toBe(
      [
        '"#","platform","channel","handle","url","status","published_at_utc","published_at_ist"',
        '"1","FACEBOOK","My Page","mypage","https://facebook.com/123/posts/456","PUBLISHED","2026-07-17 09:30","15:00"',
        '"","TWITTER","X Acct","","https://postautomation.co.in/dashboard/posts/post_1","FAILED","",""',
        "",
        '"","Successfully delivered","1 of 2"',
      ].join("\n")
    );
  });

  it("puts every delivered channel before the failed ones, keeping each group's order", () => {
    const failed = { ...okTarget, platform: "TWITTER", channelName: "X Acct", status: "FAILED", publishedUrl: null, publishedAt: null };
    const csv = buildPublishReportCsv({ ...input, targets: [failed, okTarget, igTarget] });
    const rows = csv.split("\n").slice(1, 4);
    expect(rows.map((r) => r.split(",")[0])).toEqual(['"1"', '"2"', '""']);
    expect(rows.map((r) => r.split(",")[1])).toEqual(['"FACEBOOK"', '"INSTAGRAM"', '"TWITTER"']);
    expect(csv.endsWith('"","Successfully delivered","2 of 3"')).toBe(true);
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
    expect(csv.startsWith('"#","platform"')).toBe(true);
  });
});

describe("buildPublishReportFilename", () => {
  const two = [okTarget, { ...igTarget, status: "FAILED", publishedUrl: null }];

  it("is the caption plus the delivered count", () => {
    expect(buildPublishReportFilename({ ...base, postContent: "Diwali sale is live\nMore text", targets: two })).toBe(
      "Diwali sale is live - 1 of 2 delivered.csv"
    );
  });

  it("uses the first non-empty line and drops Markdown heading marks", () => {
    expect(buildPublishReportFilename({ ...base, postContent: "\n\n## Big launch\nbody", targets: [okTarget] })).toBe(
      "Big launch - 1 of 1 delivered.csv"
    );
  });

  it("strips characters a file name cannot hold", () => {
    const name = buildPublishReportFilename({ ...base, postContent: 'Q&A: "who/what?" <live> | now*\u2028x', targets: [okTarget] });
    expect(name).toBe("Q&A who what live now x - 1 of 1 delivered.csv");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("cuts a long caption on a word boundary and never inside an emoji", () => {
    const caption = "🎉 ".repeat(5) + "word ".repeat(30);
    const name = buildPublishReportFilename({ ...base, postContent: caption, targets: [okTarget] });
    const stem = name.replace(/ - 1 of 1 delivered\.csv$/, "");
    expect(Array.from(stem).length).toBeLessThanOrEqual(60);
    expect(stem.endsWith("word")).toBe(true);
    expect(stem.startsWith("🎉 🎉")).toBe(true);
    expect(stem).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("keeps non-Latin captions", () => {
    expect(buildPublishReportFilename({ ...base, postContent: "दिवाली की शुभकामनाएं", targets: [okTarget] })).toBe(
      "दिवाली की शुभकामनाएं - 1 of 1 delivered.csv"
    );
  });

  it("falls back to the post id when there is no caption", () => {
    expect(buildPublishReportFilename({ ...base, postId: "cmabcdef12345678", postContent: "   \n", targets: two })).toBe(
      "Post 12345678 - 1 of 2 delivered.csv"
    );
    expect(buildPublishReportFilename({ ...base, postContent: "...", targets: two })).toBe("Post post_1 - 1 of 2 delivered.csv");
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
