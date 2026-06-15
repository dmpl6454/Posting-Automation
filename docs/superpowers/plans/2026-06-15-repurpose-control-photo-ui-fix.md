# Repurpose — Control Model + Photo + UI Fix (Round 8 plan)

**Status:** IN PROGRESS (session 2026-06-15). Branch `repurpose-control-photo-ui-fix` off `origin/main` (`50541de`, PR #64, live on prod).

## Session addendum (grounded recon + locked decisions — 2026-06-15)

**Two user decisions LOCKED this session (do NOT re-litigate):**
- **D-engine: TEMPLATE ENGINE WINS.** When a reference is attached + a style is picked, render via `creative-templates.ts` `buildStaticCreative` (the proven 4-template renderer), NOT the Round-7 block engine. The reference supplies ONLY theme / accentColor / logo / hero photo. The block engine (`cardLayoutToSpec`/`renderCard`) is no longer used for Repurpose *styled* output (it stays in the tree for NewsGrid/autopilot). This makes the picker provably control layout and kills "box not plain" at the root.
- **D-guard: BLOCK with actionable toast** for ALL styles when no usable photo + AI off/unavailable (not just photo-dependent styles). `BAD_REQUEST` → UI toast → no card. Static + carousel cover.

**Recon corrections to the original diagnosis below (verified in code + live repro):**
- **B1 has TWO override points, not one.** (a) `repurpose.router.ts:1173` `effectiveStyle = detectedCardHint ? presetToCreativeStyle(detectedCardHint.preset) : input.creativeStyle` — the `classifyCard` preset overrides the picker. (b) `:1690` `useLayout = detectedLayout!==null && confidence>=0.5` → `cardLayoutToSpec` block-engine render ignores the picker. BOTH must yield to `input.creativeStyle`.
- **True line numbers** (origin/main `50541de`): input schema `785-840` (`creativeStyle` default `premium_editorial`, `theme` default `light`, `logoPosition`, `accentColor`, `aestheticRefUrl`, `imageContext`, `aiImages` default `true`, `imageAssignments`); `detectedCardHint`/`detectedLayout` setup `1061-1112`; `effectiveStyle/Theme/BrandColor` `1173-1184`; static render `1685-1758`; static `renderedBgSource` assigns `1679,1706,1740`; main return `2415-2449` (`bgSource`, `referenceApplied`, `appliedStyle`, `appliedTheme`, `usedRealPhoto`); carousel branch `2030-2397`, carousel cover block-engine `2229-2246`, `coverArticleBg` pick `2149-2152`, slide upload/`carouselMediaIds` push `2288-2311`.
- **Carousel NEVER assigns `renderedBgSource`** (stays `undefined`) → T4 must cover carousel, not just rename the static union.
- **B5 root cause is NOT http:// (that was a code-reading guess).** LIVE repro: NDTV 403s direct fetch → falls back to `r.jina.ai` proxy → og:image IS present + extracted; `extractUrlContent` returns 6 images, hero at `images[0]`. The bug: `getImages` (`url-extractor.ts:288-311`) leaks a tracking pixel (`sb.scorecardresearch.com/p?…`) and a logo SVG (`drop.ndtv.com/…/ndtv-profit.svg`) — its filter only blocks literal `icon/logo/avatar/pixel/1x1`; and `pickArticleBgImage` (`repurpose.router.ts:75-84`) returns the FIRST `https://` that passes `isPublicImageUrl`. Fix = harden `getImages` (drop pixels/`.svg`/known-tracker hosts, prefer real raster) + make `pickArticleBgImage` skip non-photo URLs. (Depleted OpenAI image credits is a separate OPS fix.)
- `presetToCreativeStyle` already exists in `repurpose.router.ts` → reuse it for T2's `suggestedStyle`.
- card-engine `renderHighlightMarkup` accepts BOTH `[[...]]` and legacy `**...**`; creative-templates uses `**...**`. Still keep new code on the right side per engine.

**Original (pre-recon) diagnosis below is retained for history; defer to the addendum where they differ.**


## Where things stand (already shipped, PR #64)
The repurpose render can now reproduce a style reference's LAYOUT via a vision extractor + the `CardSpec` block engine:
- `packages/ai/src/tools/extract-card-layout.ts` — `extractCardLayout(base64,mime)` (gpt-4o-mini vision) → sanitized `CardLayout` skeleton; `cardLayoutToSpec(layout, content)` → `CardSpec`; `parseCardLayout` whitelists every field.
- `packages/ai/src/tools/card-engine.ts` — `renderCard(spec)` block engine + extensions: `CaptionPill.variant:"plain"` (boxless headline), `Background.scrimMode:"brand"|"dark"|"none"`, `captionStack.label` (brand wordmark + underline). `generateCardImage(spec,{browser?})` rasterizes to PNG.
- `packages/api/src/routers/repurpose.router.ts` — STATIC + CAROUSEL-COVER render via `cardLayoutToSpec → generateCardImage` when `detectedLayout && detectedLayout.confidence >= 0.5`; else legacy `buildHeadlineCreative`.
- `apps/web/components/content-agent/RepurposeTab.tsx` — reference-first UI: manual Style/Theme/logo-position/notes hidden behind an "Advanced" toggle; clipboard image-paste (`handleRefPaste`).

**It misses in practice** (user-reported, with screenshots): photoless blank cards, headline rendered as a white BOX (not the plain reference look), and the user **cannot choose the style** because the block engine renders `detectedLayout` and ignores the picker.

## Locked decisions (user, this round)
1. **Control model = "reference PRE-SELECTS, user overrides."** Attaching a reference auto-selects the closest style in a VISIBLE picker; the user can change it; **whatever the picker shows is what renders.** The user's selected style WINS — the reference must NOT silently switch the layout.
2. **No usable photo + AI off/unavailable → BLOCK generation** with a clear "add a hero photo (paste/upload) or enable AI image" message. Never render a blank gradient with a floating headline box.
3. **Article-photo extraction must work** from the news URL (user says it worked before; verify + fix the regression).
4. **Simplify the UI further** — it's still confusing (two reference concepts, contradictory "premium editorial" echo vs. boxed render, hidden picker).

## Concrete bugs + root causes (grounded in code)
- **B1 — picker ignored / can't choose style.** `repurpose.router.ts:1690` `const useLayout = detectedLayout && confidence>=0.5` → renders `cardLayoutToSpec(detectedLayout)` regardless of the user's `input.creativeStyle`. The chosen style does nothing when a reference is attached.
- **B2 — box not plain.** The block engine uses `detectedLayout.headline.variant`; the vision misread the moviefied (plain) reference as `"box"`. Compounded by B1 (the user's "premium" pick can't correct it).
- **B3 — photoless blank card.** `heroUrl = bgSlot.source==="branded" ? undefined : bgSlot.url` (`:1693`) → no hero when the slot resolves to branded; the card is a flat gradient + a small floating headline box.
- **B4 — false "real photo" label.** `renderedBgSource = bgSlot.source==="ai" ? "ai" : "stock"` (`:1706,1740`) collapses "branded" (no photo) into "stock"; the UI (`RepurposeTab.tsx:1561`) then says *"Image made from the article's own photo"* even when there was no photo.
- **B5 — article photo / AI image unavailable.** "AI image was unavailable" = OpenAI image gen failing (likely OpenAI image CREDITS depleted — see memory "OpenAI Add credits"). For the test URL the article `og:image` may also be missing/unusable. `extractUrlContent` (`packages/ai/src/utils/url-extractor.ts:289-307,486-589`) DOES pull og/twitter/inline images — so reproduce the exact URL and trace whether `extracted.images` is empty or filtered out by `isPublicImageUrl`/https.
- **B6 — UI confusion.** Picker hidden behind Advanced; the Round-6 echo "Matched your style reference → premium editorial · light" is inert/contradictory vs. the block render; two overlapping reference ideas.

## Fix tasks
- **T1 — make the user's selected style WIN (control model).**
  - Server: `cardLayoutToSpec` (or a wrapper) must accept the USER'S chosen `creativeStyle` and FORCE the layout family to match it — premium→`captionStack.variant:"plain"` + photo bg; hook→`variant:"box"` (bars); tweet→tweet layout; bold→bold. The reference supplies only theme/accent/scrim/logo-position/wordmark — NOT the headline variant or layout family. i.e. detected layout informs *style details*, the picker decides the *family*.
  - The render uses the picker's value every time (no `useLayout`-ignores-picker).
- **T2 — reference pre-selects the picker (UI).** Return a `suggestedStyle` from the server (map `extractCardLayout`/`classifyCard` → one of the 4) and, on reference attach, set the picker to it (overridable). The picker is ALWAYS VISIBLE (un-hide it from Advanced — that was the wrong call).
- **T3 — no-photo guard.** Before rendering a photoless card: if the resolved hero is "branded" (no real photo) AND AI is off/unavailable, return a clear `BAD_REQUEST` ("Add a hero photo — paste/upload — or enable AI image generation") that the UI surfaces as an actionable toast. Applies to static + carousel. Add an `aiImageUnavailable` signal if helpful.
- **T4 — honest bg label.** Add a third `renderedBgSource: "ai" | "real" | "branded"` (rename "stock"→"real" for an actual article/user photo; "branded" for the gradient). Fix `RepurposeTab.tsx:1561` copy to match (no false "real photo").
- **T5 — article-photo extraction regression.** Reproduce the failing URL (e.g. the NDTV "Nationalist Citizens Party / Trinamool MPs" article). Confirm `extractUrlContent(url).images`. If empty/filtered, fix extraction (og/twitter/first-large-inline) and/or the `articleImagesList` filter. Ensure the hero ladder uses it. (Also: if OpenAI image credits are depleted, that's an OPS fix — add credits — separate from code.)
- **T6 — UI simplification.** One clear reference block (paste/upload/url + thumbnail + one line of copy on what it does). Picker visible with the auto-select. Remove the contradictory echo (or make it accurate to what rendered: style + theme + photo source). Keep Advanced only for truly-optional knobs (theme/notes).
- **T7 — tests + visual verification + ship.** Unit-test the style-wins mapping + the no-photo guard. Visually render premium / hook / tweet / bold for a sample article WITH a real photo, view each PNG, confirm the picked style renders + headline is plain for premium. Compare premium to `~/Downloads/MoviefiedPostRef.jpg`. Adversarial security pass on any new interpolation/guards. Ship via rebase→PR→merge→deploy→verify.

## Invariants / guardrails
- Additive + fallback; no reference → existing behavior.
- Every color/url/text stays behind `safeColor`/`safeImageUrl`/`escapeHtml`/`renderHighlightMarkup`. `parseCardLayout` whitelists vision output. Keep per-slot media IDOR + SSRF (`safeFetchPublicImage`, `isPublicImageUrl`) guards.
- TWO `renderHighlightMarkup` exist: `card-engine.ts` uses `[[...]]`; `creative-templates.ts` uses `**...**`. Don't cross them.
- Project is db-push-managed (NOT prisma migrate dev). pnpm@9.15.0. Run `pnpm --filter @postautomation/<pkg> exec tsc --noEmit` + `... test` UNPIPED.

## Process
model-tiered-execution (Sonnet implements, Opus reviews — implementer≠reviewer; run tests/tsc yourself) + subagent-driven-development. Security/visual → adversarial + multimodal review. Visual gate against `~/Downloads/MoviefiedPostRef.jpg` BEFORE ship (puppeteer at `~/.cache/puppeteer/chrome/mac_arm-146.0.7680.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`; import card-engine via `await import("./src/tools/card-engine.ts")` then unwrap `.default` — tsx collapses named exports under default).

## Pointers
- Prior design: `docs/superpowers/specs/2026-06-15-repurpose-reference-faithful-design.md`.
- Memory: `project-repurpose-reference-faithful` (Round 7), `project-repurpose-template-mimicry` (Round 6).
- Reference target image: `~/Downloads/MoviefiedPostRef.jpg`; brand logo: `~/Downloads/Moviefied logo.png`.
