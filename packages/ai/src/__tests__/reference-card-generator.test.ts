/**
 * Tests for generateReferenceStyledCard — the Gemini img2img style-mimicry path.
 *
 * All external dependencies (generateImage, describeImageStyle, generateImageDallE,
 * overlayHeadlineAndLogo) are mocked — no network, no Puppeteer.
 *
 * Test contract:
 *  1. Rung-1 success path → engine "gemini-img2img", non-empty imageBase64.
 *  2. referenceImages assembly: [ref, hero, logo] when all provided; [ref] alone.
 *  3. textMode "ai" prompt contains headline render instruction; "overlay" contains
 *     "empty negative space" and NOT the render-headline line.
 *  4. Both prompts include the safety clause (no real person / no gibberish).
 *  5. Overlay mode calls overlayHeadlineAndLogo after rung-1; "ai" mode does NOT.
 *  6. Ladder degradation: rung-1 throws → rung-2 used → engine "openai-described".
 *     Both throw → engine "template" with empty imageBase64.
 *  7. Empty imageBase64 from rung-1 advances to rung-2.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReferenceCardDeps, GenerateReferenceStyledCardArgs, OverlayHeadlineArgs } from "../tools/reference-card-generator";

// ── helpers ──────────────────────────────────────────────────────────────────

const REF_IMAGE = { base64: "cmVm", mimeType: "image/png" };
const HERO_IMAGE = { base64: "aGVybw==", mimeType: "image/jpeg" };
const LOGO_IMAGE = { base64: "bG9nbw==", mimeType: "image/png" };

const GEMINI_OUTPUT = { imageBase64: "Z2VtaW5p", mimeType: "image/png" };
const OPENAI_OUTPUT = { imageBase64: "b3Blbg==", mimeType: "image/png" };
const OVERLAY_OUTPUT = { imageBase64: "b3ZlcmxheQ==", mimeType: "image/png" };
const COMPOSITE_OUTPUT = { imageBase64: "Y29tcG9zaXRl", mimeType: "image/png" };
const LAYOUT_EXTRACT_OUTPUT = { imageBase64: "bGF5b3V0", mimeType: "image/png" };
const SENTINEL_BBOX = { x: 100, y: 120, w: 400, h: 500 };
const MOCK_LAYOUT = { theme: "dark", accentColor: "#ff7a00", background: { mode: "photo", scrimMode: "brand" }, headline: { variant: "plain", align: "left" }, brandLabel: true, logo: { present: true, anchor: "tl", shape: "circle" }, confidence: 0.9 };

function makeDeps(overrides: Partial<ReferenceCardDeps> = {}): ReferenceCardDeps {
  return {
    generateImage: vi.fn().mockResolvedValue(GEMINI_OUTPUT),
    describeImageStyle: vi.fn().mockResolvedValue("vibrant editorial dark palette"),
    generateImageDallE: vi.fn().mockResolvedValue(OPENAI_OUTPUT),
    overlayHeadlineAndLogo: vi.fn().mockResolvedValue(OVERLAY_OUTPUT),
    // Composite-path mocks — always injected so tests NEVER launch Puppeteer.
    // Default to a successful sentinel detection + composite so a hero case
    // returns engine "gemini-composite" unless a test overrides them.
    detectSentinelRegion: vi.fn().mockResolvedValue(SENTINEL_BBOX),
    compositeHeroIntoRegion: vi.fn().mockResolvedValue(COMPOSITE_OUTPUT),
    // Layout-extract path mocks — always injected so tests NEVER call OpenAI or Puppeteer.
    // Default to a successful layout extraction + render so tests can override selectively.
    extractCardLayout: vi.fn().mockResolvedValue(MOCK_LAYOUT),
    renderLayoutCard: vi.fn().mockResolvedValue(LAYOUT_EXTRACT_OUTPUT),
    ...overrides,
  };
}

const BASE_ARGS: GenerateReferenceStyledCardArgs = {
  referenceImage: REF_IMAGE,
  headline: "Breaking: Style Mimic Now Works",
  brandName: "PostAutomation",
  textMode: "ai",
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("generateReferenceStyledCard", () => {
  // Import lazily so mocks don't need to be set up before module evaluation.
  async function load() {
    const mod = await import("../tools/reference-card-generator");
    return mod.generateReferenceStyledCard;
  }

  // ── Rung-1 success ──────────────────────────────────────────────────────────

  it("returns engine=gemini-img2img and non-empty imageBase64 on rung-1 success", async () => {
    const fn = await load();
    const deps = makeDeps();
    const result = await fn(BASE_ARGS, deps);

    expect(result.engine).toBe("gemini-img2img");
    expect(result.imageBase64).toBeTruthy();
    expect(result.mimeType).toBeTruthy();
  });

  // ── referenceImages assembly ────────────────────────────────────────────────

  it("passes [ref, hero, logo] to generateImage at the rung-1 img2img call when all three provided", async () => {
    const fn = await load();
    // With a hero, rung-0 (composite) runs FIRST, then layout-extract (rung-0b).
    // Force BOTH to bail so the ladder advances to rung-1, where the [ref,hero,logo]
    // referenceImages assembly under test happens.
    const deps = makeDeps({
      detectSentinelRegion: vi.fn().mockResolvedValue(null),   // rung-0 bails
      extractCardLayout: vi.fn().mockResolvedValue(null),       // rung-0b bails
    });

    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE, logoImage: LOGO_IMAGE }, deps);

    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    // Two generateImage calls: [0] = rung-0 sentinel (ref only), [1] = rung-1 img2img.
    const rung1Args = calls[calls.length - 1]![0] as { referenceImages: Array<{ base64: string }> };
    expect(rung1Args.referenceImages).toHaveLength(3);
    expect(rung1Args.referenceImages[0]).toMatchObject({ base64: REF_IMAGE.base64 });
    expect(rung1Args.referenceImages[1]).toMatchObject({ base64: HERO_IMAGE.base64 });
    expect(rung1Args.referenceImages[2]).toMatchObject({ base64: LOGO_IMAGE.base64 });
  });

  it("passes only [ref] when heroImage and logoImage are omitted", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn(BASE_ARGS, deps);

    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    const callArgs = calls[0]![0] as { referenceImages: Array<{ base64: string }> };
    expect(callArgs.referenceImages).toHaveLength(1);
    expect(callArgs.referenceImages[0]).toMatchObject({ base64: REF_IMAGE.base64 });
  });

  it("requests aspectRatio 4:5 from generateImage", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn(BASE_ARGS, deps);

    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    const callArgs = calls[0]![0] as { aspectRatio: string };
    expect(callArgs.aspectRatio).toBe("4:5");
  });

  // ── textMode prompt content ─────────────────────────────────────────────────

  it('textMode "ai" prompt includes headline render instruction', async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, textMode: "ai" }, deps);

    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    const prompt = (calls[0]![0] as { prompt: string }).prompt;
    // Must instruct the model to render the headline (in the reference's position)
    expect(prompt).toMatch(/Place this exact headline text/i);
    expect(prompt).toContain(BASE_ARGS.headline);
  });

  it('textMode "overlay" prompt includes empty-space instruction', async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, textMode: "overlay" }, deps);

    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    const prompt = (calls[0]![0] as { prompt: string }).prompt;
    // Must tell the model to leave headline area empty
    expect(prompt).toMatch(/empty negative space/i);
    // Must NOT contain the render-headline instruction
    expect(prompt).not.toMatch(/Place this exact headline text/i);
  });

  it("NO-hero prompt uses the strict no-real-person clause (both textModes)", async () => {
    const fn = await load();

    for (const textMode of ["ai", "overlay"] as const) {
      const deps = makeDeps();
      // BASE_ARGS has no heroImage → strict clause.
      await fn({ ...BASE_ARGS, textMode }, deps);
      const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
      const prompt = (calls[0]![0] as { prompt: string }).prompt;
      expect(prompt).toMatch(/Do NOT depict any real.*recognizable named person/i);
      expect(prompt).toMatch(/gibberish/i);
    }
  });

  it("WITH-hero prompt allows preserving the supplied person and does NOT forbid all real people", async () => {
    // The core fix: a hero photo IS a real person (celebrity-news use case). The
    // prompt must PRESERVE the supplied photo and only forbid FABRICATING a
    // different identity — never the blanket "no real person" ban that made
    // Gemini refuse every celebrity reference.
    const fn = await load();
    // With a hero, rung-0 (composite) runs FIRST, then layout-extract (rung-0b).
    // Force BOTH to bail so the ladder reaches rung-1, where the hero-aware
    // img2img prompt under test is built.
    const deps = makeDeps({
      detectSentinelRegion: vi.fn().mockResolvedValue(null),   // rung-0 bails
      extractCardLayout: vi.fn().mockResolvedValue(null),       // rung-0b bails
    });
    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);
    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    // The LAST generateImage call is rung-1 img2img (rung-0 sentinel is calls[0]).
    const prompt = (calls[calls.length - 1]![0] as { prompt: string }).prompt;
    // It must NOT carry the blanket ban...
    expect(prompt).not.toMatch(/Do NOT depict any real.*recognizable named person/i);
    // ...and it must instruct preservation of the user's supplied photo + ban identity-swap.
    expect(prompt).toMatch(/supplied photo/i);
    expect(prompt).toMatch(/do NOT alter, swap, or fabricate a different real person/i);
    expect(prompt).toMatch(/gibberish/i);
  });

  // ── overlay mode wiring ─────────────────────────────────────────────────────

  it('calls overlayHeadlineAndLogo after rung-1 in "overlay" mode', async () => {
    const fn = await load();
    const deps = makeDeps();

    const result = await fn({ ...BASE_ARGS, textMode: "overlay" }, deps);

    const overlayCalls = (deps.overlayHeadlineAndLogo as ReturnType<typeof vi.fn>).mock.calls;
    expect(overlayCalls).toHaveLength(1);
    // The overlay function receives the Gemini output as the background
    const overlayCallArgs = overlayCalls[0]![0] as { imageBase64: string };
    expect(overlayCallArgs.imageBase64).toBe(GEMINI_OUTPUT.imageBase64);
    // Final result comes from the overlay, not raw Gemini output
    expect(result.imageBase64).toBe(OVERLAY_OUTPUT.imageBase64);
  });

  it('does NOT call overlayHeadlineAndLogo in "ai" mode', async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, textMode: "ai" }, deps);

    expect((deps.overlayHeadlineAndLogo as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  // ── ladder degradation ──────────────────────────────────────────────────────

  it("advances to rung-2 when generateImage throws, returns engine=openai-described", async () => {
    const fn = await load();
    const deps = makeDeps({
      generateImage: vi.fn().mockRejectedValue(new Error("Gemini billing hold")),
    });

    const result = await fn(BASE_ARGS, deps);

    expect(result.engine).toBe("openai-described");
    expect(result.imageBase64).toBe(OPENAI_OUTPUT.imageBase64);
    expect((deps.describeImageStyle as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.generateImageDallE as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("returns engine=template with empty imageBase64 when both rungs throw", async () => {
    const fn = await load();
    const deps = makeDeps({
      generateImage: vi.fn().mockRejectedValue(new Error("Gemini down")),
      describeImageStyle: vi.fn().mockResolvedValue(null),
      generateImageDallE: vi.fn().mockRejectedValue(new Error("OpenAI down")),
    });

    const result = await fn(BASE_ARGS, deps);

    expect(result.engine).toBe("template");
    expect(result.imageBase64).toBe("");
    expect(result.mimeType).toBe("");
  });

  // ── empty image counts as rung failure ──────────────────────────────────────

  it("advances to rung-2 when generateImage returns empty imageBase64", async () => {
    const fn = await load();
    const deps = makeDeps({
      generateImage: vi.fn().mockResolvedValue({ imageBase64: "", mimeType: "image/png" }),
    });

    const result = await fn(BASE_ARGS, deps);

    expect(result.engine).toBe("openai-described");
    expect((deps.generateImageDallE as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("rung-2 overlay mode also calls overlayHeadlineAndLogo", async () => {
    const fn = await load();
    const deps = makeDeps({
      generateImage: vi.fn().mockRejectedValue(new Error("Gemini down")),
    });

    const result = await fn({ ...BASE_ARGS, textMode: "overlay" }, deps);

    expect(result.engine).toBe("openai-described");
    expect((deps.overlayHeadlineAndLogo as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(result.imageBase64).toBe(OVERLAY_OUTPUT.imageBase64);
  });
});

// ── HTML safety tests for buildOverlayHtml ────────────────────────────────────

describe("overlayHeadlineAndLogo HTML safety", () => {
  // buildOverlayHtml is the pure HTML builder; unit-testable without a browser.
  async function loadHtmlBuilder() {
    const mod = await import("../tools/reference-card-generator");
    return mod.buildOverlayHtml;
  }

  // Base opts that produce a valid card with a legit inline logo.
  const BASE_OPTS: OverlayHeadlineArgs = {
    imageBase64: "iVBORw0KGgoAAAANSUhEUg",
    mimeType: "image/png",
    width: 1080,
    height: 1350,
    headline: "A Breaking Story",
    brandName: "TestBrand",
    handle: "@testbrand",
    brandColor: "#ff7a00",
  };

  it("crafted logoMimeType with quote injection falls back to monogram — no onerror in output", async () => {
    const build = await loadHtmlBuilder();
    const html = build({
      ...BASE_OPTS,
      logoBase64: "AAAA",
      logoMimeType: 'image/png" onerror="alert(1)',
    });
    // The injected attribute must NOT appear verbatim
    expect(html).not.toContain("onerror");
    // The monogram fallback div must be present instead
    expect(html).toContain('<div style="width:44px');
  });

  it("crafted logoUrl with attribute-breakout chars falls back to monogram — no onerror in output", async () => {
    const build = await loadHtmlBuilder();
    const html = build({
      ...BASE_OPTS,
      logoUrl: 'https://evil.example/x.png" onerror="fetch(1)',
    });
    expect(html).not.toContain("onerror");
    // Monogram div present
    expect(html).toContain('<div style="width:44px');
  });

  it("XSS in headline is entity-encoded — no literal script tag in output", async () => {
    const build = await loadHtmlBuilder();
    const html = build({
      ...BASE_OPTS,
      headline: "</style><script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/style&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("CSS-injection in brandColor is rejected — default accent used, no style breakout", async () => {
    const build = await loadHtmlBuilder();
    const html = build({
      ...BASE_OPTS,
      brandColor: "red;}</style><script>x",
    });
    // The injected string must not appear
    expect(html).not.toContain("</style><script>");
    // The default accent color (#e11d48) must be used instead
    expect(html).toContain("#e11d48");
  });

  it("legitimate inline logo renders the data URL in an img src — happy path not broken", async () => {
    const build = await loadHtmlBuilder();
    const goodBase64 = "iVBORw0KGgoAAAANSUhEUg";
    const html = build({
      ...BASE_OPTS,
      logoBase64: goodBase64,
      logoMimeType: "image/png",
    });
    expect(html).toContain(`src="data:image/png;base64,${goodBase64}"`);
  });

  it("rung-2 OpenAI prompt contains the safety clause text", async () => {
    const mod = await import("../tools/reference-card-generator");
    const generateImageDallE = vi.fn().mockResolvedValue(OPENAI_OUTPUT);
    const deps = makeDeps({
      generateImage: vi.fn().mockRejectedValue(new Error("Gemini down")),
      describeImageStyle: vi.fn().mockResolvedValue("vibrant editorial"),
      generateImageDallE,
    });

    await mod.generateReferenceStyledCard(BASE_ARGS, deps);

    const promptArg = (generateImageDallE.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(promptArg).toContain("Do NOT depict any real");
  });
});

// ── Composite path (Round 11) ──────────────────────────────────────────────────

describe("findSentinelBBox (pure pixel scan)", () => {
  async function load() {
    const mod = await import("../tools/reference-card-generator");
    return mod.findSentinelBBox;
  }

  // Build an RGBA buffer with an optional magenta rectangle painted in.
  function makeBuffer(
    width: number,
    height: number,
    rect?: { x: number; y: number; w: number; h: number },
  ): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    // Fill everything with a non-magenta gray (R=G=B=128, A=255).
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = 128;
      data[i * 4 + 1] = 128;
      data[i * 4 + 2] = 128;
      data[i * 4 + 3] = 255;
    }
    if (rect) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const i = (y * width + x) * 4;
          data[i] = 255; // R high
          data[i + 1] = 0; // G low
          data[i + 2] = 255; // B high → magenta
          data[i + 3] = 255;
        }
      }
    }
    return data;
  }

  it("returns the bounding box of a magenta block", async () => {
    const findSentinelBBox = await load();
    // 100x100 image; magenta block at (20,30) sized 40x50. Use step=1 for exactness.
    const buf = makeBuffer(100, 100, { x: 20, y: 30, w: 40, h: 50 });
    const bbox = findSentinelBBox(buf, 100, 100, 1);
    expect(bbox).not.toBeNull();
    expect(bbox!.x).toBe(20);
    expect(bbox!.y).toBe(30);
    // Max edges widened by stride (1) then clamped; rightmost magenta px is x=59,
    // bottom is y=79 → w = (59+1)-20 = 40, h = (79+1)-30 = 50.
    expect(bbox!.w).toBe(40);
    expect(bbox!.h).toBe(50);
  });

  it("returns null when there is no magenta", async () => {
    const findSentinelBBox = await load();
    const buf = makeBuffer(100, 100); // all gray
    expect(findSentinelBBox(buf, 100, 100, 1)).toBeNull();
  });

  it("returns null when the magenta region is below the min-area threshold (scattered noise)", async () => {
    const findSentinelBBox = await load();
    // A 5x5 magenta speck in a 200x200 image = 25/40000 = 0.0006 < 2% threshold.
    const buf = makeBuffer(200, 200, { x: 10, y: 10, w: 5, h: 5 });
    expect(findSentinelBBox(buf, 200, 200, 1)).toBeNull();
  });

  it("returns null for a degenerate/empty buffer", async () => {
    const findSentinelBBox = await load();
    expect(findSentinelBBox(new Uint8ClampedArray(0), 0, 0)).toBeNull();
    // data too short for the declared dimensions
    expect(findSentinelBBox(new Uint8ClampedArray(4), 100, 100)).toBeNull();
  });
});

describe("buildSentinelPrompt (via generateCompositeStyledCard wiring)", () => {
  // The sentinel prompt is internal, but its content is observable through the
  // generateImage call that generateCompositeStyledCard makes.
  async function loadComposite() {
    const mod = await import("../tools/reference-card-generator");
    return mod.generateCompositeStyledCard;
  }

  it("asks Gemini for a flat magenta photo region and does NOT pass the hero in referenceImages", async () => {
    const generateCompositeStyledCard = await loadComposite();
    const generateImage = vi.fn().mockResolvedValue(GEMINI_OUTPUT);
    const deps = makeDeps({ generateImage });

    await generateCompositeStyledCard({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(generateImage).toHaveBeenCalledTimes(1);
    const call = generateImage.mock.calls[0]![0] as {
      prompt: string;
      referenceImages: Array<{ base64: string }>;
    };
    // Magenta-fill instruction present.
    expect(call.prompt).toMatch(/solid SENTINEL fill of pure magenta #FF00FF/i);
    expect(call.prompt).toMatch(/NO photo, NO person, NO face/i);
    // The hero is NEVER passed to Gemini — only the reference image.
    expect(call.referenceImages).toHaveLength(1);
    expect(call.referenceImages[0]).toMatchObject({ base64: REF_IMAGE.base64 });
    expect(call.referenceImages.some((r) => r.base64 === HERO_IMAGE.base64)).toBe(false);
  });

  it("returns null when no hero is supplied", async () => {
    const generateCompositeStyledCard = await loadComposite();
    const deps = makeDeps();
    const result = await generateCompositeStyledCard(BASE_ARGS, deps);
    expect(result).toBeNull();
    expect((deps.generateImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});

describe("composite ladder integration (Round 11)", () => {
  async function load() {
    const mod = await import("../tools/reference-card-generator");
    return mod.generateReferenceStyledCard;
  }

  it("with a hero, attempts gemini-composite FIRST and returns engine=gemini-composite on success", async () => {
    const fn = await load();
    const deps = makeDeps();

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result.engine).toBe("gemini-composite");
    expect(result.imageBase64).toBe(COMPOSITE_OUTPUT.imageBase64);
    // Sentinel generate ran; detection + composite ran; rung-1 img2img did NOT.
    expect((deps.generateImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.detectSentinelRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((deps.compositeHeroIntoRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("composite passes the detected region + the real hero (base64) to compositeHeroIntoRegion", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    const compositeArgs = (deps.compositeHeroIntoRegion as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      region: { x: number; y: number; w: number; h: number };
      heroBase64?: string;
      baseImageBase64: string;
    };
    expect(compositeArgs.region).toEqual(SENTINEL_BBOX);
    expect(compositeArgs.heroBase64).toBe(HERO_IMAGE.base64);
    // The base layer is the Gemini sentinel output.
    expect(compositeArgs.baseImageBase64).toBe(GEMINI_OUTPUT.imageBase64);
  });

  it("composite bails → layout-extract succeeds when no sentinel region is detected", async () => {
    // With the Round-11 ladder: composite (rung-0) fails → layout-extract (rung-0b)
    // is the RELIABLE fallback. It should succeed here because makeDeps injects a
    // working extractCardLayout + renderLayoutCard by default.
    const fn = await load();
    const deps = makeDeps({
      detectSentinelRegion: vi.fn().mockResolvedValue(null), // rung-0 bails
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    // Composite bailed → layout-extract took over (the reliable celebrity path).
    expect(result.engine).toBe("layout-extract");
    expect(result.imageBase64).toBe(LAYOUT_EXTRACT_OUTPUT.imageBase64);
    expect((deps.compositeHeroIntoRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // extractCardLayout was called with the reference image.
    expect((deps.extractCardLayout as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("falls through to rung-1 (gemini-img2img) when composite AND layout-extract both bail", async () => {
    const fn = await load();
    // Disable both hero rungs: no sentinel + layout extraction returns null.
    const deps = makeDeps({
      detectSentinelRegion: vi.fn().mockResolvedValue(null),   // rung-0 bails
      extractCardLayout: vi.fn().mockResolvedValue(null),       // rung-0b bails
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    // Falls through to rung-1 img2img.
    expect(result.engine).toBe("gemini-img2img");
    expect((deps.compositeHeroIntoRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // generateImage called twice: rung-0 sentinel + rung-1 img2img.
    expect((deps.generateImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("falls through to layout-extract when the sentinel Gemini call throws (refusal)", async () => {
    // Gemini REFUSES the sentinel call (celebrity face in the reference) → composite
    // bails → layout-extract is the RELIABLE fallback (no Gemini involved).
    const fn = await load();
    // First generateImage call (rung-0 sentinel) throws; layout-extract succeeds.
    const generateImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("finishReason OTHER (policy refusal)"))
      .mockResolvedValueOnce(GEMINI_OUTPUT);
    const deps = makeDeps({ generateImage });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result.engine).toBe("layout-extract");
    expect(result.imageBase64).toBe(LAYOUT_EXTRACT_OUTPUT.imageBase64);
    expect((deps.compositeHeroIntoRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("falls through to rung-1 when sentinel throws AND layout-extract bails", async () => {
    const fn = await load();
    const generateImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("finishReason OTHER (policy refusal)"))
      .mockResolvedValueOnce(GEMINI_OUTPUT);
    const deps = makeDeps({
      generateImage,
      extractCardLayout: vi.fn().mockResolvedValue(null), // layout-extract bails
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result.engine).toBe("gemini-img2img");
    expect((deps.compositeHeroIntoRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("falls through to rung-2 (openai-described) when composite bails AND layout-extract bails AND rung-1 throws", async () => {
    const fn = await load();
    const deps = makeDeps({
      detectSentinelRegion: vi.fn().mockResolvedValue(null),   // rung-0 bails
      extractCardLayout: vi.fn().mockResolvedValue(null),       // rung-0b bails
      generateImage: vi.fn().mockRejectedValue(new Error("Gemini billing hold")), // rung-1 throws
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result.engine).toBe("openai-described");
    expect(result.imageBase64).toBe(OPENAI_OUTPUT.imageBase64);
  });

  it("does NOT attempt the composite rung when no hero is supplied (existing ladder unchanged)", async () => {
    const fn = await load();
    const deps = makeDeps();

    const result = await fn(BASE_ARGS, deps); // no heroImage

    expect(result.engine).toBe("gemini-img2img");
    expect((deps.detectSentinelRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((deps.compositeHeroIntoRegion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("composite overlay mode composites the headline after pasting the hero", async () => {
    const fn = await load();
    const deps = makeDeps();

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE, textMode: "overlay" }, deps);

    expect(result.engine).toBe("gemini-composite");
    // overlayHeadlineAndLogo runs over the composited (hero-pasted) image.
    const overlayCall = (deps.overlayHeadlineAndLogo as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      imageBase64: string;
    };
    expect(overlayCall.imageBase64).toBe(COMPOSITE_OUTPUT.imageBase64);
    expect(result.imageBase64).toBe(OVERLAY_OUTPUT.imageBase64);
  });
});

// ── resolveHeroSrc / buildCompositeHtml safety ─────────────────────────────────

describe("resolveHeroSrc + buildCompositeHtml safety", () => {
  async function load() {
    return import("../tools/reference-card-generator");
  }

  const REGION = { x: 100, y: 120, w: 400, h: 500 };

  it("resolveHeroSrc assembles a clean data URL from inline base64", async () => {
    const { resolveHeroSrc } = await load();
    const src = resolveHeroSrc({
      baseImageBase64: "AAAA",
      baseMimeType: "image/png",
      region: REGION,
      width: 1080,
      height: 1350,
      heroBase64: "aGVybw==",
      heroMimeType: "image/jpeg",
    });
    expect(src).toBe("data:image/jpeg;base64,aGVybw==");
  });

  it("resolveHeroSrc rejects a crafted heroMimeType with attribute-breakout chars", async () => {
    const { resolveHeroSrc } = await load();
    const src = resolveHeroSrc({
      baseImageBase64: "AAAA",
      baseMimeType: "image/png",
      region: REGION,
      width: 1080,
      height: 1350,
      heroBase64: "AAAA",
      heroMimeType: 'image/png" onerror="alert(1)',
    });
    expect(src).toBeNull();
  });

  it("resolveHeroSrc returns null when no hero source is provided", async () => {
    const { resolveHeroSrc } = await load();
    const src = resolveHeroSrc({
      baseImageBase64: "AAAA",
      baseMimeType: "image/png",
      region: REGION,
      width: 1080,
      height: 1350,
    });
    expect(src).toBeNull();
  });

  it("buildCompositeHtml positions the hero at the detected region over the base", async () => {
    const { buildCompositeHtml } = await load();
    const html = buildCompositeHtml(
      {
        baseImageBase64: "QkFTRQ==",
        baseMimeType: "image/png",
        region: REGION,
        width: 1080,
        height: 1350,
        heroBase64: "aGVybw==",
        heroMimeType: "image/jpeg",
      },
      "data:image/jpeg;base64,aGVybw==",
    );
    expect(html).toContain("data:image/png;base64,QkFTRQ==");
    expect(html).toContain('src="data:image/jpeg;base64,aGVybw=="');
    // Region geometry interpolated into the hero layer.
    expect(html).toContain("left:100px");
    expect(html).toContain("top:120px");
    expect(html).toContain("width:400px");
    expect(html).toContain("height:500px");
  });

  it("buildCompositeHtml clamps a region that overflows the card bounds", async () => {
    const { buildCompositeHtml } = await load();
    const html = buildCompositeHtml(
      {
        baseImageBase64: "QkFTRQ==",
        baseMimeType: "image/png",
        // x+w overflows width; y+h overflows height → clamped.
        region: { x: 1000, y: 1300, w: 500, h: 500 },
        width: 1080,
        height: 1350,
        heroBase64: "aGVybw==",
        heroMimeType: "image/jpeg",
      },
      "data:image/jpeg;base64,aGVybw==",
    );
    // w clamped to width-x = 80, h clamped to height-y = 50.
    expect(html).toContain("left:1000px");
    expect(html).toContain("top:1300px");
    expect(html).toContain("width:80px");
    expect(html).toContain("height:50px");
  });
});

// ── generateLayoutExtractCard unit tests (Round 11) ───────────────────────────

describe("generateLayoutExtractCard", () => {
  async function load() {
    const mod = await import("../tools/reference-card-generator");
    return mod.generateLayoutExtractCard;
  }

  it("returns engine=layout-extract when extractCardLayout returns a layout and renderLayoutCard returns an image", async () => {
    const fn = await load();
    const deps = makeDeps();

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result).not.toBeNull();
    expect(result!.engine).toBe("layout-extract");
    expect(result!.imageBase64).toBe(LAYOUT_EXTRACT_OUTPUT.imageBase64);
    expect(result!.mimeType).toBe(LAYOUT_EXTRACT_OUTPUT.mimeType);
  });

  it("passes the hero as a data URL heroImageUrl and brandName as channelName to renderLayoutCard", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    const renderCalls = (deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls;
    expect(renderCalls).toHaveLength(1);
    const contentArg = renderCalls[0]![1] as {
      headline: string;
      heroImageUrl?: string;
      channelName: string;
    };
    // Hero must be passed as a data: URL (pixel-real, never re-encoded by an AI).
    expect(contentArg.heroImageUrl).toBe(`data:${HERO_IMAGE.mimeType};base64,${HERO_IMAGE.base64}`);
    // channelName must come from brandName.
    expect(contentArg.channelName).toBe(BASE_ARGS.brandName);
    expect(contentArg.headline).toBe(BASE_ARGS.headline);
  });

  it("passes brandColor (safeColor-sanitized) to renderLayoutCard when provided", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE, brandColor: "#ff7a00" }, deps);

    const renderCalls = (deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls;
    const contentArg = renderCalls[0]![1] as { brandColor?: string };
    expect(contentArg.brandColor).toBe("#ff7a00");
  });

  it("passes the layout (from extractCardLayout) as first arg to renderLayoutCard", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    const renderCalls = (deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls;
    const layoutArg = renderCalls[0]![0];
    expect(layoutArg).toEqual(MOCK_LAYOUT);
  });

  it("passes logoUrl as a data URL when logoImage is provided", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE, logoImage: LOGO_IMAGE }, deps);

    const renderCalls = (deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls;
    const contentArg = renderCalls[0]![1] as { logoUrl?: string };
    expect(contentArg.logoUrl).toBe(`data:${LOGO_IMAGE.mimeType};base64,${LOGO_IMAGE.base64}`);
  });

  it("returns null when no heroImage is supplied", async () => {
    const fn = await load();
    const deps = makeDeps();

    const result = await fn(BASE_ARGS, deps); // no heroImage

    expect(result).toBeNull();
    expect((deps.extractCardLayout as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("returns null when extractCardLayout returns null", async () => {
    const fn = await load();
    const deps = makeDeps({
      extractCardLayout: vi.fn().mockResolvedValue(null),
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result).toBeNull();
    expect((deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("returns null when renderLayoutCard throws", async () => {
    const fn = await load();
    const deps = makeDeps({
      renderLayoutCard: vi.fn().mockRejectedValue(new Error("Puppeteer crash")),
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result).toBeNull();
  });

  it("returns null when renderLayoutCard returns empty imageBase64", async () => {
    const fn = await load();
    const deps = makeDeps({
      renderLayoutCard: vi.fn().mockResolvedValue({ imageBase64: "", mimeType: "image/png" }),
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result).toBeNull();
  });
});

// ── Ladder order: layout-extract before gemini-img2img (Round 11) ─────────────

describe("layout-extract ladder order (Round 11)", () => {
  async function load() {
    const mod = await import("../tools/reference-card-generator");
    return mod.generateReferenceStyledCard;
  }

  it("with a hero, layout-extract runs BEFORE gemini-img2img (rung-1): when it succeeds, generateImage is NOT called for rung-1", async () => {
    // composite bails → layout-extract succeeds → rung-1 must NOT run.
    const fn = await load();
    const generateImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("finishReason OTHER (sentinel call for composite)"))
      .mockResolvedValue(GEMINI_OUTPUT); // this would be the rung-1 call
    const deps = makeDeps({ generateImage }); // extractCardLayout returns MOCK_LAYOUT by default

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    // layout-extract should have won
    expect(result.engine).toBe("layout-extract");
    // generateImage was called once (rung-0 sentinel which threw) — NOT for rung-1
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect((deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("no-hero path: layout-extract is skipped entirely, ladder goes directly to gemini-img2img", async () => {
    // BASE_ARGS has no heroImage — the no-hero ladder must be byte-identical to pre-Round-11.
    const fn = await load();
    const deps = makeDeps();

    const result = await fn(BASE_ARGS, deps);

    // extractCardLayout never called (no hero to place)
    expect((deps.extractCardLayout as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((deps.renderLayoutCard as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    // Falls straight to rung-1 (gemini-img2img)
    expect(result.engine).toBe("gemini-img2img");
    // generateImage called exactly once (rung-1, no composite sentinel call since no hero)
    expect((deps.generateImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("layout-extract engine beats gemini-img2img in the result when both hero rungs work", async () => {
    // With default makeDeps: composite succeeds → returns gemini-composite.
    // To see layout-extract win over img2img we need composite to fail.
    const fn = await load();
    const deps = makeDeps({
      detectSentinelRegion: vi.fn().mockResolvedValue(null), // composite bails
      // extractCardLayout + renderLayoutCard succeed by default
    });

    const result = await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);

    expect(result.engine).toBe("layout-extract");
    // rung-1 generateImage was NOT called (layout-extract returned before it)
    // The only generateImage call is the rung-0 sentinel which returned "no sentinel"
    expect((deps.generateImage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
