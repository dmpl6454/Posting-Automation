# Content Studio + Super Agent — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every broken/unsafe Super Agent + Content Studio path correct and safe, with surgical changes only (no look/behaviour changes beyond un-breaking).

**Architecture:** Fix in place across `apps/web`, `apps/worker`, `packages/api`, `packages/ai`. One new shared util (`safe-fetch-url.ts`). No Prisma schema changes.

**Tech Stack:** Next.js App Router, tRPC v11, Prisma, BullMQ, Puppeteer, Vitest, pnpm@9.15.0 (NOT npm). Run tests with `pnpm --filter @postautomation/<pkg> test`.

**Spec:** `docs/superpowers/specs/2026-06-09-content-studio-phase1-design.md`

**Branch:** `fix/content-studio-phase1` (already created off `origin/main`).

---

### Task 1: Shared SSRF-safe URL util

**Files:**
- Create: `packages/ai/src/utils/safe-fetch-url.ts`
- Test: `packages/ai/src/__tests__/safe-fetch-url.test.ts`
- Reference (copy logic from): `packages/ai/src/chains/chat-agent.chain.ts` (`__isAllowedImageUrl`, `isPrivateOrLoopbackHost`, `fetchImageAsBase64`)

- [ ] **Step 1: Write failing tests.** Cover: allows configured S3 public host (set `process.env.S3_PUBLIC_URL` in `beforeAll`); allows `data:image/png;base64,...`; blocks arbitrary external host; blocks `127.0.0.1`, `10.0.0.5`, `192.168.1.1`, `169.254.169.254`, `[::1]`, `localhost`, IPv6 ULA `fd00::1`, mapped `::ffff:10.0.0.1`; blocks `file://`/`gopher://`. Mirror the existing `image-fetch-ssrf.test.ts` cases but import from `../utils/safe-fetch-url`.

```ts
import { describe, it, expect, beforeAll } from "vitest";
beforeAll(() => { process.env.S3_PUBLIC_URL = "https://media.postautomation.co.in/postautomation-media"; });
describe("isAllowedImageUrl", () => {
  async function load() { return (await import("../utils/safe-fetch-url")).isAllowedImageUrl; }
  it("allows configured S3 host", async () => { expect((await load())("https://media.postautomation.co.in/postautomation-media/x.png")).toBe(true); });
  it("allows data:image", async () => { expect((await load())("data:image/png;base64,AAAA")).toBe(true); });
  it("blocks external host", async () => { expect((await load())("https://evil.example.com/x.png")).toBe(false); });
  it("blocks private/loopback/metadata/ipv6", async () => {
    const f = await load();
    for (const u of ["http://127.0.0.1/x","http://10.0.0.5/x","http://192.168.1.1/x","http://169.254.169.254/latest/meta-data/","http://[::1]/x","http://localhost/x","http://[fd00::1]/x","http://[::ffff:10.0.0.1]/x"]) expect(f(u)).toBe(false);
  });
  it("blocks non-http schemes", async () => { const f = await load(); expect(f("file:///etc/passwd")).toBe(false); expect(f("gopher://x/")).toBe(false); });
});
```

