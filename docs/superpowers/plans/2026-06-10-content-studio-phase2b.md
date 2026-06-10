# Content Studio — Phase 2b (Video Architecture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Move reel/Seedance video generation OUT of the synchronous tRPC mutation INTO a BullMQ worker job, delivering the result via the existing userId-scoped progress SSE stream. Kills the "spinner forever" + HTTP-timeout risk (long synchronous video gen held the request open) and makes the Phase-1 interim ffmpeg-in-web unnecessary. Also: Seedance allows generic people (no specific real individuals) + burns clean caption text via ffmpeg (no garbled in-video text).

**Tech Stack:** BullMQ (`createQueue`/`Worker`), Redis pub/sub (progress), Puppeteer/ffmpeg (worker already bundles both), tRPC, Vitest, pnpm@9.15.0 (NOT npm). `noUncheckedIndexedAccess` ON — guard `arr[0]` with `!` in tests. RUN `pnpm --filter @postautomation/<pkg> test` AND `... exec tsc --noEmit` per task.

**Spec:** `docs/superpowers/specs/2026-06-10-content-studio-phase2-design.md` (Phase 2b section).
**Branch:** `fix/content-studio-phase2b` (already created off `main` @ `e5e1c03`).

**Architecture decisions baked in:**
- The mutation still does the FAST prep (captions, scene extraction, and for reel the slide PNG renders — those already complete in seconds), uploads slide images to S3, then ENQUEUES the video job and returns `{ videoPending: true, progressId }`. Only the LONG ops (ffmpeg stitch, the 7.5-min Seedance poll) move to the worker.
- The plan/quota gate (`requirePlan`/`enforcePlanLimit`, `ctx.isSuperAdmin`) stays in the MUTATION, BEFORE enqueue.
- The worker publishes progress + a terminal `video_ready` (or `video_error`) step to the SAME userId-scoped progress channel the UI is already subscribed to. `video_ready`'s `detail` carries `JSON.stringify({ mediaId, url, format })`.

Key anchors (verify; may drift): `packages/queue/src/queues.ts` (`createQueue<T>`, `QUEUE_NAMES`, exports), `packages/queue/src/types.ts` (job data types), `packages/queue/src/index.ts` (re-exports). `packages/api/src/lib/progress.ts` (`scopedProgressId`, `pushProgress`, `finishProgress`, key `progress:{jobId}` + channel `progress-notify:{jobId}`). `apps/web/app/api/progress/route.ts` reads `progress:{scoped}` Redis keys DIRECTLY (key format must NOT change). `apps/worker/src/index.ts` (bootstrap: `registerWorker("name")` + `const x = createXWorker()`). `packages/ai/src/providers/seedance.provider.ts` (`generateSeedanceVideo(SeedanceGenerateParams)`, `buildSeedancePrompt` ~L254, "Do NOT show real people's faces" ~L277). `packages/ai/src/tools/reel-generator.ts` (`generateReelVideo(ReelOptions)`, `ReelResult`). `packages/api/src/routers/repurpose.router.ts` reel branch (~L1056) + seedance branch (~L751) — what they currently generate + return. `apps/web/components/content-agent/RepurposeTab.tsx` (`repurposeFromUrl` `onSuccess` result handling + the SSE `onmessage` progress handler).

---

### Task 1: Shared progress helper + repurposeVideoQueue

**Files:** Move `packages/api/src/lib/progress.ts` → `packages/queue/src/progress.ts`; re-export from `packages/queue/src/index.ts`; update the import in `packages/api/src/routers/repurpose.router.ts` (+ any other importer — grep `from ".*lib/progress"` and `lib/progress`). Add `repurposeVideoQueue` + `QUEUE_NAMES.REPURPOSE_VIDEO` + `RepurposeVideoJobData`. Test new `packages/queue/src/__tests__/repurpose-video-queue.test.ts` (follow `queues.test.ts`).

