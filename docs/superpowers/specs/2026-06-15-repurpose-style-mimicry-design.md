# Repurpose — True Style Mimicry via Reference-Driven Image-to-Image (Round 10 design)

**Date:** 2026-06-15
**Status:** APPROVED (brainstorm complete; ready for writing-plans)
**Branch (brainstorm):** `repurpose-style-mimicry-brainstorm`
**Prior context:** memory `project-repurpose-style-mimicry-gap`, `project-repurpose-color-library-split` (Round 9). CLAUDE.md "AI Content — Repurpose" KNOWN GAP bullet.

## Problem (user, 2026-06-15, with 6 screenshots incl. 2 distinct refs + a Gemini-billing-ON output)
> "It is still unable to mimic the style. The colour it does appropriately, but not the style. … Not once, in all our changes, have you given an output able to mimic the ref's style. Not once."

**Verified root cause (architectural, not tuning):** the Repurpose static + carousel render goes `buildHeadlineCreative → renderStaticCreative → buildStaticCreative` = ONE of 4 hand-coded HTML/CSS templates (`creative-templates.ts`). A style reference can only (a) PRE-SELECT which of the 4 (`classifyStyleReference`→`suggestedStyle`) and (b) supply color/theme/logo (Round 9). It can NEVER produce a layout that isn't one of the 4. So color mimics (it's a variable) but layout never has (there's no code path that builds the reference's layout). Round 7 (PR #64) built a vision→block-engine layout mimic but Round 8 (PR #65) reversed it because it ignored the user's picker. Gemini image-to-image (billing now ON) currently only conditions the BACKGROUND; the card chrome is still the fixed template overlaid on top.

## Locked decisions (user, this round — do NOT re-litigate)
- **D1 — "Mimic" = pixel-faithful recreation.** The output should look like the reference's composition (layout, element placement, filmstrip/eyebrow/footer, typography treatment) with the user's content swapped in — not a tinted template.
- **D2 — Engine = AI image-to-image, the codebase's existing multi-image Gemini path** (`gemini-3.1-flash-image-preview` via `nano-banana.provider.ts`, which already accepts `[text prompt, inline_data refs…]`). OpenAI on this account CANNOT do image-to-image (no `dall-e-2`; `gpt-image-1` edit not available — see `dalle.provider.ts:142` stub + CLAUDE.md). OpenAI is text-to-image only.
- **D3 — Graceful-degradation ladder, every rung usable + honestly labeled:**
  1. **Gemini image-to-image** — true layout mimic.
  2. **OpenAI "described"** — a vision model describes the ref's layout → `gpt-image-1` text-to-image "in that style" (approximate, NOT pixel-faithful, but freer than the rigid template).
  3. **Existing 4-template render** — always produces a clean card.
- **D4 — The template path stays a FIRST-CLASS, always-available choice** (mimicry is purely additive/opt-in). Mimicry toggle OFF (default) = today's behavior, byte-for-byte. "Don't sabotage what works" is satisfied at the design level.
- **D5 — Per-output text-strategy toggle:** "AI text (most faithful — Gemini renders the headline too)" vs "Safe text overlay (Gemini leaves headline space; deterministic code overlays exact text/logo — always correct/editable)."
- **D6 — Scope = the static post + the carousel COVER (slide 0) only** (every prior round treated the cover specially). Carousel BODY/CTA slides keep the existing template grammar so the carousel stays internally consistent — mimicking the ref on the cover, then template body slides, matches how the cover already "leads" the set. Reel/AI-video untouched.

## Architecture

### New module: `packages/ai/src/tools/reference-card-generator.ts`
One job: ref image + content → finished 1080×1350 card PNG via Gemini image-to-image.
```ts
generateReferenceStyledCard({
  referenceImage: { base64, mimeType },     // image-to-image PRIMARY input
  heroImage?: { base64, mimeType },          // user's hero/article photo (content placed IN the layout)
  headline: string,
  brandName: string, handle?: string,
  logoImage?: { base64, mimeType },
  brandColor?: string,                       // safeColor; passed as a prompt hint
  textMode: "ai" | "overlay",
}): Promise<{ imageBase64: string; mimeType: string; engine: "gemini-img2img" | "openai-described" | "template" }>
```
- **textMode "ai":** one Gemini call. Prompt ≈ *"Recreate the composition, layout, typography, and color treatment of the FIRST image EXACTLY. Replace its photo with the SECOND image and its headline with: «headline». Preserve the brand wordmark + logo treatment."* Inputs `[referenceImage, heroImage?, logoImage?]`. Output = finished card.
- **textMode "overlay":** Gemini prompt ≈ *"…recreate the layout but leave the headline area as clean negative space, no text…"* → then **deterministic overlay** of headline + logo + handle via existing Puppeteer text/logo primitives (`overlayLogoOnImage` + creative-template text rendering). Text always correct/editable.
- **NO_REAL_PERSON / clean-text safety clause appended** to the Gemini prompt (same as the current AI-background path).

### Fallback ladder (inside `generateReferenceStyledCard` or its caller)
1. `generateNanoBanana({ prompt, referenceImages: [ref, hero?, logo?] })` → on image returned, done (`engine:"gemini-img2img"`).
2. On Gemini fail/empty: `describeImageStyle(ref)` (existing OpenAI vision) → fold the layout description into a `gpt-image-1` text-to-image prompt → on success `engine:"openai-described"`. (text overlaid in "overlay" mode regardless.)
3. On both fail: signal caller to use the existing `renderStaticCreative` template path (`engine:"template"`).

### Wiring in `repurpose.router.ts` (surgical, additive)
- New input fields: `referenceMimicry: z.boolean().default(false)`, `mimicryTextMode: z.enum(["ai","overlay"]).default("overlay")`.
- In `buildHeadlineCreative` + the carousel-cover path: **if `referenceMimicry && aRef` (the already-fetched, SSRF-gated reference image exists) →** call `generateReferenceStyledCard(...)`, return its PNG. **Else →** existing `renderStaticCreative` path, byte-for-byte UNCHANGED.
- Reuse `aRef` (already fetched via `safeFetchPublicImage`); reuse the resolved hero photo + logo. No new fetch surface.
- Round-9 `effectiveBrandColor` precedence preserved (passed as the prompt hint).
- The returned `engine` flows to the response so the UI can label honestly.

### Data flow
```
URL → extract → captions + hero photo
                  │
  referenceMimicry ON & ref usable? ── no ──→ existing 4-template render (UNCHANGED)
                  │ yes
        aRef (already SSRF-fetched) + hero + logo + textMode
                  │
        generateReferenceStyledCard → ladder:
           1 Gemini img2img (mimic)  → 2 OpenAI described (approx) → 3 template
                  │
        1080×1350 PNG → same downstream (Media row, carousel ids, publish)
```

## UI (`RepurposeTab.tsx`)
- **"Recreate this reference's layout (AI)"** toggle — shown ONLY when a reference is attached; OFF by default.
- When ON, reveal the text sub-toggle (D5): "AI text (most faithful)" vs "Safe text overlay (always correct)".
- Copy: *"Recreates your reference's full layout with AI. Falls back to a styled template if AI is busy."*
- Style picker unchanged — governs the OFF path + the template-fallback rung. This RESOLVES the 9-round picker-vs-reference tension: they are now SEPARATE MODES (picker = template family; mimicry = recreate the reference).

## Honest result labeling (the chip — never lie about which rung ran)
- `gemini-img2img` → "Recreated from your reference (Google Gemini)"
- `openai-described` → "Styled after your reference (AI approximation)"
- `template` → "Style approximated with a template (AI was unavailable)"
Kills the false-echo bug (Round 6) permanently.

## Safety / invariants
- Reference + hero + logo fetched via `safeFetchPublicImage`/`isPublicImageUrl` (SSRF — reuse `aRef`, no new surface).
- `brandColor` behind `safeColor`; overlaid text behind `escapeHtml`/`safeImageUrl` (reuse existing sanitized primitives — do NOT interpolate raw).
- Gemini prompt: NO_REAL_PERSON/clean-text clause appended; on prod billing-403 path the descriptor reaching `gpt-image-1` is style-only + length-capped (same bounded blast radius as today).
- Per-image plan gate (`aiImagesPerMonth`) + IDOR (`assertMediaOwned`) unchanged.
- db-push-managed; pnpm@9.15.0; two `renderHighlightMarkup` (card-engine `[[...]]`, creative-templates `**...**`) — don't cross.

## Testing
- **Unit:** `reference-card-generator` builds correct Gemini `parts` (ref+hero+logo) per `textMode`; ladder degrades correctly (mock Gemini fail → OpenAI described → template); OFF path calls existing render untouched; honest `engine` value returned per rung.
- **Visual gate (definition of done — the gate never passed before):** render BOTH user refs through the ON path — (1) Moviefied/Akshay photo-headline, (2) Hollywood-Calendar cream-bg + centered highlighted headline + 4-image filmstrip — view the PNGs, confirm the LAYOUT matches (filmstrip present, centering, eyebrow), not just color. Compare to the supplied screenshots.
- Existing security-regression suites stay green (creative-templates XSS, image-fetch SSRF, IDOR guards).

## Process (for the implementing session)
model-tiered-execution (Sonnet implements, Opus reviews — implementer≠reviewer; run tsc/tests BARE, not piped, so `$?` is real) + subagent-driven-development. The Gemini prompt + fallback ladder is the hard part — iterate the prompt against the visual gate. Security (new image fetch/overlay) → adversarial pass. Output → multimodal visual review (this is the whole point). Ship via rebase→PR→merge→deploy→backfill(n/a)→verify prod 200. Don't push/merge until the user approves.

## Out of scope (YAGNI)
- Expanding the hand-coded template library (D1/D2 chose img2img over more templates).
- Re-wiring the Round-7 block engine (img2img supersedes it for fidelity; block engine stays for NewsGrid/autopilot).
- Reel / AI-video changes.
- Saving a mimicked layout as a reusable template (future; the saved-styles library from Round 9 still stores refs).
