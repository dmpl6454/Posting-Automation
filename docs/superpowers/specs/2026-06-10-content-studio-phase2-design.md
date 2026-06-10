# Content Studio — Phase 2 (Rendering Quality + Video Architecture) Design

**Date:** 2026-06-10
**Branch:** `fix/content-studio-phase2` (off `main` after Phase 1 merge, `1194c6c`)
**Audit source:** `project-postautomation-audit-2026-06-09-superagent-contentstudio`
**Locked product decisions (from brainstorming — do NOT re-ask):** light default + Dark/Gradient toggle · skip AI background for hook_bars/bold_typographic · all carousel slides on the branded template · video generation → BullMQ worker · Seedance allow generic people (no specific real individuals) + burn clean ffmpeg text · own-image = post media + captions (Phase 3).

## Goal

Make Content Studio creatives look good and consistent, and make video generation robust. Phase 2 changes product look/behaviour (intentionally — these are the "ugly/dark/blank/inconsistent/spinner-forever" complaints). Splits into **two PRs** to keep each reviewable:

- **Phase 2a — Rendering quality** (no worker/queue changes): theme/light default, skip-AI-bg text styles, hook highlight, bold variety, carousel all-template + single-browser reuse, accentColor wiring.
- **Phase 2b — Video architecture**: reel/Seedance generation → worker job (removes web-ffmpeg dep + spinner-forever + HTTP-timeout risk), Seedance people + clean text overlay.

## Out of scope (Phase 3)
Aesthetic reference image, aesthetic-context text box, per-image Regenerate, slide-count selector, Seedance duration selector, no-op audio-toggle cleanup, attach-own-image.

---

## Phase 2a — Rendering quality

### 2a.1 Theme support (light default + Dark/Gradient toggle) — fixes C3 + the "dark" complaint
- `creative-templates.ts`: add `theme?: "dark" | "light" | "gradient"` to `StaticCreativeOptions` (default `"light"`). Each of the 4 style builders branches on theme:
  - **light** (default): near-white/`#f7f7f8` bg fallback, light scrim (`rgba(255,255,255,0.55)` bottom-up gradient over photo), DARK headline/label text (`#0f1419`), accent rule = brand color.
  - **dark**: current behaviour (near-black navy fallback, `rgba(0,0,0,0.85)` scrim, white text).
  - **gradient**: brand-color → darker-brand gradient fallback, white text, lighter scrim.
  - A small pure helper `themeTokens(theme, accent)` → `{ bgFallback, scrim, textColor, subTextColor }` consumed by all builders (DRY).
- `repurpose.router.ts`: pass `theme: input.theme` into `generateStyledCreativeImage`/`buildStaticCreative`. Vary the AI-bg prompt by theme — light: "bright, airy, well-lit"; gradient: "vibrant, colorful, dramatic lighting"; dark: keep "dark/moody". Remove the unconditional "Dark/moody tones" suffix.
- `RepurposeTab.tsx`: default the `theme` state to `"light"`; show the Dark/Light/Gradient toggle for static + carousel formats (currently shown only for video formats). Existing schema field — no router schema change.
- **Invariant:** light theme MUST flip text colors to dark, or headlines become invisible on light bg. Test all 4 styles × 3 themes render legibly (visual spot-check via headless PNG).

### 2a.2 Skip AI background for hook_bars + bold_typographic — fixes the blank-card class + speed
- `repurpose.router.ts` `buildHeadlineCreative`: when `input.creativeStyle ∈ {"hook_bars","bold_typographic"}`, SKIP the `generateImageSafe` call and pass NO `bgImageUrl` to `generateStyledCreativeImage`. These styles render from brand color + typography only → sub-second, never blank, no AI image cost. `premium_editorial` + `tweet_card` keep the AI photo background.
- Builders must already render acceptably with no `bgImageUrl` (they use a solid/gradient fallback) — verify `buildHookBars`/`buildBoldTypographic` do; the theme fallback from 2a.1 covers it.

