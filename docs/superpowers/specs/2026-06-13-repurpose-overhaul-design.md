# Repurpose Overhaul — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design); implementation plan pending
**Author:** Claude (brainstormed with Tabish)
**Scope:** Content Studio → Repurpose (primary) + the stuck-scheduled-post worker bug (adjacent). Renderer changes automatically benefit NewsGrid Bot / Autopilot (shared `creative-templates.ts`).

---

## 1. Problem statement

Repurpose turns a URL into a caption + media bundle (`static | carousel | reel | ai_video`). A 2026-06-13 read-only recon (5 parallel readers, file:line cited below) confirmed **every** user complaint is real and reproducible in code:

1. **Style reference does nothing.** A pasted IG URL / uploaded image as a "style reference" produces output identical to having supplied nothing.
2. **Carousel is ugly & inconsistent.** Slides have mismatched text alignment; the cover and body slides look unrelated; failed slides break the set.
3. **Headlines duplicate and truncate.** Some creative styles render the same headline twice; headlines get cut mid-sentence.
4. **No real-image option.** AI image generation is always on; there is no way to use a real photo or disable AI.
5. **Scheduled posts stuck forever.** Super-Agent text-only posts (no media) targeting Instagram sit "Scheduled / in progress" indefinitely instead of failing.

### 1.1 Confirmed root causes (file:line)

- **Style-ref no-op:** reference image bytes reach the model only on the Gemini happy path. Gemini images are on a billing hold (per CLAUDE.md), so generation falls to OpenAI `gpt-image-1`, which **cannot accept image input** on this account → the reference is dropped; only a ≤40-word vision paraphrase ("Style notes: …") survives. `safe-image-generator.ts:152-162`, `dalle.provider.ts:98-139`, `describe-image-style.ts:37-80`. A pasted social URL is only mined for its `og:image`; its design/caption is never analyzed.
- **Carousel inconsistency:** `buildBodyChrome` (the shared body+CTA template) has **no `text-align`** on `.block/.body/.subhead` (they inherit left), while `.cta` is explicitly centered. The cover (slide 0) uses the chosen rich style, but **all** body+CTA slides collapse to `buildBodyChrome` regardless of `creativeStyle`. `creative-templates.ts:353-389`. `hookLine`, `secondaryImageUrl`, and the verified tick exist only in single style builders and never appear on body slides.
- **Headline duplicated:** `buildHookBars` renders two stacked bars (hook line + headline), and the hook prompt is fed the headline itself → the model echoes it. `repurpose.router.ts:180-184`, `creative-templates.ts:222-223`. On carousel body slides, `.subhead` = headline and `.body` defaults to the headline when no body is supplied. `creative-templates.ts:328,341-342`.
- **Headline incomplete:** `capHeadline` does a greedy ≤16-word / ≤90-char slice and only honors a sentence boundary above the 60% mark → mid-sentence cuts. `repurpose.router.ts:285-304`.
- **No real-image option:** `styleNeedsAiBackground()` is hardcoded `return true` (author comment: the `false` branch is "dead today"). `repurpose.router.ts:58-60`. The extracted article photo is only ever an AI-*failure* fallback, never user-selectable. The only real-image path is an explicit `userMediaIds` upload, **static format only**.
- **`bold_typographic` ignores theme:** hardcodes white text (`creative-templates.ts:283-284`) → white-on-light is unreadable on a light theme.
- **Scheduled posts stuck:** a media-less Instagram post throws `media_required` (`instagram.provider.ts:77-85`), which has **no handler** in the publish worker (handlers exist only for rate_limit / token_expired / content_too_large, `post-publish.worker.ts:478-540`). It falls to the else branch → `FAILED`; if that write throws, the `.catch` swallows + rethrows (`:561-564`) → BullMQ retries → the retry's atomic claim guard sees the target already `PUBLISHING`, returns `count===0`, and **silently returns without marking FAILED** (`:222-228`) → orphaned at `PUBLISHING` forever. Scheduled posts are created `SCHEDULED`, not enqueued at creation (`post.router.ts:171-173`); a 2-min cron `publishScheduledPosts` enqueues them (`cron-jobs.ts:375`); a 5-min watchdog reaps `PUBLISHING` > 30 min (`cron-jobs.ts:445-475`) but only if `updatedAt` isn't being refreshed by no-op retries.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|---|---|
| D1 | What a style reference DOES | **Template-match + real photo.** Detect the reference's layout, reproduce it deterministically (HTML/CSS) with a real photo. AI invents a photo only when no real one exists. |
| D2 | AI image generation | **Real-first, AI opt-in.** Default = real photo (upload → article og:image → branded background). An explicit toggle enables AI. |
| D3 | Text-styling controls (wired) | Highlight/accent color, **text-background opacity slider**, font family, text alignment, theme — plus any other feasible Instagram-grade control. No control ships unless it provably changes output. |
| D4 | Scope | Repurpose end-to-end **+** the stuck-scheduled-post worker fix. |
| D5 | Carousel body photos (single-article common case) | **Per-slide AI photo when AI is ON; otherwise reuse the cover hero photo.** |
| D6 | Auto-detected template | **Locked-with-Edit** — auto-selected and visually locked, with an "Edit" escape hatch to override. |
| D7 | Format coverage | **"Literally anything."** Renderer is a composable block engine (Component 1), not a fixed catalog — must reproduce any referenced static/carousel format. Presets are data; users can save their own. |
| D8 | Saved style references | **Save & reuse.** Every provided reference (image or URL) is persisted with its resolved `CardSpec` and re-pickable from a "Saved styles" gallery (Component 9). |
| D9 | Subject-cutout compositing | **Phase-2 stretch** (not core). Degrades to plain photo, or AI generates the composite scene directly when AI is on. |
| D10 | Custom images per slot | **Yes, all formats.** User can upload or Media-Library-pick their own image(s) (people, posters, etc.) and assign each to a specific image slot (background / inset / subject / grid tile / per carousel slide). Replaces static-only `userMediaIds`. |

