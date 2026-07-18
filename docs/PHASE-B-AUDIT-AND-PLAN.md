# Phase-B Audit & Implementation Plan — 2026-07-18

Produced by a 5-agent evidence-gathering workflow (every claim carries file:line from this repo; nothing hypothesized). Scope: the five change areas requested after the Snapchat connect slice + admin theme fix shipped on branch `feat/snapchat-connect-2026-07-18`.

**Standing rule for all work below: additive-only, live-prod product — never break shared-caption posting, the publish funnel, or the security/RBAC invariants.**

---

## 1. Publish email — visible URLs + one-click spreadsheet

**Today:** the email already HAS a "Link" column (`publish-email.ts:117-120`) but the cell renders anchor text `View post` (`:95`) — the raw URL is never visible; it appears only in the plain-text alternative (`:140`). The worker sends via its OWN inline nodemailer transport (`post-publish.worker.ts:87-105`), NOT the api-package mailer — and nodemailer 7 supports `attachments` natively (`@types/nodemailer .../mailer/index.d.ts:135`).

**Plan (recommended: CSV attachment — the only genuinely one-click spreadsheet path; Gmail opens CSV straight into Sheets):**
1. `buildPublishReportCsv(input)` exported from `publish-email.ts` — columns `platform, channel, handle, url, status, published_at_utc, published_at_ist`; **replicate the formula-injection hardening from `apps/web/lib/csv.ts:13-24` verbatim** (`^[=+\-@\t\r]` → leading `'`, all fields quoted, BOM prefix). apps/web is not importable from the worker — replicate, don't import.
2. Visible URL: inside the existing Link `<td>` add `<div style="font-size:11px;color:#a1a1aa;word-break:break-all">${escapeHtml(href)}</div>` under the anchor. Column count/escaping/safeHref unchanged (locked by tests).
3. `transport.sendMail({..., attachments: [{ filename: \`publish-report-${postId}.csv\`, content: "﻿"+csv, contentType: "text/csv; charset=utf-8" }]})` at `post-publish.worker.ts:105`; build CSV in its own try/catch (send without attachment on failure — email must never break publish, `:45,111-114`).
4. Tests in `publish-email.test.ts`: header row + row-per-target, `=HYPERLINK` neutralized, url fallback to dashboardUrl, never `javascript:`, visible-URL assertion must match TEXT content not href (existing `:41` assertion passes via attribute — illusory guard).
5. OUT of scope: touching `packages/api/src/lib/email.ts` (unused by this flow), dashboard CSV page, TSV block.

## 2. Insights/Reports — accuracy & freshness (direct answers)

- **"30-day-old post gets a like — when does it show?" → NEVER, today.** All three sync paths are age-bounded: 6-hourly cron `publishedAt >= now-7d` (`cron-jobs.ts:45,51`), at-age checkpoints end at 30d (`post-publish.worker.ts:649-654`), manual Sync Now bounded to 30d (`analytics.router.ts:492,498`). Data freezes permanently at 30 days. The user's instinct was correct.
- **Refresh rate of "current" mode:** ≤7d-old posts sync every 6h (non-FB); **FACEBOOK is excluded from the cron entirely** (`cron-jobs.ts:54`, quota decision) — FB "current" updates only at publish, the 4 checkpoints, or Sync Now.
- **At-age mode:** posts published before 2026-07-17 show "—" by design (no backfill possible). One-shot checkpoint jobs **fail-soft**: a transient provider error at checkpoint time `return null`s → job completes → checkpoint permanently lost (`analytics-sync.worker.ts:26-36`, `removeOnFail:true` at `post-publish.worker.ts:666`).
- **CSV export:** faithful superset of the table (same rows array, 14 cols 1:1 + 3 extra incl. `snapshotAt`), formula-guard real (`csv.ts`). Caveat: silently capped at the 500-row query default.
- **Platform caveats (NOT bugs):** views ride on impressions (YT/Threads), Twitter free tier = zeros, IG never fills clicks/shares, historical engagementRate mixed units — postReports recomputes Eng.% from raw counts (correct).

**Plan:** (a) additive once-daily long-tail cron pass `7d < publishedAt ≤ 90d` (non-FB) — converts "frozen at 30d" to "daily-refreshed to 90d"; (b) rethrow provider errors on TAGGED at-age jobs so BullMQ's attempts:3 engages (keep soft-return for untagged cron); (c) daily reconciliation sweep re-enqueuing missed checkpoints with `capturedLate:true`; (d) `triggerSync` optional `days` input (default 30 unchanged, UI can pass 90); (e) surface `snapshotAt` in the Reports table + stale hint + FB-cadence note in the info line; (f) export refetch at limit:1000 + truncation marker.

## 3. Super Agent + per-channel unique captions (60 channels → 60 captions)

**Facts:** one Post → N PostTargets sharing ONE content string; worker reads `contentVariants?.[platform] ?? post.content` (`post-publish.worker.ts:319-321`). `PostTarget` (schema `:307-329`) has **no content field**; `Post.contentVariants` is per-PLATFORM only. Super Agent is USER-accessible (orgProcedure), `create_agent` admin-gated (`chat.router.ts:394-399`), post actions plan-limited + `assertChannelsOwned`/`assertMediaOwned` org-scoped. **Mass posting works and must not be disturbed.**