### 2a.3 hook_bars word highlight — fixes C2 (Note3: "white bar, no highlight")
- Root cause: the router never passes `hookLine`, and nothing produces `**word**` markup. `renderHighlightMarkup` is already wired in `buildHookBars` (line ~133) but `opts.hookLine` is always undefined.
- Fix: when `creativeStyle === "hook_bars"`, generate a short punchy hook line (≤7 words) with one or two key words wrapped in `**...**`, via `generateContentResilient` (the existing resilient text helper), and pass it as `hookLine`. `renderHighlightMarkup` converts `**word**` → brand-color spans (already escapes HTML first — XSS-safe). Cap/sanitize length.

### 2a.4 bold_typographic variety — fixes C1 ("all identical")
- Root cause: builder ignores everything but headline; bg hardcoded `#0d0d12`.
- Fix: make it respond to `theme` (2a.1 fallback bg) + `brandColor` (accent band) + headline length (font-size tiers already exist) + optional `tag`/`subhead`. With AI bg skipped (2a.2), variety comes from theme + brand color + content. No longer a fixed dark charcoal for every post.

### 2a.5 Carousel all-template consistency — fixes C4 (slide-1 ≠ slides 2+)
- Root cause: cover via `buildHeadlineCreative` (template), body/CTA via raw `generateImageSafe` + `applyLogoOverlay` → different visual grammar.
- Fix: route ALL carousel slides through the branded template. Add a `carousel_body` layout to `creative-templates.ts` (`buildStaticCreative` gains body/CTA variants OR a `slideRole: "cover"|"body"|"cta"` field): same chrome (logo corner, accent rule, scrim, typography, theme) but a large body-text block instead of just a headline; CTA slide = "Follow for more" in the same chrome. Body slides may still use an AI photo background (premium/tweet styles) but with the SAME template chrome, so they read as one set.
- **Single-browser reuse (perf, N13/A4):** `generateStyledCreativeImage`/`overlayLogoOnImage` accept an optional pre-launched `browser`; the carousel loop launches ONE browser and reuses it across all slides (per-page error isolation). Eliminates the 7+ cold Chrome boots per carousel.

### 2a.6 accentColor wiring
- Root cause: UI never sends `accentColor`; saved-template `brandColor` ignored.
- Fix: `RepurposeTab.tsx` adds an `accentColor` state (a `<input type="color">` / hex field near the logo uploader). Template `onValueChange` also sets `accentColor` from `t.brandColor`. Pass `accentColor` in `repurposeFromUrl.mutate`. Router already accepts + uses it (`resolvedBrandColor = input.accentColor || …`). `safeColor` already validates. No backend change.

### 2a testing
- `creative-templates.test.ts`: extend for `themeTokens` (light/dark/gradient → correct text/bg/scrim) + the `carousel_body`/`slideRole` builder (renders body text, applies theme, escapes input). Keep the XSS/CSS-injection sanitizer tests green.
- Pure-helper tests for the hook-line markup capping. Visual spot-check (headless PNG) of all 4 styles × light/dark.
- Gates: `pnpm --filter @postautomation/ai test` + `@postautomation/api test` + both `tsc --noEmit` exit 0.

---

## Phase 2b — Video architecture

