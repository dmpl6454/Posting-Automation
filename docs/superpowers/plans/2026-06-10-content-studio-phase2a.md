# Content Studio — Phase 2a (Rendering Quality) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Make Content Studio creatives light-by-default, consistent, highlighted, varied, and instant for text styles — fixing the "ugly / dark / blank / slide-1-differs / no-highlight" complaints. No worker/queue/schema changes (that's 2b).

**Tech Stack:** Next.js, tRPC, Puppeteer (creative render), Vitest, pnpm@9.15.0 (NOT npm). `noUncheckedIndexedAccess` is ON — guard `arr[0]` in tests with `!`. RUN both `pnpm --filter @postautomation/<pkg> test` AND `... exec tsc --noEmit` per task (vitest does NOT type-check).

**Spec:** `docs/superpowers/specs/2026-06-10-content-studio-phase2-design.md`
**Branch:** `fix/content-studio-phase2` (already created off `main`).

Key current anchors (verify; may drift): `packages/ai/src/tools/creative-templates.ts` — `StaticCreativeOptions` (~L13, has `hookLine` no `theme`), `DEFAULT_ACCENT="#e11d48"` (~L36), `safeColor` (~L39), `renderHighlightMarkup` (~L59), `buildPremiumEditorial` (~L94), `buildHookBars` (~L126, `hookLine`→`renderHighlightMarkup` at ~L133), `buildTweetCard` (~L160), `buildBoldTypographic` (~L199, bg hardcoded `#0d0d12`). `packages/api/src/routers/repurpose.router.ts` — `theme` schema (~L96 default "dark"), `buildHeadlineCreative` (~L288 calls `generateImageSafe` ~L305, passes `style` ~L318), carousel branch (~L838: cover via `buildHeadlineCreative` ~L968, body via `generateImageSafe`+`applyLogoOverlay` ~L990-997). `packages/ai/src/tools/news-image-generator.ts` — `generateStyledCreativeImage`, `overlayLogoOnImage` (each `puppeteer.launch()`). `apps/web/components/content-agent/RepurposeTab.tsx` — `theme` state, format/style controls, template dropdown `onValueChange`.

---

### Task 1: Theme tokens + theme-aware builders (light default)

**Files:** Modify `packages/ai/src/tools/creative-templates.ts`; Test `packages/ai/src/__tests__/creative-templates.test.ts` (extend) + new `packages/ai/src/__tests__/creative-theme.test.ts`.

- [ ] **Step 1 — failing tests.** Add a pure exported helper `themeTokens(theme: "dark"|"light"|"gradient", accent: string)` → `{ bgFallback: string; scrim: string; textColor: string; subTextColor: string }`. Tests: `themeTokens("light", "#0052cc")` → `textColor` is a DARK color (e.g. `#0f1419`) and `bgFallback` is light (`#f...`); `themeTokens("dark", ...)` → white text + dark bg; `themeTokens("gradient", "#0052cc")` → bgFallback contains the accent. Also assert `buildStaticCreative({ style:"premium_editorial", theme:"light", headline:"X", ... })` HTML contains the dark text color and NOT `background:#000`. Keep existing XSS/CSS-injection tests green (the sanitizers are unchanged).
- [ ] **Step 2** run `pnpm --filter @postautomation/ai test creative-theme` → fail.
- [ ] **Step 3 — implement.** Add `theme?: "dark"|"light"|"gradient"` to `StaticCreativeOptions` (default `"light"` where read). Add `themeTokens`. Refactor all four builders to derive bg/scrim/text colors from `themeTokens(opts.theme ?? "light", accent)` instead of hardcoded dark values. For `buildBoldTypographic`, replace the hardcoded `#0d0d12` bg with `tokens.bgFallback` and make the headline/accent-band colors theme-derived (this also fixes C1 "identical" — output now varies by theme + brandColor + headline). Keep all `safeColor`/`safeImageUrl`/`escapeHtml`/`renderHighlightMarkup` sanitizer usage intact.
- [ ] **Step 4** run `pnpm --filter @postautomation/ai test` (all green incl. XSS suite) + `pnpm --filter @postautomation/ai exec tsc --noEmit` (exit 0).
- [ ] **Step 5** commit `feat(ai): theme tokens + light-default theme-aware creative builders (C1/C3)`.

### Task 2: Repurpose threads theme, skips AI bg for text styles, generates hook line

**Files:** Modify `packages/api/src/routers/repurpose.router.ts`; Test new `packages/api/src/__tests__/repurpose-hookline.test.ts`.

