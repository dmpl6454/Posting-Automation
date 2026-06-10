# Content Studio + Super Agent — Phase 1 (Safety / Correctness / Infra) Design

**Date:** 2026-06-09
**Branch:** `fix/content-studio-phase1` (off `origin/main` @ `1238bc0`)
**Audit source:** `project-postautomation-audit-2026-06-09-superagent-contentstudio` (45 findings)

## Goal

Make every currently-broken or unsafe path in Super Agent + Content Studio Repurpose **correct and safe**, with minimal, surgical changes. This phase does NOT change product look/behaviour beyond un-breaking it. Quality (light theme, carousel consistency, video→worker) is Phase 2; new features are Phase 3.

## Scope

**In scope (Phase 1):** carousel publish, stuck-PUBLISHING orphans, publish idempotency, reel crash guard, interim ffmpeg-in-web, security (unauth SSE, data-URL media, SSRF, cross-org IDOR), render unbreakers (paint delay, networkidle0), Activity panel correctness.

**Out of scope (later phases):** light/theme default, skip-AI-bg for text styles, hook highlight content, bold variety, carousel all-template, accentColor wiring, video→worker offload, Seedance people/text, reference image, slide count, duration, attach-own-image, regenerate.

## Decisions already made (from brainstorming, apply where relevant later)

Light default + theme toggle; skip AI bg for hook/bold; carousel all-template; video→worker; allow generic-people Seedance + clean text; phased rollout; own-image = post media + captions. **Only the rollout decision (phased) affects Phase 1** — it defines this phase's boundary.

---

## Fixes

### Group A — Publishing correctness

**A1. Carousel publish forwards only slide 0 (D1/N6).**
- Root cause: `repurpose.router.ts:1018-1020` sets `perPlatformMedia[platform] = { url: uploadedUrls[0], mediaId: carouselMediaIds[0] }` (first slide only) for carousel. The per-platform-card **Create Post** button in `RepurposeTab.tsx` reads that single `mediaId` and redirects to Compose with one `aiMediaId`. The bottom **Create Drafts** button already uses all `carouselMediaIds`.
- Design: When `format === 'carousel'`, the Create Post redirect serialises **all** carousel media ids (`aiMediaIds=id1,id2,...`). Compose page parses `aiMediaIds` (comma-split) and initialises `postMedia` with all of them in order; `aiMediaId` (single) remains the fallback for static/reel. `post.create` already accepts an ordered `mediaIds[]` and the IG provider already routes `mediaUrls.length > 1 → publishCarouselPost`, so no backend change.
- Test: unit test on the Compose URL-param parser — `aiMediaIds=a,b,c` → `postMedia` has 3 items in order; `aiMediaId=a` → 1 item; both absent → empty.

**A2. Worker leaves targets stuck at PUBLISHING (A2c/B2/B3).**
- Root cause: `post-publish.worker.ts:504` (`token_expired`) and the `content_too_large` retry throw **without** first writing `PostTarget.status='FAILED'`. The claim guard at `:192-196` only allows `status IN (SCHEDULED,FAILED,DRAFT)` → a BullMQ retry sees `PUBLISHING` and early-returns (`claim.count===0`), so `worker.on('failed')` never fires → permanent orphan. The auto-healer re-queue is blocked by the same guard.
- Design:
  1. Introduce a single helper `await markTargetFailed(postTargetId, message)` (idempotent `update`) and call it immediately before **every** `throw` inside the publish catch block that isn't already in the success path — specifically the `token_expired` path and the `content_too_large` re-publish path. (The existing `else`/unknown branch already does this — mirror it.) Do NOT change the `rate_limit` branch (it intentionally sets `SCHEDULED`).
  2. Auto-healer (`auto-healer.worker.ts`): a stuck (>30 min) PUBLISHING target is **set to `FAILED`** with a "stuck >30 min — please retry" error message and is **NOT silently re-queued**. Rationale: a >30 min PUBLISHING almost certainly failed, but silently re-publishing risks a double-post if the platform actually received it; surfacing FAILED lets the user retry explicitly. This turns the healer from a silent no-op (blocked by the claim guard today) into a real terminal-state writer.
- Test: worker unit test — simulate `publishPost` throwing a `token_expired`-classified error; assert `PostTarget.status` becomes `FAILED` (mock prisma) before the rethrow. Auto-healer test: a target PUBLISHING for >30 min → status set to FAILED (no re-queue).

**A3. Chat `publish_now` has no retries (B4).**
- Root cause: `chat.router.ts:442-451` queues with `{ delay: 0 }` only; compose uses `attempts:3, backoff exponential 30s`.
- Design: add `attempts: 3, backoff: { type: 'exponential', delay: 30000 }` to the `postPublishQueue.add` options in `publish_now`. (Safe only because A2 now pre-marks FAILED — A2 must land in the same PR.)
- Test: covered by A2's worker test (retry no longer orphans). No separate test needed; assert the queue options object in a chat-action unit test if cheap.

