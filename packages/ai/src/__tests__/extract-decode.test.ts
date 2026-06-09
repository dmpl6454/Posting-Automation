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
