# Round 10 Handoff Prompt — Repurpose True Style Mimicry (image-to-image)

**Paste the block below to the next session to execute.** It is self-contained but points at the approved spec + memory for full grounding.

---

## NEXT-SESSION PROMPT (copy from here)

Implement **Round 10 of the Repurpose feature** in `/Users/tabish/Desktop/Dashmani-PostAutomation` (pnpm@9.15.0 monorepo: Next.js web + tRPC api + `@postautomation/ai`).

**READ FIRST, in order:**
1. The approved design spec: `docs/superpowers/specs/2026-06-15-repurpose-style-mimicry-design.md` — this is the source of truth (locked decisions D1–D6, architecture, fallback ladder, UI, labeling, safety, testing).
2. Memory `project-repurpose-style-mimicry-gap` (the architectural root cause + why 9 rounds never mimicked layout) and `project-repurpose-color-library-split` (Round 9, what shipped).
3. CLAUDE.md → "AI Content — Repurpose / Content Studio" → the "KNOWN GAP — style-reference mimicry is COLOR/THEME ONLY" bullet.

**THE PROBLEM (do not re-diagnose — it's confirmed):** the render only picks 1 of 4 hand-coded templates (`creative-templates.ts buildStaticCreative`) and tints it with the reference's color. It has NEVER reproduced a reference's LAYOUT. The user confirmed: "you only change the colours, not the style. Not once."

**THE FIX (approved):** when a new "Recreate this reference's layout (AI)" toggle is ON, route the static + carousel-cover render through **Gemini image-to-image** (the existing multi-image `nano-banana.provider.ts` / `gemini-3.1-flash-image-preview` path that already accepts `[prompt, inline_data refs…]`) to reproduce the reference's full composition with the user's content swapped in. Graceful ladder: **Gemini img2img → OpenAI "described" (vision-describe ref → gpt-image-1 text-to-image) → existing template**. Per-output text-strategy toggle: "AI text" vs "Safe text overlay". Toggle OFF (default) = today's behavior, byte-for-byte (the user's "don't sabotage what works" constraint — verify the OFF path is untouched).

**KEY GROUNDED FACTS (verified this session):**
- Gemini multi-image input ALREADY works on this account: `nano-banana.provider.ts:75-88` builds `parts = [{text}, {inline_data}…]`. `generateNanoBanana({ prompt, referenceImages })` is the entry; `generateImageSafe` already plumbs `referenceImages`.
- **OpenAI on this account CANNOT do image-to-image** (no dall-e-2; `gpt-image-1` edit unavailable — `dalle.provider.ts:142` is a text-only stub). So rung 2 is OpenAI TEXT-to-image from a vision DESCRIPTION of the ref (use the existing `describeImageStyle`), NOT image-to-image. Only Gemini truly mimics.
- The reference image is ALREADY fetched in `repurpose.router.ts` as `aRef` via `safeFetchPublicImage` (SSRF-gated, ~line 1187). Reuse it — no new fetch surface. Same for the resolved hero photo + logo.
- Round-9 `effectiveBrandColor` precedence (picker > ref accent > logo > default) must be preserved and passed as a prompt hint.

**BUILD (per the spec):**
- New module `packages/ai/src/tools/reference-card-generator.ts` — `generateReferenceStyledCard({ referenceImage, heroImage?, headline, brandName, handle?, logoImage?, brandColor?, textMode })` → `{ imageBase64, mimeType, engine }`. Implements the ladder + the two text modes (see spec for exact prompts). "overlay" mode reuses existing Puppeteer text/logo overlay primitives (`overlayLogoOnImage` + creative-template text rendering) so text is always correct.
- Wire into `repurpose.router.ts` `buildHeadlineCreative` + carousel-cover path: new inputs `referenceMimicry: z.boolean().default(false)`, `mimicryTextMode: z.enum(["ai","overlay"]).default("overlay")`; branch on `referenceMimicry && aRef` → mimic, else existing render UNCHANGED. Return `engine` to the response.
- UI `RepurposeTab.tsx`: the toggle (shown only when a ref is attached, OFF by default) + the text sub-toggle + honest result-chip labels per rung (see spec). Style picker stays — it governs the OFF path + template fallback.
- Scope: static + carousel COVER (slide 0) only; body/CTA slides keep the template grammar. Reel/AI-video untouched.

**INVARIANTS:** Additive + fallback; OFF path byte-identical. Every color/url/text behind `safeColor`/`safeImageUrl`/`escapeHtml`. SSRF (`safeFetchPublicImage`/`isPublicImageUrl`) + IDOR (`assertMediaOwned`) + per-image plan gate (`aiImagesPerMonth`) unchanged. NO_REAL_PERSON/clean-text clause appended to Gemini prompt. db-push-managed (NOT prisma migrate dev). TWO `renderHighlightMarkup` — card-engine `[[...]]`, creative-templates `**...**`; don't cross.

**PROCESS:** Use **model-tiered-execution** (Sonnet implements, Opus reviews — implementer ≠ reviewer; YOU run tsc/tests, and run tsc **BARE not piped** so `$?` is the real exit code — a piped tail masked a type error last session) + **subagent-driven-development**. The Gemini prompt + ladder is the hard part: iterate the prompt against the VISUAL GATE. Security (new fetch/overlay paths) → adversarial review. Output → **multimodal visual review (the whole point)**.

**VISUAL GATE = DEFINITION OF DONE (never passed before):** render BOTH of the user's references through the ON path — (1) the Moviefied/Akshay photo-headline card, (2) the "Your Hollywood Calendar" cream-bg + centered highlighted headline + 4-image filmstrip card — VIEW the PNGs, and confirm the LAYOUT matches (filmstrip present, centering, eyebrow), not just the color. Puppeteer Chrome at `~/.cache/puppeteer/chrome/mac_arm-146.0.7680.66/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`. The user's reference images are in the chat history / `~/Downloads/` (MoviefiedPostRef.jpg + the calendar ref). Do NOT ship until a rendered output visibly reproduces a reference's layout.

**SHIP:** branch off latest origin/main; commit per task; rebase → PR → merge → watch "Deploy to Linode" (`gh run watch`) → verify `https://postautomation.co.in/` 200. **Do NOT push/merge until the user approves** — present the visual-gate PNGs for sign-off first.

**OPS NOTE (not code):** OpenAI image credits were depleted as of Round 9 (top up to re-arm rung 2/the OFF-path AI background). Gemini billing is now ON (user added it) — rung 1 should work.

## END NEXT-SESSION PROMPT
