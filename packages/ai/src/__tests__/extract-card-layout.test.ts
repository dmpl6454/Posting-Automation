import { describe, it, expect } from "vitest";
import { parseCardLayout, cardLayoutToSpec, type CardLayout } from "../tools/extract-card-layout";

const MOVIEFIED: CardLayout = {
  theme: "dark",
  accentColor: "#ff7f50",
  fontFamily: "inter",
  background: { mode: "photo", scrimMode: "brand" },
  headline: { variant: "plain", align: "left" },
  brandLabel: true,
  labelUnderline: false,
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

  it("renders NO logo block when logo.present=true but no logoUrl (FIX 1: no monogram placeholder)", () => {
    // Prior behaviour rendered a monogram circle — user reported it as a "blank profile-picture".
    // New behaviour: zero logo blocks → clean card.
    const spec = cardLayoutToSpec(MOVIEFIED, { headline: "X", channelName: "newsdesk" });
    expect(spec.blocks.find((b) => b.kind === "logo")).toBeUndefined();
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

// ── Round 12: styleOverride — picker wins over vision-detected treatment ────────

describe("cardLayoutToSpec — styleOverride", () => {
  /** A layout with BOX variant and gradient bg — the OPPOSITE of premium_editorial. */
  const BOX_LAYOUT: CardLayout = {
    ...MOVIEFIED,
    background: { mode: "gradient", scrimMode: "none" },
    headline: { variant: "box", align: "center" },
  };

  it("premium_editorial overrides box→plain variant, gradient→photo bg, and sets scrimMode brand", () => {
    const spec = cardLayoutToSpec(BOX_LAYOUT, {
      headline: "Big Headline",
      channelName: "Moviefied",
      styleOverride: "premium_editorial",
    });
    const bg = spec.blocks.find((b) => b.kind === "background") as any;
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;

    expect(bg.props.mode).toBe("photo");
    expect(bg.props.scrimMode).toBe("brand");
    expect(cap.props.pills[0].variant).toBe("plain");
  });

  it("hook_bars overrides plain→box variant (background mode unchanged)", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "Hook Headline",
      channelName: "Newsdesk",
      styleOverride: "hook_bars",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    const bg = spec.blocks.find((b) => b.kind === "background") as any;

    expect(cap.props.pills[0].variant).toBe("box");
    // bg mode comes from the ref (MOVIEFIED = "photo") — hook_bars doesn't touch it
    expect(bg.props.mode).toBe("photo");
  });

  it("bold_typographic forces variant plain; keeps the ref's background mode", () => {
    const spec = cardLayoutToSpec(BOX_LAYOUT, {
      headline: "Bold Headline",
      channelName: "Brand",
      styleOverride: "bold_typographic",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    const bg = spec.blocks.find((b) => b.kind === "background") as any;

    expect(cap.props.pills[0].variant).toBe("plain");
    // bg mode NOT overridden by bold_typographic — stays as the ref's "gradient"
    expect(bg.props.mode).toBe("gradient");
  });

  it("tweet_card leaves variant + background mode exactly as detected (no override)", () => {
    const spec = cardLayoutToSpec(BOX_LAYOUT, {
      headline: "Tweet Headline",
      channelName: "Brand",
      styleOverride: "tweet_card",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    const bg = spec.blocks.find((b) => b.kind === "background") as any;

    expect(cap.props.pills[0].variant).toBe("box");   // unchanged from BOX_LAYOUT
    expect(bg.props.mode).toBe("gradient");            // unchanged from BOX_LAYOUT
    expect(bg.props.scrimMode).toBe("none");           // unchanged from BOX_LAYOUT
  });

  it("no styleOverride → uses the layout's detected variant + mode (regression guard)", () => {
    const spec = cardLayoutToSpec(BOX_LAYOUT, { headline: "X", channelName: "C" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    const bg = spec.blocks.find((b) => b.kind === "background") as any;

    expect(cap.props.pills[0].variant).toBe("box");
    expect(bg.props.mode).toBe("gradient");
    expect(bg.props.scrimMode).toBe("none");
  });

  it("brandLabel is preserved from the reference regardless of styleOverride; logo only renders with a logoUrl", () => {
    // Without logoUrl: brandLabel still rendered, no logo block (FIX 1).
    const specNoLogo = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "Moviefied",
      styleOverride: "hook_bars",
    });
    const capNoLogo = specNoLogo.blocks.find((b) => b.kind === "captionStack") as any;
    expect(capNoLogo.props.label?.text).toBe("Moviefied");
    expect(specNoLogo.blocks.find((b) => b.kind === "logo")).toBeUndefined();

    // With logoUrl: logo block appears with the ref's anchor.
    const specWithLogo = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "Moviefied",
      styleOverride: "hook_bars",
      logoUrl: "https://cdn.example.com/logo.png",
    });
    const logo = specWithLogo.blocks.find((b) => b.kind === "logo") as any;
    expect(logo.props.logos[0].anchor).toBe("tr"); // from layout.logo.anchor
  });
});

// ── Round 13: font family from reference ────────────────────────────────────

describe("parseCardLayout — fontFamily (Round 13)", () => {
  it("parses 'serif_display' fontFamily", () => {
    const raw = JSON.stringify({
      theme: "dark",
      accentColor: "#ff7f50",
      fontFamily: "serif_display",
      background: { mode: "photo", scrimMode: "brand" },
      headline: { variant: "plain", align: "left" },
      brandLabel: true,
      logo: { present: true, anchor: "tr", shape: "circle" },
      confidence: 0.9,
    });
    const l = parseCardLayout(raw)!;
    expect(l.fontFamily).toBe("serif_display");
  });

  it("parses 'condensed' fontFamily", () => {
    const raw = JSON.stringify({
      theme: "dark",
      accentColor: "#e11d48",
      fontFamily: "condensed",
      background: { mode: "photo", scrimMode: "dark" },
      headline: { variant: "box", align: "left" },
      brandLabel: false,
      logo: { present: false, anchor: "tr", shape: "circle" },
      confidence: 0.8,
    });
    const l = parseCardLayout(raw)!;
    expect(l.fontFamily).toBe("condensed");
  });

  it("defaults fontFamily to 'inter' when the field is missing", () => {
    const raw = JSON.stringify({
      theme: "dark",
      accentColor: "#ff7f50",
      // no fontFamily
      background: { mode: "photo", scrimMode: "brand" },
      headline: { variant: "plain", align: "left" },
      brandLabel: false,
      logo: { present: false, anchor: "tr", shape: "circle" },
      confidence: 0.7,
    });
    const l = parseCardLayout(raw)!;
    expect(l.fontFamily).toBe("inter");
  });

  it("defaults fontFamily to 'inter' on an unknown value", () => {
    const raw = JSON.stringify({
      theme: "light",
      accentColor: "#e11d48",
      fontFamily: "comic_sans", // invalid
      background: { mode: "gradient", scrimMode: "none" },
      headline: { variant: "box", align: "center" },
      brandLabel: false,
      logo: { present: false, anchor: "tl", shape: "circle" },
      confidence: 0.5,
    });
    const l = parseCardLayout(raw)!;
    expect(l.fontFamily).toBe("inter");
  });
});

describe("cardLayoutToSpec — fontFamily propagation (Round 13)", () => {
  const SERIF_LAYOUT: CardLayout = {
    ...MOVIEFIED,
    fontFamily: "serif_display",
  };

  const CONDENSED_LAYOUT: CardLayout = {
    ...MOVIEFIED,
    fontFamily: "condensed",
  };

  it("sets controls.fontFamily from layout.fontFamily (serif_display)", () => {
    const spec = cardLayoutToSpec(SERIF_LAYOUT, { headline: "X", channelName: "C" });
    expect(spec.controls.fontFamily).toBe("serif_display");
  });

  it("sets controls.fontFamily from layout.fontFamily (condensed)", () => {
    const spec = cardLayoutToSpec(CONDENSED_LAYOUT, { headline: "X", channelName: "C" });
    expect(spec.controls.fontFamily).toBe("condensed");
  });

  it("styleOverride does NOT override fontFamily — font stays from reference", () => {
    // The picker overrides layout treatment (bg mode / headline variant) but NOT
    // the font — font is a reference-fidelity property.
    const spec = cardLayoutToSpec(SERIF_LAYOUT, {
      headline: "X",
      channelName: "C",
      styleOverride: "hook_bars",
    });
    expect(spec.controls.fontFamily).toBe("serif_display");
  });

  it("styleOverride premium_editorial also does NOT override fontFamily", () => {
    const spec = cardLayoutToSpec(CONDENSED_LAYOUT, {
      headline: "Bold Headline",
      channelName: "Newsdesk",
      styleOverride: "premium_editorial",
    });
    expect(spec.controls.fontFamily).toBe("condensed");
  });
});

// ── Round 13: color precedence regression guards ────────────────────────────

describe("cardLayoutToSpec — color precedence (Round 13 regression guards)", () => {
  it("explicit content.brandColor wins over layout.accentColor", () => {
    // Explicit picker color (user decision) must always beat the reference's detected accent.
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      brandColor: "#aabbcc", // explicit picker
    });
    // MOVIEFIED.accentColor = "#ff7f50" — picker "#aabbcc" must win
    expect(spec.controls.brandColor).toBe("#aabbcc");
  });

  it("when no content.brandColor, falls back to layout.accentColor (reference beats logo)", () => {
    // No brandColor passed → cardLayoutToSpec uses layout.accentColor.
    // This is the key Round 13 guarantee: on the mimicry path, passing brandColor=null
    // lets the reference's own extracted accent drive the card color.
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      // no brandColor
    });
    expect(spec.controls.brandColor).toBe("#ff7f50"); // layout.accentColor
  });

  it("safeColor sanitizes a malicious brandColor and falls back to DEFAULT_ACCENT", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      brandColor: "<script>evil</script>",
    });
    // safeColor rejects non-hex → falls back to DEFAULT_ACCENT (#e11d48)
    expect(spec.controls.brandColor).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(spec.controls.brandColor).not.toContain("<");
  });
});