**Design principle (D3 corollary):** *If a control reaches the UI, it must provably change the output.* Dead UI knobs and dead backend params are removed, not left dormant.

---

## 3. Architecture & components

### Component 1 — Composable card engine (`creative-templates.ts`, rebuilt)

> **Requirement (D7):** the renderer must produce *any* static/carousel format the user references — not a fixed list. Analysis of 17 reference cards (Moviefied, Bollywood Chronicle/Society/Paparazzi, SpaceX/IPO infographic, etc.) shows they are **one composable card language**, not N distinct templates. So instead of a rigid catalog we build **one block-composition engine** that renders an ordered set of optional, independently-configurable layers, plus **named presets** (saved block configurations) the detector maps to. The engine can render block combinations no preset covers — that is what satisfies "literally anything."

**The card model:** a card is a `CardSpec` = an ordered list of blocks over a 1080×1350 canvas. Every block is optional and independently styled. Blocks:

| Block | What it is | Seen in |
|---|---|---|
| `background` | base layer, one of: `photo` (real) · `subjectComposite` (cutout subject over scene — see stretch) · `ai` (generated) · `gradient` (branded) · `splitPhotos` (2-up) · `photoGrid` (2×2 / 1×N) · `topTextBottomPhoto` (solid text band + photo) · `screenshot` (phone/UI mockup) | all |
| `logo` | fully-parameterized logo block — see §3.1 | all (orange "m", "BOLLYWOOD CHRONICLE", "mam.", "DS" monogram, faint watermark, embedded KFC) |
| `circularInset` | **1–N** secondary images in a circle with a colored ring; position + size | Salman poster, Shivangi, CM headshots, **Hema (×2)** |
| `labelChip` | **1–N** pills/boxes with text, bg color, text color, per-span highlight, position | Shivangi name pill, **MrBeast "History Created" / "MrBeast Becomes…" gold-on-black**, Hema "Rejected" |
| `tweetHeader` | logo + display name + @handle + verified tick | Moviefied tweet cards |
| `captionStack` | **1–N** caption pills, each: text + multi-span highlight markup (see §Component 2) + bg color + **bg opacity** + text color + alignment + radius (pill/bar) + optional trailing emoji | nearly all (white/red/black bottom pills) |
| `statCards` | **1–N** label+value callout boxes | SpaceX "IPO SIZE / $75 BILLION" |
| `bodyText` | index + title + meta rows (Starring/Genre) + description paragraph | "Made in India" listicle, tweet body |
| `footer` | "Follow <brand> for more" line | Moviefied OTT body |
| `carouselChrome` | per-slide global decoration: progress bar / page dots + optional nav-arrow hint, consistent across the set | MAM/KFC periwinkle progress bar |
| `ctaCard` | end-slide: brand/gradient bg + optional phone mockup + follow button + logo | MAM "Follow Us" card |

