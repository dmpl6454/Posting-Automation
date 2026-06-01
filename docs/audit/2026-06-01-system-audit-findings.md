# PostAutomation — End-to-End System Audit (Findings)

**Date:** 2026-06-01
**Scope:** Deep-dive on the publish pipeline (compose → upload → schedule → worker → provider) and the three priority channels (Facebook, Instagram, YouTube), with emphasis on media-type differentiation (Shorts / Reels / Stories / feed video / carousel / image). Light show-stopper sweep of the rest of the system (routes, pages, tRPC routers, other workers, other providers, config).
**Method:** Static analysis + `pnpm type-check` / `pnpm lint` / `pnpm test`, plus a fan-out audit (42 agents) with **adversarial verification of every finding** against the actual code. Security findings were re-verified in a second adversarial pass. No live OAuth posting (no real credentials).

> **How to read severities:** `critical` = data loss / security / silent cross-tenant or duplicate posting. `high` = a priority feature cannot be expressed or a priority channel mis-posts. `medium` = correctness gap with a real but bounded user impact. `low` = polish, latent edge case, or verified-OK note. Severities shown are **post-verification** (several initial ratings were corrected down/up by the verifier).

## Baseline (build health)

| Check | Result |
|-------|--------|
| `pnpm type-check` | ✅ Passes (exit 0) |
| `pnpm lint` | ⚠️ Fails only because `next lint` interactively prompts for ESLint setup — **no `.eslintrc` exists in `apps/web`**. Not a code error, but lint is effectively not running in CI. |
| `pnpm test` | ❌ 17 test failures across `social`/`queue`/`ai` — **all stale tests**, not product bugs (assert Twitter=OAuth2, "16 platforms", "exactly 7 queues", Twitter limit 280). The suite no longer reflects reality and gates nothing. |

---

## Summary by severity

