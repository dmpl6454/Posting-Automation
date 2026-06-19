import { describe, it, expect } from "vitest";
import { buildStaticCreative, renderHighlightMarkup, safeImageUrl, type StaticCreativeOptions } from "../tools/creative-templates";

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
  it("does NOT render an empty headline pill when headline is empty (R3)", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "",
      hookLine: "TMC ka **Pushpa** kaise jhukega nahi 🚨",
      channelName: "NewsPage",
      logoPosition: "top-right",
    });
    // The empty white pill bug: a `.bar` wrapping an empty `.headline`.
    expect(html).not.toContain(`<div class="headline"></div>`);
    // The hook bar must still render so the layout isn't entirely empty.
    expect(html).toContain("Pushpa");
    expect(html).toContain(`<div class="hook">`);
  });
  it("does NOT render an empty headline pill when headline is whitespace-only (R3)", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "   ",
      hookLine: "TMC ka **Pushpa** kaise jhukega nahi 🚨",
      channelName: "NewsPage",
      logoPosition: "top-right",
    });
    // escapeHtml("   ") preserves whitespace → a whitespace-only `.headline`.
    expect(html).not.toContain(`<div class="headline">   </div>`);
    // No headline element of any kind should be emitted for a blank headline.
    expect(html).not.toContain(`<div class="headline">`);
    // The hook bar must still render.
    expect(html).toContain("Pushpa");
  });
  it("STILL renders the headline bar when headline is non-empty (regression guard)", () => {
    const html = buildStaticCreative({
      style: "hook_bars",
      headline: "TMC's Jahangir Khan arrested near Nepal border",
      hookLine: "Hook!",
      channelName: "NewsPage",
      logoPosition: "top-right",
    });
    expect(html).toContain(`<div class="headline">`);
    expect(html).toContain("Nepal border");
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

  // R5 defense-in-depth: safeImageUrl is a security gate, not a normalizer — it
  // passed `&amp;`-encoded URLs through UNCHANGED, so a hero URL that escaped
  // decoding upstream still baked a broken CSS bg → photoless render. Add a
  // NARROW repair (`&amp;`→`&` ONLY) BEFORE the allowlist test, so the gate
  // still runs after and STILL fails closed on real breakout chars.
  it("repairs &amp; → & in an otherwise-clean https url", () => {
    expect(safeImageUrl("https://cdn.x/p.jpg?w=1200&amp;ar=40")).toBe(
      "https://cdn.x/p.jpg?w=1200&ar=40",
    );
  });
  it("still REJECTS an entity that exposes a breakout char after repair (fail-closed)", () => {
    // After `&amp;`→`&` the string contains a literal `"` → must be rejected.
    expect(safeImageUrl(`https://cdn.x/p.jpg?a=1&amp;b="onerror`)).toBeNull();
  });
  it("leaves a clean https url unchanged", () => {
    expect(safeImageUrl("https://cdn.x/photo_1.png?x=1")).toBe(
      "https://cdn.x/photo_1.png?x=1",
    );
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

describe("postcard_grid style", () => {
  const basePostcard: StaticCreativeOptions = {
    style: "postcard_grid",
    headline: "Five cities, one weekend — the ultimate travel roundup",
    channelName: "Travelwise",
    handle: "@travelwise",
    verified: true,
    logoPosition: "top-left",
    brandColor: "#1d9bf0",
  };

  it("renders the header: channelName, handle, verified tick, canvas size", () => {
    const html = buildStaticCreative({ ...basePostcard });
    expect(html).toContain("Travelwise");
    expect(html).toContain("@travelwise");
    expect(html).toContain("verified-tick");
    expect(html).toContain("width:1080px");
    expect(html).toContain("height:1350px");
  });

  it("two_up renders 2 tiles", () => {
    const html = buildStaticCreative({
      ...basePostcard,
      gridImageUrls: ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
      gridPreset: "two_up",
    });
    expect(html).toContain("collage two_up");
    expect(html).toContain("https://cdn.example.com/a.jpg");
    expect(html).toContain("https://cdn.example.com/b.jpg");
    // Only 2 imgs in collage
    const matches = html.match(/collage two_up/g);
    expect(matches).toHaveLength(1);
  });

  it("three_up renders 3 tiles and includes span-2 CSS for the first tile", () => {
    const html = buildStaticCreative({
      ...basePostcard,
      gridImageUrls: [
        "https://cdn.example.com/a.jpg",
        "https://cdn.example.com/b.jpg",
        "https://cdn.example.com/c.jpg",
      ],
      gridPreset: "three_up",
    });
    expect(html).toContain("collage three_up");
    expect(html).toContain("https://cdn.example.com/a.jpg");
    expect(html).toContain("https://cdn.example.com/b.jpg");
    expect(html).toContain("https://cdn.example.com/c.jpg");
    // The CSS for the span-2 first tile must be present
    expect(html).toContain("grid-column:1 / span 2");
  });

  it("grid_2x2 renders 4 tiles", () => {
    const html = buildStaticCreative({
      ...basePostcard,
      gridImageUrls: [
        "https://cdn.example.com/a.jpg",
        "https://cdn.example.com/b.jpg",
        "https://cdn.example.com/c.jpg",
        "https://cdn.example.com/d.jpg",
      ],
      gridPreset: "grid_2x2",
    });
    expect(html).toContain("collage grid_2x2");
    expect(html).toContain("https://cdn.example.com/a.jpg");
    expect(html).toContain("https://cdn.example.com/d.jpg");
  });

  it("escapes a malicious headline/channelName", () => {
    const html = buildStaticCreative({
      ...basePostcard,
      headline: `A <b>"x"</b> & y`,
      channelName: `<script>evil()</script>`,
    });
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain(`<b>"x"</b>`);
    expect(html).not.toContain(`<script>evil()</script>`);
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops malicious gridImageUrls entries; valid https URL is present; no script/javascript", () => {
    const html = buildStaticCreative({
      ...basePostcard,
      gridImageUrls: [
        "https://ok.example/a.jpg",
        `"><script>alert(1)</script>`,
        "javascript:alert(1)",
      ],
      gridPreset: "two_up",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://ok.example/a.jpg");
  });

  it("omits the collage div element cleanly when gridImageUrls is absent", () => {
    const html = buildStaticCreative({ ...basePostcard });
    // The CSS rule `.collage` is always emitted; the DIV element must NOT be.
    expect(html).not.toContain(`<div class="collage`);
  });

  it("omits the collage div element cleanly when gridImageUrls is empty", () => {
    const html = buildStaticCreative({ ...basePostcard, gridImageUrls: [] });
    // The CSS rule `.collage` is always emitted; the DIV element must NOT be.
    expect(html).not.toContain(`<div class="collage`);
  });
});

describe("renderHighlightMarkup (** / == markers)", () => {
  it("wraps **word** in a brand-accent span", () => {
    const html = renderHighlightMarkup("Five IAF personnel **killed** today", "#ff7f50");
    expect(html).toContain(`<span style="color:#ff7f50">killed</span>`);
    expect(html).not.toContain("**");
  });

  it("strips an ORPHAN marker left by truncation (never renders literal **)", () => {
    // A truncated headline can leave a dangling "**" — it must be dropped, not shown.
    const html = renderHighlightMarkup("Five IAF personnel **killed in the cra", "#ff7f50");
    expect(html).not.toContain("**");
    expect(html).toContain("killed in the cra");
  });

  it("still escapes HTML in the surrounding text (no injection via markup)", () => {
    const html = renderHighlightMarkup("**<img src=x onerror=alert(1)>** ok", "#ff7f50");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("falls back to the default accent for an invalid color", () => {
    const html = renderHighlightMarkup("a **b** c", "javascript:alert(1)");
    expect(html).not.toContain("javascript:");
  });
});

describe("premium_editorial — moviefied mimic (highlight + bold + photo legibility)", () => {
  it("renders **word** highlight in the brand color + heavy (900) headline", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "Five IAF personnel **killed** in AN-32 crash",
      channelName: "Demo Account",
      handle: "@demo",
      brandColor: "#ff7f50",
      logoPosition: "top-right",
      theme: "dark",
      bgImageUrl: "https://cdn.example.com/photo.jpg",
    });
    expect(html).toContain(`<span style="color:#ff7f50">killed</span>`);
    expect(html).toContain("font-weight:900");
  });

  it("adds a bottom photo-scrim + text shadow over a real photo on a light-text theme", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "Headline over a busy photo",
      channelName: "Demo",
      logoPosition: "top-right",
      theme: "dark",
      bgImageUrl: "https://cdn.example.com/photo.jpg",
    });
    // The scrim ELEMENT is rendered (not just the CSS class) + a legibility shadow.
    expect(html).toContain(`<div class="photo-scrim">`);
    expect(html).toContain("text-shadow:");
  });

  it("light theme over a photo keeps dark text and NO shadow/scrim element (no regression)", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "Headline",
      channelName: "Demo",
      logoPosition: "top-right",
      theme: "light",
      bgImageUrl: "https://cdn.example.com/photo.jpg",
    });
    // No scrim element, no shadow applied (the CSS class def may exist, the element/shadow must not).
    expect(html).not.toContain(`<div class="photo-scrim">`);
    expect(html).not.toContain("text-shadow:");
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