// ── Round 14: no-logo, headlineColor, fontOverride ──────────────────────────

describe("cardLayoutToSpec — no-logo (Round 14 FIX 1)", () => {
  it("logo.present=true BUT no content.logoUrl → zero logo blocks (no monogram)", () => {
    // The reference wants a logo but the user hasn't uploaded one.
    // FIX 1: render nothing — clean card, no blank placeholder circle.
    const spec = cardLayoutToSpec(MOVIEFIED, { headline: "X", channelName: "MyBrand" });
    expect(spec.blocks.filter((b) => b.kind === "logo").length).toBe(0);
  });

  it("logo.present=true WITH content.logoUrl → exactly one image logo block", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "MyBrand",
      logoUrl: "https://cdn.example.com/logo.png",
    });
    const logos = spec.blocks.filter((b) => b.kind === "logo");
    expect(logos.length).toBe(1);
    expect((logos[0] as any).props.logos[0].kind).toBe("image");
    expect((logos[0] as any).props.logos[0].src).toBe("https://cdn.example.com/logo.png");
  });

  it("logo.present=false → zero logo blocks (reference has no logo)", () => {
    const noLogo: CardLayout = { ...MOVIEFIED, logo: { present: false, anchor: "tr", shape: "circle" } };
    const spec = cardLayoutToSpec(noLogo, { headline: "X", channelName: "C", logoUrl: "https://cdn.example.com/logo.png" });
    expect(spec.blocks.filter((b) => b.kind === "logo").length).toBe(0);
  });
});

