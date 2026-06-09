import { describe, it, expect } from "vitest";
import { buildStaticCreative, type StaticCreativeOptions } from "../tools/creative-templates";

const base: StaticCreativeOptions = {
  style: "premium_editorial",
  headline: "Krrish 4 Budget Controversy Debunked",
  channelName: "Moviefied",
  handle: "@moviefied",
  logoPosition: "top-right",
};

describe("buildStaticCreative", () => {
  it("renders premium_editorial with headline + channel + escaped HTML", () => {
    const html = buildStaticCreative({ ...base });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Krrish 4 Budget Controversy Debunked");
    expect(html).toContain("Moviefied");
    expect(html).toContain("width:1080px");
    expect(html).toContain("height:1350px");
  });
  it("escapes HTML-special chars in the headline (no injection)", () => {
    const html = buildStaticCreative({ ...base, headline: `A <b>"x"</b> & y` });
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain(`<b>"x"</b>`);
  });
});
