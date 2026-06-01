# PostAutomation — End-to-End Fix Plan (for Sonnet to execute)

**Companion to:** `2026-06-01-system-audit-findings.md` (read it first; finding ids like `C1`, `H4`, `M9` map 1:1).
**Audience:** Claude Sonnet, executing each phase in order.
**Stack reminders:** pnpm@9.15.0 (NOT npm) · Node ≥20 · Turborepo · cross-workspace imports use the package name `@postautomation/<name>`, not relative paths · schema changes go through `pnpm db:push` (dev) and the migrate container rebuilds in prod (see `CLAUDE.md` quirk #2).

## How to work this plan

1. Do the phases **in order**. Phases 1–3 are independent security/integrity fixes that ship immediately. Phase 4 is the format epic and is larger. Phases 5–8 are cleanups.
2. After each phase: run `pnpm type-check` (must stay exit 0) and the targeted check listed in that phase. Commit per phase with a focused message.
3. **Do not** change behavior beyond the finding. Match surrounding code style.
4. **Verify line numbers before editing** — read the cited file first; numbers below are from the 2026-06-01 audit and may have drifted.
5. Skip anything in the findings' "Explicitly refuted" list.

---

## Phase 0 — Make the safety nets real (prereq, ~30 min)

The test suite and lint currently catch nothing. Fix that so the rest of the plan is verifiable.

- **0a. ESLint config (lint finding).** `apps/web` has no ESLint config, so `next lint` prompts interactively and "fails". Add a minimal `apps/web/.eslintrc.json`:
  ```json
  { "extends": "next/core-web-vitals" }
  ```
  Confirm `pnpm --filter @postautomation/web lint` runs non-interactively.
- **0b. Un-rot the stale tests** (they assert reality that changed; they are not product bugs):
  - `packages/queue/src/__tests__/queues.test.ts` — "contains exactly 7 queue names" → update to the real count (currently 17; will become 18 after Phase 3). Prefer asserting `QUEUE_NAMES` *contains* expected names rather than an exact length.
  - `packages/social/src/__tests__/provider-methods.test.ts` — the Twitter cases assume OAuth2 + `maxMediaCount=4`; Twitter is now OAuth1.0a. Update expectations (or `it.skip` with a TODO referencing the OAuth1.0a migration) so the suite reflects the provider's real contract. Also fix the "16 platforms" / "all 16 supported platforms" assertion → 17.
  - `packages/ai/src/__tests__/content-generation.test.ts` — "Twitter limit of 280" / "pass platform-specific char limit" assertions reference an old hardcoded map; align with the current `PLATFORM_CHAR_LIMITS`.
- **Verify:** `pnpm test` is green (or only intentional `it.skip`s remain). `pnpm lint` runs.

---

## Phase 1 — Cross-org IDOR fixes (CRITICAL/HIGH security) — C1, H1, H2, H3

These are independent, small, and ship first. **Pattern:** every mutation that takes a resource id from the client must scope the resource to `ctx.organizationId`. Use `updateMany`/`deleteMany` (allow non-unique `where`, return `count`) and throw `NOT_FOUND`/`FORBIDDEN` when `count===0`.

### 1.1 — C1: validate `channelIds` in `post.create` + harden the worker
**File:** `packages/api/src/routers/post.router.ts` — in `create` (`~line 73`, before `prisma.post.create` at `~88`), add:
```ts
const owned = await ctx.prisma.channel.findMany({
  where: { id: { in: input.channelIds }, organizationId: ctx.organizationId },
  select: { id: true },
});
if (owned.length !== new Set(input.channelIds).size) {
  throw new TRPCError({ code: "FORBIDDEN", message: "One or more channels do not belong to this organization." });
}
```
**Apply the same guard to any other path that accepts raw `channelIds`:** check `publishNow` (`post.router.ts:~228` — it scopes the Post but NOT the channels; a poisoned target attached at create still flows), `bulk.router.ts` (already validates — use as reference), `newsgrid.router.ts:496`, `chat.router.ts:351`.

**File (defense-in-depth):** `apps/worker/src/workers/post-publish.worker.ts:~204-205` — change the channel fetch to scope by the job's org:
```ts
const channel = await prisma.channel.findFirst({
  where: { id: channelId, organizationId: job.data.organizationId },
});
if (!channel) { /* mark target FAILED: "Channel not found for this organization" and return */ }
```
(`postTarget` can still be fetched as today.)

### 1.2 — H1: campaign influencer mutations
**File:** `packages/api/src/routers/campaign.router.ts:~205-219`.
- `updateInfluencer`: replace `influencer.update({ where: { id } })` with `influencer.updateMany({ where: { id, organizationId: ctx.organizationId }, data })`; if `count===0` throw `NOT_FOUND`; then return `findFirstOrThrow({ where: { id, organizationId } })`.
- `deleteInfluencer`: replace with `influencer.deleteMany({ where: { id: input.id, organizationId: ctx.organizationId } })`; if `count===0` throw `NOT_FOUND`.

### 1.3 — H2: team role change + removal
**File:** `packages/api/src/routers/team.router.ts`.
- `updateRole` (`~185-208`): before the update, `const target = await ctx.prisma.organizationMember.findFirst({ where: { id: input.memberId, organizationId: ctx.organizationId } }); if (!target) throw new TRPCError({ code: "NOT_FOUND" });` then update by `target.id`.
- `removeMember` (`~262-270`): same `findFirst` guard before delete. Mirror the (correct) `transferOwnership` pattern in the same file.

### 1.4 — H3: listening cross-org leak + write
**File:** `packages/api/src/routers/listening.router.ts`.
- In `mentions` (`~101`), `sentimentOverview` (`~138`), `alerts` (`~235`), `sourceBreakdown`: change the `queryId` branch from `{ listeningQueryId: input.queryId }` to `{ listeningQueryId: input.queryId, listeningQuery: { organizationId: ctx.organizationId } }`.
- `markAlertRead` (`~252`): scope the update via the relation, e.g. `sentimentAlert.updateMany({ where: { id: input.id, listeningQuery: { organizationId: ctx.organizationId } }, data: { read: true } })`, throw `NOT_FOUND` if `count===0`.

**Verify Phase 1:** `pnpm type-check`. Add/adjust a unit test per router asserting a foreign-org id throws (use a mocked prisma returning `count:0`). Commit: `fix(security): scope cross-org IDORs in post/campaign/team/listening + harden publish worker`.

---

## Phase 2 — Stop duplicate posting (CRITICAL) — C2 + M6

Two complementary changes; **both** land. 2.1 makes every enqueue path safe regardless of dedup (highest value); 2.2 removes the double-enqueue at the source.

### 2.1 — Worker-side idempotency (the keystone)
**File:** `apps/worker/src/workers/post-publish.worker.ts`.
- **Atomic claim** — replace the unconditional `update({ status: "PUBLISHING" })` at `~197-201` with a conditional claim:
  ```ts
  const claim = await prisma.postTarget.updateMany({
    where: { id: postTargetId, status: { in: ["SCHEDULED", "FAILED", "DRAFT"] } },
    data: { status: "PUBLISHING" },
  });
  if (claim.count === 0) {
    console.warn(`[PostPublish] target ${postTargetId} already claimed/published — skipping duplicate job`);
    return;
  }
  ```
- **`publishedId` short-circuit** — after loading `postTarget` (`~206`), if `postTarget.publishedId` is non-null, reconstruct the result from `publishedId`/`publishedUrl`, ensure status is `PUBLISHED`, and **skip `provider.publishPost` entirely**.
- **Isolate the success commit** — wrap the `publishedId`/`publishedUrl`/`PUBLISHED` write (`~498`) in its own try/catch that runs **before** the analytics snapshot (`~511`) and the all-targets aggregation (`~537`); also wrap the aggregation block in try/catch (the analytics block already is). This ensures a post-publish DB hiccup cannot trigger a republishing retry.

### 2.2 — Single scheduling owner
Pick `publishScheduledPosts` (cron) as the sole producer for scheduled posts:
- **File:** `packages/api/src/routers/post.router.ts:127-142` — remove the delayed `postPublishQueue.add` loop in `create` (the cron will pick the post up within 2 min). Keep `publishNow` as the immediate path.
- **File:** `apps/worker/src/workers/autopilot-schedule.worker.ts:~145-163` — same: stop enqueuing `publish-<targetId>` delayed jobs; rely on the cron.
- **File:** `apps/worker/src/scheduler/cron-jobs.ts:346-406` (`publishScheduledPosts`) — flip the matched **targets** to `PUBLISHING` via a conditional `updateMany` *inside the selection window* (not just the parent Post), so a claimed target leaves the cron's selection set immediately. The 2.1 atomic claim is the backstop if two cron cycles overlap.
> If near-instant scheduled latency is a hard requirement, the alternative is to keep delayed jobs but give **every** producer the identical deterministic jobId `publish-${target.id}` so BullMQ dedupes, and have the cron use `getJob`/`upsert` semantics instead of a timestamped id. Prefer the single-owner approach unless latency is raised as a concern.

**Verify Phase 2:** `pnpm type-check`. Manually trace: a post scheduled 30s out should produce exactly one `PUBLISHED` PostTarget. If a local Redis/worker is available, schedule a post and confirm one publish. Commit: `fix(publish): idempotent claim + single scheduling owner to prevent duplicate posting`.

---

## Phase 3 — Dual-worker queue collision (HIGH) — H4

Give brand-content sync its own queue.
- **File:** `packages/queue/src/queues.ts` — add `BRAND_CONTENT_SYNC: "brand-content-sync"` to `QUEUE_NAMES`; export `brandContentSyncQueue = createQueue<BrandContentSyncJobData>(QUEUE_NAMES.BRAND_CONTENT_SYNC)`.
- **File:** `packages/queue/src/types.ts` — add `export interface BrandContentSyncJobData { organizationId: string; campaignId?: string }`.
- **File:** `packages/queue/src/index.ts` — export the new queue + type.
- **File:** `apps/worker/src/workers/brand-content-sync.worker.ts:~281` — bind the Worker to `QUEUE_NAMES.BRAND_CONTENT_SYNC` (remove the "reuses CAMPAIGN_ANALYTICS_SYNC" comment).
- **File:** `apps/worker/src/scheduler/cron-jobs.ts:~300` (`scheduleBrandContentSync`) — enqueue onto `brandContentSyncQueue`, not `campaignAnalyticsSyncQueue`.
- **File:** `packages/queue/src/__tests__/queues.test.ts` — bump the expected count to 18 (or switch to a "contains" assertion per Phase 0b).

**Verify Phase 3:** `pnpm type-check`; `pnpm --filter @postautomation/queue test`. Commit: `fix(worker): dedicated queue for brand-content-sync (was colliding with campaign-analytics)`.

---

## Phase 4 — Post-format epic (HIGH) — H5, H6, M1, M2, M3, M4 (+ enables L1, L8)

Introduce an explicit, per-target **format** dimension and thread it end-to-end. This is the user's #1 request (distinct Short / video / normal; Reel / feed / Story; carousel).

### 4.1 — Schema (data home)
**File:** `packages/db/prisma/schema.prisma`.
- Add an enum: `enum PostFormat { FEED REEL STORY SHORT VIDEO CAROUSEL }`.
- Add `format PostFormat?` to `PostTarget` (nullable → `null` means "infer from media", preserving current behavior).
- (Optional, for YouTube title/tags/privacy) rely on `Post.metadata` (already exists) rather than new columns.
- Run `pnpm db:push` (dev). For prod, the migrate container rebuilds on deploy (CLAUDE.md quirk #2) — no manual SQL.

### 4.2 — API surface (M1)
**File:** `packages/api/src/routers/post.router.ts`.
- Extend the `create` zod input with an optional per-channel format map, e.g. `formatByChannelId: z.record(z.enum(["FEED","REEL","STORY","SHORT","VIDEO","CAROUSEL"])).optional()`, and an optional `metadata: z.object({ title: z.string().optional(), tags: z.array(z.string()).optional(), privacyStatus: z.enum(["public","unlisted","private"]).optional(), videoOverlayText: z.string().optional() }).passthrough().optional()`.
- Persist `metadata` to `Post.metadata`. When creating `targets`, set each `format` from `formatByChannelId[channelId] ?? null`.
- Mirror in `update`.

### 4.3 — Job payload + worker passthrough (M2)
**File:** `packages/queue/src/types.ts` — add `format?: string` to `PostPublishJobData` (or read it from the target in the worker — simpler, do that).
**File:** `apps/worker/src/workers/post-publish.worker.ts:~282,~397` — build the provider payload metadata so **channel ids win** but post/target intent is surfaced:
```ts
const providerMetadata = {
  ...((postTarget.post.metadata as object) || {}),
  ...((postTarget.metadata as object) || {}),
  format: postTarget.format ?? undefined,
  ...channelMetadata, // pageId/igUserId/logo_path MUST win — keep last
};
```
Pass `providerMetadata` (not bare `channelMetadata`) into every `provider.publishPost(...)` call (happy path `~397`, token_expired retry `~471`, content_too_large retry `~487`).

### 4.4 — Instagram: honor format (M3)
**File:** `packages/social/src/providers/instagram.provider.ts:109-114` — branch on `payload.metadata?.format`:
```ts
if (isVideo) {
  containerParams["video_url"] = mediaUrl;
  const fmt = String(payload.metadata?.format ?? "REEL").toUpperCase();
  containerParams["media_type"] = fmt === "STORY" ? "STORIES" : "REELS";
}
```
(Plain in-feed IG video is not supported by the publishing API for most accounts — keep REELS as the default for non-story video, but no longer hardcode.)

### 4.5 — YouTube: thread per-post controls (M4)
**File:** `packages/social/src/providers/youtube.provider.ts:172-194` (`uploadVideo`) — already reads `metadata.title/tags/privacyStatus/categoryId`; now that 4.3 forwards them, they work. Optionally: if `metadata.format === "SHORT"`, append `\n#Shorts` to the description (YouTube auto-classifies by aspect/duration; this is a discovery hint only). Do **not** add aspect/duration gating.

### 4.6 — Compose UI selector (H6)
**File:** `apps/web/components/content-agent/ComposeTab.tsx`.
- Add a per-selected-platform format control (shown conditionally): YouTube+video → `Short | Video`; Instagram+video → `Reel | Story`; multiple images → `Carousel | Single`.
- In `handleSubmit` (`~426`), pass `formatByChannelId` and `metadata` into `createPost.mutate(...)` (`~472`).
- Keep the existing YouTube image/video gate.

**Verify Phase 4:** `pnpm type-check`; `pnpm db:push` succeeds; compose a post with an explicit format and trace it through to the provider payload (add a temporary `console.log` of `providerMetadata` in the worker, then remove). Commit: `feat(format): per-target post format (Short/Reel/Story/feed/carousel) end-to-end`.

---

## Phase 5 — Instagram carousel video children (HIGH) — H7

**File:** `packages/social/src/providers/instagram.provider.ts:417-466` (`publishCarouselPost`).
- Pass `payload.mediaTypes` into the method (available on `payload`).
- For each child, detect video (MIME-first, regex fallback). Video child → `{ video_url: url, media_type: "VIDEO", is_carousel_item: true }` (note: **VIDEO**, not REELS, for carousel items); image child → `{ image_url: url, is_carousel_item: true }`.
- After creating any video child container, `await this.waitForMediaReady(tokens, childId)`; only build the `CAROUSEL` parent once all video children are `FINISHED`.
- If full support is deferred, at minimum add to IG `validateContent`: reject a video in a multi-item post so it fails explicitly at validation, not at the API call.

**Verify:** `pnpm type-check`; `pnpm --filter @postautomation/social test`. Commit: `fix(instagram): support video children in carousels`.

---

## Phase 6 — Media validation & storage correctness (MEDIUM) — M5, M7, M8, M9, M10, M11

- **M5/M7/M8 — make `validateMediaForPlatform` real.** Wire `packages/social/src/utils/media-validator.ts` into a live path. Best at **schedule time** in `post.router.create`: after the channel-ownership check, load each attached `Media` (`fileType`, `fileSize`), and for each target platform call `validateMediaForPlatform(files, getSocialProvider(platform).constraints)`; surface a clear per-platform error (e.g. "Video exceeds Facebook's limit"). **First correct the bogus constraints:** `facebook.provider.ts:42` `maxMediaSize` 10MB → a realistic feed-video limit; review IG/YT `supportedMediaTypes` so video is represented where the provider actually posts video. (Alternatively/additionally enforce in the worker before `publishPost`.)
- **M9 — `media-process.worker.ts:18,45`.** Replace the virtual-host `S3_BASE_URL` with a local `getPublicUrl(key)` matching `packages/api/src/lib/s3.ts:47-52` exactly (path-style; honor `S3_PUBLIC_URL`). Do **not** cross-import API internals into the worker — copy the small helper.
- **M10 — `media.getUploadUrl` orphan rows (`media.router.ts:104-133`).** Add `status MediaStatus @default(PENDING)` (`enum MediaStatus { PENDING READY }`) to `Media`. In `confirmUpload`, run `HeadObjectCommand(bucket,key)` to verify the object exists before flipping to `READY` (throw if absent). Filter `status: "READY"` in `media.list`, the media picker, and reject PENDING ids in `post.create`'s `mediaIds` attach.
- **M11 — `media.delete` brittle key (`media.router.ts:146`).** Add `storageKey String?` to `Media`; populate it in `getUploadUrl` (the `key` is already computed at `~87`) and in the `/api/upload` + multipart-complete paths. In `delete`, use `media.storageKey` directly; for legacy rows lacking it, derive scheme-independently (strip `S3_PUBLIC_URL` prefix if set, else strip `${S3_ENDPOINT}/${BUCKET}/`).

> M10 + M11 + L4 all touch the `Media` model and upload paths — batch the schema change (`status`, `storageKey`, and L4's `width/height/duration` capture) into one `pnpm db:push`.

**Verify:** `pnpm type-check`; `pnpm db:push`. Commit: `fix(media): real per-platform validation + canonical S3 URLs + verified uploads + reliable deletes`.

---

## Phase 7 — OAuth/config correctness (MEDIUM) — M12, M13 + sweep env items

- **M12 — `.env.production.example:35-36`.** Rename to what the code reads: `FACEBOOK_APP_ID/SECRET` → `FACEBOOK_CLIENT_ID/SECRET`; same for Pinterest. Add `TIKTOK_CLIENT_ID` (keep `TIKTOK_CLIENT_SECRET`; also keep `TIKTOK_CLIENT_KEY` which workers read directly). Apply the matching fixes to **`.env.example`** (sweep finding `env-tiktok-pinterest-name-mismatch`).
- **M13 — FB page-token refresh (`facebook.provider.ts` + `oauth/callback/[provider]/route.ts:234-252`).** Make `FacebookProvider.refreshAccessToken` re-derive the page token from the stored user token: pass `channel.metadata` into the refresh call (extend the signature with an optional `metadata`/`userAccessToken`), then if `userAccessToken` + `pageId` are present, call `getPages({ accessToken: userAccessToken })` and return the matching page's token. Update the worker's refresh call sites (`post-publish.worker.ts:~240,~458`) to pass `channel.metadata`.
- **Sweep (verify first): `getDefaultScopes` empty for TikTok/Pinterest/Threads/Slack** (`channel.router.ts:380-396`) — populate the correct default scope lists so OAuth connect works for those platforms.

**Verify:** `pnpm type-check`. Commit: `fix(oauth): correct FB/TikTok/Pinterest env names, FB page-token refresh, default scopes`.

---

## Phase 8 — Polish & latent edges (LOW) — L2, L3, L4, L5, L6, L7, L9

Batch these; each is small.
- **L2 — shared `isVideoUrl(url, mime)`** in `packages/social` (`/\.(mp4|m4v|mov|avi|mkv|webm|ogv)(\?|$)/i.test(url) || (mime ?? "").startsWith("video/")`, MIME as primary). Reuse in `instagram/facebook/linkedin/threads` providers.
- **L3 — IG/FB previews render video.** Extract `isVideoUrl` from `youtube-preview.tsx` into `apps/web/components/previews/media-utils.ts`; in `instagram-preview.tsx`, `facebook-preview.tsx` (and linkedin/twitter/generic) render `<video controls preload="metadata">` when the url is a video.
- **L4 — capture `Media.width/height/duration`.** Have the client read dimensions from a `<video>`/`<img>` element and pass them into the multipart `complete` input (`upload.router.ts` — extend zod) and the `/api/upload` route; persist on `media.create`. (Schema columns already exist; batch with Phase 6.)
- **L5 — single `toPublicMediaUrl(key)` helper** in `packages/api/src/lib/s3.ts`; replace the duplicated ternary in `apps/web/app/api/upload/route.ts:116`, `post-publish.worker.ts:362`, `video-overlay.ts:151`.
- **L6 — surface overlay failures.** When an explicitly-requested overlay (text or resolved logo) is dropped in `post-publish.worker.ts:326`, record it on the PostTarget (`metadata.overlaySkipped`) instead of only `console.warn`.
- **L7 — pass `onProgress` on retries** (`post-publish.worker.ts:471,487`).
- **L9 — Media Library uses multipart.** Extract ComposeTab's threshold-based `uploadFileToS3` into a shared hook/helper; use it in `apps/web/app/dashboard/media/page.tsx` `handleUpload` so large videos uploaded from the library use the direct-to-S3 path.

**Verify:** `pnpm type-check`; `pnpm lint`. Commit: `chore: media/preview polish — shared video helpers, progress on retry, library multipart`.

---

## Sequencing summary

| Phase | Theme | Severity | Independent? |
|-------|-------|----------|--------------|
| 0 | Safety nets (lint + stale tests) | — | yes |
| 1 | Cross-org IDORs | CRITICAL/HIGH | yes |
| 2 | Duplicate posting | CRITICAL | yes |
| 3 | Queue collision | HIGH | yes |
| 4 | Post-format epic | HIGH | larger; depends on schema (4.1) |
| 5 | IG carousel video | HIGH | yes (benefits from Phase 4's mediaTypes plumbing) |
| 6 | Media validation/storage | MEDIUM | batch schema with Phase 4/L4 |
| 7 | OAuth/config | MEDIUM | yes |
| 8 | Polish | LOW | yes |

**Ship 0→3 first** (security + integrity, all small). **Then 4–5** (the format work the user asked for). **Then 6–8.**

## Do-not-touch (refuted by adversarial verification)

AI-image MinIO URL · prod S3 fallback URL · "PUBLISHING stuck forever" · PKCE · YouTube `getProfile` scope · job-data `organizationId`/`postId`. All checked and found correct — see the findings doc's "Explicitly refuted" section.