describe("cardLayoutToSpec — headlineColor (Round 14 FIX 2)", () => {
  it("valid headlineColor is used as the pill textColor", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "White on Orange",
      channelName: "C",
      headlineColor: "#ffffff",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.pills[0].textColor).toBe("#ffffff");
  });

  it("without headlineColor → pill textColor is the theme default (dark theme → white)", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, { headline: "X", channelName: "C" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.pills[0].textColor).toBe("#ffffff"); // dark theme default
  });

  it("without headlineColor on a light theme with no scrim → pill textColor is the light default", () => {
    // scrimMode "none" means no dark overlay — a light-theme card with no scrim
    // should default to a dark text color for legibility on a bright background.
    const lightNoScrimLayout: CardLayout = { ...MOVIEFIED, theme: "light", background: { mode: "photo", scrimMode: "none" } };
    const spec = cardLayoutToSpec(lightNoScrimLayout, { headline: "X", channelName: "C" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.pills[0].textColor).toBe("#0f1419"); // light theme + no scrim → dark text
  });

  it("brand scrim on a light theme → pill textColor is white (FIX 1 Round 15: scrim-aware default)", () => {
    // MOVIEFIED has scrimMode:"brand" — the headline sits over the brand-color
    // gradient at the bottom. Even on a light theme, white text is correct here.
    const lightBrandScrimLayout: CardLayout = { ...MOVIEFIED, theme: "light" };
    const spec = cardLayoutToSpec(lightBrandScrimLayout, { headline: "X", channelName: "C" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.pills[0].textColor).toBe("#ffffff"); // brand scrim → white default
  });

  it("dark scrim on a light theme → pill textColor is white (dark scrim also forces white)", () => {
    const lightDarkScrimLayout: CardLayout = { ...MOVIEFIED, theme: "light", background: { mode: "photo", scrimMode: "dark" } };
    const spec = cardLayoutToSpec(lightDarkScrimLayout, { headline: "X", channelName: "C" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.pills[0].textColor).toBe("#ffffff"); // dark scrim → white default
  });

  it("invalid headlineColor ('red;}') → falls back to theme default, NOT accent", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      headlineColor: "red;}",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    // Must be the theme default (#ffffff for dark), not the accent (#ff7f50) or anything malicious
    expect(cap.props.pills[0].textColor).toBe("#ffffff");
    expect(cap.props.pills[0].textColor).not.toContain(";");
    expect(cap.props.pills[0].textColor).not.toContain("}");
  });

  it("invalid headlineColor (CSS injection attempt) → falls back to theme default", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      headlineColor: "#fff</style><script>alert(1)</script>",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.pills[0].textColor).toBe("#ffffff");
    expect(cap.props.pills[0].textColor).not.toContain("<");
  });
});