**Future-proofing guarantee (answers "are you positive?"):** the model is closed under composition — every one of the 24 reference cards decomposes into the blocks above. A genuinely new style is either a new *combination* (free — just a new preset, which is data) or a new *block type* (additive — a new pure builder + a sanitizer entry, touching no existing block). There is no layout branch to fork, so adding styles never destabilizes existing ones. That is the structural property that makes it future-proof — not a promise that the current block list is final.

**Engine API:**
```ts
type CardSpec = {
  canvas: { w: 1080; h: 1350 };
  blocks: Block[];          // ordered; each Block is a discriminated union of the rows above
  controls: StyleControls;  // global defaults (theme, brand color, font, logo pos) — see Component 2
};
function renderCard(spec: CardSpec): string;  // pure → HTML; rendered to PNG by news-image-generator.ts
```
Each block builder is a pure, individually-testable function (`renderCaptionStack`, `renderCircularInset`, …). Every interpolated value flows through the sanitizers (Component 2 / §4). A block with missing inputs (no inset image, no stat data) simply isn't emitted — never a broken slot.

**Presets** (named `CardSpec` factories — what the detector targets, and what users pick from a gallery):

| Preset | Blocks enabled | Reference |
|---|---|---|
| `news_caption` | photo bg + logo + captionStack(1–2) | Jaishankar, Nirav Modi, Meghalaya |
| `news_inset` | photo bg + logo + circularInset(1–N) + captionStack + labelChip? | Salman/Kala Hiran, Shivangi, Khan Sir, Hema |
| `infographic_stats` | photo/subjectComposite bg + logo + captionStack + statCards | SpaceX IPO |
| `marketing_minimal` | topTextBottomPhoto bg + logo + headline w/ highlight-box + carouselChrome | MAM/KFC |
| `tweet_card` | white bg + tweetHeader + bodyText + photo/splitPhotos | Moviefied "shell shocked" / "revenge" |
| `photo_grid` | photoGrid bg + captionStack(top) | Kalki 2898 |
| `title_cover` | gradient/photo-strip bg + big title + accent word | OTT calendar cover |
| `listicle_body` | photo bg + bodyText + footer + logo | "Made in India" body |

Presets are data, not code branches — adding one is a config entry, and a user-saved configuration becomes a reusable preset (extends the existing `CreativeTemplate` model).

**Carousel mapping:** cover = a cover-oriented preset (e.g. `title_cover`); all body slides = the **same** body `CardSpec` with consistent alignment/logo/footer (fixes the inconsistency bug); `carouselChrome` (progress bar / dots) renders identically across the set; last slide = a `ctaCard`. Cover is intentionally distinct; bodies are identical to each other.

### Component 1.1 — Logo block (full flexibility)

The logo must not be a single fixed corner image. The 24 references use image marks, text wordmarks, monograms, faint watermarks, and embedded third-party brand logos, in different corners and sizes. So:

```ts
interface LogoBlock {
  kind: 'image' | 'wordmark' | 'monogram';
  src?: string;          // image: sanitized via safeImageUrl + assertLogoMediaOwned (IDOR)
  text?: string;         // wordmark/monogram: escaped
  anchor: 'tl'|'tc'|'tr'|'ml'|'mc'|'mr'|'bl'|'bc'|'br';   // 9-point
  size: number;          // % of canvas width, clamped
  opacity: number;       // 0–100 (low = watermark)
  box?: { bg: string; opacity: number; radius: number; pad: number };  // optional chip/pill behind logo
  watermark?: boolean;   // render faint, behind content (single or tiled)
}
```
- **Multiple logos allowed** (`LogoBlock[]`) — e.g. your brand mark + an embedded subject brand (the KFC card). Each independently anchored/sized.
- Image logos resolve from org-owned `Media` (reuses `assertLogoMediaOwned`); URLs sanitized by `safeImageUrl`; text escaped. Saved as brand assets (extends `CreativeTemplate`/brand-logo upload already in the UI).
- Defaults: a sensible brand-mark in a corner; if no logo, the block is simply omitted (no broken slot).

