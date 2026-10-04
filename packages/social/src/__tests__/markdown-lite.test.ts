import { describe, it, expect } from "vitest";
import { markdownToHtml, markdownToExcerpt, renderInline, escapeHtml } from "../utils/markdown-lite";

describe("markdown-lite: blocks", () => {
  it("paragraphs split on blank lines; a single newline becomes <br>", () => {
    expect(markdownToHtml("one\ntwo\n\nthree")).toBe("<p>one<br>two</p>\n<p>three</p>");
  });

  it("headings, rule, blockquote, lists, fenced code", () => {
    const md = ["# Title", "## Sub ##", "---", "> quoted", "> line", "- a", "- b", "1. x", "2) y", "```", "<b>raw</b>", "```"].join(
      "\n",
    );
    expect(markdownToHtml(md)).toBe(
      [
        "<h1>Title</h1>",
        "<h2>Sub</h2>",
        "<hr>",
        "<blockquote><p>quoted<br>line</p></blockquote>",
        "<ul><li>a</li><li>b</li></ul>",
        "<ol><li>x</li><li>y</li></ol>",
        "<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>",
      ].join("\n"),
    );
  });

  it("empty input yields an empty string, CRLF is normalised", () => {
    expect(markdownToHtml("")).toBe("");
    expect(markdownToHtml("   \n\n")).toBe("");
    expect(markdownToHtml("a\r\nb")).toBe("<p>a<br>b</p>");
  });
});

describe("markdown-lite: inline", () => {
  it("bold, italic, code, strike, links and images", () => {
    expect(renderInline(escapeHtml("**b** __b2__ *i* _i2_ `c` ~~d~~"))).toBe(
      "<strong>b</strong> <strong>b2</strong> <em>i</em> <em>i2</em> <code>c</code> <del>d</del>",
    );
    expect(markdownToHtml("see [docs](https://x.y/z?a=1&b=2) and ![pic](https://x.y/p.jpg)")).toBe(
      '<p>see <a href="https://x.y/z?a=1&amp;b=2">docs</a> and <img src="https://x.y/p.jpg" alt="pic"></p>',
    );
  });

  it("does not italicise underscores inside words or mid-word asterisks", () => {
    expect(markdownToHtml("snake_case_name and 2*3*4")).toBe("<p>snake_case_name and 2*3*4</p>");
  });

  it("inline code is never formatted", () => {
    expect(markdownToHtml("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });
});

describe("markdown-lite: SECURITY — input is text, never HTML", () => {
  it("escapes raw tags, attributes and entities everywhere", () => {
    const html = markdownToHtml('<script>alert(1)</script> & "quoted" <img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; &quot;quoted&quot;");
  });

  it("refuses javascript:/data: URLs in links and images (left as plain text)", () => {
    const html = markdownToHtml("[x](javascript:alert(1)) ![y](data:image/png;base64,AAAA) [z](ftp://h/f)");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(html).toContain("[x](javascript:alert(1))");
  });

  it("an attribute breakout inside a URL is neutralised by escaping", () => {
    const html = markdownToHtml('[x](https://h/"onmouseover="alert(1))');
    // The quote is escaped, so it cannot close the href attribute.
    expect(html).not.toMatch(/href="[^"]*"onmouseover/);
    expect(html).toContain("&quot;");
  });

  it("mailto is allowed for links only", () => {
    expect(markdownToHtml("[m](mailto:a@b.co) ![m](mailto:a@b.co)")).toBe(
      '<p><a href="mailto:a@b.co">m</a> ![m](mailto:a@b.co)</p>',
    );
  });
});

describe("markdownToExcerpt", () => {
  it("strips markup and cuts on a word boundary with an ellipsis", () => {
    expect(markdownToExcerpt("# Title\n\nSome **bold** text with a [link](https://x.y).")).toBe(
      "Title Some bold text with a link.",
    );
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const ex = markdownToExcerpt(long, 50);
    expect(ex.length).toBeLessThanOrEqual(51);
    expect(ex.endsWith("…")).toBe(true);
    expect(ex).not.toMatch(/\s…$/);
  });
});