### 2b.1 Reel/Seedance generation → BullMQ worker — fixes spinner-forever + ffmpeg-in-web + HTTP timeout
- **New queue:** add `repurposeVideoQueue` + `QUEUE_NAMES.REPURPOSE_VIDEO` in `packages/queue` (follow the existing `createQueue<T>(QUEUE_NAMES.X)` pattern). Job data: `{ userId, organizationId, progressId, format: "reel"|"seedance_video", payload (slide image refs / seedance params + scenes), theme, audio opts }`.
- **Mutation change (`repurpose.router.ts`):** for `reel`/`seedance_video`, the mutation does the fast prep (captions, scene extraction, and for reel the slide PNGs — which are Phase-2a template renders), uploads slide images to S3, then ENQUEUES a `repurposeVideoQueue` job and RETURNS immediately with `{ videoPending: true, progressId }` (no synchronous ffmpeg/Seedance in the web process). No more web-ffmpeg dependency (Phase 1's interim ffmpeg-in-web becomes unnecessary — leave it, harmless).
- **New worker (`apps/worker/src/workers/repurpose-video.worker.ts`):** consumes the job (worker already bundles ffmpeg). Generates the video (reel = ffmpeg stitch of the slide PNGs + audio; seedance = `generateSeedanceVideo` + post-process), uploads the MP4 to S3, creates the `Media` row, and PUBLISHES progress + a terminal `{ type: "video_ready", mediaId, url }` (or `video_error`) event to the **userId-scoped** progress channel (`progress:${userId}:${progressId}` — reuse `scopedProgressId` from Phase 1; the job carries `userId`). On failure publish `video_error` with a friendly message.
- **UI (`RepurposeTab.tsx`):** when the mutation returns `videoPending`, keep the SSE open (already userId-scoped) and render the result from the SSE `video_ready` event (mediaId/url) instead of the mutation return value. Add a definite client-side safety timeout (e.g. 10 min) → show "still processing / check back" instead of an infinite spinner. The existing 7.5-min Seedance provider timeout now lives in the worker and resolves to `video_error`.
- **Progress channel cross-process:** the worker publishes to the same Redis channel the SSE reads. Confirm the worker's `progress` helper writes/publishes with the scoped id identically to the web writer (share `lib/progress.ts` `scopedProgressId`; the worker imports it).
- **Plan gate / quota:** the AI-video plan gate (`requirePlan PROFESSIONAL`) + `postsPerMonth`/`aiImagesPerMonth` limits must run in the MUTATION (before enqueue), not the worker, so a gated user can't enqueue. Keep `ctx.isSuperAdmin` passthrough.

### 2b.2 Seedance — generic people + clean text overlay — fixes D7b (no people, garbled text)
- `seedance.provider.ts` `buildSeedancePrompt`: REMOVE the hardcoded "Do NOT show real people's faces" ban; allow generic people/crowds/silhouettes. Add explicit guidance to AVOID depicting a specific named real individual's likeness (deepfake/policy risk) — generic figures only. (This is the locked decision.)
- **Clean text:** stop asking the model to render in-video text (models garble it). Instead, after the worker downloads the Seedance MP4, post-process with ffmpeg `drawtext` to burn clean caption/scene text on top (same approach the reel generator already uses). Requires the worker (has ffmpeg) — fits 2b.1's worker move.

### 2b testing
- Queue test: `repurposeVideoQueue` exported + named (follow `queues.test.ts`).
- Pure-helper tests for the worker job payload builder + the scoped progress event shape.
- Worker test (root vitest globs `apps/**/src/**`): the video worker publishes a `video_ready` event with mediaId on success and `video_error` on failure (mock prisma/S3/ffmpeg + the seedance provider).
- Manual/integration: the seedance prompt no longer bans people; the drawtext overlay produces legible text (spot-check).
- Gates: full `pnpm type-check` + `pnpm build` + all suites green.

---

## Risks & rollout
- **2a:** light-default changes EVERY new creative's look — intended, but flag in the PR. The text-color flip is the main legibility risk (tested). Carousel all-template + single-browser reuse changes the body-slide pipeline — verify slides still upload + attach (Phase 1's carousel-publish path is downstream and unchanged).
- **2b:** the result-delivery model changes from "mutation returns video" to "SSE delivers video" — the highest-risk change; the client must handle `videoPending` + the terminal SSE event + a timeout. Schema: **no Prisma changes** (reuses Media/Notification). New queue + worker = additive infra; the worker container already has ffmpeg.
- **Deploy:** 2a and 2b ship as separate PRs to `main`; each auto-deploys. 2b adds a new worker — confirm the worker process registers the new queue consumer (wire it into the worker's bootstrap alongside the other workers).
- Seedance "generic people" raises Meta/TikTok policy exposure slightly; mitigated by the "no specific real individuals" prompt guidance + the operator's existing review posture.