describe("cardLayoutToSpec — fontOverride (Round 14 FIX 3)", () => {
  it("fontOverride 'serif_display' wins over layout.fontFamily 'inter'", () => {
    // layout.fontFamily = "inter" (MOVIEFIED), but the user picks "serif_display"
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      fontOverride: "serif_display",
    });
    expect(spec.controls.fontFamily).toBe("serif_display");
  });

  it("fontOverride 'condensed' wins over layout.fontFamily", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      fontOverride: "condensed",
    });
    expect(spec.controls.fontFamily).toBe("condensed");
  });

  it("without fontOverride → controls.fontFamily comes from layout.fontFamily", () => {
    const serifLayout: CardLayout = { ...MOVIEFIED, fontFamily: "serif_display" };
    const spec = cardLayoutToSpec(serifLayout, { headline: "X", channelName: "C" });
    expect(spec.controls.fontFamily).toBe("serif_display");
  });

  it("fontOverride 'inter' overrides a layout 'condensed' reference", () => {
    const condensedLayout: CardLayout = { ...MOVIEFIED, fontFamily: "condensed" };
    const spec = cardLayoutToSpec(condensedLayout, {
      headline: "X",
      channelName: "C",
      fontOverride: "inter",
    });
    expect(spec.controls.fontFamily).toBe("inter");
  });
});

// ── Round 17 FIX 1: the REFERENCE drives the look (picker is fallback only) ─────

