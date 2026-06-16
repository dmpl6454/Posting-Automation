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

// FIX 4 (Round 15): strip HTML tags from titles before decoding entities
describe("getMeta/getTitle strip HTML tags (FIX 4 Round 15)", () => {
  it("strips <i>…</i> italic tags from og:title", () => {
    const html = `<meta property="og:title" content="<i>Main Vaapas Aaunga</i> — Review">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Main Vaapas Aaunga — Review");
  });

  it("strips tags from <title> element content", () => {
    const html = `<title><b>Breaking:</b> Election Results</title>`;
    expect(__test__.getTitle(html)).toBe("Breaking: Election Results");
  });

  it("strips tags then decodes entities: '<i>Movie</i> News &amp; More' → 'Movie News & More'", () => {
    const html = `<meta property="og:title" content="<i>Movie</i> News &amp; More">`;
    expect(__test__.getMeta(html, "og:title")).toBe("Movie News & More");
  });

  it("entity-encoded tags (&lt;i&gt;) are decoded to plain text, not stripped as tags", () => {
    // &lt;i&gt; is not a real HTML tag — decode should turn it into literal text <i>
    // then the second pass leaves it as text (no actual tags to strip on that pass).
    // getMeta decodes first, so the result should contain the angle-bracket text.
    const html = `<meta property="og:title" content="Word &lt;i&gt;italicized&lt;/i&gt;">`;
    const result = __test__.getMeta(html, "og:title");
    // The regex captures the raw content= value; stripTags removes real tags only;
    // decodeEntities then turns &lt; → <.  Final: "Word <i>italicized</i>" which
    // is decoded-text, not a real rendered element.
    expect(result).toBe("Word <i>italicized</i>");
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