| Severity | Count | Headline items |
|----------|-------|----------------|
| **Critical** | 2 | Cross-org publish IDOR (publish to another tenant's account with their tokens); duplicate posting from double-enqueue |
| **High** | 6 | 3 more cross-org IDORs (campaign influencers, team members, listening); dual-worker queue collision; no media-kind data model; no compose format selector; IG carousel video broken |
| **Medium** | ~14 | Format intent never reaches providers; IG forces Reels; YT no Shorts UX; dead media validation; orphan/zombie media rows; S3 URL inconsistencies; FB env-var mismatch; FB page-token refresh |
| **Low** | ~11 | FB no Reels/Stories; preview never renders video; regex gaps; overlay swallows errors; + 2 verified-OK notes |

**The single most important theme:** the platform has **no concept of "post format" anywhere** — not in the schema, not in the API, not in the compose UI, not in the job payload. Format is inferred purely from a file's MIME type at the moment of publish, and each provider then *hardcodes* one behavior (IG → always Reel, YT → always default upload, FB → always feed video). The user's explicit requirement (distinct Short / video / normal, Reel / feed / Story) cannot be expressed today. This is one coherent epic spanning DB → API → queue → worker → provider → UI (Findings F2, H3, H4, M1, M2, M3, M4, L1, L8).

---

## CRITICAL

### C1 — Cross-org publish IDOR: publish to another tenant's account using their tokens
`packages/api/src/routers/post.router.ts:88-118` · `apps/worker/src/workers/post-publish.worker.ts:205` · **confirmed (2× adversarial)**

`post.create` (an `orgProcedure`) maps `input.channelIds` straight into `PostTarget` rows with **no check that each channel belongs to `ctx.organizationId`**. The worker then loads the channel by id alone — `prisma.channel.findUniqueOrThrow({ where: { id: channelId } })` (no org filter) — decrypts that channel's OAuth tokens, and publishes. `ctx.organizationId` comes from the client-supplied `x-organization-id` header; `orgProcedure` only checks the caller is a *member of that header's org*, never that the channels belong to it.

**Impact:** An authenticated user in Org A can create a post targeting Org B's connected channel id and have the worker publish to Org B's social account using Org B's credentials — cross-tenant account abuse. (`newsgrid.router.ts:582` shows the codebase *has* the correct `findFirst({ where:{ id, organizationId } })` pattern; `post.create` simply omits it.)

**Fix:** Validate all `channelIds` against the org in `post.create` (reject if any aren't owned), AND defense-in-depth: scope the worker's channel fetch by `job.data.organizationId`. See Fix Plan §1.

### C2 — Duplicate posting: scheduled posts are enqueued twice
`apps/web` `post.router.ts:127-142` (create) + `apps/worker/src/scheduler/cron-jobs.ts:346-406` (`publishScheduledPosts` cron) · **confirmed**

`post.create` enqueues a delayed publish job per target (`publish-<targetId>`) when a post is scheduled. Separately, the `publishScheduledPosts` cron runs every 2 minutes, finds the same `SCHEDULED` targets, and enqueues **another** job per target with a *different, timestamped* job id (`scheduled-publish-...-<Date.now()>`). BullMQ does **not** dedupe across differing job ids, so both run → the post publishes twice to every platform. Autopilot (`autopilot-schedule.worker.ts`) is a third producer of `publish-<targetId>` jobs.

**Impact:** Every scheduled post risks double (or triple, with autopilot) posting. There is no worker-side idempotency guard to catch it.

**Fix:** Worker-side atomic claim (conditional `updateMany` of `SCHEDULED→PUBLISHING`, bail if `count===0`) + a `publishedId` short-circuit, AND pick a single scheduling owner. See Fix Plan §2 (this also resolves M6).

---

## HIGH

### H1 — Cross-org IDOR: campaign influencers (update + delete)
`packages/api/src/routers/campaign.router.ts:205-219` · **confirmed**
`updateInfluencer` (`influencer.update({ where: { id } })`) and `deleteInfluencer` (`influencer.delete({ where: { id } })`) omit `organizationId`, while *every sibling mutation in the same router* scopes by it. Any org member can edit or delete any other org's influencer rows by id. **Fix:** `updateMany`/`deleteMany` with `{ id, organizationId: ctx.organizationId }`, throw `NOT_FOUND` if `count===0`.

### H2 — Cross-org IDOR: team member role change + removal
`packages/api/src/routers/team.router.ts:185-208, 262-270` · **confirmed**
`updateRole` checks the caller is OWNER of *their* org, then `organizationMember.update({ where: { id: input.memberId } })` with no org scope; `removeMember` likewise. `transferOwnership` *is* correctly scoped — proving the omission is an oversight. An OWNER/ADMIN of Org A can change roles of / remove members of Org B by passing B's `memberId`. **Fix:** `findFirst({ where: { id: memberId, organizationId } })` guard before mutating.

### H3 — Cross-org data leak + write: social listening
`packages/api/src/routers/listening.router.ts:101, 138, 235, 252` · **confirmed**
When `input.queryId` is provided, the filter becomes `{ listeningQueryId: input.queryId }` with no org check (the code comment claims it verifies ownership but doesn't), across `mentions` / `sentimentOverview` / `alerts` / `sourceBreakdown`. `markAlertRead` writes by id with no scope. Any member can read another org's listening data and mark its alerts read. **Fix:** scope via the relation `{ listeningQueryId, listeningQuery: { organizationId } }`.

### H4 — Dual worker on one queue: campaign-analytics & brand-content silently swap jobs
`apps/worker/src/workers/brand-content-sync.worker.ts:281` + `campaign-analytics-sync.worker.ts:11` + `index.ts:60-61` + `cron-jobs.ts:273,300` · **confirmed**
Both workers bind to the identical `QUEUE_NAMES.CAMPAIGN_ANALYTICS_SYNC` queue and are both started. BullMQ load-balances jobs across all consumers of a queue **by availability, not by job name** — so ~half of each job type runs the *wrong* handler and silently no-ops (campaign job hits brand handler → finds nothing; brand job with `campaignId:''` hits campaign handler → `findUnique({id:''})` → `{skipped:true}`). Both campaign metric aggregation and brand-content discovery intermittently fail with no surfaced error. **Fix:** give brand-content its own dedicated queue. See Fix Plan §3.

### H5 — No data-model field for post format (Short / Reel / Story / feed / carousel)
`packages/db/prisma/schema.prisma` (Post / PostTarget / Media) · **confirmed (severity corrected critical→high)**
None of `Post`, `PostTarget`, or `Media` has a `format`/`postType`/`mediaKind` column. The product requirement (YouTube Short vs long-form; IG Reel vs feed vs Story; FB Reel vs feed) has no place to live, so it can't be selected, stored, previewed, or published differently. Nothing is *broken* (posting works with one default per platform) — it's a capability gap. **Fix:** add `PostTarget.format` enum (nullable, default inferred). See Fix Plan §4 (epic).

### H6 — Compose UI has no format selector
`apps/web/components/content-agent/ComposeTab.tsx:472-477` · **confirmed (corrected critical→high)**
The only format-aware logic in the 1107-line composer is the YouTube image-vs-video gate. There is no control for Short vs video, Reel vs feed vs Story, or single vs carousel. `createPost.mutate()` sends only `{ content, channelIds, scheduledAt, mediaIds }` — no metadata. **Fix:** per-platform format picker in compose, threaded through (Fix Plan §4).

### H7 — Instagram carousel drops/breaks video children
`packages/social/src/providers/instagram.provider.ts:417-466` · **confirmed**
`publishCarouselPost` builds every child container with `image_url`, regardless of type. A video in a multi-item post is passed as `image_url` → child creation fails / produces a broken slide. The carousel path also never calls `waitForMediaReady`. **Impact:** any multi-item IG post containing a video silently breaks. **Fix:** detect per-child type, use `video_url` + `media_type:"VIDEO"` + `waitForMediaReady` for video children. See Fix Plan §5.

---

## MEDIUM

> These are correctness gaps with real but bounded impact. Grouped by theme.

**Format plumbing (part of the H5/H6 epic):**
- **M1 — `post.router` accepts no `metadata`/format input** (`post.router.ts:59-72`, confirmed). The create/update zod schemas have no `metadata` field, so even if the UI sent format intent there's no API surface to receive it. `Post.metadata.videoOverlayText` (read by the worker) is also never written → the overlay-text feature is dead.
- **M2 — Worker never forwards post-level format to providers** (`post-publish.worker.ts:282-397`, confirmed). The provider payload's `metadata` is built **only** from `channel.metadata` (pageId/igUserId). Post/target metadata, title, tags, privacyStatus, and format never reach the provider — which is *why* YouTube always titles from `content.slice(0,100)` and is always `public`. Fix must merge `post.metadata`/`postTarget.metadata` into the payload **without clobbering** channel-owned ids.
- **M3 — Instagram forces every single video to a Reel** (`instagram.provider.ts:100-125`, confirmed; corrected high→medium). `media_type="REELS"` is unconditional — no feed-video, no Story. **Fix:** branch on `payload.metadata.format` (`story`→`STORIES`, else `REELS`/feed).
- **M4 — YouTube has no Shorts UX plumbing** (`youtube.provider.ts:82-194`, confirmed; corrected high→medium). *Note (verifier correction):* YouTube **auto-classifies** Shorts by aspect ratio + duration, so the current upload path already yields valid Shorts. The real gap is plumbing per-post controls (title, tags, privacyStatus, madeForKids, optional `#Shorts`) through — see M2.

**Validation that doesn't validate:**
- **M5 — `validateContent` ignores media type & size** (`social.abstract.ts` base + `post-publish.worker.ts:381`, confirmed). The base check only validates content length and media count; `supportedMediaTypes`/`maxMediaSize` are **dead**. IG declares no video support yet passes video through; oversized videos pass and fail downstream.
- **M7 — Facebook `maxMediaSize=10MB`** (`facebook.provider.ts:42`, confirmed) is wrong for video and, being dead (M5), is also misleading. **Fix:** correct it *and* wire `validateMediaForPlatform` into a real path.
- **M8 — Upload size cap vs platform mismatch** (`upload route` 500MB / multipart 5GB vs FB 10MB / YT 256MB, confirmed). Large videos upload fine, then silently fail at publish because size is never checked against the target platform. **Fix:** check `Media.fileSize`/`fileType` against each target's constraints at schedule time with a clear per-platform error.

**Idempotency / retries:**
- **M6 — Duplicate publish on retry** (`post-publish.worker.ts:397-508`, confirmed; corrected high→medium). `publishPost` (network side-effect) runs *before* the DB write to `PUBLISHED`. If the DB update / analytics / aggregation throws, or the worker stalls between the platform call and commit, BullMQ retries and re-posts. No check of `postTarget.publishedId` before publishing. **Fix:** `publishedId` short-circuit at job start + isolate the `publishedId` commit in its own try/catch *before* analytics. (Pairs with C2.)

**Storage / media lifecycle:**
- **M9 — `media-process.worker` builds virtual-host S3 URLs** (`media-process.worker.ts:18,45`, confirmed) while every other path uses path-style. Against MinIO (path-style only) the thumbnail/processed URLs are wrong and 404. **Fix:** use the same `getPublicUrl` shape as `s3.ts`.
- **M10 — `media.getUploadUrl` creates orphan Media rows** (`media.router.ts:104-133`, confirmed). The row is created *before* the file is PUT; `confirmUpload` never verifies the object exists. Abandoned uploads leave Media rows pointing at nonexistent S3 objects. **Fix:** add a `status` (PENDING/READY), HEAD-check in `confirmUpload`, filter `READY` in lists/attach.
- **M11 — `media.delete` extracts the S3 key brittly** (`media.router.ts:146`) via `url.split("<bucket>/")` — breaks under `S3_PUBLIC_URL` schemes that don't contain the bucket in the path, leaving objects undeleted. **Fix:** persist a `storageKey` column.

**OAuth / config:**
- **M12 — FB env-var name mismatch in prod template** (`.env.production.example:35-36`, confirmed). Template uses `FACEBOOK_APP_ID/SECRET`; code reads `FACEBOOK_CLIENT_ID/SECRET`. An operator who fills the template gets `undefined` creds → "Facebook not configured". (Same class as the sweep finding for TikTok/Pinterest in `.env.example`.)
- **M13 — FB page-token refresh re-exchanges the page token** (`oauth/callback/[provider]/route.ts:234-252`, confirmed). FB Page channels store the *page* token as `refreshToken` and `tokenExpiresAt=null` (so the pre-flight refresh never runs); on `token_expired` the worker re-exchanges the page token (wrong) instead of the saved user token. **Fix:** make `FacebookProvider.refreshAccessToken` re-derive the page token from the stored `metadata.userAccessToken`.

---

## LOW (polish, latent edges, and verified-OK notes)

- **L1 — Facebook has no Reels / Stories path** (`facebook.provider.ts:444-498`, confirmed). All video → `/{pageId}/videos` (feed). A *feature addition* gated on the H5 format epic (Reels use the `/video_reels` resumable flow).
- **L2 — Video-detection regex gaps** (`instagram.provider.ts:101` et al, partial). `$`-anchored regex misses query-string URLs and `m4v`/`ogv`; MIME (`fileType`, reliably populated) is the real signal. **Fix:** one shared query-tolerant `isVideoUrl(url, mime)` helper across providers.
- **L3 — IG/FB previews never render video** (`instagram-preview.tsx:84-100`, `facebook-preview.tsx`, confirmed). Always `<img>`, so video posts show a broken thumbnail. **Fix:** extract the `isVideoUrl` helper from `youtube-preview.tsx` into a shared previews util; render `<video>` for video.
- **L4 — No capture of `Media.width/height/duration`** (schema has the columns; uploads never populate them, partial). This is the *enabling data* for any auto-classify of Short/Reel eligibility. **Fix:** capture client-side dimensions at upload `complete`.
- **L5 — `processVideoOverlay` returns a non-public URL when `S3_PUBLIC_URL` unset** (`video-overlay.ts:151-155`, partial). Same duplicated URL pattern in 3 places. **Fix:** extract one `toPublicMediaUrl(key)` helper. (Verifier note: this is not unique to overlay; in prod with `S3_PUBLIC_URL` set it's fine.)
- **L6 — Overlay failures are swallowed** (`post-publish.worker.ts:326-328`, partial). On any ffmpeg error the *original un-watermarked* video posts with only a `console.warn`. (Verifier note: ffmpeg + fonts *are* installed in `Dockerfile.worker`, so the common cause is covered; the gap is observability.) **Fix:** record a warning on the PostTarget when an explicitly-requested overlay is dropped.
- **L7 — `token_expired`/`content_too_large` retries omit `onProgress`** (`post-publish.worker.ts:471,487`, partial). The progress bar freezes during a re-upload. **Fix:** pass `onProgress` on both retry calls.
- **L8 — YouTube Shorts: no explicit UX** (`post-publish.worker.ts:386-397`, partial) — same as M4; YouTube auto-classifies, so this is optional polish (`#Shorts` hint + per-target controls).
- **L9 — Media Library upload doesn't use multipart** (`media/page.tsx:103`, partial). It uploads only via the proxied `/api/upload`, so large videos added from the library can't use the direct-to-S3 path. (Verifier note: CORS/ETag is already handled by `scripts/setup-s3-cors.sh` + nginx; the valid part is reusing ComposeTab's threshold logic.)
- **L10 — Token encryption is correctly wired end-to-end** ✅ (`packages/db/src/index.ts:80-131`, verified-OK). AES-256-GCM via a Prisma `$extends` client; both web and worker import it. *Operational note:* web and worker must share the identical `TOKEN_ENCRYPTION_KEY`/`NEXTAUTH_SECRET` or stored tokens become undecryptable.
- **L11 — FB pageId / IG igUserId are persisted at connect and read by the worker** ✅ (`oauth/callback/[provider]/route.ts:240-303`, verified-OK). The happy path does not fall back to `me`/per-publish lookup.

---

## Lower-severity sweep findings (plausible, not yet adversarially verified)

These came from the light sweep and were **not** put through the second verification pass. Treat as "likely real, verify before fixing":

- **(high)** `.env.example` uses wrong var names for TikTok & Pinterest OAuth (`env-tiktok-pinterest-name-mismatch`); `getDefaultScopes` returns empty scopes for TikTok/Pinterest/Threads/Slack (`channel.router.ts:380-396`).
- **(medium)** `aiImagesPerMonth`/`aiVideosPerMonth` plan limits never trigger — usage always counts 0 (`plan-limit.middleware.ts:97`); `bulkRouter` uses `protectedProcedure` and hard-fails without an org header (`bulk.router.ts:27`); Telegram sends video as photo (`telegram.provider.ts:158-191`).
- **(low)** `newsgrid.assignLogoToChannel` updates media by id without org scope (`newsgrid.router.ts:575`); `channelGroup.addChannel` doesn't verify the channel against the org (`channel-group.router.ts:69`); `notification-send` queue has no producer/consumer (dead); Discord attaches video as embed image; several optional env keys undocumented in `.env.example`.

---

## Explicitly refuted (do NOT spend time on these)

The adversarial pass **refuted** these plausible-sounding claims after reading the code:

- ❌ "AI-image auto-gen uses an unreachable MinIO URL" — refuted.
- ❌ "Production S3 public URL falls back to `s3.amazonaws.com` and is unreachable" — refuted (prod sets `S3_PUBLIC_URL`).
- ❌ "PostTarget can stay `PUBLISHING` forever on stall" — refuted (watchdog handling exists).
- ❌ "No PKCE is a vulnerability" — not a bug (confidential clients; state CSRF is HMAC-signed + session-bound).
- ❌ "YouTube `getProfile` will 403 from missing scope" — not a bug (both `youtube.upload` + `youtube.readonly` are requested).
- ❌ "`job.data.organizationId`/`postId` are missing" — not a bug (all enqueue sites set them).

---

*Companion document: `2026-06-01-system-fix-plan.md` — a step-by-step, Sonnet-executable remediation plan.*
