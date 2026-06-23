import { describe, it, expect } from "vitest";
import { extractTag, parseRssItems } from "../utils/rss-parser";

describe("extractTag", () => {
  it("strips HTML tags from a CDATA-wrapped value (regression: summaries leaked <p>/<b> markup)", () => {
    const xml = "<description><![CDATA[<p>A <b>rich</b> summary.</p>]]></description>";
    expect(extractTag(xml, "description")).toBe("A rich summary.");
  });

  it("strips HTML tags from a non-CDATA value", () => {
    const xml = "<description><p>plain <i>html</i></p></description>";
    expect(extractTag(xml, "description")).toBe("plain html");
  });

  it("returns CDATA plain text untouched (no inner tags)", () => {
    const xml = "<title><![CDATA[Breaking: Big News & Stuff]]></title>";
    expect(extractTag(xml, "title")).toBe("Breaking: Big News & Stuff");
  });

  it("returns empty string when the tag is absent", () => {
    expect(extractTag("<rss></rss>", "title")).toBe("");
  });
});

describe("parseRssItems — RSS 2.0", () => {
  const rss2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>Site</title>
<item><title><![CDATA[Breaking: Big News & Stuff]]></title>
<link>https://ex.com/a1</link><guid isPermaLink="false">id-001</guid>
<description><![CDATA[<p>A <b>rich</b> summary.</p>]]></description>
<pubDate>Mon, 16 Jun 2025 12:00:00 GMT</pubDate></item>
<item><title>Second Article</title><link>https://ex.com/a2</link>
<guid>https://ex.com/a2</guid><description>Plain text desc</description></item></channel></rss>`;

  it("parses both items", () => {
    expect(parseRssItems(rss2)).toHaveLength(2);
  });

  it("decodes CDATA title and strips HTML from CDATA description", () => {
    const [first] = parseRssItems(rss2);
    expect(first!.title).toBe("Breaking: Big News & Stuff");
    expect(first!.summary).toBe("A rich summary.");
  });

  it("uses explicit <guid>, falling back to <link> when absent", () => {
    const [first, second] = parseRssItems(rss2);
    expect(first!.guid).toBe("id-001");
    expect(second!.guid).toBe("https://ex.com/a2");
  });

  it("parses pubDate into a valid Date", () => {
    const [first] = parseRssItems(rss2);
    expect(first!.published).toBeInstanceOf(Date);
    expect(Number.isNaN(first!.published!.getTime())).toBe(false);
  });
});

describe("parseRssItems — Atom (entry fallback)", () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Site</title>
<entry><title>Atom Post One</title><link href="https://ex.com/atom1" rel="alternate"/>
<id>tag:ex.com,2025:1</id><summary>Atom summary one</summary>
<updated>2025-06-18T10:00:00Z</updated></entry>
<entry><title>Atom Post Two</title><link href="https://ex.com/atom2"/>
<id>tag:ex.com,2025:2</id><content type="html">Atom content two</content></entry></feed>`;

  it("falls back to <entry> when there are no <item>s", () => {
    expect(parseRssItems(atom)).toHaveLength(2);
  });

  it("extracts link href, id-as-guid, and content when summary absent", () => {
    const [first, second] = parseRssItems(atom);
    expect(first!.link).toBe("https://ex.com/atom1");
    expect(first!.guid).toBe("tag:ex.com,2025:1");
    expect(second!.summary).toBe("Atom content two");
  });
});

describe("parseRssItems — edge cases", () => {
  it("returns [] for empty / garbage input", () => {
    expect(parseRssItems("")).toEqual([]);
    expect(parseRssItems("<html><body>not a feed</body></html>")).toEqual([]);
  });

  it("skips items with no title", () => {
    expect(parseRssItems("<rss><item><link>https://x.com/no-title</link></item></rss>")).toEqual([]);
  });

  it("falls back guid to the title when no guid/link present", () => {
    const items = parseRssItems("<rss><item><title>T</title></item></rss>");
    expect(items).toHaveLength(1);
    expect(items[0]!.guid).toBe("T");
  });

  it("does not crash on an invalid pubDate (returns an Invalid Date object)", () => {
    const items = parseRssItems("<rss><item><title>T</title><guid>g</guid><pubDate>not-a-date</pubDate></item></rss>");
    expect(items[0]!.published).toBeInstanceOf(Date);
  });

  it("caps summary at 2000 chars", () => {
    const long = "x".repeat(5000);
    const items = parseRssItems(`<rss><item><title>T</title><guid>g</guid><description>${long}</description></item></rss>`);
    expect(items[0]!.summary.length).toBe(2000);
  });
});
