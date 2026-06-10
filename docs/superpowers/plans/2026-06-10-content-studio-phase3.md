# Content Studio — Phase 3 (Features) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Add the user-requested Content Studio features (aesthetic reference image, aesthetic-context text box, per-image regenerate, carousel slide-count, Seedance duration, attach-own-image). All additive; existing flows unchanged unless the new control is used.

**Tech Stack:** Next.js, tRPC, Prisma, BullMQ, Vitest, pnpm@9.15.0 (NOT npm). `noUncheckedIndexedAccess` ON — guard `arr[0]` with `!`. RUN `pnpm --filter @postautomation/<pkg> test` AND `... exec tsc --noEmit` per task (vitest does NOT type-check).

**Spec:** `docs/superpowers/specs/2026-06-10-content-studio-phase3-design.md`
**Branch:** `fix/content-studio-phase3` (already created off `main` @ `80f0e37`).

Key anchors (verify; may drift): `packages/api/src/routers/repurpose.router.ts` — input schema (~L161-185: `logoUrl`, `accentColor`, `theme`, etc.), `brandReferenceImages` build (~L348-355), `generateImageSafe({ referenceImages })` (~L397), `buildHeadlineCreative` (~L300+), `bgPrompt` (static ~L652, carousel slide ~L1066), slide extraction prompt "5-7 key points" (~L976) + `slideData` slice/pad (~L1010-1026), the seedance enqueue with `duration: 8` (~L945), `sanitizePrompt`, `uploadAndCreateMedia`, `isPublicImageUrl` (from `@postautomation/ai`), `enforcePlanLimit`, `assertMediaOwned` (find its export — chat.router exports one). `apps/web/components/content-agent/RepurposeTab.tsx` — logo uploader (~L554), accentColor picker (~L591), `voiceOver`/`bgMusic` toggles + "Reel Audio" block (~L669-711), `FORMAT_OPTIONS` (~L57), the mutate payload (~L355-365), the generated-image result cards. `apps/worker/src/workers/repurpose-video.worker.ts` — where it calls `generateSeedanceVideo` (uses `job.data.seedance.duration`). `packages/queue/src/types.ts` `RepurposeVideoJobData.seedance.duration`.

---

### Task 1: Aesthetic reference image (F1) + aesthetic-context text box (F2)

**Files:** `packages/api/src/routers/repurpose.router.ts`, `apps/web/components/content-agent/RepurposeTab.tsx`. Test new `packages/api/src/__tests__/repurpose-aesthetic.test.ts`.

- [ ] **Step 1 — failing tests.** Pure helper `appendImageContext(basePrompt: string, imageContext?: string): string` → appends `\n\nStyle notes: ${imageContext.slice(0,300)}` only when non-empty, else returns base unchanged. And `aestheticRefsToPush(aestheticRefUrl, isAllowed): string | null` (returns the url only if present AND `isPublicImageUrl`). Test both: context appended/capped/omitted; ref gated by the allow predicate.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Router: add `aestheticRefUrl: z.string().optional()` + `imageContext: z.string().max(300).optional()` to the input schema. After the logo is pushed into `brandReferenceImages`, if `input.aestheticRefUrl && isPublicImageUrl(input.aestheticRefUrl)`, fetch it via the SAME guarded fetch the logo uses and push `{ base64, mimeType }` into `brandReferenceImages` (after the logo). Append `input.imageContext` (via `appendImageContext`, through `sanitizePrompt`) to BOTH `bgPrompt` sites (static + carousel slide). UI: a 2nd file input "Style reference (optional)" (uploads via `/api/upload`, stores url) + a collapsible "Aesthetic / style notes (optional)" textarea (maxLength 300); send `aestheticRefUrl` + `imageContext` in the mutate payload (static + carousel).
- [ ] **Step 4** `pnpm --filter @postautomation/api test` green + `@postautomation/api exec tsc --noEmit` + `@postautomation/web exec tsc --noEmit` exit 0.
- [ ] **Step 5** commit `feat: aesthetic reference image + aesthetic-context text box (E1/E3a)`.

### Task 2: Carousel slide-count selector (F4)

**Files:** `repurpose.router.ts`, `RepurposeTab.tsx`. Test extend `repurpose-aesthetic.test.ts` or new `repurpose-slidecount.test.ts`.

- [ ] **Step 1 — failing test.** Pure helper `enforceSlideCount(slideData: {title:string;body:string}[], target: number, fallback: {title:string;body:string}[]): {title:string;body:string}[]` → returns exactly `target` items (slice if longer, pad from `fallback` then a generic filler if shorter). Test: 7 items, target 5 → 5; 2 items, target 5 → 5 (padded); 0 items → target fillers.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Router: add `slideCount: z.number().int().min(3).max(10).default(5)`. Inject into the slide-extraction prompt ("break it into exactly ${input.slideCount} key points"). Apply `enforceSlideCount(slideData, input.slideCount, fallbackSentences)` so exactly `slideCount` CONTENT slides result (cover + cta still added around them). UI: a segmented control (3/5/7/10) visible when `format === "carousel"`, labeled "Content slides"; send `slideCount`.
- [ ] **Step 4** tests green + both tsc exit 0.
- [ ] **Step 5** commit `feat: carousel slide-count selector (E2)`.

### Task 3: Seedance duration selector (F5) + audio-toggle cleanup (D-ADD4)

**Files:** `repurpose.router.ts` (enqueue), `apps/worker/src/workers/repurpose-video.worker.ts` (uses `job.data.seedance.duration` — should already), `packages/queue/src/types.ts` (`seedance.duration` already exists), `RepurposeTab.tsx`. Test `repurpose-video-enqueue.test.ts` (extend).