**A4. Publish-now idempotency / double-click (A1 finding).**
- Root cause: the Super Agent action button is only disabled while `executeActionMutation.isPending`; after it resolves it's re-enabled and `msg.action` is still present → unlimited re-fires → duplicate live posts.
- Design (two layers):
  1. Client: track `executedActionMessageIds: Set<string>` in `super-agent/page.tsx`; on a successful `executeAction`, add the message id; render the action button `disabled` (and show a "✓ Done" badge) when the id is in the set.
  2. Server: accept an optional `clientActionId` (the message id) on `executeAction`; in `publish_now`/`schedule_post`/`bulk_schedule`, short-circuit if a `ChatMessage` already records that `clientActionId` as executed (store it in the result message metadata). This stops a refresh/replay from double-posting even if client state is lost.
- Test: chat-action unit test — second `executeAction` with the same `clientActionId` does not create a second post.

**A5. Reel sparse-array crash (N5).**
- Root cause: `repurpose.router.ts` reel branch maps `slideImages` (a sparse array) without a null guard → `TypeError` when a slide fails generation (the upload loop guards, the reel map does not).
- Design: `slideImages.filter(Boolean).map(...)` before passing to `generateReelVideo`.
- Test: unit test feeding a sparse array `[a, , c]` to the mapping helper → 2 entries, no throw.

**A6. Interim: ffmpeg in web container (D2).**
- Root cause: `Dockerfile.web:3` apk line lacks `ffmpeg`; reel stitch + bg-music `execSync('ffmpeg')` run in the web process → "ffmpeg: not found".
- Design: add `ffmpeg` to the `Dockerfile.web` apk line. **Interim** — Phase 2's video→worker offload removes the in-web ffmpeg dependency; leaving ffmpeg installed afterwards is harmless.
- Test: none (Dockerfile). Verify by building the web image or, post-deploy, `docker exec postautomation-web-1 which ffmpeg`.

### Group B — Security

**B1. `/api/progress` SSE is unauthenticated (N1).**
- Root cause: `apps/web/app/api/progress/route.ts` has no `auth()` check; the progress id is low-entropy (`rep-${Date.now()}-${6char}`) → any signed-out request can read another job's step data (URLs, titles, brand names, errors).
- Design: add `const session = await auth(); if (!session?.user?.id) return 401` at the top of the GET handler. (Stronger user/org scoping of the id is deferred — auth gating closes the public leak now.)
- Test: route unit/integration test — no session → 401; valid session → 200 stream opens. (If route-level testing is awkward, assert the guard via a thin extracted `requireSession` helper unit test.)