describe("cardLayoutToSpec — hasReference suppresses the styleOverride stomp (Round 17 FIX 1)", () => {
  /** A gradient + box layout — the OPPOSITE of premium_editorial. */
  const GRADIENT_BOX: CardLayout = {
    ...MOVIEFIED,
    background: { mode: "gradient", scrimMode: "none" },
    headline: { variant: "box", align: "center" },
  };

  it("Round 20: hasReference:true + premium_editorial → picker treatment STILL applies (photo/brand/plain)", () => {
    // Round 20 reversed R17 here: the style PICKER owns the TREATMENT (variant +
    // scrim + bg mode) even with a reference, so premium_editorial reliably produces
    // the Moviefied look (gradient + plain white headline, no white box). The
    // reference still drives accent/logo/alignment/brandLabel (asserted elsewhere).
    const spec = cardLayoutToSpec(GRADIENT_BOX, {
      headline: "Big Headline",
      channelName: "Brand",
      styleOverride: "premium_editorial",
      hasReference: true,
    });
    const bg = spec.blocks.find((b) => b.kind === "background") as any;
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(bg.props.mode).toBe("photo");
    expect(bg.props.scrimMode).toBe("brand");
    expect(cap.props.pills[0].variant).toBe("plain");
  });

  it("hasReference:false + styleOverride premium_editorial → STILL forces photo/brand/plain (regression guard)", () => {
    const spec = cardLayoutToSpec(GRADIENT_BOX, {
      headline: "Big Headline",
      channelName: "Brand",
      styleOverride: "premium_editorial",
      hasReference: false,
    });
    const bg = spec.blocks.find((b) => b.kind === "background") as any;
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(bg.props.mode).toBe("photo");
    expect(bg.props.scrimMode).toBe("brand");
    expect(cap.props.pills[0].variant).toBe("plain");
  });

  it("hasReference undefined (no reference) + styleOverride → forces the picker treatment (no-reference path unchanged)", () => {
    const spec = cardLayoutToSpec(GRADIENT_BOX, {
      headline: "Big Headline",
      channelName: "Brand",
      styleOverride: "hook_bars",
      // no hasReference
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.pills[0].variant).toBe("box"); // hook_bars → box
  });

  it("hasReference:true with NO styleOverride → still renders the detected layout", () => {
    const spec = cardLayoutToSpec(GRADIENT_BOX, {
      headline: "X",
      channelName: "Brand",
      hasReference: true,
    });
    const bg = spec.blocks.find((b) => b.kind === "background") as any;
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(bg.props.mode).toBe("gradient");
    expect(cap.props.pills[0].variant).toBe("box");
  });
});

// ── Round 17 FIX 2: per-reference label underline ──────────────────────────────

describe("cardLayoutToSpec — labelUnderline (Round 17 FIX 2)", () => {
  it("parseCardLayout defaults labelUnderline to false", () => {
    const l = parseCardLayout(
      JSON.stringify({ theme: "dark", background: {}, headline: {}, logo: {}, brandLabel: true }),
    )!;
    expect(l.labelUnderline).toBe(false);
  });

  it("parseCardLayout reads labelUnderline:true", () => {
    const l = parseCardLayout(
      JSON.stringify({ theme: "dark", background: {}, headline: {}, logo: {}, brandLabel: true, labelUnderline: true }),
    )!;
    expect(l.labelUnderline).toBe(true);
  });

  it("cardLayoutToSpec: label.underline is false when layout.labelUnderline is false (default)", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, { headline: "X", channelName: "Moviefied" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.label.underline).toBe(false);
  });

  it("cardLayoutToSpec: label.underline is true when layout.labelUnderline is true", () => {
    const underlined: CardLayout = { ...MOVIEFIED, labelUnderline: true };
    const spec = cardLayoutToSpec(underlined, { headline: "X", channelName: "Moviefied" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.label.underline).toBe(true);
  });
});

// ── Round 17 FIX 3: brand-label color defaults to the headline color ───────────

describe("cardLayoutToSpec — labelColor (Round 17 FIX 3)", () => {
  it("label color defaults to the resolved headline color when not provided", () => {
    // MOVIEFIED has scrimMode brand → headline default is #ffffff; the label matches it.
    const spec = cardLayoutToSpec(MOVIEFIED, { headline: "X", channelName: "Moviefied" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.label.color).toBe("#ffffff");
    expect(cap.props.label.color).toBe(cap.props.pills[0].textColor); // never diverges
  });

  it("label color follows a custom headlineColor when labelColor is unset", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "Moviefied",
      headlineColor: "#abcdef",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.label.color).toBe("#abcdef");
  });

  it("an explicit valid labelColor wins over the headline color", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "Moviefied",
      headlineColor: "#abcdef",
      labelColor: "#102030",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(cap.props.label.color).toBe("#102030");
  });

  it("an invalid labelColor falls back to the headline color (NOT the accent)", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "Moviefied",
      labelColor: "red;}</style>",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    // headline default for MOVIEFIED (brand scrim) is #ffffff; the accent is #ff7f50.
    expect(cap.props.label.color).toBe("#ffffff");
    expect(cap.props.label.color).not.toBe("#ff7f50");
    expect(cap.props.label.color).not.toContain(";");
  });
});

