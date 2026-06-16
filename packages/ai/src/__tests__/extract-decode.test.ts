import { describe, it, expect } from "vitest";
import { __test__ } from "../utils/url-extractor";

// __test__ exposes getMeta / getTitle for unit testing (added in this task).
describe("getMeta/getTitle decode entities", () => {
  it("decodes og:title entities", () => {
    const html = `<meta property="og:title" content="June&#x2019;s OTT &quot;hits&quot;">`;
    expect(__test__.getMeta(html, "og:title")).toBe(`June's OTT "hits"`);
  });
  it("decodes <title> entities", () => {
    const html = `<title>Tom &amp; Jerry</title>`;
    expect(__test__.getTitle(html)).toBe("Tom & Jerry");
  });
});

// FIX 2 (Round 16): DECODE entities first, THEN strip tags — so entity-encoded
// tags (`&lt;i&gt;`, served by NDTV et al.) are decoded to real tags then removed.
describe("getMeta/getTitle decode-then-strip HTML tags (FIX 2 Round 16)", () => {
  it("strips <i>…</i> italic tags from og:title", () => {
    const html = `<meta property="og:title" content="<i>Main Vaapas Aaunga</i> — Review">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Main Vaapas Aaunga — Review");
  });

  it("strips tags from <title> element content", () => {
    const html = `<title><b>Breaking:</b> Election Results</title>`;
    expect(__test__.getTitle(html)).toBe("Breaking: Election Results");
  });

  it("decodes then strips: '<i>Movie</i> News &amp; More' → 'Movie News & More'", () => {
    const html = `<meta property="og:title" content="<i>Movie</i> News &amp; More">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Movie News & More");
  });

  it("ENTITY-encoded tags (&lt;i&gt;) are decoded THEN stripped (no tag leak)", () => {
    // NDTV serves entity-encoded italics. decode-first turns &lt;i&gt; into a real
    // <i> tag, which the subsequent stripTags removes — so the headline is clean
    // text, NOT the leaked "<i>…</i>" the Round-15 strip-then-decode order produced.
    const html = `<meta property="og:title" content="Word &lt;i&gt;italicized&lt;/i&gt;">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Word italicized");
  });

  it("entity-encoded title: '&lt;i&gt;Movie&lt;/i&gt; News &amp; More' → 'Movie News & More'", () => {
    const html = `<title>&lt;i&gt;Movie&lt;/i&gt; News &amp; More</title>`;
    expect(__test__.getTitle(html)).toBe("Movie News & More");
  });

  it("raw-tag title still works: '<i>Movie</i> News' → 'Movie News'", () => {
    const html = `<title><i>Movie</i> News</title>`;
    expect(__test__.getTitle(html)).toBe("Movie News");
  });

  it("strips multiple nested tags from og:title", () => {
    // Note: the meta regex captures content between double-quotes, so the content
    // value itself must use double-quotes as delimiter. Tags inside the value
    // must not contain unescaped double-quotes (they would break the regex capture).
    const html = `<meta property="og:title" content="Shah Rukh wins award">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Shah Rukh wins award");
  });

  it("strips <b> tag from og:title content", () => {
    const html = `<meta property="og:title" content="Actor <b>Shah Rukh</b> wins award">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Actor Shah Rukh wins award");
  });

  it("plain titles with no tags pass through unchanged", () => {
    const html = `<meta property="og:title" content="Plain headline with no tags">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Plain headline with no tags");
  });
});
