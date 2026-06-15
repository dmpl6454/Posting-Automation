import { describe, it, expect } from "vitest";
import { parseCardLayout, cardLayoutToSpec, type CardLayout } from "../tools/extract-card-layout";

const MOVIEFIED: CardLayout = {
  theme: "dark",
  accentColor: "#ff7f50",
  background: { mode: "photo", scrimMode: "brand" },
  headline: { variant: "plain", align: "left" },
  brandLabel: true,
  logo: { present: true, anchor: "tr", shape: "circle" },
  confidence: 0.9,
};

describe("parseCardLayout (sanitize at the vision boundary)", () => {
  it("parses a well-formed layout (wrapped in ```json fences)", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        theme: "dark",
        accentColor: "#ff7f50",
        background: { mode: "photo", scrimMode: "brand" },
        headline: { variant: "plain", align: "left" },
        brandLabel: true,
        logo: { present: true, anchor: "tr", shape: "circle" },
        confidence: 0.92,
      }) +
      "\n```";
    const l = parseCardLayout(raw)!;
    expect(l.theme).toBe("dark");
    expect(l.accentColor).toBe("#ff7f50");
    expect(l.background.mode).toBe("photo");
    expect(l.background.scrimMode).toBe("brand");
    expect(l.headline.variant).toBe("plain");
    expect(l.brandLabel).toBe(true);
    expect(l.logo).toEqual({ present: true, anchor: "tr", shape: "circle" });
    expect(l.confidence).toBeCloseTo(0.92);
  });

  it("returns null on non-JSON", () => {
    expect(parseCardLayout("sorry, I cannot do that")).toBeNull();
    expect(parseCardLayout("")).toBeNull();
  });

  it("whitelists enums — unknown values fall back to safe defaults", () => {
    const l = parseCardLayout(
      JSON.stringify({
        theme: "rainbow",
        background: { mode: "hologram", scrimMode: "sparkle" },
        headline: { variant: "neon", align: "justify" },
        logo: { present: "yes", anchor: "middle", shape: "triangle" },
      }),
    )!;
    expect(l.theme).toBe("light"); // unknown theme → light
    expect(l.background.mode).toBe("photo"); // unknown mode → photo
    expect(l.background.scrimMode).toBe("dark"); // unknown scrim → dark
    expect(l.headline.variant).toBe("plain"); // non-"box" → plain
    expect(l.headline.align).toBe("left"); // non-"center" → left
    expect(l.logo.present).toBe(false); // non-true → false
    expect(l.logo.anchor).toBe("tr"); // unknown anchor → tr
    expect(l.logo.shape).toBe("circle"); // non-"square" → circle
  });

  it("sanitizes a malicious accentColor through safeColor", () => {
    const l = parseCardLayout(
      JSON.stringify({ theme: "dark", accentColor: "url('http://x')</style><script>", background: {}, headline: {}, logo: {} }),
    )!;
    expect(l.accentColor).not.toContain("<");
    expect(l.accentColor).not.toContain("script");
    expect(l.accentColor).toMatch(/^#[0-9a-fA-F]{3,8}$/);
  });

  it("clamps confidence to [0,1]", () => {
    expect(parseCardLayout(JSON.stringify({ theme: "dark", background: {}, headline: {}, logo: {}, confidence: 5 }))!.confidence).toBe(1);
    expect(parseCardLayout(JSON.stringify({ theme: "dark", background: {}, headline: {}, logo: {}, confidence: -3 }))!.confidence).toBe(0);
    expect(parseCardLayout(JSON.stringify({ theme: "dark", background: {}, headline: {}, logo: {} }))!.confidence).toBe(0);
  });
});

describe("cardLayoutToSpec (layout skeleton + our content → CardSpec)", () => {
  it("builds the moviefied spec: photo+brand-scrim bg, brand-label captionStack (plain), image logo", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "Five IAF personnel killed in AN-32 crash",
      heroImageUrl: "https://cdn.example.com/hero.jpg",
      channelName: "Moviefied",
      logoUrl: "https://cdn.example.com/logo.png",
      brandColor: "#ff7f50",
    });
    expect(spec.canvas).toEqual({ w: 1080, h: 1350 });
    expect(spec.controls.theme).toBe("dark");
    expect(spec.controls.brandColor).toBe("#ff7f50");
    expect(spec.controls.logoPosition).toBe("tr");

    const bg = spec.blocks.find((b) => b.kind === "background") as any;
    expect(bg.props.mode).toBe("photo");
    expect(bg.props.scrimMode).toBe("brand");
    expect(bg.props.imageUrl).toBe("https://cdn.example.com/hero.jpg");

    const logo = spec.blocks.find((b) => b.kind === "logo") as any;
    expect(logo.props.logos[0].kind).toBe("image");
    expect(logo.props.logos[0].src).toBe("https://cdn.example.com/logo.png");
    expect(logo.props.logos[0].anchor).toBe("tr");

    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.label.text).toBe("Moviefied");
    expect(cap.props.pills[0].text).toBe("Five IAF personnel killed in AN-32 crash");
    expect(cap.props.pills[0].variant).toBe("plain");
  });

  it("falls back to a monogram from the channel initial when no logoUrl", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, { headline: "X", channelName: "newsdesk" });
    const logo = spec.blocks.find((b) => b.kind === "logo") as any;
    expect(logo.props.logos[0].kind).toBe("monogram");
    expect(logo.props.logos[0].text).toBe("N");
  });

  it("omits the logo block when the reference has no logo", () => {
    const noLogo: CardLayout = { ...MOVIEFIED, logo: { present: false, anchor: "tr", shape: "circle" } };
    const spec = cardLayoutToSpec(noLogo, { headline: "X", channelName: "C" });
    expect(spec.blocks.find((b) => b.kind === "logo")).toBeUndefined();
  });

  it("omits the brand label when the reference has none, and honors box variant", () => {
    const boxed: CardLayout = { ...MOVIEFIED, brandLabel: false, headline: { variant: "box", align: "center" } };
    const spec = cardLayoutToSpec(boxed, { headline: "X", channelName: "C" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.label).toBeUndefined();
    expect(cap.props.pills[0].variant).toBe("box");
    expect(cap.props.pills[0].align).toBe("center");
  });

  it("the user's explicit brand color wins over the reference's detected accent", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, { headline: "X", channelName: "C", brandColor: "#123456" });
    expect(spec.controls.brandColor).toBe("#123456");
  });
});