- [ ] **Step 1 — failing test.** Assert: `QUEUE_NAMES.REPURPOSE_VIDEO === "repurpose-video"`; `repurposeVideoQueue` is exported (truthy, has `.add`); `scopedProgressId("u1","rep-x") === "u1:rep-x"` (re-exported from queue now). 
- [ ] **Step 2** run `pnpm --filter @postautomation/queue test` → fail.
- [ ] **Step 3 — implement.** (a) `git mv` progress.ts into `packages/queue/src/` (keep its exact contents — `scopedProgressId`/`pushProgress`/`getProgress`/`finishProgress`, key/channel formats UNCHANGED). Re-export from `packages/queue/src/index.ts`. Update `repurpose.router.ts` import to `@postautomation/queue`. (b) Add `REPURPOSE_VIDEO: "repurpose-video"` to `QUEUE_NAMES`; define `RepurposeVideoJobData` in `types.ts`: `{ userId: string; organizationId: string; progressId: string; format: "reel" | "seedance_video"; theme: "dark"|"light"|"gradient"; reel?: { slideUrls: string[]; voiceOver: boolean; bgMusic: boolean; voiceType?: string; voiceScript?: string }; seedance?: { scenes: string[]; title: string; description: string; duration: number } }` (match the real fields `generateReelVideo`/`generateSeedanceVideo` need — read their option interfaces and mirror what the mutation currently passes). Export `repurposeVideoQueue = createQueue<RepurposeVideoJobData>(QUEUE_NAMES.REPURPOSE_VIDEO)`.
- [ ] **Step 4** `pnpm --filter @postautomation/queue test` + `@postautomation/api test` green; `pnpm --filter @postautomation/queue exec tsc --noEmit` + `@postautomation/api exec tsc --noEmit` exit 0 (the progress import move must not break api).
- [ ] **Step 5** commit `feat(queue): repurposeVideoQueue + move progress helper to shared queue pkg`.

### Task 2: repurpose-video worker (reel + seedance) + Seedance people/clean-text