### Component 2 — `StyleControls` (global defaults + per-block overrides)

Two layers: **global defaults** on the `CardSpec`, and **per-block overrides** (each caption pill can have its own bg color/opacity, etc. — the SpaceX card mixes a yellow highlight with blue stat boxes; the Salman card mixes a red pill and a white pill).

```ts
type FontFamily = 'inter' | 'serif_display' | 'condensed' | /* curated bundled set */;
interface StyleControls {            // global defaults
  theme: 'light' | 'dark';
  brandColor: string;        // #hex, safeColor-sanitized
  highlightColor: string;    // #hex, safeColor-sanitized
  bgOpacity: number;         // 0–100, clamped  (default caption-pill opacity)
  fontFamily: FontFamily;    // enum allowlist
  textAlign: 'left' | 'center';
  logoPosition: 'tl' | 'tr' | 'bl' | 'br';
  fontScale?: number;        // optional fine-tune, clamped
}
interface CaptionPill {              // example of a per-block override
  text: string;              // highlight markup — see below
  bg?: string;               // pill bg color; default white/dark per theme
  bgOpacity?: number;        // overrides global; 0–100
  textColor?: string;
  align?: 'left' | 'center';
  shape?: 'pill' | 'bar';
  emoji?: string;            // trailing emoji
}
```

**Highlight system (per-span color + two render modes).** A single global accent can't render the Hema card (red/blue/purple words in one line) or the MAM card (a solid box behind words). So highlight is **per-span**:
- Markup: `[[text]]` = default accent; `[[text|#hex]]` = explicit color; `[[text|#hex|box]]` = solid highlight *box* behind the text (the MAM/IG-selection look) vs the default colored-*text* mode. Legacy `**text**` still maps to default-accent colored text.
- Each span is independently colored/moded; a pill can mix several. Rendered by `renderHighlightMarkup` (escape-then-markup), every color `safeColor`-sanitized, mode an enum. Tests assert span injection (`[[x|#fff" onload=…]]`), unbalanced markup, and box/text modes.

- Threaded **UI → zod mutation input → engine**. Every field maps to a real CSS variable; unset per-block fields inherit the global default.
- **Sanitization (extends existing XSS guards):** `safeColor` (strict `^#[0-9a-fA-F]{3,8}$` → else default) on *every* color (global + per-block), opacity clamp to [0,100], `fontFamily` enum allowlist, `textAlign`/`shape` enums, emoji whitelisted to a safe unicode range. Never interpolate raw. `creative-templates.test.ts` extended to cover per-block fields (injection via pill `bg`, `emoji`, multi-span markup breakout).
- Fixes the opacity complaint directly: each caption pill's background opacity is a slider (`rgba(var(--pill), <bgOpacity/100>)`), tunable like Instagram — no forced 100% solid block, per-pill.
- **Design rule (D3):** every UI control maps to a `StyleControls` or per-block field that provably changes output. No dead knobs.

### Component 3 — Template detection + auto-select

On style-ref provided (URL or upload):
1. Fetch reference image — reuse `safeFetchPublicImage` / og:image resolution (sound today).
2. `classifyCard(image)` → **structured** gpt-4o-mini vision call returning a `CardSpec`-shaped hint: `{ preset: <enum>, blocks: { logo, circularInset, labelChip, tweetHeader, statCards, captionCount }, theme, accentColor, confidence }`. It detects *which blocks are present* + accent/theme, not just a single template id. Replaces the prose-only `describeImageStyle` for layout (the prose descriptor still feeds AI photo prompts when AI is on).
3. UI: auto-select the matched preset, pre-fill `highlightColor`/`theme` and toggle the detected blocks on, show *"Detected: <Preset> — matched from your reference"*, and **lock the picker with an Edit button** (D6) that reveals the full block editor for overrides.
4. **Fallback:** classification failure or `confidence` below threshold → default to `news_caption` (the most universal preset); never block generation.