**B2. `generate_news_image` stores a base64 data URL as Media.url (N2).**
- Root cause: `chat.router.ts:519-555` builds `data:${mime};base64,${...}` and writes it to `media.url` (`:528`) and returns it as `imageUrl` (`:555`). Providers `fetch(media.url)` expecting HTTP → publish fails; also a multi-MB blob in a Postgres text column per generation.
- Design: upload the image buffer to S3 (reuse the repurpose `uploadAndCreateMedia` pattern — extract it to a shared `packages/api/src/lib/upload-media.ts` or duplicate minimally) and store the **S3 public URL** in `media.url`; return that URL as `imageUrl`. UI display still works (it's an https URL).
- Test: chat-action unit test — `generate_news_image` result `imageUrl` starts with the S3 public host (mock the S3 client), and `media.url` is not a `data:` URL.

**B3. SSRF in logo fetch + extractDominantColor (N3 + A4 finding).**
- Root cause: `repurpose.router.ts` logo `fetch(resolvedLogoUrl)` and `news-image-generator.ts:extractDominantColor` (Puppeteer `img.src = url`) both load arbitrary user-supplied `logoUrl` with no allowlist. The chat `fetchImageAsBase64` SSRF guard was never extended here.
- Design: extract the existing SSRF allowlist logic (from `chat-agent.chain.ts`) into a shared `packages/ai/src/utils/safe-fetch-url.ts` exporting `isAllowedImageUrl(url)` (https/data-image allowlist incl. configured S3 hosts, blocks RFC1918/loopback/link-local/metadata + IPv6 ranges) and `safeFetchImage(url)` (validates then fetches with `redirect:'manual'`). Use it in the repurpose logo fetch and gate `extractDominantColor` (reject disallowed URLs → return null → DEFAULT_ACCENT). Refactor `fetchImageAsBase64` to call the shared util so there's one implementation.
- Test: extend `image-fetch-ssrf.test.ts` to cover the shared util directly; add a test that `extractDominantColor` short-circuits on a blocked URL (returns null) without launching a browser.

**B4. Cross-org IDOR on AI-supplied ids (N8 / N7).**
- Root cause: `create_brand_tracker` writes AI-supplied `campaignId` with no org check; `update_agent` (`chat.router.ts:472-473`) updates `where: { id: thread.agentId }` with no `organizationId` filter.
- Design: in `create_brand_tracker`, if `p.campaignId` is present, verify `prisma.campaign.findFirst({ where: { id, organizationId: ctx.organizationId } })` → throw FORBIDDEN if not found. In `update_agent`, change the where clause to `{ id: thread.agentId, organizationId: ctx.organizationId }`.
- Test: chat-action IDOR unit tests — a campaignId from another org → FORBIDDEN; update_agent where-clause includes organizationId.

### Group C — Render unbreakers (cheap; prevent blank/failed renders)

**C1. Missing paint delay → blank styled creatives (B1/N10).**
- Root cause: `generateStyledCreativeImage` (`news-image-generator.ts:~141`) lacks the `await new Promise(r=>setTimeout(r,400))` that `generateStaticNewsCreativeImage` has (`:100`). With a large/slow background it screenshots before paint → blank.
- Design: add the 400 ms paint delay after the `setContent` try/catch, before `page.screenshot()`. Also compress the gpt-image-1 fallback PNG to JPEG (quality ~82) in `buildHeadlineCreative` before inlining as the data URL, so the payload is ~500 KB not 4-8 MB and `load` fires reliably (normalise the mimeType string to `image/jpeg`; `safeImageUrl` already allows jpeg).
- Test: existing creative-templates tests stay green; add a sanity test that the compression helper returns a smaller buffer + `image/jpeg`.

**C2. `overlayLogoOnImage` uses networkidle0 (N9).**
- Root cause: `news-image-generator.ts:243` uses `waitUntil:'networkidle0', timeout:10000` while embedding a data-URL bg + a Google-Fonts `@import` → times out → carousel logo overlay fails/loses branding.
- Design: switch to `waitUntil:'load', timeout:30000` wrapped in try/catch (screenshot-on-timeout) + a 400 ms paint delay, matching the other generators.
- Test: covered by render smoke; no new unit test required (Puppeteer-bound).

### Group D — Activity panel correctness

**D1. PUBLISHING shows a Clock icon, not a spinner (A2b).**
- Root cause: `activity-panel.tsx:135` type ternary has no `PUBLISHING` branch → falls to `post.scheduled` → Clock icon, though the title is correct.
- Design: add a `PUBLISHING → 'post.publishing'` branch and a `'post.publishing': Loader2` entry in `TYPE_ICONS`.
- Test: none (cosmetic) or a trivial render assertion if cheap.

**D2. Worker writes no publish notifications → Activity stale (B5, the actionable half).**
- Root cause: `post-publish.worker.ts` never creates `Notification` rows; the SSE only pushes when unread notifications exist, so the Activity panel can lag.
- Design: after a target reaches PUBLISHED (and in `worker.on('failed')` for FAILED), create org-member `Notification` rows (`post.published` / `post.failed`, link to `postId`), reusing the org-member lookup already done for the email report. Lower the Activity `post.recentActivity` `refetchInterval` to 10 s as a belt-and-suspenders.
- Test: worker unit test — PUBLISHED transition creates a notification row (mock prisma).

---

## Cross-cutting

- **Shared SSRF util** (`packages/ai/src/utils/safe-fetch-url.ts`) is the single source of truth; `fetchImageAsBase64`, the repurpose logo fetch, and `extractDominantColor` all use it. This is the only new shared module in Phase 1.
- **Shared media upload** (`generate_news_image` S3 upload) — reuse/extract the repurpose `uploadAndCreateMedia` helper rather than duplicating S3 logic.

## Testing strategy

- Vitest, per existing convention. Keep green: `creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, `chat-action-*.test.ts`, `s3-config.test.ts`.
- New suites: `chat-action-idempotency.test.ts` (A4, B4 IDOR, B2 S3), `worker-publish-failed-state.test.ts` (A2, A3, D2 notification), `compose-media-params.test.ts` (A1), `safe-fetch-url.test.ts` (B3, extends ssrf).
- Gates before PR: `pnpm --filter @postautomation/ai test`, `pnpm --filter @postautomation/api test`, root `pnpm type-check`, `pnpm build`.

## Risks & rollout

- **Schema:** Phase 1 adds **no** Prisma model/column changes (Notification, Campaign, Agent, Media, PostTarget all exist). Zero migration risk.
- **A2/A3 ordering:** A3 (chat retries) must ship with A2 (pre-mark FAILED) or chat publishes could orphan. Same PR.
- **B2 S3 dependency:** requires S3 env (already set in prod). If unset locally, generate_news_image upload fails loudly (acceptable — same as repurpose today).
- **D2 notification volume:** bounded by publishes × org members; acceptable at current scale. A prune job is a Phase-2+ concern, noted not built.
- **Deploy:** single PR → `main` → GitHub Actions. Web image rebuild picks up the ffmpeg apk change (A6); worker rebuild picks up A2/D2. Per deploy-quirks, all three images rebuild each deploy.