**Design decision: Option A — `PostTarget.contentOverride String? @db.Text`** (NOT N single-channel posts, which would 60× the postsPerMonth quota accounting, explode the per-postId approval flow, and change dedupe semantics).
- Worker precedence one-liner: `target.contentOverride ?? contentVariants?.[platform] ?? post.content` — NULL short-circuits to today's exact behavior (byte-identical for all existing posts).
- **Async generation is load-bearing:** new `CAPTION_FANOUT` queue + worker; post created as DRAFT, chunked LLM calls (~10 captions/call via the existing provider-fallback chain), write overrides, flip DRAFT→SCHEDULED; safety valve: on final failure flip anyway with null overrides (shared caption publishes — degraded, never lost). NEVER generate 60 captions inline in the tRPC mutation (minutes-long request = the 504 class fixed in PR #119).
- Triggers: `uniqueCaptions` boolean on `post.create` (Compose toggle, shown only when >1 channel) + accepted on chat `publish_now`/`schedule_post` payloads (skip direct enqueue on that path; cron picks up post-flip).
- Review surface: post detail page lists per-target captions + org-scoped `post.updateTargetContent` (IDOR-guarded, reject PUBLISHED targets).
- Quota: `enforcePlanLimit` unchanged — 1 post = 1 quota unit regardless of caption count.

**🔴 RBAC gap found (fix in this phase):** chat `create_campaign` / `create_brand_tracker` / `create_listening_query` carry **no `isAppAdmin` gate** (`chat.router.ts:729+`) while the dedicated campaign/listening routers are admin-gated — a USER-role side door. Add the same gate used by `create_agent` (`:394-399`) + `requirePlan(PROFESSIONAL)` for campaigns.

## 4. Stability / rate-limit

**Verified good:** nginx-HTML 429 → friendly toast (`react.tsx:26-46`, "Too many requests - please wait a moment and try again."); zero sync exec in web paths; worker queues all have bounded concurrency; carousel render batched (3/batch, shared browser).

**Real vectors (top 2 HIGH):**
1. **Unbounded concurrent Chromium in web**: `repurposeFromUrl`/`regenerateImage` are bare `orgProcedure` (`repurpose.router.ts:962, :3119` — no rate limit, unlike ai/image routers) and each static render can self-launch Puppeteer (`news-image-generator.ts:165-168`); no semaphore exists anywhere. N users → N Chromiums → web OOM.
2. **ai_video Veo3-fallback runs the full slideshow pipeline inline in web** (`repurpose.router.ts:2426-2496`, up-to-180s ffmpeg) — and this path fires on EVERY ai_video request while Veo3 is billing-blocked. The sibling `reel` format already enqueues to the worker (`:2989-2999`).

**Plan:** (a) attach the EXISTING `createRateLimitMiddleware(aiRateLimiter)` to both repurpose mutations; (b) small env-tunable semaphore (default 3, try/finally) around creative-browser launches; (c) move the ai_video fallback to the existing repurpose-video worker via the proven `videoPending` contract (verify the ai_video UI branch handles videoPending first); (d) worker `execFileSync`→async `execFile` (identical argv) in `repurpose-video.worker.ts:108,:199` + `video-overlay.ts:168` so encodes stop blocking all 19 queues; (e) verify/add container mem limits in docker-compose.prod.yml.

## 5. Channel-connect timeouts

**Former causes — all FIXED:** nginx limit_req 503s on callbacks (PR #119 exemption, `nginx.conf:193-202`), sync-ffmpeg event-loop freeze (PR #119), blocking avatar fetches (PR #127 — `queueAvatarCache` verified fire-and-forget, `route.ts:16-24`).

**Remaining REAL risk (the answer to "has it been fixed?" — mostly, with one gap):**
- **ZERO fetch timeouts in `packages/social`** — every provider token-exchange/profile/pages call is bare `fetch()`; a hung platform API holds the callback to nginx's 120s → 504 → burns the one-shot consent code. (Snapchat provider currently matches this pattern — give it the helper too.)
- FB `graphFetch` can sleep >210s inside the callback (60s usage-pause + 30/60/120s backoff, `facebook.provider.ts:114-135`) vs the 120s proxy budget.
- FB/IG `while(url)` pagination is unbounded + O(N) sequential upserts in the callback.

**Plan:** shared `fetchT(url, init, ms=25_000)` helper (`AbortSignal.timeout` — same pattern already in prod in `avatar-cache.worker.ts:86`) applied ONLY to connect-path methods; opt-in `maxSleepMs`/`retries` params so the web callback clamps graphFetch sleeps while worker publish paths keep exact current behavior; page-cap (20 pages ≈ 500 Pages) with warn; oauth-flow tests asserting `init.signal` present.

---

## Recommended execution order (each PR independently shippable)

1. **PR-1 (small, high value): publish-email URL column + CSV attachment** (§1) — self-contained in 2 worker files + tests.
2. **PR-2: connect-path fetch timeouts + graphFetch clamp + page cap** (§5) — closes the last known connect-timeout class; includes Snapchat provider.
3. **PR-3: stability guardrails** (§4 a/b/d first; c after UI videoPending check) + the **chat RBAC side-door gate** (§3 gap — one-file fix, do it here).
4. **PR-4: insights freshness** (§2 long-tail cron + at-age hard-fail + reconciliation + UI freshness column).
5. **PR-5 (largest): per-channel unique captions** (§3 design) — schema + queue + worker + toggle + chat payload + review surface + tests.
6. **Beautification of Insights/Reports** rides with PR-4 (freshness column, stale hints, FB note) + any visual polish after accuracy is right.

Insights email-to-anyone button (send a filtered report to an arbitrary address): design in PR-4's follow-up — needs an org-scoped mutation + reuse of the report CSV builder; treat the recipient field as untrusted (no relay abuse: rate-limit + audit-log it).
