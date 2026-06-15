# Repurpose — Reference Color + Logo/Style Library Split (Round 9 plan)

**Status:** IN PROGRESS (session 2026-06-15). Branch `repurpose-color-and-library-split` off `origin/main` (`77ff686`, PR #65, live on prod).

## User report (with 3 screenshots)
1. A style reference replicates the **fade/scrim** but **NOT the accent color** ("worked before, not anymore"). Screenshot #1 = the Moviefied reference (orange accent, "Moviefied" wordmark + orange underline, circular orange "m" logo). #2 = reference-only output (fade ✓, no orange). #3 = reference + orange Moviefied logo selected (logo placed, but accent went muted — still no orange).
2. **Logos and style references share the same saved-template space** → confusing; "all templates feel selectable"; unclear which is a logo vs a style.
3. Wants a **simple process**.

## Grounded root cause (verified in code, origin/main 77ff686)
The reference color is **already extracted** — by `classifyCard` (gpt-4o-mini vision) which returns `CardHint.accentColor` (`packages/ai/src/tools/classify-card.ts:75`). It is NOT broken; it is **shadowed** by a logo-first merge:

- `repurpose.router.ts:1137` — `resolvedBrandColor = input.accentColor || extractDominantColor(logo)` (explicit picker, then logo color).
- `repurpose.router.ts:1294` — `effectiveBrandColor = resolvedBrandColor || detectedCardHint?.accentColor || null` — the **reference accent is last**, used only when both picker AND logo produced nothing.

So: fade survives (it comes from detected `theme` at `:1293`, not shadowed); color dies (reference accent is tertiary). Screenshot #3 = selecting the saved logo/style set the picker's `accentColor` from the template's stored `brandColor`, which became `resolvedBrandColor` and shadowed the reference; `extractDominantColor` can also yield a muted bucket on a busy/pale logo.

`classifyStyleReference` (`:856`) returns ONLY `{ suggestedStyle, confidence }` — it **discards** the `accentColor` `classifyCard` already computed, so the UI can't pre-fill the brand-color picker either.

Library confusion: ONE `CreativeTemplate` model + ONE combined UI (dropdown lists all by name; gallery shows only ones with `referenceMedia`). Selecting either **destructively** applies style+logo+color together. Model already has separate `logoMediaId` + `referenceMediaId` + `Media.category` ("logo"/"aesthetic-ref").

## Locked user decisions (this round — do NOT re-litigate)
- **D1 Color priority = reference-first, picker overrides, logo fallback.** When a style reference is active: accent comes from the reference's detected `accentColor`. An **explicit** brand-color picker value still wins (a deliberate brand decision). If **no reference**: extract from the logo (existing behavior). If neither: leave current behavior — "do not sabotage stuff that already works."
- **D2 `classifyStyleReference` returns the accent** too (`{ suggestedStyle, confidence, accentColor, theme }`) so the UI pre-fills the brand-color picker (and theme) on reference attach — overridable.
- **D3 Library split = two sections, backed by a STORED `kind` field** on `CreativeTemplate` (`"logo" | "style"`). Add via `db:push` (additive). Backfill existing rows by shape.
- **D4 Saved-style select applies its saved color** (full look — style + theme + accent).
- **D5 Brand-logo select** sets logo + position, AND accent from the logo's color **only if no reference is active**; if a reference is active the logo never changes color.

## Tasks (model-tiered + subagent-driven; implementer ≠ reviewer)

### T1 — Reference-first color priority (server) [security-adjacent: color is sanitized via safeColor]
`repurpose.router.ts`: replace the two-stage shadow with a single explicit precedence after `detectedCardHint` is known:
```
effectiveBrandColor =
  input.accentColor                          // explicit picker — always wins
  ?? detectedCardHint?.accentColor           // reference accent — when a ref is active
  ?? resolvedBrandColor-from-logo            // logo fallback (no ref)
  ?? null
```
- Keep `extractDominantColor(logo)` but compute it as the **logo fallback**, used only when there's no explicit picker value AND no `detectedCardHint?.accentColor`. (Don't run it eagerly if a reference accent will win — minor perf win, but mainly correctness.)
- `input.accentColor` keeps winning (D1). Every color stays behind `safeColor` (it already is at the template boundary; `classifyCard.accentColor` is `safeColor`-validated at `classify-card.ts:75`).
- Carousel path uses the same `effectiveBrandColor` — verify it does (it reads the same variable). No new interpolation.
- Update the `[Repurpose] Reference classified…` log to show the new precedence.
- **Test:** unit test the precedence (ref-only → ref accent; ref + explicit picker → picker; logo-only no-ref → logo color; none → null/default).

