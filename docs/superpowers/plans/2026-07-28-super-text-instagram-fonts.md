# Super Text — Instagram Font Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a font picker to the Super Text video overlay with two options — **Classic** (today's exact rendering) and **Sans** (an Instagram-Sans-alike) — without changing a single pixel of any existing post's output.

**Architecture:** A font **registry** in `packages/super-text/src/constants.ts` maps a `z.enum` key to a CSS spec (stack, weight, letter-spacing, optional embedded font). The new `font` field on `SuperTextConfig` is **optional**, and an absent value resolves to `classic`, whose spec reproduces the current CSS byte-for-byte. The "Sans" face is embedded as a **base64 data-URI `@font-face`** emitted by the same shared builder that already feeds both the compose preview and the worker burn — so preview and burn use literally the same font bytes and cannot drift. No font is installed into the Docker image, which sidesteps the workspace-package Docker trap entirely.

**Tech Stack:** TypeScript, zod, React (Next.js), Puppeteer (worker burn), ffmpeg, Vitest.

---

## Context an engineer needs before touching this

Read [CLAUDE.md](../../../CLAUDE.md) § "Super Text — burned-in video text strip" first. The five invariants that govern this change:

1. **ONE renderer for preview AND burn.** [packages/super-text/src/html.ts](../../../packages/super-text/src/html.ts) is consumed by the React preview ([super-text-strip.tsx](../../../apps/web/components/content-agent/super-text-strip.tsx), via `dangerouslySetInnerHTML`) *and* by the worker's Puppeteer page ([super-text.worker.ts](../../../apps/worker/src/workers/super-text.worker.ts)). This exists because of the REP-4 revert, where a preview drawn by a parallel path drifted from the baked artifact and the user shipped an image they never saw. **Do not add a second rendering path for fonts.**
2. **Posting without super text must stay byte-identical.** Absent `metadata.superText`, every touched path takes its pre-feature branch. Locked by [super-text-plan.test.ts](../../../packages/api/src/__tests__/super-text-plan.test.ts) and [super-text-payload.test.ts](../../../apps/web/lib/super-text-payload.test.ts).
3. **All user text goes through `escapeHtml`; all colours through `safeHexColor` (`^#[0-9a-fA-F]{6}$`).** The builder generates 100% of the markup and never accepts user HTML. **The font key must join this discipline** — see Issue A.
4. **Geometry is `em`-based off ONE font-size and positions are percentages**, so the ~280px preview stage and a 1080px video lay out identically.
5. **Retry idempotency:** `metadata.superText.results[mediaId].status === "done"` means a BullMQ retry never re-burns. The S3 key carries a config hash.

### Why fonts are riskier here than they look