### Component 4 — Image resolution ladder (`resolveImage`, real-first)

Resolution is **per image slot**, not one global background (D10). *Every* image-consuming block — `background`, each `circularInset`, the `subjectComposite` subject, each `splitPhotos`/`photoGrid` tile, each carousel body photo — is an **`ImageSlot`** the user can fill explicitly. For each slot:
```
1. user-assigned image (upload OR Media Library pick) for THIS slot?  → use it   (source = 'user')
2. AI toggle ON?                                                       → generate (Gemini → OpenAI)  (source = 'ai')
3. article / post og:image (or next unused article image[])           → use it (SSRF-gated)  (source = 'article')
4. otherwise                                                           → clean branded gradient  (source = 'branded')
```

- **Custom images of people, etc. (D10):** the user can supply their own image(s) — by upload *or* by picking from the Media Library — and **assign each to a specific slot** (e.g. a person's photo as the `background` subject, a poster as a `circularInset`, distinct photos per carousel slide). Available for **all formats** (static *and* carousel), not static-only as the current `userMediaIds` is. Multiple images supported (insets, grid tiles, per-slide). Each is org-owned (`assertMediaOwned`) and SSRF/sanitization applies on render.
- Replaces the dead `styleNeedsAiBackground()` constant with a real, per-slot, parameterized gate driven by user assignment + the AI toggle + availability.
- `source` is returned per slot and surfaced honestly in the UI ("Your image" / "AI-generated" / "From article" / "Branded").

**Fallback matrix ("consider all possibilities"):**

| Situation | Behavior |
|---|---|
| No style ref | Manual preset pick (or default `news_caption`); all controls available |
| No real image + AI off | `branded` background; card renders cleanly (headline on brand gradient) — **never blank/broken** |
| Unknown/new reference layout | Classify to nearest preset; if none/low-confidence → `news_caption` |
| AI on but provider fails | Fall to article og:image, then branded — labeled honestly, never a broken slide |
| Carousel, single article photo, AI off | Cover uses hero; body slides reuse hero (D5) |
| Carousel, single article photo, AI on | Cover uses hero; body slides get per-slide AI photos (D5) |
| Block input missing (no inset image, no stat data, no 2nd photo for split/grid) | That block is **not emitted** — the card re-flows without it; never a broken/empty slot |
| Preset enables a block the source can't fill (e.g. `news_inset` but only one image) | Degrade to the nearest simpler preset (`news_inset` → `news_caption`); log the downgrade |
| `subjectComposite` requested but cutout unavailable | Fall back to plain `photo` background (subject shown un-cut) — see stretch goal |
| User assigns a custom image to a slot (any format) | That image wins for the slot (source='user'); other slots fall through the ladder independently |
| User assigns fewer custom images than slots | Assigned slots use the user image; remaining slots fall through (AI/article/branded) per slot |

### Component 5 — Carousel consistency

- Cover ≠ body by design; **all body slides identical** in layout (explicit `text-align` from `StyleControls`, identical logo offset + footer).
- Body photo sourcing: article `images[]` in order if multiple → else per D5 (AI-on: per-slide AI; AI-off: reuse hero).
- A failed AI slide falls through the resolution ladder to `article`/`branded` so it matches the set instead of breaking it.

### Component 6 — Headline integrity

- **No duplication:** the hook line is generated from a *different angle* with an explicit "do NOT repeat the headline" instruction; a post-generation normalized-similarity check (e.g. token Jaccard / Levenshtein ratio over a threshold) drops or regenerates (max once) a near-duplicate hook. The headline is **never** piped into both the headline slot and the hook/subhead slot.
- **No truncation:** generate at the target length; if over, cut on a full clause/sentence boundary (never mid-word, never mid-sentence). Prefer wrapping over cutting — the font ladder accommodates the raised ceiling. `capHeadline`/`capBody` retained and tuned, not replaced.

### Component 7 — Scheduled-post state machine (worker)

- Add a **`media_required` handler** in `post-publish.worker.ts` → mark target `FAILED` with a clear human reason ("Instagram requires an image; none attached and AI generation is off/unavailable").
- **Guaranteed-terminal FAILED write:** on the final BullMQ attempt, the claim guard must terminalize a stuck `PUBLISHING` → `FAILED` rather than silently returning `count===0`.
- **Block at schedule time:** if a media-required platform (IG/FB) is targeted with no media and AI is off, warn/block at creation (super-agent + compose paths) so a doomed post never enqueues. (Closes the user's exact scenario.)
- Verify the 30-min `PUBLISHING` watchdog reaps (no `updatedAt` refresh on no-op retries).

### Component 8 — UI (`RepurposeTab.tsx`)

- Remove every dead control.
- Prominent **Real ⇄ AI image** toggle (D2).
- Style-ref upload/URL → auto-detect → pre-selected + locked-with-Edit preset (D3/D6); Edit reveals the block editor.
- An Instagram-style **Text** panel: per-pill accent/highlight color (+ box-mode), **background-opacity slider**, font family, alignment, theme — each control shown only if the active blocks use it.
- A **"Saved styles" gallery** (Component 9) to re-pick a past reference/preset in one click.
- **Per-slot image picker (D10):** each image slot (background / inset / subject / grid tile / carousel slide) shows an "Add image" affordance → upload or Media Library pick; reorder/clear per slot. Works for static *and* carousel.
- Honest per-slot `source` labels.

### Component 9 — Saved style-reference library (reusable) — D8

A style reference the user provides (uploaded image **or** pasted URL) is **saved for reuse**, so a look tuned once is reusable forever. Reference + its resolved style live in **one** record (extends the existing `CreativeTemplate` model — org-scoped, already IDOR-guarded):

```
CreativeTemplate  (extended)
  + referenceMediaId   String?   // org-owned Media row of the source reference image (nullable: manual presets)
  + cardSpec           Json      // the resolved/edited CardSpec (preset + blocks + StyleControls)
  + sourceUrl          String?   // original ref URL, if pasted (sanitized; for provenance only)
  + name / thumbnail               // existing fields reused for the gallery
```

- **On generate with a new reference:** fetch (SSRF-gated) → `classifyCard` → on success, persist the reference image as an org `Media` row + the resolved `CardSpec` as a `CreativeTemplate` row. (Auto-save with a sensible default name; rename/delete in the gallery.)
- **Reuse:** the "Saved styles" gallery lists the org's saved references (thumbnail + name); picking one loads its `CardSpec` directly — **no re-upload, no re-classification, no AI call**. Deterministic and instant.
- **Ownership/security:** `referenceMediaId` resolves via `assertLogoMediaOwned`-class guard (org-scoped); `cardSpec` is sanitized on read (every color/url re-validated before render — never trust stored JSON blindly); `sourceUrl` stored for provenance only, never re-fetched without the SSRF guard. List/create/update/delete via the existing `creativeTemplate` tRPC router.
- **Carousel:** a saved style stores the cover + body `CardSpec` pair, so reusing it reproduces the whole multi-slide look.

---

## 4. Security invariants to preserve (do not regress)

- All `brandColor`/`highlightColor`/image-URL interpolations stay sanitized (`safeColor`, `safeImageUrl`, escape-then-markup). New `StyleControls` fields added to the sanitizer + its tests.
- SSRF fail-closed on every image fetch (`safeFetchPublicImage`, `isPublicImageUrl`) — reference fetch, og:image fetch, AI-reference fetch.
- IDOR guards intact: `assertLogoMediaOwned`, `assertMediaOwned`, org-scoped template ownership.
- No shell-string `execSync`/`execFileSync` regressions in any media path.

---

## 5. Testing / acceptance criteria

**Renderer / block engine**
- Each block builder renders in isolation; `renderCard` composes them at 1080×1350 with correct per-block align/opacity/color/highlight.
- Every preset (§Component 1) renders correctly; a hand-built `CardSpec` combining blocks no preset uses also renders (proves composability / "any format").
- All themes honored — no white-on-light (the old `bold_typographic` bug class).
- A block with missing inputs is omitted and the card re-flows (no empty slot); preset downgrade path works (`news_inset` → `news_caption`).
- Sanitizer tests cover global **and per-block** fields (pill `bg`/`emoji` injection, multi-span markup breakout, opacity bounds, font/align/shape enums, `</style><script>`, `url()` breakout).

**Carousel**
- Cover visually distinct; all body slides share one layout; CTA consistent.
- Single-article + AI-off → body reuses hero; AI-on → per-slide AI; failed AI → article/branded, set stays coherent.

**Headlines**
- No rendered slide shows the headline twice (hook≠headline, subhead≠headline).
- No headline cut mid-word/mid-sentence; complete clause or wrapped.

**Image source**
- Per-slot resolution ladder unit-tested across the full fallback matrix; correct `source` label each branch.
- AI toggle off + no real image → branded background, never blank.
- **Custom image per slot (all formats):** user-assigned image wins its slot; other slots resolve independently; assigning fewer images than slots leaves the rest to fall through; org-ownership (`assertMediaOwned`) enforced; works for static + carousel.

**Detection**
- `classifyCard` returns a valid preset + block flags (or a low-confidence default); UI locks-with-Edit; failure never blocks generation.

**Saved style library**
- Providing a reference persists a `CreativeTemplate` (referenceMediaId + cardSpec); re-picking it loads the `CardSpec` with **no AI call** and reproduces the look (static + carousel cover/body).
- Stored `cardSpec` is re-sanitized on read (color/url injection via a tampered row is rejected); cross-org access blocked (IDOR).

**Scheduler**
- Media-less IG scheduled post → `FAILED` with clear reason (not stuck).
- Forced double-claim race → terminalizes, no `PUBLISHING` orphan.
- Schedule-time block fires for IG/FB + no media + AI off.

---

## 6. Out of scope / stretch

**Out of scope:**
- Resolving the Gemini/Veo3 Google Cloud billing hold (infra/billing, not code).
- Adding `dall-e-2` image-edit conditioning (account lacks access).
- New video formats (reel/ai_video pipelines unchanged except where they share the renderer).
- Billing/plan gates (untouched; `BILLING_DISABLED` state preserved).

**Stretch (flagged, not core):**
- **`subjectComposite` auto-cutout** — the SpaceX/Maharashtra/Nirav cards composite a subject *cutout* over a themed scene. Automatic cutout needs a background-removal capability (segmentation model or a service like remove.bg). **Core behavior:** when cutout is unavailable, `subjectComposite` degrades to a plain `photo` background, and if AI is ON the composite scene can be generated directly by the image model instead. Auto-cutout is a phase-2 enhancement, not a blocker for "any format" — the block exists in the model; only the automatic matting is deferred.

---

## 7. Sequencing

The scheduler fix (Component 7) is independent and can land first/parallel. The renderer + template work (Components 1–6, 8) is the cohesive core. Detection (Component 3) depends on the catalog (Component 1) existing.

---

## 8. Salvageable vs rebuild (file-level)

**Salvage/extend:** `url-extractor.ts` (`getImages`/`resolveImageFromPageUrl`/`pickArticleBgImage`), SSRF guards (`safeFetchPublicImage`/`isPublicImageUrl`), scheduling cron + atomic claim, `capHeadline`/`capBody`, `CreativeTemplate` model (extend to store a saved `CardSpec`).
**Rebuild/rework:** `creative-templates.ts` → composable block engine (`renderCard` + per-block builders + presets), replacing the fixed `buildPremiumEditorial/buildHookBars/buildTweetCard/buildBoldTypographic` + `buildBodyChrome` split; hook/headline dedup; `safe-image-generator.ts` fallback ladder + `bgSource` third state; the real-image gate (replace `styleNeedsAiBackground`); `RepurposeTab.tsx` controls (preset gallery + block editor).
**Migration note:** the existing four style ids map onto presets (`premium_editorial`→`news_caption`, `hook_bars`→`news_caption` w/ 2 pills, `tweet_card`→`tweet_card`, `bold_typographic`→`title_cover`), so NewsGrid/Autopilot callers keep working through a thin compatibility shim while they migrate to `CardSpec`.