### T2 — `classifyStyleReference` returns accent + theme (server + UI)
- Server (`:856`): widen the return to `{ suggestedStyle, confidence, accentColor: string | null, theme: "light"|"dark"|null }`, sourced from the same `classifyCard` hint (accent already `safeColor`-validated; theme is the enum). Fail-soft (nulls) unchanged.
- UI (`RepurposeTab.tsx` `classifyAndPreselect`): on a confident classify, set the picker's accent + theme (only if the user hasn't explicitly overridden — same "auto-suggested, manual clears" pattern as the style). Badge copy: "Suggested from your reference."
- **Test:** mutation returns accent/theme; existing classify-persist test extended.

### T3 — `CreativeTemplate.kind` + backfill (db + router)
- Schema: add `kind String @default("style")` to `CreativeTemplate`. `pnpm db:push` (additive, safe).
- Backfill script `scripts/backfill-template-kind.ts` (idempotent): set `kind='logo'` where `referenceMediaId IS NULL AND logoMediaId IS NOT NULL`; leave the rest `'style'`. Run on prod via docker exec (documented like `db:backfill-orgs`). Local: run after push.
- `creative-template.router.ts`: `create` accepts `kind` (default derived from inputs if omitted: has `referenceMediaId` → "style", else "logo"); `list` returns it; `update` may change `name`/color only (kind is set at create). Keep IDOR guards.
- **Test:** create with each kind; list returns kind; backfill logic (pure function) unit-tested.

### T4 — Two-section library UI (web)
`RepurposeTab.tsx`: replace the single "Saved styles" block with TWO clearly-labeled sections driven by `kind`:
- **"Brand logos"** (`kind==='logo'`): thumbnails of the logo; click → set `logoUrl`/`logoMediaId`/`logoPosition` ONLY (+ logo-color fallback per D5: set accent from logo color only if no `aestheticRefUrl` active). Rename/delete kept.
- **"Saved styles"** (`kind==='style'`): thumbnails of the reference image; click → set `creativeStyle`/`theme`/`accentColor` (full saved look, D4) + `logoPosition`. Rename/delete kept.
- Drop the confusing combined dropdown. "Save as template" infers `kind` from what's present (reference → style; logo-only → logo) OR offers an explicit choice — keep it simple: if a reference is attached, save as a style; else save as a logo.
- Simplify copy: each section gets ONE line on what selecting does.
- **Visual/multimodal review** of the rendered UI states + at least one rendered creative proving the reference's orange now reaches the output.

### T5 — Visual gate + tests + ship
- Render premium_editorial with a reference whose accent is orange (no explicit picker, no logo) → VIEW the PNG → confirm the accent (underline/wordmark/highlight) is orange, matching the reference. Compare to `~/Downloads/MoviefiedPostRef.jpg`.
- Render with explicit picker color → confirm picker wins.
- Render logo-only (no ref) → confirm logo color used.
- Adversarial pass on the color precedence + any UI→server field that feeds a color/url (must stay `safeColor`/`safeImageUrl`).
- `pnpm --filter @postautomation/ai exec tsc --noEmit`, `... api ...`, web tsc; `pnpm --filter @postautomation/ai test`, `... api test` — UNPIPED, run by orchestrator.
- Ship: rebase onto origin/main → PR → merge → watch Deploy to Linode → verify prod 200.

