import { describe, it, expect } from "vitest";
import { decodeEntities } from "../utils/url-extractor";

describe("decodeEntities", () => {
  it("decodes named entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &quot;quote&quot; it&#39;s")).toBe(
      `Tom & Jerry "quote" it's`
    );
  });
  it("decodes numeric decimal entities", () => {
    expect(decodeEntities("don&#8217;t stop")).toBe("don't stop");
  });
  it("decodes hex entities including emoji", () => {
    // &#x1f37f; = 🍿 popcorn, &#x2019; = ' right single quote
    expect(decodeEntities("&#x1f37f; June&#x2019;s OTT")).toBe("\u{1f37f} June's OTT");
  });
  it("handles &lt; &gt; &nbsp;", () => {
    expect(decodeEntities("a &lt;b&gt;&nbsp;c")).toBe("a <b> c");
  });
  it("leaves plain text untouched", () => {
    expect(decodeEntities("plain text")).toBe("plain text");
  });
});