**Files:** Create `apps/worker/src/workers/repurpose-video.worker.ts`; wire into `apps/worker/src/index.ts`; modify `packages/ai/src/providers/seedance.provider.ts` (`buildSeedancePrompt`); a worker-side ffmpeg drawtext helper (new `apps/worker/src/lib/burn-captions.ts` OR reuse the reel generator's approach). Test new `apps/worker/src/lib/repurpose-video.test.ts` (pure helpers) + `packages/ai/src/__tests__/seedance-prompt.test.ts`.

- [ ] **Step 1 — failing tests.** (a) `seedance-prompt.test.ts`: `buildSeedancePrompt({...})` does NOT contain "Do NOT show real people" and DOES contain guidance against specific real individuals (assert it contains a phrase like "do not depict any specific real" / "no real public figures" — pick the exact phrase you implement). (b) `repurpose-video.test.ts`: a pure helper `buildVideoReadyDetail(mediaId, url, format)` → `JSON.stringify({ mediaId, url, format })`; and a `videoErrorDetail(msg)` shape. (Keep the worker handler itself out of the unit test — test the pure helpers + the prompt.)
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.**
  - `seedance.provider.ts buildSeedancePrompt`: REMOVE "Do NOT show real people's faces. Use abstract visuals, motion graphics, silhouettes." Replace with guidance allowing generic people/crowds/silhouettes BUT explicitly: "Do not depict any specific, real, named public figure or attempt their likeness — use generic, anonymous people only." Keep the rest of the prompt.
  - `repurpose-video.worker.ts`: `createRepurposeVideoWorker()` consuming `repurposeVideoQueue`. For `format==="reel"`: download the `slideUrls` to buffers, call `generateReelVideo({ slides, voiceOver, bgMusic, ... })` (match `ReelOptions`), then upload the MP4 to S3 + `prisma.media.create` (reuse the worker's existing S3 upload pattern — grep how `media-process.worker.ts` or another worker uploads to S3; if none, use `@aws-sdk/client-s3` `PutObjectCommand` with the same env the repurpose router uses). For `format==="seedance_video"`: call `generateSeedanceVideo(params)` (the 7.5-min poll now runs HERE), then burn clean caption text onto the downloaded MP4 with an ffmpeg `drawtext` pass (worker has ffmpeg), upload + Media row. THROUGHOUT, publish progress via the shared `pushProgress(scopedProgressId(userId, progressId), step, status, detail)`; on success `pushProgress(scoped, "video_ready", "done", buildVideoReadyDetail(media.id, media.url, format))` then `finishProgress(scoped, "done")`; on error `pushProgress(scoped, "video_error", "error", friendlyMsg)` + `finishProgress(scoped, "error")` and rethrow (so BullMQ records failure). Use `friendlyAIMessage`/`toFriendlyAIError` for error text (don't leak raw provider JSON).
  - `apps/worker/src/index.ts`: add `registerWorker("repurpose-video")` + `import { createRepurposeVideoWorker }` + `const repurposeVideoWorker = createRepurposeVideoWorker();` (mirror the existing pattern; also add to the graceful-shutdown list if there is one).
- [ ] **Step 4** `pnpm --filter @postautomation/ai test` + the new worker/seedance tests green (root vitest globs `apps/**/src/**`); `pnpm --filter @postautomation/worker exec tsc --noEmit` + `@postautomation/ai exec tsc --noEmit` exit 0.
- [ ] **Step 5** commit `feat(worker): repurpose-video worker (reel+seedance) + Seedance generic-people + clean caption burn`.

### Task 3: Router enqueues video instead of generating synchronously

**Files:** Modify `packages/api/src/routers/repurpose.router.ts` (reel + seedance_video branches). Test new `packages/api/src/__tests__/repurpose-video-enqueue.test.ts`.

- [ ] **Step 1 — failing test.** Pure helper `buildVideoJobData(input, { userId, organizationId, scenes/slideUrls })` → the `RepurposeVideoJobData` shape; assert it carries `userId`, `progressId`, `format`, `theme`, and the format-specific block. Also assert (via a mocked `repurposeVideoQueue.add`) that the reel/seedance branch, after prep, calls `.add` once and returns `{ videoPending: true, progressId }` (mock the queue like `chat-action-idempotency.test.ts` mocks `@postautomation/queue`).
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** In the `reel` branch: keep generating + uploading the slide PNGs (as today, via the Phase-2a template path) → collect `slideUrls`; then INSTEAD of calling `generateReelVideo` synchronously, `await repurposeVideoQueue.add("repurpose-video-${progressId}", buildVideoJobData(...), { attempts: 1 })` and `return { ...captions/extracted..., videoPending: true, progressId: input.progressId }`. In the `seedance_video` branch: keep scene extraction + prompt prep; INSTEAD of `generateSeedanceVideo` synchronously, enqueue with the seedance params + `return { videoPending: true, progressId }`. The plan gate (`requirePlan`/`enforcePlanLimit` + `ctx.isSuperAdmin`) MUST run BEFORE the enqueue (keep it where it is, before this branch). Keep `pushProgress` for the prep steps; the worker continues the stream. Do NOT change the carousel/static branches.
- [ ] **Step 4** `pnpm --filter @postautomation/api test` green; `@postautomation/api exec tsc --noEmit` exit 0.
- [ ] **Step 5** commit `feat: repurpose reel/seedance enqueue video job + return videoPending (no sync gen)`.

### Task 4: RepurposeTab renders video from the SSE stream

**Files:** Modify `apps/web/components/content-agent/RepurposeTab.tsx`. Test (pure helper if extractable) `apps/web/lib/*.test.ts`.

- [ ] **Step 1 — (light) test.** If you extract a pure helper `parseVideoReadyEvent(step: {step:string; status:string; detail?:string})` → `{ mediaId, url, format } | null` (returns the parsed object only when `step.step==="video_ready"`), unit-test it: a `video_ready` step with JSON detail → parsed object; any other step → null; malformed detail → null (no throw). Put it in `apps/web/lib/`.
- [ ] **Step 2** run → fail.
- [ ] **Step 3 — implement.** (a) `repurposeFromUrl.onSuccess`: when the result has `videoPending`, do NOT try to render a video from the (absent) return value — instead keep the SSE open and set a "generating video…" state. (b) In the SSE `onmessage`/progress handler, when a step parses as `video_ready` (via `parseVideoReadyEvent`), build the result object (video media id + url) and render the generated-video card (same UI the synchronous path used). When a step is `video_error`, show the friendly error + stop the spinner. (c) Add a client-side safety timeout (e.g. 10 min) after which, if no `video_ready`/`video_error` arrived, show "still processing — check the post later" and stop the spinner (no infinite spin). (d) Ensure the SSE is closed on `video_ready`/`video_error`/timeout. Match the existing result-card markup for videos.
- [ ] **Step 4** `pnpm --filter @postautomation/web exec tsc --noEmit` exit 0; new helper test green.
- [ ] **Step 5** commit `feat: RepurposeTab renders reel/AI-video from SSE video_ready event + safety timeout`.

---

## Final gate (after all 2b tasks)
- [ ] `pnpm --filter @postautomation/{queue,ai,api,worker} test` + web tsc; root `pnpm type-check` 7/7 + `pnpm build` 9/9.
- [ ] Confirm: the worker process registers the `repurpose-video` consumer; the progress key/channel format is byte-identical to what the SSE route reads; the plan gate runs before enqueue; the mutation no longer holds the request for the full video duration.
- [ ] Final full-diff adversarial review (focus: the mutation→SSE result-delivery change, no orphaned "generating" state, plan-gate-before-enqueue, no double Media rows, Seedance prompt has no specific-individual generation).
- [ ] superpowers:finishing-a-development-branch → PR `fix/content-studio-phase2b` → `main`.
