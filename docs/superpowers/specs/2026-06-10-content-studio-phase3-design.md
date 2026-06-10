# Content Studio — Phase 3 (Features) Design

**Date:** 2026-06-10
**Branch:** `fix/content-studio-phase3` (off `main` after Phase 2b merge, `80f0e37`)
**Audit source:** `project-postautomation-audit-2026-06-09-superagent-contentstudio` (E1-E4, D7a, D-ADD4)

## Goal

Add the user-requested Content Studio features. All additive — no behavior change to existing flows unless the new control is used. Builds on Phase 1 (security/correctness), 2a (rendering quality), 2b (video→worker) — all live.

**Locked product decisions (from brainstorming):** aesthetic reference image is Gemini-only; aesthetic-context is a free-text hook; attach-own-image = use as post media + captions (skip AI image gen); these are confirmed.

## Features

### F1 — Aesthetic/style reference image (E1)
Today only a LOGO reference feeds `generateImageSafe({ referenceImages })` (brand-color conditioning, Gemini-only). Add a SECOND optional reference: a style/aesthetic photo the AI mimics.
- **Router:** add `aestheticRefUrl: z.string().optional()` to `repurposeFromUrl` input. After the logo, if `aestheticRefUrl` is set AND `isPublicImageUrl(aestheticRefUrl)` (reuse the Phase-1 SSRF guard), fetch it (via the same guarded path as the logo) and PUSH it into `brandReferenceImages` (so Gemini receives logo + aesthetic). No change to `generateImageSafe` (it already takes an array). OpenAI fallback ignores references (unchanged) — Gemini-only feature, degrade silently.
- **UI:** a second `<input type="file">` labeled "Style reference (optional)" near the logo uploader; uploads via `/api/upload`; stores the returned url in state; sent as `aestheticRefUrl`.
- **Security:** SSRF-guarded by `isPublicImageUrl` at the same chokepoint as the logo; user-uploaded → S3 url (public, safe).

### F2 — Aesthetic-context text box (E3a)
Let the user describe the desired look in free text, appended to the AI background prompt.
- **Router:** add `imageContext: z.string().max(300).optional()`. When present, append it to `bgPrompt` (L652 + the carousel slide bgPrompt L1066) AFTER the existing content, through the SAME `sanitizePrompt`/resilient path (so political-name safety-block handling still applies). Cap at 300 chars.
- **UI:** a small collapsible "Aesthetic / style notes (optional)" text input, visible for static + carousel formats.

### F3 — Per-image Regenerate (E3b)
A button to re-roll just the image without re-running the whole flow.
- **Router:** new mutation `repurpose.regenerateImage` — input `{ headline: string; format: "static"|"carousel-cover"; creativeStyle; theme; logoUrl?; accentColor?; imageContext?; aestheticRefUrl?; channelName?; channelHandle? }`. Runs ONLY `buildHeadlineCreative` (+ `uploadAndCreateMedia`) and returns `{ url, mediaId }`. **Plan-gated:** `enforcePlanLimit(orgId, "aiImagesPerMonth", ctx.isSuperAdmin)` (so it can't be a free unlimited image faucet). SSRF-guard `logoUrl`/`aestheticRefUrl` via `isPublicImageUrl`. Sanitize `imageContext`.
- **UI:** a "Regenerate" icon button on the generated static image + the carousel cover; calls the mutation, swaps the displayed image on success; its own loading state.

### F4 — Carousel slide-count selector (E2)
Today the AI decides (prompt says "5-7 key points"); cover + CTA are added → variable count.
- **Router:** add `slideCount: z.number().int().min(3).max(10).default(5)`. Inject into the slide-extraction prompt ("break it into exactly ${slideCount} key points") and ENFORCE: if `slideData.length > slideCount` slice; if shorter, pad with fallback sentences. (Cover + CTA are still added around the N content slides — document that the total = slideCount content slides + cover + cta, OR define slideCount as the TOTAL; pick TOTAL-content-slides and label the UI "content slides".)
- **UI:** a segmented control (3 / 5 / 7 / 10) visible when `format === "carousel"`.

### F5 — Seedance duration selector (D7a) + audio-toggle cleanup (D-ADD4)
Seedance duration is hardcoded to 8s in the worker job; the provider supports 2-12s. Also the voiceOver/bgMusic toggles are no-ops for Seedance (it generates native audio).
- **Router:** add `videoDuration: z.number().int().min(2).max(12).default(8)`. Thread into the `seedance` job-data block (replace the hardcoded `duration: 8` at the enqueue site) → the Phase-2b worker passes it to `generateSeedanceVideo`. (The 2b worker move means longer durations no longer risk an HTTP timeout.)
- **UI:** a duration selector (e.g. 4 / 6 / 8 / 10 / 12 s) visible for `seedance_video`; note "longer = slower + higher cost". HIDE the "Reel Audio" voiceOver/bgMusic toggles for `seedance_video` (keep them for `reel`/`ai_video`) and show a one-line note "Seedance generates its own audio."

### F6 — Attach your own image (E4)
Let the user attach a photo to use as the post media (separate from the URL extraction), for STATIC format.
- **Router:** add `userMediaIds: z.array(z.string()).max(10).optional()`. When present: `assertMediaOwned(prisma, orgId, userMediaIds)` (reuse the chat.router export or the repurpose equivalent — IDOR guard), SKIP the AI image generation for the static branch, and return the user media as the post media (`carouselMediaIds = userMediaIds`, `mediaMap` per platform = the first). Captions are STILL generated from the URL/text. (Scope: static format only this pass; carousel/video attach is future.)
- **UI:** an "Attach your own image" media row (file input → `/api/upload`, or the existing MediaPicker) below the URL/text input; stores `mediaId`(s); sent as `userMediaIds`. When set, the UI hides the AI-style controls (theme/style/aesthetic) since no AI image is generated.

## Cross-cutting
- All new image-URL inputs (`aestheticRefUrl`, regenerate `logoUrl`/`aestheticRefUrl`) go through the Phase-1 `isPublicImageUrl` SSRF guard.
- `imageContext` goes through the existing `sanitizePrompt` before reaching any provider.
- `userMediaIds` go through `assertMediaOwned` (IDOR) before being attached.
- New router fields are all OPTIONAL with safe defaults → existing callers/behavior unaffected.

## Testing
- Pure-helper + zod-schema tests: `slideCount` enforcement (slice/pad), `imageContext` cap + append, `videoDuration` clamp + job threading, `userMediaIds` IDOR guard (cross-org → reject), `regenerateImage` plan-gate (FREE → FORBIDDEN), aesthetic-ref pushed into referenceImages.
- Keep all Phase 1/2 suites green (XSS sanitizers, SSRF, idempotency, carousel publish, video enqueue).
- Gates: `pnpm type-check` 7/7, `pnpm build` 9/9, all suites green.

## Risks & rollout
- **No Prisma schema changes** (all new fields are tRPC-input + reuse existing Media/CreativeTemplate). Zero migration risk. (If a future iteration wants to PERSIST aesthetic refs/templates, that's a separate additive model.)
- `regenerateImage` is a new write endpoint → MUST be plan-gated + SSRF-guarded (the spec requires both) so it isn't an unlimited free image faucet or an SSRF vector.
- F6 attach-image changes the static branch's media source when `userMediaIds` is set — gate strictly on its presence; the AI path must remain the default.
- Ships as ONE PR (all additive, lower-risk than 2b). Could split F3/F6 (the two new-write/IDOR features) into a second PR if review prefers.
