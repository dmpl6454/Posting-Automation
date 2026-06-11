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

describe("hook_bars style", () => {
  it("renders both bars + highlight markup + optional inset", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "TMC's Jahangir Khan arrested near Nepal border",
      hookLine: "TMC ka **Pushpa** kaise jhukega nahi 🚨",
      channelName: "NewsPage",
      brandColor: "#e11d48",
      logoPosition: "top-right",
      bgImageUrl: "data:image/png;base64,AAAA",
      secondaryImageUrl: "data:image/png;base64,BBBB",
    });
    expect(html).toContain("Nepal border");
    expect(html).toContain(`color:#e11d48`);
    expect(html).toContain("Pushpa");
    expect(html).toContain("data:image/png;base64,BBBB");
  });
  it("omits inset when no secondaryImageUrl", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "Headline only",
      hookLine: "Hook!",
      channelName: "NewsPage",
      logoPosition: "top-right",
    });
    expect(html).not.toContain("inset-cutout");
  });
});

describe("tweet_card style", () => {
  it("renders brand name, handle, verified tick, text, and image pair", () => {
    const html = buildStaticCreative({
      style: "tweet_card",
      headline: "Garret this, Dean that... Honestly i just want Conrad Fisher back!!!",
      channelName: "Moviefied Bollywood",
      handle: "@moviefiedbollywood",
      verified: true,
      logoPosition: "top-left",
      bgImageUrl: "data:image/png;base64,AAAA",
      secondaryImageUrl: "data:image/png;base64,BBBB",
    });
    expect(html).toContain("Moviefied Bollywood");
    expect(html).toContain("@moviefiedbollywood");
    expect(html).toContain("Conrad Fisher back");
    expect(html).toContain("verified-tick");
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).toContain("data:image/png;base64,BBBB");
  });
  it("omits verified tick when verified is false", () => {
    const html = buildStaticCreative({
      style: "tweet_card",
      headline: "x",
      channelName: "Brand",
      handle: "@brand",
      logoPosition: "top-left",
    });
    expect(html).not.toContain("verified-tick");
  });
});

describe("creative-templates security (XSS / CSS injection)", () => {
  it("rejects a malicious brandColor and falls back to a default", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "x",
      channelName: "Brand",
      logoPosition: "top-right",
      brandColor: "red;}</style><script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    // The injected payload must not appear; the document's own </style> closing tag is fine.
    expect(html).not.toContain("red;}</style><script>");
  });
  it("accepts a valid hex brandColor unchanged", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "x",
      channelName: "Brand",
      logoPosition: "top-right",
      brandColor: "#e11d48",
    });
    expect(html).toContain("#e11d48");
  });
  it("drops a malicious bgImageUrl (CSS url breakout)", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "x",
      channelName: "Brand",
      logoPosition: "top-right",
      bgImageUrl: `https://x/a.png);}</style><script>alert(1)</script>`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    // The injected payload must not appear; the document's own </style> closing tag is fine.
    expect(html).not.toContain(`https://x/a.png);}</style>`);
  });
  it("accepts a valid https bgImageUrl and a data:image url", () => {
    const a = buildStaticCreative({
      style: "premium_editorial", headline: "x", channelName: "B", logoPosition: "top-right",
      bgImageUrl: "https://cdn.example.com/photo_1.png?x=1",
    });
    expect(a).toContain("https://cdn.example.com/photo_1.png?x=1");
    const b = buildStaticCreative({
      style: "premium_editorial", headline: "x", channelName: "B", logoPosition: "top-right",
      bgImageUrl: "data:image/png;base64,AAAA",
    });
    expect(b).toContain("data:image/png;base64,AAAA");
  });
  it("drops a malicious secondaryImageUrl in hook_bars/tweet_card", () => {
    const html = buildStaticCreative({
      style: "tweet_card", headline: "x", channelName: "B", handle: "@b", logoPosition: "top-left",
      bgImageUrl: "data:image/png;base64,AAAA",
      secondaryImageUrl: `"><script>alert(1)</script>`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("bold_typographic style", () => {
  it("renders large headline on brand background with corner logo", () => {
    const html = buildStaticCreative({
      style: "bold_typographic",
      headline: "This month's biggest releases.",
      channelName: "Moviefied",
      handle: "@moviefied",
      brandColor: "#e11d48",
      logoPosition: "top-left",
    });
    expect(html).toContain("biggest releases");
    expect(html).toContain("Moviefied");
    expect(html).toContain("#e11d48");
  });

  it("honors a valid bgImageUrl with a photo background", () => {
    const html = buildStaticCreative({
      style: "bold_typographic",
      headline: "Big news today.",
      channelName: "Moviefied",
      brandColor: "#e11d48",
      logoPosition: "top-left",
      bgImageUrl: "https://x/y.jpg",
    });
    // The photo is referenced under a dark scrim overlay (keeps headline legible).
    expect(html).toContain("url('https://x/y.jpg')");
    expect(html).toContain("background-image:");
  });

  it("falls back to a branded gradient (not flat) when no bgImageUrl", () => {
    const html = buildStaticCreative({
      style: "bold_typographic",
      headline: "Big news today.",
      channelName: "Moviefied",
      brandColor: "#e11d48",
      logoPosition: "top-left",
    });
    expect(html).toContain("linear-gradient(");
    // A photo background must NOT be present in the no-photo path.
    expect(html).not.toContain("background-image:url(");
  });

  it("drops a malicious bgImageUrl (falls back to gradient, no breakout)", () => {
    const html = buildStaticCreative({
      style: "bold_typographic",
      headline: "x",
      channelName: "Brand",
      logoPosition: "top-right",
      bgImageUrl: `https://x/y.jpg');}</style><script>alert(1)</script>`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`https://x/y.jpg');}</style>`);
    expect(html).toContain("linear-gradient(");
  });
});

describe("hook_bars no-photo fallback", () => {
  it("uses a branded gradient (not a flat near-white fill) when no bgImageUrl + light theme", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "Headline only",
      hookLine: "Hook!",
      channelName: "NewsPage",
      brandColor: "#e11d48",
      theme: "light",
      logoPosition: "top-right",
    });
    expect(html).toContain("linear-gradient(");
    // The flat near-white fallback must NOT be used on the main background.
    expect(html).not.toContain(".bg{position:absolute;inset:0;background:#f7f7f8;}");
  });

  it("still honors a valid bgImageUrl when present", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "Headline only",
      hookLine: "Hook!",
      channelName: "NewsPage",
      brandColor: "#e11d48",
      theme: "light",
      logoPosition: "top-right",
      bgImageUrl: "https://cdn.example.com/photo.png",
    });
    expect(html).toContain("background-image:url");
    expect(html).toContain("https://cdn.example.com/photo.png");
  });

  it("drops a malicious bgImageUrl (falls back to gradient, no breakout)", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "x",
      hookLine: "Hook!",
      channelName: "Brand",
      logoPosition: "top-right",
      bgImageUrl: `https://x/y.jpg');}</style><script>alert(1)</script>`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain(`https://x/y.jpg');}</style>`);
    expect(html).toContain("linear-gradient(");
  });
});
