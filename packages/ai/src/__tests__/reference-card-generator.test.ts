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

function makeDeps(overrides: Partial<ReferenceCardDeps> = {}): ReferenceCardDeps {
  return {
    generateImage: vi.fn().mockResolvedValue(GEMINI_OUTPUT),
    describeImageStyle: vi.fn().mockResolvedValue("vibrant editorial dark palette"),
    generateImageDallE: vi.fn().mockResolvedValue(OPENAI_OUTPUT),
    overlayHeadlineAndLogo: vi.fn().mockResolvedValue(OVERLAY_OUTPUT),
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

  it("passes [ref, hero, logo] to generateImage when all three provided", async () => {
    const fn = await load();
    const deps = makeDeps();

    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE, logoImage: LOGO_IMAGE }, deps);

    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    const callArgs = calls[0]![0] as { referenceImages: Array<{ base64: string }> };
    expect(callArgs.referenceImages).toHaveLength(3);
    expect(callArgs.referenceImages[0]).toMatchObject({ base64: REF_IMAGE.base64 });
    expect(callArgs.referenceImages[1]).toMatchObject({ base64: HERO_IMAGE.base64 });
    expect(callArgs.referenceImages[2]).toMatchObject({ base64: LOGO_IMAGE.base64 });
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
    const deps = makeDeps();
    await fn({ ...BASE_ARGS, heroImage: HERO_IMAGE }, deps);
    const calls = (deps.generateImage as ReturnType<typeof vi.fn>).mock.calls;
    const prompt = (calls[0]![0] as { prompt: string }).prompt;
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