The current stack is `Arial, 'Liberation Sans', 'Helvetica Neue', Helvetica, sans-serif` ([constants.ts:14-15](../../../packages/super-text/src/constants.ts#L14)). That pairing is **deliberate**: Liberation Sans (installed in the worker image) is metric-compatible with Arial (the client's font), so **line-wrap points match across environments**. Since the strip is width-clamped at `STRIP_MAX_WIDTH_PCT = 88`, a font with different glyph advance widths breaks at different words → a different number of lines → a different strip height → a burn that does not match the preview the user positioned.

This is why we embed the font rather than install it: a data-URI `@font-face` in the shared HTML makes "same font in both environments" structurally true instead of a deployment promise.

---

## Decisions already made (do not relitigate)

| Decision | Choice | Why |
|---|---|---|
| Font files | Open-licensed (SIL OFL) metric-alikes, tuned for maximum visual fidelity | Instagram Sans is Meta's proprietary typeface and is not licensed for third-party redistribution. Choosing a legitimately-licensed font that *resembles* it is normal practice and carries no exposure; shipping Meta's binary in a commercial product would. |
| "Classic" | Today's exact sans stack | Zero new font file, existing burns stay cache-valid, existing renders byte-identical, all 22 existing tests keep passing. |
| "Sans" face | **DM Sans 700** | Closest OFL match to Instagram Sans: geometric with a **double-storey `a`** and large x-height. (Poppins is often suggested but has a *single-storey* `a`, which reads visibly different.) Tuned with `letter-spacing: -0.012em` to match Instagram's tighter display tracking. |
| Delivery | base64 data-URI `@font-face` from the shared builder | Guarantees preview/burn parity; requires a `document.fonts.ready` wait in the worker (Issue B). |
| UI labels | `Classic` / `Sans` | Matches Instagram's own picker, which labels styles ("Classic", "Modern"…) rather than naming the typeface. Change the `label` field in the registry if you want different wording — it is the only place labels live. |
| Internal font family name | `PA Display Sans` | Never name the embedded family "Instagram Sans" — the file is DM Sans, and mislabelling it in shipped CSS would be a false claim. |

---

## Additional issues found during investigation

These are **real defects or hazards in the current code** that this change either must handle or would otherwise trip over. Severity is about what happens if ignored.

### 🔴 A. A free-text font field would be a CSS-injection vector

`buildStripInnerHtml` interpolates the font stack directly into a `style="…"` attribute. [constants.ts:11-12](../../../packages/super-text/src/constants.ts#L11) already warns that single quotes inside those strings are **required** because double quotes would terminate the attribute.

If `font` were `z.string()`, a value like `Arial;background:url(https://evil/x)` or one containing `"` would break out of the attribute — reachable not only from the UI but from a **restored localStorage draft** or a **hand-written DB row**, which is exactly the threat model `safeHexColor` exists for.

**Handling:** `font` is a `z.enum(["classic","sans"])`, and the CSS is fetched from a registry **by key**. The config value is *never* interpolated. Task 1 + Task 2, locked by a test that a bogus/injecting key falls back to `classic`.

Prototype-pollution note: resolve with an **array `includes` check**, not `key in SUPER_TEXT_FONTS` — `in` would match `__proto__`, `constructor`, `toString`.

### 🔴 B. The worker screenshots before webfonts load → silent fallback

[super-text.worker.ts:113-118](../../../apps/worker/src/workers/super-text.worker.ts#L113):

```ts
await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
const png = (await page.screenshot({ type: "png", omitBackground: true, encoding: "base64" })) as string;
```

`waitUntil: "load"` **does not wait for `@font-face` fonts**. Chromium screenshots immediately, so the burn renders in the *fallback* face while the preview showed the real one. It fails **silently** — no error, just a video whose text doesn't match what the user positioned. This is precisely the preview≠burn drift the architecture exists to prevent.

The existing comment ("the page is fully self-contained inline HTML") is true today and is exactly why this was safe before — embedding a font is what invalidates it.

**Handling:** Task 5 adds an explicit `document.fonts.load(...)` + `document.fonts.ready` await, bounded by a timeout so a font problem can never hang the burn.

### 🟠 C. A required `font` field would break existing drafts and posts

Three populations already hold `SuperTextConfig` objects with no `font` key:
- rows in `Post.metadata.superText` (posts already burned, or mid-flight)
- localStorage compose drafts — `draftMediaSignature` includes `superText`, and restore re-validates via zod
- the burn cache: the S3 key hash is `sha1(JSON.stringify(parsed.data))` ([super-text.worker.ts:254-258](../../../apps/worker/src/workers/super-text.worker.ts#L254))

CLAUDE.md is explicit that "a stale draft can never 400 the whole post", and [super-text-payload.test.ts](../../../apps/web/lib/super-text-payload.test.ts) locks "drops an invalid restored config instead of failing the whole post".

**Handling:** `font` is `.optional()` and **not** `.default()`. `.default("classic")` would make zod *inject* the key, changing `JSON.stringify` output → a different hash for every pre-existing config → needless re-burns. Optional-and-absent serialises identically, so **existing cached burns stay valid**. Task 2.

### 🟠 D. Emoji stack must stay appended, or 😍 becomes tofu

Current: `font-family:${SUPER_TEXT_FONT_STACK}, ${SUPER_TEXT_EMOJI_STACK}`. The Dockerfile note ([Dockerfile.worker:7](../../../docker/Dockerfile.worker#L7)) exists because without `font-noto-emoji` the user's emoji burn as tofu. A per-font stack that forgets to append `SUPER_TEXT_EMOJI_STACK` reintroduces that bug.

**Handling:** the emoji stack is appended in `buildStripInnerHtml`, *outside* the registry, so it is impossible for a registry entry to omit it. Task 4 test asserts the emoji stack is present for **every** font key.

### 🟠 E. Synthetic bold would differ between environments

`STRIP_FONT_WEIGHT = 700`. If the embedded file were a Regular weight, Chromium would **synthesise** fake bold — and synthetic-bold rasterisation differs between macOS and Alpine Chromium, so preview and burn would diverge even with identical bytes.

**Handling:** embed the **actual 700 weight** file and declare `font-weight: 700` in the `@font-face`. Task 3 verification asserts the downloaded file is the 700 cut.

### 🟡 F. Non-Latin text falls back (not a regression, but know it)

DM Sans has no Devanagari/Arabic/CJK coverage. For an India-based operation this matters. Chromium will fall back **per glyph** to `font-noto` (already installed in the worker) and to the OS font in the browser — which is **exactly what happens today** with Arial/Liberation Sans, so this is not a regression. But mixed-script text may wrap slightly differently between environments.

**Handling:** embed the `latin` subset, keep the existing stack as the fallback chain behind the embedded family, and add a Devanagari test case documenting the fallback. Task 4. Not blocking; noted for honesty.

### 🟡 G. `font-display` must be `block`, not `swap`

With `swap`, the preview paints in the fallback first, then reflows. The user could drag the strip into position against fallback metrics and have it settle elsewhere. `block` shows nothing briefly instead of showing a lie.

**Handling:** Task 4 emits `font-display: block`.

### 🟡 H. Mobile: the controls row gains a third group

The editor's control row is `flex flex-wrap items-center gap-x-4 gap-y-2` holding Strip colour, Text colour, and the size picker. Adding a font picker makes four. This repo has a history of mobile-responsiveness regressions (PRs #107, #109). Task 7 includes a 390px check.

### 🟢 I. Docker image needs **no** change — and that is a deliberate win

Because the font is embedded as a data URI, `docker/Dockerfile.worker` needs **no new font package**. This deliberately avoids CLAUDE.md quirk #10 (the two-line workspace-package trap) and the fact that `.dockerignore` is **empty**, which makes a local `docker build` an invalid deploy check. `packages/super-text` is already wired into both Dockerfile lists ([lines 34 and 54](../../../docker/Dockerfile.worker#L34)) — verify, change nothing.

Task 9 still runs a clean-tree build + real worker boot, because the *bundle size* of the new base64 module is the only thing that could surprise us.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `packages/super-text/src/fonts/dm-sans-700-latin.ts` | **Create** | Generated: the base64 woff2 payload as a single exported string. Machine-written, never hand-edited. |
| `packages/super-text/src/fonts/README.md` | **Create** | How the payload was generated + how to regenerate or swap in a licensed face. |
| `scripts/gen-super-text-font.mjs` | **Create** | Reproducible generator for the above (fetch → verify → base64 → emit). |
| `packages/super-text/src/constants.ts` | **Modify** | Add the font registry, the prototype-safe resolver, and `SUPER_TEXT_FONT_KEYS`. Existing exports untouched. |
| `packages/super-text/src/schema.ts` | **Modify** | Add optional `font` field. |
| `packages/super-text/src/html.ts` | **Modify** | Resolve the font spec; emit `@font-face` CSS; keep the classic path byte-identical. |
| `packages/super-text/src/index.ts` | **Modify** | Export the new symbols. |
| `packages/super-text/src/__tests__/super-text.test.ts` | **Modify** | Add font tests alongside the existing 22. |
| `packages/super-text/src/__tests__/super-text-fonts.test.ts` | **Create** | Registry, injection-safety, byte-identity, parity tests. |
| `packages/super-text/src/__tests__/super-text-render-golden.test.ts` | **Create** | 🔒 Golden gate. Snapshots the default render; must pass with **0 written** after the change. |
| `apps/web/components/content-agent/super-text-strip.tsx` | **Modify** | Consume the resolved stack (already does, via the builder) — no change expected; verify. |
| `apps/web/components/content-agent/super-text-font-faces.tsx` | **Create** | Injects every `@font-face` **once** per editor mount. |
| `apps/web/components/content-agent/SuperTextEditor.tsx` | **Modify** | Font picker + mount the font-faces component + thread `font` through save. |
| `apps/worker/src/workers/super-text.worker.ts` | **Modify** | Await font readiness before screenshot (Issue B). |

---

## Task 1: Font registry + prototype-safe resolver

**Files:**
- Modify: `packages/super-text/src/constants.ts`
- Create: `packages/super-text/src/__tests__/super-text-fonts.test.ts`

This task adds the registry with the **`sans` entry pointing at an empty payload** so it can land and be tested before the font file exists. Task 3 fills the payload in.

- [ ] **Step 1: Write the failing test**

Create `packages/super-text/src/__tests__/super-text-fonts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  SUPER_TEXT_FONTS,
  SUPER_TEXT_FONT_KEYS,
  DEFAULT_SUPER_TEXT_FONT,
  resolveSuperTextFont,
  SUPER_TEXT_FONT_STACK,
  STRIP_FONT_WEIGHT,
} from "../constants";

describe("super text font registry", () => {
  it("exposes exactly the two supported keys", () => {
    expect(SUPER_TEXT_FONT_KEYS).toEqual(["classic", "sans"]);
  });

  it("defaults to classic", () => {
    expect(DEFAULT_SUPER_TEXT_FONT).toBe("classic");
  });

  it("classic reproduces today's stack, weight and zero tracking exactly", () => {
    const classic = SUPER_TEXT_FONTS.classic;
    expect(classic.stack).toBe(SUPER_TEXT_FONT_STACK);
    expect(classic.weight).toBe(STRIP_FONT_WEIGHT);
    expect(classic.letterSpacingEm).toBe(0);
    // No embedded payload => no @font-face => nothing new can affect the render.
    expect(classic.embedded).toBeNull();
  });

  it("sans keeps the classic stack as its fallback chain", () => {
    // A missing glyph (e.g. Devanagari) must still resolve via the old stack.
    expect(SUPER_TEXT_FONTS.sans.stack).toContain(SUPER_TEXT_FONT_STACK);
  });

  it("resolves a known key", () => {
    expect(resolveSuperTextFont("sans")).toBe(SUPER_TEXT_FONTS.sans);
    expect(resolveSuperTextFont("classic")).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("falls back to classic for undefined, null and empty", () => {
    expect(resolveSuperTextFont(undefined)).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont(null)).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont("")).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("falls back to classic for a CSS-injection attempt (never interpolates input)", () => {
    const evil = `Arial;background:url(https://evil.example/x);`;
    expect(resolveSuperTextFont(evil)).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont(`x" onload="alert(1)`)).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("is not fooled by prototype keys (uses an allowlist, not `in`)", () => {
    expect(resolveSuperTextFont("__proto__")).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont("constructor")).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont("toString")).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("every registry stack is free of attribute-terminating double quotes", () => {
    // The stack is interpolated into style="…"; a double quote would break out.
    for (const key of SUPER_TEXT_FONT_KEYS) {
      expect(SUPER_TEXT_FONTS[key].stack).not.toContain('"');
    }
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @postautomation/super-text test -- super-text-fonts`
Expected: FAIL — `SUPER_TEXT_FONTS` is not exported from `../constants`.

- [ ] **Step 3: Implement the registry**

In `packages/super-text/src/constants.ts`, **append** after the existing `WORD_COLOR_SWATCHES` block (leave every existing export untouched):

```ts
/* ─── Font options ──────────────────────────────────────────────────────────
 * The picker's keys are a CLOSED SET and the CSS is looked up BY KEY. The
 * config value is never interpolated into the style attribute — same discipline
 * as safeHexColor. See docs/superpowers/plans/2026-07-28-super-text-instagram-fonts.md
 * issue A.
 *
 * `classic` reproduces the pre-picker CSS exactly (same stack, same weight, no
 * letter-spacing declaration at all), so an existing config with no `font` key
 * renders byte-identically and its cached burn stays valid.
 */
export const SUPER_TEXT_FONT_KEYS = ["classic", "sans"] as const;
export type SuperTextFontKey = (typeof SUPER_TEXT_FONT_KEYS)[number];

/** Internal family name for the embedded face. Deliberately NOT "Instagram
 *  Sans" — the file is DM Sans, and naming it otherwise in shipped CSS would be
 *  a false claim about a proprietary Meta typeface. */
export const EMBEDDED_SANS_FAMILY = "PA Display Sans";

export interface SuperTextFontSpec {
  /** Shown in the editor's picker. The only place UI wording lives. */
  label: string;
  /** CSS font-family list. MUST NOT contain a double quote (see tests). */
  stack: string;
  weight: number;
  /** 0 means "emit no letter-spacing declaration at all" (byte-identity). */
  letterSpacingEm: number;
  /** null = rely on system/OS fonts, no @font-face emitted. */
  embedded: { family: string; base64: string } | null;
}

export const DEFAULT_SUPER_TEXT_FONT: SuperTextFontKey = "classic";

export const SUPER_TEXT_FONTS: Record<SuperTextFontKey, SuperTextFontSpec> = {
  classic: {
    label: "Classic",
    stack: SUPER_TEXT_FONT_STACK,
    weight: STRIP_FONT_WEIGHT,
    letterSpacingEm: 0,
    embedded: null,
  },
  sans: {
    label: "Sans",
    // Embedded family first, then the classic stack as the fallback chain so a
    // glyph DM Sans lacks (Devanagari, CJK) still resolves — issue F.
    stack: `'${EMBEDDED_SANS_FAMILY}', ${SUPER_TEXT_FONT_STACK}`,
    weight: 700,
    // Instagram's display text is tracked slightly tighter than DM Sans's
    // default. This is the fidelity dial — adjust here, nowhere else.
    letterSpacingEm: -0.012,
    embedded: { family: EMBEDDED_SANS_FAMILY, base64: DM_SANS_700_LATIN_WOFF2_BASE64 },
  },
};

/**
 * Allowlist lookup — deliberately `includes` on the key array and NOT
 * `key in SUPER_TEXT_FONTS`, because `in` would match `__proto__`,
 * `constructor` and `toString` and return a garbage spec.
 */
export function resolveSuperTextFont(key: string | undefined | null): SuperTextFontSpec {
  const ok =
    typeof key === "string" && (SUPER_TEXT_FONT_KEYS as readonly string[]).includes(key);
  return SUPER_TEXT_FONTS[ok ? (key as SuperTextFontKey) : DEFAULT_SUPER_TEXT_FONT];
}
```

Add this import at the **top** of `constants.ts`:

```ts
import { DM_SANS_700_LATIN_WOFF2_BASE64 } from "./fonts/dm-sans-700-latin";
```

- [ ] **Step 4: Create a placeholder payload so the module resolves**

Create `packages/super-text/src/fonts/dm-sans-700-latin.ts`:

```ts
/**
 * GENERATED FILE — do not hand-edit.
 * Regenerate with: node scripts/gen-super-text-font.mjs
 *
 * DM Sans 700 (latin subset), SIL Open Font License 1.1.
 * Empty until Task 3 runs; an empty payload makes buildSuperTextFontFaceCss
 * emit nothing, so the render safely falls back to the classic stack.
 */
export const DM_SANS_700_LATIN_WOFF2_BASE64 = "";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @postautomation/super-text test`
Expected: PASS — the 8 new font tests plus all 22 pre-existing tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/super-text/src/constants.ts \
        packages/super-text/src/fonts/dm-sans-700-latin.ts \
        packages/super-text/src/__tests__/super-text-fonts.test.ts
git commit -m "feat(super-text): font registry with prototype-safe key resolver"
```

---

## Task 2: Optional `font` field on the schema

**Files:**
- Modify: `packages/super-text/src/schema.ts`
- Modify: `packages/super-text/src/__tests__/super-text-fonts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/super-text/src/__tests__/super-text-fonts.test.ts`:

```ts
import { superTextConfigSchema } from "../schema";

const baseConfig = {
  version: 1 as const,
  segments: [{ text: "Ranveer" }, { text: "returns", color: "#EF4444" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

describe("superTextConfigSchema — font field", () => {
  it("accepts a config with NO font (every pre-existing draft and DB row)", () => {
    const parsed = superTextConfigSchema.safeParse(baseConfig);
    expect(parsed.success).toBe(true);
  });

  it("does NOT inject a font key when absent — the burn cache hash must not shift", () => {
    const parsed = superTextConfigSchema.parse(baseConfig);
    expect("font" in parsed).toBe(false);
    // The worker keys S3 objects on sha1(JSON.stringify(parsed)); if zod
    // defaulted this field, every existing config would re-burn for nothing.
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(baseConfig));
  });

  it("accepts both supported font keys", () => {
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "classic" }).success).toBe(true);
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "sans" }).success).toBe(true);
  });

  it("rejects an unknown font key at the boundary", () => {
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "comic-sans" }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "__proto__" }).success).toBe(false);
  });

  it("rejects a font key carrying CSS (defence in depth with the resolver)", () => {
    const evil = { ...baseConfig, font: `Arial;background:url(https://evil.example/x)` };
    expect(superTextConfigSchema.safeParse(evil).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @postautomation/super-text test -- super-text-fonts`
Expected: FAIL — `font: "comic-sans"` is currently accepted (zod strips unknown keys rather than rejecting), so the "rejects an unknown font key" assertions fail.

- [ ] **Step 3: Add the field**

In `packages/super-text/src/schema.ts`, add this import at the top:

```ts
import { SUPER_TEXT_FONT_KEYS } from "./constants";
```

Then add the field inside `superTextConfigSchema`, immediately after `fontSizePct`:

```ts
  /**
   * Which typeface to render. OPTIONAL and deliberately NOT `.default()`:
   * zod's default would INJECT the key, changing JSON.stringify output and
   * therefore the worker's S3 config hash for every pre-existing config —
   * forcing needless re-burns. Absent => resolveSuperTextFont() => "classic",
   * which reproduces the pre-picker CSS exactly.
   */
  font: z.enum(SUPER_TEXT_FONT_KEYS).optional(),
```

> `z.enum` requires a non-empty readonly tuple, which `SUPER_TEXT_FONT_KEYS` (declared `as const`) satisfies. If tsc complains about the tuple type, widen with `z.enum(SUPER_TEXT_FONT_KEYS as unknown as [string, ...string[]])` — but try the direct form first.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @postautomation/super-text test`
Expected: PASS — all font tests plus the original 22.

- [ ] **Step 5: Verify no circular import**

`constants.ts` imports from `./fonts/...` and `schema.ts` imports from `./constants` — a chain, not a cycle.

Run: `pnpm --filter @postautomation/super-text exec tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add packages/super-text/src/schema.ts packages/super-text/src/__tests__/super-text-fonts.test.ts
git commit -m "feat(super-text): optional font enum on SuperTextConfig (absent = classic)"
```

---

## Task 3: Generate and embed the DM Sans 700 payload

**Files:**
- Create: `scripts/gen-super-text-font.mjs`
- Create: `packages/super-text/src/fonts/README.md`
- Modify: `packages/super-text/src/fonts/dm-sans-700-latin.ts` (generated)

- [ ] **Step 1: Write the generator**

Create `scripts/gen-super-text-font.mjs`:

```js
/**
 * Regenerates packages/super-text/src/fonts/dm-sans-700-latin.ts.
 *
 * Fetches the LATIN subset of DM Sans at weight 700 from Google Fonts and emits
 * it as a base64 woff2 string. Google serves woff2 only to a modern UA, so the
 * User-Agent header below is load-bearing.
 *
 * Usage: node scripts/gen-super-text-font.mjs
 */
import { writeFileSync } from "node:fs";

const CSS_URL = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@700&display=block";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT = "packages/super-text/src/fonts/dm-sans-700-latin.ts";

const css = await (await fetch(CSS_URL, { headers: { "User-Agent": UA } })).text();

// Google's CSS emits one @font-face per subset, each preceded by a /* subset */
// comment. Take the block commented `latin` (NOT latin-ext, which is a
// different, larger file).
const blocks = css.split("/*").map((b) => "/*" + b);
const latin = blocks.find((b) => b.startsWith("/* latin */"));
if (!latin) throw new Error("no /* latin */ block in the Google Fonts CSS");

const url = latin.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
if (!url) throw new Error("no woff2 URL in the latin block — did Google change the format?");

const weight = latin.match(/font-weight:\s*(\d+)/)?.[1];
if (weight !== "700") throw new Error(`expected weight 700, got ${weight} (issue E: no synthetic bold)`);

const buf = Buffer.from(await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer());

// woff2 files start with the ASCII signature "wOF2".
if (buf.subarray(0, 4).toString("ascii") !== "wOF2") {
  throw new Error("downloaded file is not woff2");
}

const base64 = buf.toString("base64");

writeFileSync(
  OUT,
  `/**
 * GENERATED FILE — do not hand-edit.
 * Regenerate with: node scripts/gen-super-text-font.mjs
 *
 * DM Sans 700 (latin subset), SIL Open Font License 1.1.
 * Source: ${url}
 * Raw: ${buf.length} bytes -> base64: ${base64.length} chars
 *
 * Embedded as a data URI (not installed in the Docker image) so the compose
 * preview and the worker burn use literally the same bytes and cannot drift.
 */
export const DM_SANS_700_LATIN_WOFF2_BASE64 =
  "${base64}";
`
);

console.log(`OK ${OUT}  raw=${buf.length}B base64=${base64.length}c weight=${weight}`);
```

- [ ] **Step 2: Run it**

Run: `node scripts/gen-super-text-font.mjs`
Expected: `OK packages/super-text/src/fonts/dm-sans-700-latin.ts  raw=~20000B base64=~27000c weight=700`

If the raw size is wildly off (< 5KB or > 120KB), stop and inspect — Google may have changed the subset layout.

- [ ] **Step 3: Verify the payload decodes to a real 700-weight woff2**

Run:

```bash
node -e '
const { DM_SANS_700_LATIN_WOFF2_BASE64: b64 } = await import("./packages/super-text/src/fonts/dm-sans-700-latin.ts").catch(() => ({}));
' 2>/dev/null || node --input-type=module -e '
import { readFileSync } from "fs";
const src = readFileSync("packages/super-text/src/fonts/dm-sans-700-latin.ts","utf8");
const b64 = src.match(/"([A-Za-z0-9+/=]{100,})"/)[1];
const buf = Buffer.from(b64, "base64");
console.log("magic:", buf.subarray(0,4).toString("ascii"));
console.log("bytes:", buf.length);
if (buf.subarray(0,4).toString("ascii") !== "wOF2") process.exit(1);
'
```

Expected: `magic: wOF2` and a plausible byte count.

- [ ] **Step 4: Document the swap-in point**

Create `packages/super-text/src/fonts/README.md`:

```markdown
# Super Text embedded fonts

`dm-sans-700-latin.ts` is **generated** — run `node scripts/gen-super-text-font.mjs`.

## Why embedded rather than installed in the worker image

The compose preview (browser) and the burn (worker Chromium) must use the *same*
font, or the strip wraps at different words and the burned video does not match
what the user positioned. Embedding the bytes in the shared HTML makes that
structurally true instead of a deployment promise, and avoids adding a font
package to `docker/Dockerfile.worker`.

## Which face, and why not Instagram Sans

Instagram Sans is Meta's proprietary typeface and is not licensed for
third-party redistribution. **DM Sans** (SIL OFL 1.1) is the closest open match:
geometric, large x-height, and — importantly — a **double-storey `a`**, like
Instagram Sans. Poppins is often suggested but has a single-storey `a`, which
reads noticeably different. Tracking is tightened via
`SUPER_TEXT_FONTS.sans.letterSpacingEm` to match Instagram's display setting.

## Swapping in a licensed face

If you obtain a licence for a different face:

1. Convert it to **woff2 at weight 700** (a real bold cut — not Regular, or
   Chromium synthesises fake bold and preview/burn diverge).
2. Base64 it and replace the string in `dm-sans-700-latin.ts` (rename the file
   and the export if you like; update the import in `../constants.ts`).
3. Update `EMBEDDED_SANS_FAMILY` in `../constants.ts` to the correct family name.
4. Re-run the golden-parity check in
   `docs/superpowers/plans/2026-07-28-super-text-instagram-fonts.md` Task 9.

The `font` enum values (`classic` / `sans`) must **not** change — existing posts
and drafts reference them.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-super-text-font.mjs \
        packages/super-text/src/fonts/dm-sans-700-latin.ts \
        packages/super-text/src/fonts/README.md
git commit -m "feat(super-text): embed DM Sans 700 (OFL) as a base64 woff2 payload"
```

---

## Task 4: Emit `@font-face` and apply the font in the builders

**Files:**
- Modify: `packages/super-text/src/html.ts`
- Modify: `packages/super-text/src/index.ts`
- Modify: `packages/super-text/src/__tests__/super-text-fonts.test.ts`

This is the byte-identity task. **The classic path must produce exactly the string it produces today.**

- [ ] **Step 1: Commit a golden snapshot of TODAY's output — BEFORE editing `html.ts`**

This mirrors the repo's existing golden-render gate for `buildStaticCreative` ([repurpose-render-golden.test.ts](../../../packages/ai/src/__tests__/repurpose-render-golden.test.ts)). The committed snapshot is the pre-change bytes; after the edit the test must pass with **0 snapshots written**, and that 0-written result *is* the byte-identity proof.

Create `packages/super-text/src/__tests__/super-text-render-golden.test.ts`:

```ts
/**
 * 🔒 GOLDEN RENDER GATE — keep green, never run `-u` blindly.
 *
 * Snapshots the DEFAULT (font-less / "classic") strip and burn-frame output.
 * Any change that alters a default-path render fails this test. When adding a
 * render feature, gate it behind an option that defaults to today's behaviour so
 * this passes with 0 snapshots written — that is the byte-identity proof.
 *
 * Only run `-u` for a deliberately approved change, and confirm the diff is
 * ADDITIONS ONLY (new snapshots), never a modification to an existing one.
 */
import { describe, it, expect } from "vitest";
import { buildStripInnerHtml, buildSuperTextFrameHtml } from "../html";
import type { SuperTextConfig } from "../schema";

const golden: SuperTextConfig = {
  version: 1,
  segments: [
    { text: "Ranveer" },
    { text: "returns", color: "#EF4444" },
    { text: "😍✨" },
  ],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

describe("golden render gate — default (classic) path", () => {
  it("strip inner html is unchanged", () => {
    expect(buildStripInnerHtml(golden)).toMatchSnapshot();
  });

  it("burn frame html is unchanged at 1080x1920", () => {
    expect(buildSuperTextFrameHtml(golden, 1080, 1920)).toMatchSnapshot();
  });

  it("burn frame html is unchanged at 720x1280", () => {
    expect(buildSuperTextFrameHtml(golden, 720, 1280)).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run it to write the pre-change snapshots, then commit them**

Run: `pnpm --filter @postautomation/super-text test -- super-text-render-golden`
Expected: PASS with **3 snapshots written**.

```bash
git add packages/super-text/src/__tests__/super-text-render-golden.test.ts \
        packages/super-text/src/__tests__/__snapshots__/super-text-render-golden.test.ts.snap
git commit -m "test(super-text): golden render gate capturing pre-font-picker output"
```

> This commit must land **before** any `html.ts` edit, or the snapshot records post-change bytes and proves nothing.

- [ ] **Step 3: Write the failing test**

Append to `packages/super-text/src/__tests__/super-text-fonts.test.ts`:

```ts
import {
  buildStripInnerHtml,
  buildSuperTextFrameHtml,
  buildSuperTextFontFaceCss,
  buildAllSuperTextFontFaceCss,
} from "../html";
import { EMBEDDED_SANS_FAMILY, SUPER_TEXT_EMOJI_STACK } from "../constants";

describe("buildSuperTextFontFaceCss", () => {
  it("emits nothing for classic — no @font-face, nothing to load", () => {
    expect(buildSuperTextFontFaceCss("classic")).toBe("");
    expect(buildSuperTextFontFaceCss(undefined)).toBe("");
  });

  it("emits a weight-700 data-URI face for sans with font-display:block", () => {
    const css = buildSuperTextFontFaceCss("sans");
    expect(css).toContain(`font-family:'${EMBEDDED_SANS_FAMILY}'`);
    expect(css).toContain("font-weight:700");
    // `block`, not `swap`: swap would let the user position the strip against
    // fallback metrics and then reflow underneath them (issue G).
    expect(css).toContain("font-display:block");
    expect(css).toContain("src:url(data:font/woff2;base64,");
    expect(css).toContain("format('woff2')");
  });

  it("emits no face when the payload is empty (safe degrade to the stack)", () => {
    // Guards the Task-1 placeholder state and a botched regeneration.
    const css = buildSuperTextFontFaceCss("sans");
    if (css !== "") expect(css).not.toContain("base64,)");
  });

  it("buildAll emits every font's face in one string", () => {
    const all = buildAllSuperTextFontFaceCss();
    expect(all).toContain(EMBEDDED_SANS_FAMILY);
  });
});

describe("font application — byte identity and parity", () => {
  const cfg = {
    version: 1 as const,
    segments: [{ text: "Ranveer" }, { text: "returns", color: "#EF4444" }],
    stripColor: "#FFFFFF",
    textColor: "#111111",
    xPct: 50,
    yPct: 72,
    fontSizePct: 4.2,
  };

  it("a config with NO font renders identically to font:'classic'", () => {
    expect(buildStripInnerHtml(cfg)).toBe(buildStripInnerHtml({ ...cfg, font: "classic" }));
  });

  it("classic emits NO letter-spacing declaration at all", () => {
    // A `letter-spacing:0em` would still be a byte change vs the pre-picker output.
    expect(buildStripInnerHtml(cfg)).not.toContain("letter-spacing");
  });

  it("sans applies the embedded family and the tightened tracking", () => {
    const html = buildStripInnerHtml({ ...cfg, font: "sans" });
    expect(html).toContain(EMBEDDED_SANS_FAMILY);
    expect(html).toContain("letter-spacing:-0.012em");
  });

  it("EVERY font key still appends the emoji stack (or emoji burn as tofu)", () => {
    for (const font of ["classic", "sans"] as const) {
      expect(buildStripInnerHtml({ ...cfg, font })).toContain(SUPER_TEXT_EMOJI_STACK);
    }
  });

  it("every font key keeps the classic stack in its fallback chain (non-Latin)", () => {
    // Devanagari has no DM Sans coverage; it must fall through, as it does today.
    const html = buildStripInnerHtml({ ...cfg, segments: [{ text: "नमस्ते" }], font: "sans" });
    expect(html).toContain("Liberation Sans");
    expect(html).toContain("नमस्ते");
  });

  it("an injecting font value cannot reach the style attribute", () => {
    const html = buildStripInnerHtml({
      ...cfg,
      // Bypasses zod exactly like a hand-written DB row would.
      font: `Arial;background:url(https://evil.example/x)` as never,
    });
    expect(html).not.toContain("evil.example");
    expect(html).toBe(buildStripInnerHtml(cfg)); // silently classic
  });

  it("the burn frame carries the @font-face for sans and none for classic", () => {
    expect(buildSuperTextFrameHtml({ ...cfg, font: "sans" }, 1080, 1920)).toContain("@font-face");
    expect(buildSuperTextFrameHtml(cfg, 1080, 1920)).not.toContain("@font-face");
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `pnpm --filter @postautomation/super-text test -- super-text-fonts`
Expected: FAIL — `buildSuperTextFontFaceCss` is not exported from `../html`.

- [ ] **Step 5: Implement in `html.ts`**

Add to the imports at the top of `packages/super-text/src/html.ts`:

```ts
import { resolveSuperTextFont } from "./constants";
```

Add this function (place it above `buildStripInnerHtml`):

```ts
/**
 * `@font-face` CSS for one font key, or "" when the key needs no webfont.
 *
 * The family name and the payload both come from the registry — never from
 * caller input — so nothing user-controlled reaches this CSS. Returns "" when
 * the payload is empty so a missing/botched generated file degrades to the
 * fallback stack rather than emitting `url(data:font/woff2;base64,)`.
 */
export function buildSuperTextFontFaceCss(key: string | undefined | null): string {
  const spec = resolveSuperTextFont(key);
  if (!spec.embedded || !spec.embedded.base64) return "";
  return (
    `@font-face{font-family:'${spec.embedded.family}';font-style:normal;` +
    `font-weight:${spec.weight};font-display:block;` +
    `src:url(data:font/woff2;base64,${spec.embedded.base64}) format('woff2');}`
  );
}

/** Every font's face in one string — for the editor, which mounts them once so
 *  switching fonts in the picker is instant and never shows a fallback. */
export function buildAllSuperTextFontFaceCss(): string {
  return SUPER_TEXT_FONT_KEYS.map((k) => buildSuperTextFontFaceCss(k)).join("");
}
```

Add `SUPER_TEXT_FONT_KEYS` to the existing `./constants` import list.

Now change **only** the three font-related declarations inside `buildStripInnerHtml`:

```ts
export function buildStripInnerHtml(config: SuperTextConfig): string {
  const textColor = safeHexColor(config.textColor, "#111111");
  const stripColor = safeHexColor(config.stripColor, "#FFFFFF");
  const font = resolveSuperTextFont(config.font);          // <-- added
  const words = config.segments
    .map((seg) => {
      const color = seg.color ? safeHexColor(seg.color, textColor) : textColor;
      return `<span style="color:${color}">${escapeHtml(seg.text)}</span>`;
    })
    .join(" ");
  return (
    `<span style="background:${stripColor};color:${textColor};` +
    `font-weight:${font.weight};` +                        // was STRIP_FONT_WEIGHT
    `font-family:${font.stack}, ${SUPER_TEXT_EMOJI_STACK};` + // was SUPER_TEXT_FONT_STACK
    // Omitted entirely when 0 so the classic output stays byte-identical.
    (font.letterSpacingEm ? `letter-spacing:${font.letterSpacingEm}em;` : "") +
    `line-height:${STRIP_LINE_HEIGHT};` +
    `padding:${STRIP_PAD_Y_EM}em ${STRIP_PAD_X_EM}em;` +
    `border-radius:${STRIP_RADIUS_EM}em;` +
    `-webkit-box-decoration-break:clone;box-decoration-break:clone;` +
    `white-space:pre-wrap;">${words}</span>`
  );
}
```

> `font.weight` for `classic` **is** `STRIP_FONT_WEIGHT` and `font.stack` **is** `SUPER_TEXT_FONT_STACK` (asserted in Task 1), so the classic string is unchanged. `STRIP_FONT_WEIGHT` / `SUPER_TEXT_FONT_STACK` may now be unused in this file — leave the imports only if still referenced, or tsc will warn.

Now `buildSuperTextFrameHtml`. It already emits a `<style>` block in `<head>`; the `@font-face` goes **first inside it**, so the rule is declared before anything uses it. Change only the first line of the returned template — everything else stays exactly as-is:

```ts
export function buildSuperTextFrameHtml(
  config: SuperTextConfig,
  videoWidth: number,
  videoHeight: number
): string {
  const w = Math.max(16, Math.min(7680, Math.round(videoWidth)));
  const h = Math.max(16, Math.min(7680, Math.round(videoHeight)));
  const fontPx = Math.round((config.fontSizePct / 100) * w);
  const xPct = Math.min(95, Math.max(5, config.xPct));
  const yPct = Math.min(95, Math.max(5, config.yPct));
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    // @font-face FIRST in the stylesheet — declared before the rules that use
    // it. Empty string for `classic`, which keeps the frame byte-identical.
    buildSuperTextFontFaceCss(config.font) +
    `html,body{margin:0;padding:0;background:transparent;width:${w}px;height:${h}px;overflow:hidden}` +
    `.anchor{position:absolute;left:${xPct}%;top:${yPct}%;transform:translate(-50%,-50%);` +
    `max-width:${STRIP_MAX_WIDTH_PCT}%;text-align:center;font-size:${fontPx}px}` +
    `</style></head><body><div class="anchor">${buildStripInnerHtml(config)}</div></body></html>`
  );
}
```

- [ ] **Step 6: Export the new symbols**

In `packages/super-text/src/index.ts`, extend the `./html` export:

```ts
export {
  buildStripInnerHtml,
  buildSuperTextFrameHtml,
  buildSuperTextFontFaceCss,
  buildAllSuperTextFontFaceCss,
  safeHexColor,
  escapeHtml,
} from "./html";
```

`export * from "./constants"` already re-exports the registry symbols.

- [ ] **Step 7: Run the tests — the golden gate is the byte-identity proof**

Run: `pnpm --filter @postautomation/super-text test`

Expected, all three of these:
1. The new font tests PASS.
2. All 22 pre-existing tests PASS.
3. `super-text-render-golden` PASSES with **0 snapshots written** and **0 obsolete**.

**If the golden test reports a snapshot MISMATCH, stop and fix the code — do not run `-u`.** A mismatch means an existing post's render changed, which is exactly what this task must not do. The likely causes, in order:
- `letter-spacing` is being emitted for `classic` (it must be omitted entirely when `letterSpacingEm === 0`)
- `SUPER_TEXT_FONTS.classic.stack` is not exactly `SUPER_TEXT_FONT_STACK`
- `buildSuperTextFontFaceCss` returns something other than `""` for `classic`

- [ ] **Step 8: Commit**

```bash
git add packages/super-text/src/html.ts packages/super-text/src/index.ts \
        packages/super-text/src/__tests__/super-text-fonts.test.ts
git commit -m "feat(super-text): apply per-font CSS + embedded @font-face (classic byte-identical)"
```

---

## Task 5: Make the worker wait for the font before screenshotting

**Files:**
- Modify: `apps/worker/src/workers/super-text.worker.ts:107-124`

This is Issue B — without it the burn silently uses the fallback face.

- [ ] **Step 1: Modify `renderStripPng`**

Replace the body of `renderStripPng` in `apps/worker/src/workers/super-text.worker.ts`:

```ts
/** Render the strip as a transparent full-frame PNG at the video's native size. */
async function renderStripPng(
  html: string,
  width: number,
  height: number,
  outPath: string,
  /** Embedded family to await, or null when the font needs no loading. */
  embeddedFamily: string | null
) {
  const browser = await launchCreativeBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    // `load` (not networkidle0) — the page is fully self-contained inline HTML.
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });

    // `waitUntil:"load"` does NOT wait for @font-face. Screenshotting here would
    // silently bake the FALLBACK face while the compose preview showed the real
    // one — the preview/burn drift this architecture exists to prevent.
    // Bounded so a font problem degrades to a fallback render instead of hanging
    // the burn (which the watchdog would eventually reap as FAILED).
    if (embeddedFamily) {
      await Promise.race([
        page.evaluate(async (family: string) => {
          try {
            // Explicitly kick the load: fonts.ready only settles work already
            // triggered by layout, so asking for the exact face is the reliable
            // way to know it is resolved.
            await (document as unknown as { fonts: FontFaceSet }).fonts.load(`700 100px "${family}"`);
          } catch {
            /* fall through to fonts.ready */
          }
          await (document as unknown as { fonts: FontFaceSet }).fonts.ready;
        }, embeddedFamily),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }

    const png = (await page.screenshot({
      type: "png",
      omitBackground: true, // transparency is what makes overlay=0:0 work
      encoding: "base64",
    })) as string;
    await fsp.writeFile(outPath, Buffer.from(png, "base64"));
  } finally {
    // Closing releases the CREATIVE_RENDER_CONCURRENCY slot.
    await browser.close().catch(() => undefined);
  }
}
```

- [ ] **Step 2: Pass the family at the call site**

Find the `renderStripPng(` call in the same file and thread the resolved family through. Add to the file's `@postautomation/super-text` import:

```ts
import { resolveSuperTextFont } from "@postautomation/super-text";
```

At the call site, where `parsed.data` (the validated `SuperTextConfig`) is in scope:

```ts
const fontSpec = resolveSuperTextFont(parsed.data.font);
await renderStripPng(
  html,
  src.width,
  src.height,
  stripPngPath,
  fontSpec.embedded?.base64 ? fontSpec.embedded.family : null
);
```

> Use the existing variable names at that call site for `html`, the dimensions and the PNG path — do not rename them. Guarding on `.base64` being non-empty means a missing generated payload skips the wait rather than burning 10s on a font that will never arrive.

- [ ] **Step 3: Type-check the worker**

Run: `pnpm --filter @postautomation/worker exec tsc --noEmit`
Expected: exit 0.

If `FontFaceSet` is not in the worker's TS lib (it is a DOM type and the worker targets Node), replace both `FontFaceSet` annotations with `{ load: (f: string) => Promise<unknown>; ready: Promise<unknown> }`. The code runs **inside the browser page**, so only the annotation is at issue.

- [ ] **Step 4: Run the worker test suite**

Run: `pnpm --filter @postautomation/worker test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/workers/super-text.worker.ts
git commit -m "fix(super-text): await embedded font before screenshot (burn used fallback face)"
```

---

## Task 6: Mount the `@font-face` in the browser preview

**Files:**
- Create: `apps/web/components/content-agent/super-text-font-faces.tsx`
- Modify: `apps/web/components/content-agent/SuperTextEditor.tsx` (mount it)

`SuperTextStrip` injects only the strip `<span>`; the `@font-face` must exist in the document for the preview to use the real face.

- [ ] **Step 1: Create the component**

Create `apps/web/components/content-agent/super-text-font-faces.tsx`:

```tsx
"use client";

import { buildAllSuperTextFontFaceCss } from "@postautomation/super-text";

/**
 * Mounts every super-text @font-face once.
 *
 * The CSS comes from the SAME shared builder the worker feeds to Puppeteer, so
 * the preview and the burn load identical font bytes — the whole point of
 * embedding rather than installing (see the plan's issue C). Rendering ALL
 * faces up front means switching fonts in the picker is instant and never
 * flashes a fallback the user might position the strip against.
 *
 * The string is machine-generated from a closed registry — no user input
 * reaches it — and is hoisted to module scope so the ~27KB base64 is not
 * re-created on every render.
 */
const FONT_FACE_CSS = buildAllSuperTextFontFaceCss();

export function SuperTextFontFaces() {
  if (!FONT_FACE_CSS) return null;
  return <style dangerouslySetInnerHTML={{ __html: FONT_FACE_CSS }} />;
}
```

- [ ] **Step 2: Mount it in the editor**

In `apps/web/components/content-agent/SuperTextEditor.tsx`, add the import:

```tsx
import { SuperTextFontFaces } from "./super-text-font-faces";
```

and render it as the first child inside `<DialogContent>`:

```tsx
<DialogContent ...>
  <SuperTextFontFaces />
  ...
```

- [ ] **Step 3: Verify the font actually loads in the browser**

Run `pnpm dev`, open Content Studio → Compose, attach a video, open Super Text, then in the browser console:

```js
document.fonts.check('700 100px "PA Display Sans"')
```

Expected: `true`. If `false`, the `@font-face` is absent or the payload is empty — re-check Task 3.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/content-agent/super-text-font-faces.tsx \
        apps/web/components/content-agent/SuperTextEditor.tsx
git commit -m "feat(super-text): mount embedded @font-face in the compose preview"
```

---

## Task 7: Font picker in the editor

**Files:**
- Modify: `apps/web/components/content-agent/SuperTextEditor.tsx`

- [ ] **Step 1: Add the state**

Add the import:

```tsx
import { SUPER_TEXT_FONTS, SUPER_TEXT_FONT_KEYS, DEFAULT_SUPER_TEXT_FONT, type SuperTextFontKey } from "@postautomation/super-text";
```

Add state alongside the existing `fontSizePct` state:

```tsx
const [font, setFont] = useState<SuperTextFontKey>(
  () => initial?.font ?? DEFAULT_SUPER_TEXT_FONT
);
```

- [ ] **Step 2: Add the control**

The existing control row is a `flex flex-wrap items-center gap-x-4 gap-y-2 text-sm` div holding Strip colour, Text colour and the size buttons. Add a font group, mirroring the size picker's pattern so it looks native:

```tsx
<div className="flex items-center gap-1">
  {SUPER_TEXT_FONT_KEYS.map((k) => (
    <Button
      key={k}
      type="button"
      size="sm"
      variant={font === k ? "default" : "outline"}
      onClick={() => setFont(k)}
      // Preview the actual face on the button itself.
      style={{ fontFamily: SUPER_TEXT_FONTS[k].stack, fontWeight: SUPER_TEXT_FONTS[k].weight }}
    >
      {SUPER_TEXT_FONTS[k].label}
    </Button>
  ))}
</div>
```

- [ ] **Step 3: Thread it into the built config**

Find where the component assembles the `SuperTextConfig` for the live preview and for `onSave`. Add `font` to **both**, omitting it when it is the default so the payload (and therefore the burn cache hash) stays identical for classic:

```tsx
// Omit `font` when classic: an absent key keeps JSON.stringify — and so the
// worker's S3 config hash — identical to every pre-picker config.
...(font !== DEFAULT_SUPER_TEXT_FONT ? { font } : {}),
```

- [ ] **Step 4: Verify preview updates and the payload is clean**

Run `pnpm dev`, open the Super Text editor on a video:
1. Type text. Click **Sans** — the strip must visibly change face (rounder, tighter) and may re-wrap.
2. Click **Classic** — it must return to the original look.
3. Save with **Classic** and confirm via the React DevTools / a `console.log` of the saved config that there is **no `font` key**.
4. Save with **Sans** and confirm `font: "sans"` is present.

- [ ] **Step 5: Check mobile at 390px (issue H)**

In DevTools set the viewport to 390×844 and open the editor. The control row now holds four groups; confirm it wraps cleanly with no horizontal page scroll and every button is tappable.

- [ ] **Step 6: Run the web build**

Run: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: exit 0.

> Required by the repo's standing rule: **verify the Next build, not just tsc** — SWC rejects things tsc accepts (memory `feedback-verify-next-build-not-just-tsc`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/content-agent/SuperTextEditor.tsx
git commit -m "feat(super-text): Classic/Sans font picker in the compose editor"
```

---

## Task 8: Lock the payload and plan-gate round-trips

**Files:**
- Modify: `apps/web/lib/super-text-payload.test.ts`
- Modify: `packages/api/src/__tests__/super-text-plan.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("buildSuperTextPayload", …)` block in `apps/web/lib/super-text-payload.test.ts`. The file's signature is `buildSuperTextPayload(items, mediaIds)` and its fixture is `cfg(text)` — both already in scope:

```ts
  it("carries the chosen font through to the payload", () => {
    const out = buildSuperTextPayload([{ superText: { ...cfg("hi"), font: "sans" } }], ["m1"]);
    expect(out.m1!.font).toBe("sans");
  });

  it("a config with no font round-trips with NO injected key", () => {
    // zod must not default this field: an injected key would change
    // JSON.stringify and therefore the worker's S3 burn-cache hash for every
    // pre-existing config.
    const out = buildSuperTextPayload([{ superText: cfg("hi") }], ["m1"]);
    expect("font" in out.m1!).toBe(false);
  });

  it("drops a config with a bogus font instead of failing the whole post", () => {
    const bad = { ...cfg("x"), font: "comic-sans" } as unknown as SuperTextConfig;
    const out = buildSuperTextPayload([{ superText: bad }, { superText: cfg("ok") }], ["m1", "m2"]);
    expect(out.m1).toBeUndefined();
    expect(out.m2).toBeDefined();
  });
```

Append inside the existing `describe("planSuperText", …)` block in `packages/api/src/__tests__/super-text-plan.test.ts`. That file's fixtures `cfg`, `video(id)` and `image(id)` are already in scope:

```ts
  it("plans a burn identically regardless of which font is chosen", () => {
    const withFont = planSuperText({
      superText: { a: { ...cfg, font: "sans" } },
      mediaRows: [video("a")],
      scheduledAt: null,
    });
    const withoutFont = planSuperText({
      superText: { a: cfg },
      mediaRows: [video("a")],
      scheduledAt: null,
    });
    // The publish gate must not care which typeface it is — only that a burn is
    // pending. Compare the whole plan so a future field can't silently diverge.
    expect(withFont).toEqual(withoutFont);
    expect(withFont.enabled).toBe(true);
  });

  it("still parks the schedule for a font-carrying config", () => {
    const plan = planSuperText({
      superText: { a: { ...cfg, font: "sans" } },
      mediaRows: [video("a")],
      scheduledAt: new Date("2026-08-01T10:00:00Z"),
    });
    expect(plan.parkedSchedule).toBe(true);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @postautomation/web test -- super-text-payload` and `pnpm --filter @postautomation/api test -- super-text-plan`
Expected: FAIL on the font assertions.

- [ ] **Step 3: Confirm no production code change is needed**

These should pass once the schema accepts `font` (Task 2) — `buildSuperTextPayload` validates via `superTextConfigSchema` and passes the parsed object through. **If a test still fails, the payload builder is stripping or reshaping fields** and needs a fix; investigate before editing the test.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test`
Expected: PASS — the whole repo suite green (1437+ tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/super-text-payload.test.ts packages/api/src/__tests__/super-text-plan.test.ts
git commit -m "test(super-text): lock font round-trip through payload and publish gate"
```

---

## Task 9: End-to-end verification

No code changes — this is the gate before merge. **Do not skip the clean-tree build**: `.dockerignore` is empty, so a build from your working tree copies your local `node_modules` and proves nothing about a server build (CLAUDE.md quirk #10).

- [ ] **Step 1: Confirm the Docker image needs no font change**

Run:

```bash
grep -n "super-text" docker/Dockerfile.worker
```

Expected: **two** lines — the `package.json` copy (~line 34) and the `node_modules` copy (~line 54). Both already exist. No new font package is needed because the face is embedded.

- [ ] **Step 2: Clean-tree worker build**

```bash
rm -rf /tmp/cleanbuild && mkdir -p /tmp/cleanbuild
git ls-files -z | tar --null -T - -cf - | tar -xf - -C /tmp/cleanbuild
cd /tmp/cleanbuild && docker build -f docker/Dockerfile.worker -t cleanworker .
```

Expected: build succeeds.

- [ ] **Step 3: Prove the generated font file is inside the image**

```bash
docker run --rm cleanworker sh -c \
  'ls -la /app/packages/super-text/src/fonts/ && wc -c /app/packages/super-text/src/fonts/dm-sans-700-latin.ts'
```

Expected: the file is present and tens of KB — **not** the empty placeholder. A generated file that is gitignored would silently ship empty; if the byte count is tiny, check `.gitignore`.

- [ ] **Step 4: Boot the actual worker**

```bash
docker run --rm -e DATABASE_URL=postgresql://x:x@127.0.0.1:5432/x -e REDIS_URL=redis://127.0.0.1:6379 \
  cleanworker sh -c "cd /app && ./node_modules/.pnpm/node_modules/.bin/tsx apps/worker/src/index.ts" | head -30
```

Expected: the worker starts and registers queues (DB/Redis connection errors are fine — we are proving module resolution). **Smoke-testing a library function is not sufficient; boot the entrypoint** (quirk #10's stated lesson).

- [ ] **Step 5: The parity check that actually matters**

Burn the same text twice — once Classic, once Sans — and compare the burn against the preview:

1. `pnpm dev`, attach a real video in Compose, and add super text whose text is long enough to wrap to **two lines** (this is what exercises the metric-parity risk).
2. Screenshot the compose preview for each font.
3. Publish (or run the worker locally) so `super-text.worker` burns both.
4. Download both burned videos and extract a frame:
   ```bash
   ffmpeg -y -i burned-classic.mp4 -vf "select=eq(n\,30)" -vframes 1 /tmp/classic.png
   ffmpeg -y -i burned-sans.mp4    -vf "select=eq(n\,30)" -vframes 1 /tmp/sans.png
   ```
5. Compare each frame to its preview screenshot. **The line-break words must be the same** and the strip must sit in the same place. Different break points mean the font did not load in one environment — go back to Task 5.

- [ ] **Step 6: Confirm the classic path did not regress**

Burn a video with a **pre-existing** super-text post (or one saved with Classic) and confirm the output is unchanged from before this branch. Combined with the Task-4 byte-identity diff, this closes the "no sabotage" requirement.

- [ ] **Step 7: Verify the burn cache behaves**

Re-burn the same Sans config twice: the second run must **not** re-burn (`results[mediaId].status === "done"`). Then switch the font and re-burn: the S3 key hash must **change** (a new object), proving the font is inside the cache key.

```bash
# On the server or local MinIO:
docker exec postautomation-minio-1 sh -c \
  'mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD && mc ls --recursive local/postautomation-media/supertext/'
```

Expected: two distinct `{mediaId}-{hash}.mp4` objects with different hashes.

- [ ] **Step 8: Full checks**

```bash
pnpm test
pnpm type-check
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: all green.

---

## Deliberately out of scope

- **The other Instagram story fonts** (Modern, Neon, Typewriter, Strong, Signature, Bubble, Deco). The registry makes each a ~6-line addition plus a generated payload, but every added face grows the embedded HTML and needs its own fidelity review. Ship two, then extend.
- **Per-segment fonts.** One font per strip, matching Instagram.
- **Editing super text on an existing post.** Already a documented v1 limit of the feature; unchanged.
- **`latin-ext` / Devanagari subsets.** Non-Latin falls through to the existing stack exactly as it does today (issue F). If Hindi super text becomes common, add a second embedded entry with a `unicode-range`.
- **Installing fonts in the worker image.** Deliberately avoided — embedding is what guarantees parity.

## Rollback

Every task is an independent commit. The feature is inert without a `font` key in the config, so:
- **Full revert:** `git revert` the range; existing posts are unaffected because they never carried a `font`.
- **Disable the picker only:** remove the font group from `SuperTextEditor.tsx` (Task 7). Configs already saved with `font:"sans"` keep rendering correctly because the registry and builders remain.