## Invariants / guardrails
- Additive + fallback; no reference → existing behavior (D1 "don't sabotage what works").
- Every color/url/text stays behind `safeColor`/`safeImageUrl`/`escapeHtml`/`renderHighlightMarkup`. Keep per-slot media IDOR (`assertLogoMediaOwned`/`assertReferenceMediaOwned`/`assertMediaOwned`) + SSRF (`isPublicImageUrl`, `safeFetchPublicImage`) guards. `extractDominantColor` keeps its `isPublicImageUrl` SSRF guard.
- TWO `renderHighlightMarkup`: `card-engine.ts` `[[...]]`, `creative-templates.ts` `**...**`. Don't cross.
- Project is **db-push-managed** (NOT prisma migrate dev). pnpm@9.15.0. Run tsc + test UNPIPED, yourself.
- The Round-8 control model stays: picked `creativeStyle` ALWAYS decides the layout family (`effectiveStyle = input.creativeStyle`). Do NOT re-introduce the block engine into the Repurpose styled-render path.

## Process
model-tiered-execution (Sonnet implements, Opus reviews — implementer≠reviewer; run tests/tsc yourself) + subagent-driven-development. Color precedence + UI→server fields → adversarial review. Library UI → multimodal review. Visual gate (orange reaches output) BEFORE ship. Puppeteer at `~/.cache/puppeteer/chrome/mac_arm-146.0.7680.66/...`.

## DEPLOY RUNBOOK (must do, in order)
1. Deploy normally (push → merge → Deploy to Linode). The migrate container runs `db:push` and adds `CreativeTemplate.kind String @default("style")` — additive, non-destructive.
2. **AFTER db:push, run the backfill ONCE** so existing logo-only templates file under "Brand logos" (the column default is "style", so without this they show under "Saved styles" until run):
   ```bash
   ssh posting-automation 'docker exec postautomation-web-1 sh -c "cd /app && NODE_PATH=/app/packages/db/node_modules /app/packages/db/node_modules/.bin/tsx scripts/backfill-template-kind.ts"'
   ```
   Idempotent — only stamps rows that have a logoMediaId, no referenceMediaId, and still carry the default kind. Safe to re-run.

## Visual gate result (2026-06-15) — PASSED
Rendered premium_editorial via the real `generateStyledCreativeImage`→Puppeteer path with `brandColor:"#ff7a00"` vs no brandColor (default `#e11d48`) and VIEWED both PNGs: the orange render shows an orange logo badge + orange wordmark underline + photo→orange-gradient scrim (matches `~/Downloads/MoviefiedPostRef.jpg`); the default render is identical but RED — proving the accent is driven by `brandColor`, not hardcoded. The "fade copies but color doesn't" symptom is resolved: the scrim gradient is `linear-gradient(..., brandColor, ...)`, so once the reference's accent flows through (T1), fade AND color are both the reference's orange.

## Pointers
- Round 8 (control model + photo + UI): `docs/superpowers/plans/2026-06-15-repurpose-control-photo-ui-fix.md`; memory `project-repurpose-control-photo-ui`.
- Reference image: `~/Downloads/MoviefiedPostRef.jpg`; logo: `~/Downloads/Moviefied logo.png`.
- Key files: `packages/api/src/routers/repurpose.router.ts` (color merge `:1137`,`:1294`; `classifyStyleReference` `:856`), `packages/ai/src/tools/classify-card.ts` (accent extraction), `packages/ai/src/tools/news-image-generator.ts` (`extractDominantColor` `:408`), `packages/api/src/routers/creative-template.router.ts`, `packages/db/prisma/schema.prisma` (`CreativeTemplate` `:904`), `apps/web/components/content-agent/RepurposeTab.tsx`.