- [ ] **Step 1 — failing test.** Extract a pure helper `buildHookLine(headline: string, generate: (p:string)=>Promise<string>): Promise<string>` (or `capHookLine(raw: string): string`) that returns a hook line capped to ≤7 words / ≤60 chars with `**...**` markup preserved. Test: a long raw hook → capped, markup kept, HTML-safe length. (Also export a tiny `styleNeedsAiBackground(style): boolean` returning false for `hook_bars`/`bold_typographic`, true for `premium_editorial`/`tweet_card`; test it.)
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** In `buildHeadlineCreative`: (a) if `!styleNeedsAiBackground(input.creativeStyle)` SKIP the `generateImageSafe` call and pass no `bgImageUrl`; (b) pass `theme: input.theme` to `generateStyledCreativeImage`; (c) vary the AI-bg prompt by `input.theme` (light → "bright, airy, well-lit"; gradient → "vibrant, colorful, dramatic lighting"; dark → "dark, moody") and REMOVE the unconditional "Dark/moody tones" suffix; (d) when `creativeStyle==="hook_bars"`, call `generateContentResilient` for a ≤7-word hook with one/two `**word**` highlights, run it through `capHookLine`, and pass as `hookLine`. Keep all existing gating/SSRF chokepoint/error handling intact.
- [ ] **Step 4** `pnpm --filter @postautomation/api test` green + `pnpm --filter @postautomation/api exec tsc --noEmit` exit 0.
- [ ] **Step 5** commit `feat: theme-aware repurpose + skip-AI-bg text styles + hook-line highlight (C2/C3 + perf)`.

### Task 3: Carousel all-template consistency + single-browser reuse

**Files:** Modify `packages/ai/src/tools/creative-templates.ts` (add `slideRole`), `packages/ai/src/tools/news-image-generator.ts` (optional shared `browser` param), `packages/api/src/routers/repurpose.router.ts` (carousel branch routes ALL slides through the template, reuses one browser); Test extend `creative-templates.test.ts`.

- [ ] **Step 1 — failing test.** Add `slideRole?: "cover"|"body"|"cta"` to `StaticCreativeOptions`. Test `buildStaticCreative({ style:"premium_editorial", slideRole:"body", headline:"Heading", body:"Long body text here", theme:"light", ... })` renders the body text block AND the same brand chrome (accent rule / logo slot) as the cover, escapes the body (XSS-safe), and a `slideRole:"cta"` render contains a follow/CTA affordance. Keep XSS suite green.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** (a) `creative-templates.ts`: builders honor `slideRole` — `cover` = current headline layout; `body` = large body-text block with the same chrome; `cta` = "Follow for more" in the same chrome. (b) `news-image-generator.ts`: `generateStyledCreativeImage` (and `overlayLogoOnImage`) accept an optional `browser?: Browser`; when provided, create a page on it and DON'T launch/close (caller owns lifecycle); when absent, keep current self-launch behavior (back-compat). (c) `repurpose.router.ts` carousel branch: launch ONE `puppeteer.launch()` for the whole carousel, render cover+body+cta ALL via `buildHeadlineCreative`/`generateStyledCreativeImage` with the appropriate `slideRole` + `theme` (drop the raw `generateImageSafe`+`applyLogoOverlay` body path), reusing the shared browser; close it in a `finally`. Per-slide try/catch so one failure doesn't abort the set. Slides still create Media rows + `carouselMediaIds` exactly as today (Phase-1 publish path unchanged).
- [ ] **Step 4** `pnpm --filter @postautomation/ai test` + `@postautomation/api test` green + BOTH `tsc --noEmit` exit 0.
- [ ] **Step 5** commit `feat: carousel slides all use branded template + single-browser reuse (C4/N13)`.

### Task 4: RepurposeTab accentColor + light default + theme toggle for static/carousel

**Files:** Modify `apps/web/components/content-agent/RepurposeTab.tsx`; Test (if a pure helper is extractable) `apps/web/lib/*.test.ts`.

- [ ] **Step 1 — (light) test or trace.** If you extract a pure helper (e.g. a `resolveAccentColor(stateColor, templateBrandColor)` or the mutate-payload builder), unit-test it under `apps/web/lib/` (vitest globs it). Otherwise rely on tsc + manual trace (no brittle React test).
- [ ] **Step 2** run any new test → fail.
- [ ] **Step 3 — implement.** (a) default the `theme` state to `"light"`. (b) Render the Dark/Light/Gradient toggle for static + carousel formats (currently video-only). (c) Add an `accentColor` state with a `<input type="color">` (and/or hex field) near the logo uploader; include `accentColor` in the `repurposeFromUrl.mutate({...})` payload. (d) In the template dropdown `onValueChange`, also set `accentColor` from `t.brandColor` when present. Router already accepts `accentColor` + `theme` (no backend change).
- [ ] **Step 4** `pnpm --filter @postautomation/web exec tsc --noEmit` exit 0; any new test green.
- [ ] **Step 5** commit `feat: RepurposeTab light-default theme toggle + accentColor picker wiring (C3 + accentColor)`.

---

## Final gate (after all 2a tasks)
- [ ] `pnpm --filter @postautomation/ai test` · `@postautomation/api test` green; root `pnpm type-check` 7/7 + `pnpm build` succeed.
- [ ] Visual spot-check: render all 4 styles × {light, dark} to headless PNG; confirm legible text + brand color + (for hook_bars) visible highlight + (carousel) consistent chrome across cover/body/cta.
- [ ] Final full-diff review.
- [ ] superpowers:finishing-a-development-branch → PR `fix/content-studio-phase2` (2a) to `main`. (2b lands as a later commit set / PR on the same or a new branch.)