// ── Round 17 FIX 4: shape-aware logo size + override ───────────────────────────

describe("cardLayoutToSpec — logoSize (Round 17 FIX 4)", () => {
  const SQUARE: CardLayout = { ...MOVIEFIED, logo: { present: true, anchor: "tr", shape: "square" } };
  const CIRCLE: CardLayout = { ...MOVIEFIED, logo: { present: true, anchor: "tr", shape: "circle" } };

  it("square/wordmark logo defaults LARGER than a circle/icon logo", () => {
    const squareSpec = cardLayoutToSpec(SQUARE, { headline: "X", channelName: "C", logoUrl: "https://cdn.x/l.png" });
    const circleSpec = cardLayoutToSpec(CIRCLE, { headline: "X", channelName: "C", logoUrl: "https://cdn.x/l.png" });
    const squareSize = (squareSpec.blocks.find((b) => b.kind === "logo") as any).props.logos[0].size;
    const circleSize = (circleSpec.blocks.find((b) => b.kind === "logo") as any).props.logos[0].size;
    expect(squareSize).toBeGreaterThan(circleSize);
  });

  it("explicit logoSize wins over the shape-aware default", () => {
    const spec = cardLayoutToSpec(SQUARE, { headline: "X", channelName: "C", logoUrl: "https://cdn.x/l.png", logoSize: 15 });
    const size = (spec.blocks.find((b) => b.kind === "logo") as any).props.logos[0].size;
    expect(size).toBe(15);
  });

  it("logoSize is clamped to [4, 40]", () => {
    const tooBig = cardLayoutToSpec(SQUARE, { headline: "X", channelName: "C", logoUrl: "https://cdn.x/l.png", logoSize: 999 });
    const tooSmall = cardLayoutToSpec(SQUARE, { headline: "X", channelName: "C", logoUrl: "https://cdn.x/l.png", logoSize: 1 });
    expect((tooBig.blocks.find((b) => b.kind === "logo") as any).props.logos[0].size).toBe(40);
    expect((tooSmall.blocks.find((b) => b.kind === "logo") as any).props.logos[0].size).toBe(4);
  });
});

// ── Round 17 FIX 5: alignment override (+ "right") ─────────────────────────────

describe("cardLayoutToSpec — alignOverride (Round 17 FIX 5)", () => {
  it("parseCardLayout allows headline.align 'right'", () => {
    const l = parseCardLayout(
      JSON.stringify({ theme: "dark", background: {}, headline: { align: "right" }, logo: {} }),
    )!;
    expect(l.headline.align).toBe("right");
  });

  it("alignOverride 'right' flows to controls.textAlign AND the pill align", () => {
    const spec = cardLayoutToSpec(MOVIEFIED, {
      headline: "X",
      channelName: "C",
      alignOverride: "right",
    });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(spec.controls.textAlign).toBe("right");
    expect(cap.props.pills[0].align).toBe("right");
  });

  it("without alignOverride → uses the reference's detected alignment", () => {
    const centered: CardLayout = { ...MOVIEFIED, headline: { variant: "plain", align: "center" } };
    const spec = cardLayoutToSpec(centered, { headline: "X", channelName: "C" });
    const cap = spec.blocks.find((b) => b.kind === "captionStack") as any;
    expect(spec.controls.textAlign).toBe("center");
    expect(cap.props.pills[0].align).toBe("center");
  });
});