- [ ] **Step 2: Run, verify fail** (`pnpm --filter @postautomation/ai test safe-fetch-url` → module not found).
- [ ] **Step 3: Implement** `safe-fetch-url.ts`: export `isAllowedImageUrl(url: string): boolean` (port the chat-agent allowlist verbatim: build allowed hosts from `S3_PUBLIC_URL`/`S3_ENDPOINT` + `s3.amazonaws.com`; allow `data:image/(png|jpeg|jpg|webp|gif);base64,`; for https, parse host and reject if it's an IP in RFC1918/loopback/link-local/metadata or IPv6 ULA/link-local/mapped/`::1`, or hostname `localhost`); and `async safeFetchImage(url, { timeoutMs = 10000 } = {})` that throws if `!isAllowedImageUrl(url)`, else `fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })`. Keep it dependency-free.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(ai): shared SSRF-safe image URL util (isAllowedImageUrl/safeFetchImage)`.

### Task 2: Route existing fetches through the SSRF util

**Files:**
- Modify: `packages/ai/src/chains/chat-agent.chain.ts` (make `fetchImageAsBase64` delegate to `safeFetchImage`/`isAllowedImageUrl`; keep `__isAllowedImageUrl` export delegating so `image-fetch-ssrf.test.ts` stays green)
- Modify: `packages/api/src/routers/repurpose.router.ts` (logo `fetch(resolvedLogoUrl)` → guard with `isAllowedImageUrl` before fetch; on disallowed, skip logo/branding gracefully — same as the existing fetch-failure catch)
- Modify: `packages/ai/src/tools/news-image-generator.ts` (`extractDominantColor`: if `!isAllowedImageUrl(url)` return `null` before launching Puppeteer)
- Test: `packages/ai/src/__tests__/image-fetch-ssrf.test.ts` stays green; add `extractDominantColor` short-circuit test

- [ ] **Step 1: Write failing test** — `extractDominantColor("http://169.254.169.254/x")` resolves to `null` without launching a browser (mock `puppeteer.launch` to throw if called; assert it was NOT called). Add to a new/existing ai test file.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the three delegations. In `extractDominantColor`, add the guard as the first line. In the repurpose logo fetch, wrap with the guard. In `chat-agent.chain.ts`, refactor to import from `safe-fetch-url` and keep `export const __isAllowedImageUrl = isAllowedImageUrl`.
- [ ] **Step 4: Run** `pnpm --filter @postautomation/ai test` and `pnpm --filter @postautomation/api test` — all green (existing ssrf test must still pass).
- [ ] **Step 5: Commit** `fix(security): apply SSRF guard to repurpose logo fetch + extractDominantColor (N3/A4)`.

### Task 3: Authenticate `/api/progress` SSE

**Files:**
- Modify: `apps/web/app/api/progress/route.ts`

- [ ] **Step 1:** Add at the top of the `GET` handler: `const session = await auth(); if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });` (import `auth` from the project's NextAuth entry — match how other API routes import it, e.g. `@postautomation/auth` or the local `auth` helper used by sibling routes; grep a neighboring authenticated route to copy the exact import).
- [ ] **Step 2:** Manually reason/verify: a signed-out request returns 401; signed-in still streams. (No automated route test required; if a sibling route has a test harness, add a 401 assertion.)
- [ ] **Step 3: Commit** `fix(security): require auth on /api/progress SSE (N1)`.

### Task 4: `generate_news_image` uploads to S3 (not a data URL)

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts` (`generate_news_image` case, ~line 486-555)
- Possibly create: `packages/api/src/lib/upload-media.ts` (extract the repurpose `uploadAndCreateMedia` S3 pattern) — OR duplicate minimally in chat.router if extraction is risky
- Test: `packages/api/src/__tests__/chat-action-media.test.ts` (extend) or new `chat-generate-image-s3.test.ts`

- [ ] **Step 1: Write failing test** — mock the S3 client (`@aws-sdk/client-s3` `send`) and `generateImageSafe`; call the `generate_news_image` executeAction path; assert the created `media.url` starts with the configured S3 public host and is NOT a `data:` URL, and the returned `imageUrl` matches. (Follow the mocking style in existing `chat-action-*.test.ts`.)
- [ ] **Step 2: Run, verify fail** (currently writes `data:` URL).
- [ ] **Step 3: Implement** — after `generateImageSafe` returns `{ imageBase64, mimeType }`, upload `Buffer.from(imageBase64, "base64")` to S3 (`PutObjectCommand`, key like `news-image-${id}.png`, `ContentType: mimeType`), build the public URL the same way repurpose does, store it in `media.url`, and return it as `imageUrl`. Reuse the repurpose helper if extracted.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix: generate_news_image stores S3 URL not multi-MB data URL (N2)`.

### Task 5: Chat cross-org IDOR guards

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts` (`update_agent` ~line 472; `create_brand_tracker` ~line 586)
- Test: new `packages/api/src/__tests__/chat-action-idor.test.ts`

- [ ] **Step 1: Write failing tests** — (a) `update_agent`: assert the `prisma.agent.update` where-clause includes `organizationId: ctx.organizationId` (spy on prisma); (b) `create_brand_tracker` with a `campaignId` belonging to another org → throws `FORBIDDEN` (mock `campaign.findFirst` returning null for cross-org id). Mirror `chat-channel-ownership.test.ts` style.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `update_agent`: `where: { id: thread.agentId, organizationId: ctx.organizationId }`. `create_brand_tracker`: if `p.campaignId` present, `const c = await ctx.prisma.campaign.findFirst({ where: { id: p.campaignId, organizationId: ctx.organizationId } }); if (!c) throw new TRPCError({ code: "FORBIDDEN", message: "Campaign not found in this workspace" });`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix(security): org-scope update_agent + create_brand_tracker campaignId (N7/N8)`.

### Task 6: Harden Super Agent `publish_now` (idempotency + retries + client lock)

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts` (`executeAction` input schema: add optional `clientActionId: z.string().optional()`; `publish_now`/`schedule_post`/`bulk_schedule`: dedupe + `attempts:3` on `postPublishQueue.add`)
- Modify: `apps/web/app/dashboard/super-agent/page.tsx` (per-message executed lock)
- Test: new `packages/api/src/__tests__/chat-action-idempotency.test.ts`

- [ ] **Step 1: Write failing test** — calling `executeAction(publish_now, { clientActionId: "m1" })` twice creates only ONE post (the second short-circuits). Mock prisma so a `ChatMessage` recording `metadata.executedActionId="m1"` exists on the 2nd call; assert `post.create` called once.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — server: before creating the post in `publish_now`/`schedule_post`/`bulk_schedule`, if `input.clientActionId`, check for an existing executed marker (`ctx.prisma.chatMessage.findFirst({ where: { threadId, metadata: { path: ["executedActionId"], equals: input.clientActionId } } })` — match the project's JSON-filter style; if the metadata shape differs, store/read a dedicated marker) and return the existing result if found; write `executedActionId` into the result message metadata. Add `attempts: 3, backoff: { type: "exponential", delay: 30000 }` to the `postPublishQueue.add` options (`chat.router.ts:451`). Client: add `executedActionIds` state in `super-agent/page.tsx`; on successful `executeAction`, add `msg.id`; pass `clientActionId: msg.id` in the mutation; render the action button `disabled` + a "✓ Done" badge when `executedActionIds.has(msg.id)`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix: publish_now idempotency + per-message lock + retries (A1/B4)`.

### Task 7: Worker terminal-state correctness

**Files:**
- Modify: `apps/worker/src/workers/post-publish.worker.ts` (pre-mark FAILED in `token_expired` + `content_too_large` branches before throw)
- Modify: `apps/worker/src/workers/auto-healer.worker.ts` (stuck >30 min PUBLISHING → set FAILED, no re-queue)
- Test: new `apps/worker/src/__tests__/publish-terminal-state.test.ts` (if worker has no test setup, place the testable logic in a small pure helper and unit-test that in `packages/api` or co-located)

- [ ] **Step 1: Write failing test** — extract a helper `markTargetFailed(prisma, postTargetId, message)` (idempotent `update`) and a `shouldReap(target, now)` predicate; test that after a `token_expired` classified error the worker path calls `markTargetFailed` before rethrow, and `shouldReap` is true for a PUBLISHING target older than 30 min. Use the existing worker test conventions; if none, create a vitest config entry for the worker or test the pure helpers.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add `markTargetFailed` and call it immediately before the `throw` in the `token_expired` path (`:504`) and before any rethrow in the `content_too_large` retry. In `auto-healer.worker.ts`, replace the silent re-queue of stuck PUBLISHING targets with `markTargetFailed(..., "Publish stuck >30 min — please retry")` and remove the re-queue for that case.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix(worker): pre-mark FAILED on all publish error paths + auto-heal stuck PUBLISHING (A2c/B2/B3)`.

### Task 8: Worker publish notifications + Activity panel correctness

**Files:**
- Modify: `apps/worker/src/workers/post-publish.worker.ts` (create `Notification` rows on PUBLISHED; in `worker.on("failed")` on FAILED)
- Modify: `apps/web/components/layout/activity-panel.tsx` (PUBLISHING type→`post.publishing`; add `Loader2` icon; lower `post.recentActivity` refetchInterval to 10_000)
- Test: extend Task 7's worker test — PUBLISHED transition creates a Notification (mock prisma `notification.create`)

- [ ] **Step 1: Write failing test** — on a successful publish, `prisma.notification.create` is called once per org owner/admin with `type: "post.published"` and the `postId`. Reuse the org-member lookup already present (the email-report block).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — after the PUBLISHED update, fetch org owners/admins (reuse existing `organizationMember` query) and `notification.create` `post.published` rows (link `/dashboard/posts/${postId}`); in `worker.on("failed")`'s FAILED branch, create `post.failed` rows. In `activity-panel.tsx`: add the `pt.status === "PUBLISHING" ? "post.publishing"` branch (line ~135), add `"post.publishing": Loader2` to `TYPE_ICONS`, and set `refetchInterval: 10_000` on the `post.recentActivity` query.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix: worker publish notifications + Activity panel PUBLISHING state (B5/A2b)`.

### Task 9: Carousel publishes all slides + reel crash guard

**Files:**
- Modify: `apps/web/components/content-agent/RepurposeTab.tsx` (per-platform "Create Post" onClick: when `format === "carousel"`, emit `&aiMediaIds=<id,id,...>` from `results.carouselMediaIds`)
- Modify: `apps/web/app/dashboard/content-agent/page.tsx` (parse `aiMediaIds` comma list)
- Modify: `apps/web/components/content-agent/ComposeTab.tsx` (initialise `postMedia` with all parsed ids in order; single `aiMediaId` remains fallback)
- Modify: `packages/api/src/routers/repurpose.router.ts` (reel branch: `slideImages.filter(Boolean).map(...)`)
- Test: new `apps/web/__tests__/compose-media-params.test.ts` (or co-located) for the param parser; ai/api test for the filter helper

- [ ] **Step 1: Write failing tests** — (a) param parser: `aiMediaIds=a,b,c` → `["a","b","c"]`; `aiMediaId=a` only → `["a"]`; neither → `[]`. (b) reel: mapping a sparse `[x, , z]` yields 2 entries, no throw. Extract both into pure helpers to test cleanly.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — RepurposeTab Create Post: `const mediaParam = format === "carousel" && results.carouselMediaIds?.length ? "&aiMediaIds=" + encodeURIComponent(results.carouselMediaIds.join(",")) : platformMediaId ? "&aiMediaId=" + encodeURIComponent(platformMediaId) : "";`. page.tsx/ComposeTab: read `aiMediaIds`, split on `,`, init `postMedia` to all; keep `aiMediaId` fallback. repurpose.router reel map: add `.filter(Boolean)`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `fix: carousel "Create Post" forwards all slides + guard reel sparse array (D1/N6/N5)`.

### Task 10: Render unbreakers (paint delay + JPEG compress + overlay wait)

**Files:**
- Modify: `packages/ai/src/tools/news-image-generator.ts` (`generateStyledCreativeImage`: add 400ms paint delay after setContent try/catch; `overlayLogoOnImage` line ~243: `networkidle0`→`load`, timeout 30000, try/catch + 400ms delay)
- Modify: `packages/api/src/routers/repurpose.router.ts` (`buildHeadlineCreative`: compress gpt-image-1 fallback PNG to JPEG q82 before inlining as `backgroundImageUrl`; set mimeType `image/jpeg`)
- Test: small ai test that a compress helper returns a smaller buffer + `image/jpeg`; keep `creative-templates.test.ts` green

- [ ] **Step 1: Write failing test** — compress helper: given a PNG buffer, returns `{ buffer, mimeType: "image/jpeg" }` with `buffer.length < input.length` (use `sharp` if already a dep; else a tiny canvas re-encode — check existing deps first and prefer what's installed). If no image lib is available, SKIP compression and only do the paint-delay fixes (note this in the commit); the paint delay alone fixes the blank.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add `await new Promise((r) => setTimeout(r, 400))` before `page.screenshot()` in `generateStyledCreativeImage`; change `overlayLogoOnImage` to `waitUntil:"load", timeout:30000` in a try/catch with a 400ms delay; add the JPEG compression of the DALL-E fallback in `buildHeadlineCreative` (only when the fallback path produced the image — Gemini outputs are already small).
- [ ] **Step 4: Run, verify pass + `creative-templates.test.ts` green.**
- [ ] **Step 5: Commit** `fix: paint delay + JPEG-compress fallback + overlay wait → no blank styled creatives (B1/N9/N10)`.

### Task 11: ffmpeg in web container (interim)

**Files:**
- Modify: `docker/Dockerfile.web`

- [ ] **Step 1:** Add `ffmpeg` to the `RUN apk add --no-cache ...` line (line 3): `RUN apk add --no-cache ffmpeg openssl chromium nss freetype harfbuzz ca-certificates ttf-freefont`.
- [ ] **Step 2:** Verify the Dockerfile parses (no build here; checked at deploy). Note in commit this is interim (Phase 2 offloads to worker).
- [ ] **Step 3: Commit** `fix(infra): install ffmpeg in web container so reel stitch works (D2, interim)`.

---

## Final gate (after all tasks)

- [ ] `pnpm --filter @postautomation/ai test` · `pnpm --filter @postautomation/api test` · (worker tests if configured) — all green.
- [ ] Root `pnpm type-check` (7/7) and `pnpm build` succeed.
- [ ] Dispatch a final full-diff code review.
- [ ] Use superpowers:finishing-a-development-branch → PR to `main`.