- [ ] **Step 1 — failing test.** Extend the enqueue test: `buildVideoJobData({ format:"seedance_video", ..., seedance:{ ..., duration: 6 } })` → `seedance.duration === 6` (clamped 2-12). Add a `clampDuration(n): number` pure helper (`Math.max(2, Math.min(12, n || 8))`) and test 0→8 (default-ish), 20→12, 6→6.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Router: add `videoDuration: z.number().int().min(2).max(12).default(8)`. At the seedance enqueue site, replace hardcoded `duration: 8` with `clampDuration(input.videoDuration)`. (Worker already passes `job.data.seedance.duration` to `generateSeedanceVideo` — verify; if it hardcodes, thread it through.) UI: a duration selector (4/6/8/10/12 s) visible for `seedance_video`, with a "longer = slower + higher cost" note; send `videoDuration`. ALSO: HIDE the "Reel Audio" voiceOver/bgMusic block for `seedance_video` (change its render condition from `(reel||ai_video||seedance_video)` to `(reel||ai_video)`) and show a one-line note "Seedance generates its own audio." for `seedance_video`.
- [ ] **Step 4** `pnpm --filter @postautomation/api test` + worker tsc + api tsc + web tsc green/exit 0.
- [ ] **Step 5** commit `feat: Seedance duration selector + hide no-op audio toggles for Seedance (D7a/D-ADD4)`.

### Task 4: Per-image Regenerate mutation (F3)

**Files:** `repurpose.router.ts` (new `regenerateImage` mutation), `RepurposeTab.tsx` (Regenerate button). Test new `packages/api/src/__tests__/repurpose-regenerate.test.ts`.

- [ ] **Step 1 — failing test.** Assert: `regenerateImage` is plan-gated — a FREE non-superadmin org hits `enforcePlanLimit(orgId, "aiImagesPerMonth", false)` → FORBIDDEN when over quota (mock the limit like `repurpose-plan-gate.test.ts`); a disallowed `logoUrl`/`aestheticRefUrl` (private host) is dropped (not fetched) via `isPublicImageUrl`. (Mock `generateImageSafe`/`buildHeadlineCreative` + S3 + prisma per existing test conventions.)
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Add an `orgProcedure` mutation `regenerateImage` with input `{ headline: z.string().min(1); creativeStyle; theme; logoUrl?; accentColor?; imageContext?(max300); aestheticRefUrl?; channelName?; channelHandle? }`. Body: `enforcePlanLimit(ctx.organizationId, "aiImagesPerMonth", ctx.isSuperAdmin)`; SSRF-guard + drop disallowed `logoUrl`/`aestheticRefUrl` via `isPublicImageUrl`; sanitize `imageContext`; run the SAME `buildHeadlineCreative` path (skip-AI-bg honored for hook/bold via the Phase-2a helper) + `uploadAndCreateMedia`; return `{ url, mediaId }`. UI: a "Regenerate" icon button on the generated static image + carousel cover that calls `trpc.repurpose.regenerateImage.useMutation`, swaps the displayed image on success, with its own loading state; passes the current style/theme/logo/accent/imageContext/aestheticRef.
- [ ] **Step 4** tests green + api tsc + web tsc exit 0.
- [ ] **Step 5** commit `feat: per-image Regenerate mutation (plan-gated, SSRF-guarded) (E3b)`.

### Task 5: Attach your own image (F6)

**Files:** `repurpose.router.ts`, `RepurposeTab.tsx`. Test new `packages/api/src/__tests__/repurpose-user-media.test.ts`.

- [ ] **Step 1 — failing test.** Assert: with `userMediaIds: ["m-otherorg"]` whose `assertMediaOwned` rejects (cross-org) → the mutation throws FORBIDDEN before any AI image gen (mock `assertMediaOwned`/prisma). With owned `userMediaIds` on a `static` job → `generateImageSafe`/`buildHeadlineCreative` is NOT called and the result `carouselMediaIds` === the user media ids (mock the AI path to throw if called, asserting it isn't).
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** Router: add `userMediaIds: z.array(z.string()).max(10).optional()`. In the STATIC branch (and the shared early section), if `input.userMediaIds?.length`: `await assertMediaOwned(ctx.prisma, ctx.organizationId, input.userMediaIds)` (reuse the export; if not importable, replicate the org-scoped `media.findMany` count check), SKIP the AI image generation, set the result media to the user's media (`carouselMediaIds = userMediaIds`, `mediaMap[platform] = { url: <media.url>, mediaId: <id> }` resolving urls from the owned Media rows), and STILL generate the captions. UI: an "Attach your own image" row (file input → `/api/upload` returning `{ id, url }`, or the existing MediaPicker) below the URL/text input; store `mediaId`(s); when set, hide the AI-style controls (theme/style/aesthetic ref/context) for static and send `userMediaIds`. Gate strictly on presence — the AI path stays default.
- [ ] **Step 4** `pnpm --filter @postautomation/api test` green + api tsc + web tsc exit 0.
- [ ] **Step 5** commit `feat: attach your own image to a repurpose (post media + captions, IDOR-guarded) (E4)`.

---

## Final gate (after all tasks)
- [ ] `pnpm --filter @postautomation/{ai,api,queue,worker} test` + web tsc; root `pnpm type-check` 7/7 + `pnpm build` 9/9.
- [ ] Confirm: every new image-URL input is `isPublicImageUrl`-guarded; `imageContext` sanitized; `userMediaIds` `assertMediaOwned`-guarded; `regenerateImage` plan-gated; all new fields optional/defaulted (no existing-flow regression).
- [ ] Final full-diff adversarial review (focus: regenerate plan-gate + SSRF, attach-image IDOR + skip-AI correctness, no behavior change when new controls unused).
- [ ] superpowers:finishing-a-development-branch → PR `fix/content-studio-phase3` → `main`.
