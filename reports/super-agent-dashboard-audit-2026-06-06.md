# Post-Automation Platform Audit — Super Agent, Dashboard, Content Studio, Media, Analytics

_Lead auditor synthesis · 2026-06-06 · for tabish@dashmani.com_

## Executive Summary

Overall the platform is **functionally solid but has one genuinely dangerous gap and a cluster of cosmetic-to-medium routing bugs.** Content Studio, Media, and the core compose/post pipeline are well-built and work end-to-end; the recently-shipped Repurpose fixes (PR #44/#45) are correctly in place. The headline answers to your core questions: **(a) Yes — Super Agent does generate posts end-to-end** (it can compose, schedule, bulk-schedule, publish-now, and generate AI images via `executeAction`), but it does so with **zero plan gating and no org-ownership validation on channel IDs**, which is the single CRITICAL finding. **(b) Media upload broadly exists and works** (images + video, single-shot ≤8MB and multipart up to 5GB, library, picker, AI-generated media) — but **the Super Agent chat UI specifically has no upload affordance** even though its backend accepts `attachmentMediaIds`. **(c) Yes — the Repurpose dashboard card routing bug is real**: it emits `?expanded=repurpose`, which the destination page never reads, silently dumping the user on the Compose tab. This is part of a family of ~6 broken navigation links into Content Studio.

The most urgent work is the Super Agent plan-bypass + IDOR (security/revenue), followed by the analytics timezone off-by-one (corrupts data for all non-UTC users — i.e., you, in India), then the quick-win routing-param fixes.

---

## Findings by Severity

### CRITICAL

**1. Super Agent — Zero plan gating on every `executeAction` mutation**
Surface: Super Agent (conversational AI).
Evidence: `packages/api/src/routers/chat.router.ts:1-4` (no `plan-limit.middleware` import), `executeAction` at lines 179-630 has zero `requirePlan`/`enforcePlanLimit`/`checkUsageLimit` calls. Contrast: `agent.router.ts:5,10` imports and calls `requirePlan(..., "STARTER")`; `post.router.ts:8,82` calls `enforcePlanLimit(..., "postsPerMonth")`. Plan limits live in `packages/billing/src/plans.ts` (FREE = 30 posts/mo, 50 AI images/mo; STARTER required for agents).
User experience: A FREE-tier user opens `/dashboard/super-agent` and, through chat, can create agents (a STARTER feature), schedule unlimited posts (past the 30/mo cap), and generate unlimited AI images (past the 50/mo cap) — every paid gate is bypassed via the AI assistant.
Recommended fix: Import `plan-limit.middleware` into `chat.router.ts`. In `executeAction`, gate `create_agent` → `requirePlan(STARTER)`; `generate_news_image` → `requirePlan(PROFESSIONAL)` + `enforcePlanLimit(aiImagesPerMonth)`; `schedule_post` / `bulk_schedule` / `publish_now` → `enforcePlanLimit(postsPerMonth)`. Pass `ctx.isSuperAdmin` through as the other routers do.

### HIGH

**2. Super Agent — IDOR via unvalidated `channelIds` across 4 action cases (merged with create_agent finding)**
Surface: Super Agent.
Evidence: `chat.router.ts:219` (`create_agent`: `channelIds: p.channelIds||[]`), `:260` (`schedule_post` targets), `:300` (`bulk_schedule`), `:340` (`publish_now`) all pass AI-supplied channel IDs straight into Prisma `create()` with no org-ownership check. The correct pattern exists in `post.router.ts:55-69` and `agent.router.ts:64-76` (`findMany({ where: { id: { in: ids }, organizationId } })` + count check).
User experience: An authenticated user who knows another org's channel ID can ask the agent to schedule/publish a post or create an agent targeting that foreign channel — a cross-org write (IDOR) through the chat interface.
Recommended fix: Before each `targets`/`channelIds` write, validate ownership against `ctx.organizationId` and throw `FORBIDDEN` on mismatch. Copy the block from `post.router.ts:55-69` into all four cases.

**3. Super Agent — `publish_now` auto-executes with no confirmation**
Surface: Super Agent.
Evidence: `apps/web/app/dashboard/super-agent/page.tsx:250` — `if (event.action?.type === "publish_now") executeAction(event.action);` fires immediately on stream completion, vs. lines 482-501 which render an explicit **Execute** button for all other action types.
User experience: Saying "create a post about the sale and publish it now" pushes live content to the connected channels instantly — no review step, no warning, no cancel. The asymmetry with every other action makes this surprising and irreversible.
Recommended fix: Remove the auto-execute on line 250; let `publish_now` render the same Execute button, ideally with a "This will publish immediately to [channels]" warning banner.

**4. Repurpose & Bulk dashboard cards route to the wrong tab via `?expanded=` (merged: `repurpose-card-routing-bug`, `bulk-create-routing-bug`, `broken-dashboard-cards-expanded-param`)**
Surface: Dashboard → Content Studio.
Evidence: `apps/web/app/dashboard/page.tsx:66` emits `/dashboard/content-agent?expanded=repurpose`; `:319` emits `?expanded=bulk`. The destination `apps/web/app/dashboard/content-agent/page.tsx:35` reads only `searchParams.get("tab")` (verified: `tabs` = `[compose, create, repurpose, bulk]` at lines 22-27). No code anywhere reads `expanded`.
User experience: Clicking "Repurpose Content" or "Bulk Create" silently lands the user on the Compose tab. They must notice and manually click the right tab. This is your reported bug, confirmed — and it affects two cards, not one.
Recommended fix: Change the two hrefs to `?tab=repurpose` and `?tab=bulk` (preferred — one-line each). Or make line 35 fall back: `searchParams.get("tab") || searchParams.get("expanded") || "compose"`.

**5. `/dashboard/ai` redirects to a non-existent `?tab=generate`**
Surface: Content Studio.
Evidence: `apps/web/app/dashboard/ai/page.tsx:4` — `redirect("/dashboard/content-agent?tab=generate")`. Valid tab IDs are `[compose, create, repurpose, bulk]` (`content-agent/page.tsx:22-27`); `generate` matches none.
User experience: Anyone navigating to `/dashboard/ai` lands on the default Compose tab instead of AI Create.
Recommended fix: Change the redirect to `?tab=create`.

**6. `/dashboard/image-studio` redirects to a non-existent `?tab=image`**
Surface: Content Studio.
Evidence: `apps/web/app/dashboard/image-studio/page.tsx:4` redirects to `?tab=image`; there is no `image` top-level tab. Image generation is a nested sub-view under the `create` tab (`content-agent/page.tsx:74-92`).
User experience: Navigating to `/dashboard/image-studio` silently falls back to Compose.
Recommended fix: Redirect to `?tab=create`. If you want the image sub-view pre-selected, introduce `?tab=create&subTab=image` and have `content-agent/page.tsx` read `subTab`.

**7. Analytics date picker shifts the range by the local timezone offset (off-by-one-day)**
Surface: Analytics.
Evidence: `apps/web/app/dashboard/analytics/page.tsx:85-97` — `new Date(e.target.value).toISOString()` on the `<input type="date">` value; in a browser this parses `YYYY-MM-DD` as **local** midnight. `analytics.router.ts:227-230` then calls `from.setHours(0,…)`/`to.setHours(23,…)` (local, not UTC), compounding the shift. Note: `postsOverTime` (lines 259-265) correctly uses `setUTCHours`/`setUTCDate` — the fix exists in the codebase but wasn't applied to overview/engagement/perChannelStats.
User experience: For a user in India (UTC+5:30), selecting `2026-06-06` actually queries from `2026-06-05T18:30:00Z`, so today's posts drop out / yesterday's leak in. Silent — the user just sees subtly wrong numbers. Affects every non-UTC user, including you.
Recommended fix: Build the range in UTC on the frontend (e.g., `new Date(value + "T00:00:00Z")`) and switch the backend normalization to `setUTCHours`, matching the `postsOverTime` query.

### MEDIUM

**8. Super Agent chat — no media upload affordance**
Surface: Super Agent.
Evidence: `apps/web/app/dashboard/super-agent/page.tsx:199` calls `sendMessageMutation.mutateAsync({ threadId, content })` — never passes `attachmentMediaIds`. The input bar (lines 541-565) is text-only: no file input, no drag-drop. The backend already accepts and persists `attachmentMediaIds` (`chat.router.ts:125, 142-148`); the UI never populates it.
User experience: The chat advertises "Create images & carousels," but a user cannot attach an existing image/video — only AI-generated images via `generate_news_image` are possible. Telling the agent "attach this image" has no mechanism behind it. (This appears intentional — generation-focused — but it's a real capability gap.)
Recommended fix: Add a file input/drag-drop to the chat input area, call `/api/upload`, collect `mediaIds`, and pass them as `attachmentMediaIds`; show thumbnails above the input.

**9. `/dashboard/posts` and `/dashboard/calendar` deep-link to non-existent tabs**
Surface: Content Studio.
Evidence: `apps/web/app/dashboard/posts/page.tsx:10` → `?tab=posts`; `calendar/page.tsx:10` → `?tab=calendar`. Neither is in the `tabs` array. Posts/Calendar are not tabs — they're rendered via the `showCalendar` boolean toggle (`content-agent/page.tsx:105-131`), which the URL never controls.
User experience: Visiting these legacy URLs lands on Compose; the intended posts/calendar view is not auto-shown.
Recommended fix: Redirect to `/dashboard/content-agent` and pass a state flag (e.g., `?view=posts` / `?view=calendar`) that the page reads to set `showCalendar`.

**10. Super Agent stream parser silently swallows all JSON errors**
Surface: Super Agent.
Evidence: `apps/web/app/dashboard/super-agent/page.tsx:233-258` — per-line `try { JSON.parse(...) } catch {}` with an empty catch. The outer try/catch (line 261) only covers fetch/reader errors, not per-line parse failures.
User experience: If a malformed SSE event arrives, the chunk is dropped with no log, toast, or recovery — the user sees the stream freeze or end silently, unaware data was lost.
Recommended fix: `catch (e) { console.error("[super-agent] dropped SSE event", e); }` and optionally surface a warning toast.

**11. Super Agent `executeAction` payloads are untyped `any` with no runtime validation**
Surface: Super Agent.
Evidence: Input schema `chat.router.ts:189` is `z.record(z.unknown())`; every action casts `const p = input.payload as any` (lines 202, 243, 249, 281, 327, 377, 396, 469, 494, 523, 548, 573, 600). Required fields (e.g. `content` at lines 255/295/335) are read with no presence check.
User experience: An AI-emitted action missing required fields produces an opaque Prisma-layer error instead of a clean API-boundary rejection.
Recommended fix: Define a Zod discriminated union of payload schemas keyed on `actionType`; validate before processing.

**12. `perChannelStats` raw SQL silently drops rows with NULL `publishedAt`**
Surface: Analytics.
Evidence: `analytics.router.ts:317-318` (and the postCount sub-query at 287-293) use strict `p."publishedAt" >= $2 AND <= $3`. In SQL, comparisons with NULL yield NULL (falsy), so PUBLISHED-but-null-`publishedAt` posts are excluded. `publishedAt` is nullable in the schema. `postsOverTime` (lines 238-241) handles this with an explicit OR/null-fallback; perChannelStats does not.
User experience: Posts marked PUBLISHED but missing a `publishedAt` timestamp (lagged sync, failed capture) vanish from per-channel metrics, understating engagement.
Recommended fix: Apply the same NULL-fallback pattern used in `postsOverTime` (fall back to `updatedAt`), or explicitly document the exclusion.

**13. Analytics "Sync Now" uses a fixed 8-second timeout → stale data on slow syncs**
Surface: Analytics.
Evidence: `apps/web/app/dashboard/analytics/page.tsx:111-121` invalidates the cache after a hardcoded `setTimeout(…, 8000)`. The worker runs jobs async with `concurrency: 2` (`apps/worker/src/workers/analytics-sync.worker.ts:62`); on rate-limiting/latency a job can exceed 8s, and on failure (`getPostAnalytics` throws/returns null, lines 27-31) it returns silently with no surfacing.
User experience: Clicking "Sync Now" refetches before the worker finishes; the page shows old numbers with no indication the sync is still in flight. _(Confidence: likely — the source JSON was truncated mid-repro for this item.)_
Recommended fix: Replace the fixed timeout with job-completion polling (or push/SSE), and surface per-job sync errors.

**14. Super Agent `get_analytics` returns only post counts, not engagement metrics**
Surface: Analytics / Super Agent.
Evidence: `chat.router.ts:599-625` returns `{ totalPosts, published, scheduled, channels }`. The dashboard (`analytics/page.tsx:124`) additionally queries `analytics.engagement` (`analytics.router.ts:41-119`: impressions, likes, comments, shares, reach, engagementRate). The agent never calls it.
User experience: "Show me my analytics" in chat returns a bare post-count summary; the dashboard shows far richer data. The two sources diverge.
Recommended fix: Have `get_analytics` also call the `engagement` aggregation and include those metrics in the response.

**15. Media editor (Fabric.js) is image-only — cannot edit or save video**
Surface: Media.
Evidence: `apps/web/components/media-editor/panels/UploadsPanel.tsx:15` hardcodes `type: 'image'`, `:56` `accept='image/*'`, lines 17-35 use `FabricImage` only. Backend storage supports video (`media.router.ts:11-19`), and videos can be picked from the library and attached raw (`media-picker-dialog.tsx:146-174`).
User experience: Users can upload/attach videos to posts, but cannot composite or edit them in the design tool — an architectural limit of Fabric.js, not a regression.
Recommended fix: Acceptable as-is; if video editing is desired it requires a different editor. Otherwise document the design tool as image-only.

**16. Brand Leads / Brand Outreach label mismatch**
Surface: Dashboard.
Evidence: dashboard card `page.tsx:117` = "Brand Leads"; sidebar `sidebar.tsx:66` = "Brand Outreach"; page header `brand-leads/page.tsx:433` = "Brand Outreach". (Sidebar comment at line 65, "Fix #62", aligned sidebar↔header but missed the card.)
User experience: The same feature has two names; mild confusion about whether they're the same thing.
Recommended fix: Change `dashboard/page.tsx:117` to "Brand Outreach".

**17. S3 credential fallback-to-empty-string with no pre-flight validation**
Surface: Media.
Evidence: `apps/web/app/api/upload/route.ts:96-97` and `packages/api/src/lib/s3.ts:14-15` resolve `S3_ACCESS_KEY_ID || S3_ACCESS_KEY || ''` (and secret equivalent). `apps/web/app/api/upload/avatar/route.ts:39-40` uses the same fallback but has no try/catch around `s3.send()`. CLAUDE.md:101 confirms: "production .env.prod must have at least one of each pair set or uploads will fail silently."
User experience: If both credential names are unset, uploads fail with a generic 502 (or unhandled rejection on the avatar route) rather than a clear config error.
Recommended fix: Add a startup/pre-flight check that at least one key per pair is non-empty; wrap `s3.send()` in the avatar route with the same try/catch the main upload route already has.

### LOW

**18. Social Listening / "Listening" label inconsistency**
Surface: Dashboard.
Evidence: dashboard card `page.tsx:97` = "Social Listening"; sidebar `sidebar.tsx:63` = "Listening"; page header `listening/page.tsx:174` = "Social Listening".
User experience: Minor naming inconsistency; no functional impact.
Recommended fix: Set `sidebar.tsx:63` to "Social Listening".

**19. Analytics empty state conflates "no channels" with "no data synced"**
Surface: Analytics.
Evidence: `analytics/page.tsx:425-439` renders "No active channels found" whenever `channelStats.length === 0`. (Verifier nuance: the backend actually returns all active channels with zeroed metrics, so channels-with-no-data show as zero rows rather than the empty state; the true gap is that nothing distinguishes "no engagement synced" / "permission pending" from genuinely zero data.)
User experience: A user with Facebook channels pending Advanced Access sees zero-filled rows (or, if zero channels, a "connect channels" CTA) with no explanation that engagement sync is blocked on permissions.
Recommended fix: Add messaging for "channels connected but no engagement data yet / Advanced Access pending" distinct from "no channels connected."

### INFO (verified working — do not touch)

- **Repurpose PR #44/#45 invariants are correctly implemented.** `dalle.provider.ts:20` uses `gpt-image-1`; `seedance.provider.ts:23` uses `bytedance/seedance-2.0/text-to-video` and polls the returned `status_url`/`response_url` (lines 137-147); `repurpose.router.ts:95-102` gates AI video with `requirePlan(..., ctx.isSuperAdmin)`; `mediaFailed` is set/returned honestly (lines 1041, 1067).
- **ComposeTab post-creation flow is fully wired** — upload/library/AI-image/external-URL media paths, channel selection, schedule/publish, success redirect to `/dashboard/posts/{postId}` (`ComposeTab.tsx:218, 232, 442-477, 504-532`).
- **BulkTab fully wired** — `bulk.bulkSchedule`, `bulk.csvImport`, `bulk.csvExport` all backed by `bulk.router.ts`.
- **GenerateTab → ComposeTab via sessionStorage (Fix #24)** — avoids URL-length truncation (`GenerateTab.tsx:25,46`; `ComposeTab.tsx:57,91-95`).
- **Media upload works end-to-end for images AND video** — single-shot ≤8MB (500MB video cap) + multipart up to 5GB; nginx `/postautomation-media/` block preserves path + `Host` for SigV4, CORS/ETag set, 8MB threshold consistent across code (`upload-multipart.ts:48`, `ComposeTab.tsx:446`).
- **Media library + picker dialog feature-complete** — infinite scroll, search, type filter, lightbox with video controls, delete, org-scoped via `orgProcedure` (`media/page.tsx`, `media-picker-dialog.tsx`, `media.router.ts:32`).

---

## Per-Surface Verdict

**Super Agent — PARTIALLY WORKS (functionally yes, securely no).**
It does generate posts end-to-end (compose/schedule/bulk/publish/AI-image via `executeAction`). But it ships with the CRITICAL plan bypass (#1), HIGH cross-org IDOR (#2), and HIGH no-confirmation publish (#3). Works correctly: action streaming, the Execute-button confirmation UX for non-publish actions, and the backend persistence of agents/posts/threads. Not safe for paid/multi-tenant production until #1–#3 are fixed.

**Dashboard — PARTIALLY WORKS.**
Tiles and layout render fine, but the two headline feature cards (Repurpose, Bulk Create) route to the wrong tab (#4), and two labels are inconsistent (#16, #18). Works correctly: the card grid, accent styling, and the Compose card (which correctly lands on Compose).

**Content Studio — PARTIALLY WORKS.**
The tabs themselves and their backends are all solid (Compose, AI Create, Repurpose, Bulk all fully wired; Repurpose fixes verified). What's broken is _navigation into_ them: `?expanded=` cards (#4), `/dashboard/ai` → `?tab=generate` (#5), `/dashboard/image-studio` → `?tab=image` (#6), and legacy `/dashboard/posts` & `/dashboard/calendar` deep-links (#9). All are URL-param mismatches, not feature failures — users can reach everything manually.

**Media — WORKS.**
Upload (image + video, dual-path), library, picker, and compose attachment are all fully implemented and org-scoped — directly answering "shouldn't there be a way to upload videos/media — does it exist?": **yes, it exists and works.** Caveats are minor: the design editor is image-only (#15), the Super Agent chat lacks an upload affordance (#8), and S3 credentials lack pre-flight validation (#17).

**Analytics — PARTIALLY WORKS.**
The dashboard renders and the engagement aggregation is real, but the timezone off-by-one (#7) silently corrupts the date range for all non-UTC users, `perChannelStats` drops null-`publishedAt` rows (#12), Sync Now races an 8s timeout (#13), the agent's `get_analytics` is impoverished (#14), and empty states are ambiguous (#19). Works correctly: `postsOverTime` (already UTC-correct), the engagement SQL aggregation, and org-scoping.

---

## Quick-Win Fix List

A checklist an engineer can knock out fast — all high-certainty, mostly one-line:

- [ ] `apps/web/app/dashboard/page.tsx:66` — change `?expanded=repurpose` → `?tab=repurpose`.
- [ ] `apps/web/app/dashboard/page.tsx:319` — change `?expanded=bulk` → `?tab=bulk`.
- [ ] `apps/web/app/dashboard/ai/page.tsx:4` — change `?tab=generate` → `?tab=create`.
- [ ] `apps/web/app/dashboard/image-studio/page.tsx:4` — change `?tab=image` → `?tab=create` (add `subTab=image` handling if the nested view should auto-open).
- [ ] `apps/web/app/dashboard/page.tsx:117` — change card title `"Brand Leads"` → `"Brand Outreach"`.
- [ ] `apps/web/components/layout/sidebar.tsx:63` — change `"Listening"` → `"Social Listening"`.
- [ ] `apps/web/app/dashboard/super-agent/page.tsx:250` — remove the `publish_now` auto-execute; let it render the Execute button like other actions (#3).
- [ ] `apps/web/app/dashboard/super-agent/page.tsx:258` — replace bare `catch {}` with `catch (e) { console.error(e); }` (#10).
- [ ] _(Optional belt-and-suspenders for all routing bugs at once)_ `apps/web/app/dashboard/content-agent/page.tsx:35` — `searchParams.get("tab") || searchParams.get("expanded") || "compose"`.

The CRITICAL/HIGH security items (#1 plan gating, #2 IDOR) and the analytics timezone fix (#7) are NOT quick wins — they need real code and testing — but they are the highest-priority work.

---

## Refuted / Non-Issues

The supplied dataset contained no explicit "refuted" array (and the JSON was truncated at the final analytics finding), so this list reflects claims that were **investigated and confirmed to be working correctly** — listed here so you don't chase them as bugs:

- **Repurpose AI media pipeline is NOT broken.** The `gpt-image-1` fallback, Seedance 2.0 model ID, fal.ai poll-URL handling, superadmin video gate, and honest `mediaFailed` flag are all correctly implemented (PR #44/#45 verified in code). The only remaining repurpose limitation — native Veo3/Gemini images 403'ing — is the **Google Cloud billing hold on project 518560861182**, not a code bug.
- **Media upload does NOT need to be added — it already exists** (images + video, single-shot and multipart, library, picker, compose attachment). The user's "shouldn't there be a way to upload media?" concern is answered: it's there and working.
- **The `?expanded` parameter is the only routing problem on the Repurpose card — the Repurpose tab itself works** once reached.
- **GenerateTab → Compose content handoff is NOT broken** — it intentionally uses `sessionStorage` (Fix #24) to dodge URL-length limits.
- **`postsOverTime` analytics query is NOT affected by the timezone/null bugs** — it already uses UTC handling and explicit NULL fallback correctly; only overview/engagement/perChannelStats need the same treatment.

_Note: one finding (#13, Sync Now race) had its source record truncated mid-reproduction in the input data; its code citations are intact and verified, but the exact end-state repro is reconstructed — flagged as "likely" rather than "certain."_

---

## Resolution (branch `fix/audit-2026-06-06`, 2026-06-06)

All actioned fixes were implemented, type-checked, unit-tested (465 passing incl. 13 new), built (`next build` clean), and **verified end-to-end in the running app via Playwright** (login → each surface, DOM + screenshots).

| Finding | Fix | Commit |
|---|---|---|
| #1 Super Agent zero plan gating (CRITICAL) | `requirePlan`/`enforcePlanLimit` on every `executeAction` case, `isSuperAdmin` passthrough | `c8aed57` |
| #2 Super Agent channel IDOR (HIGH) | `assertChannelsOwned()` on create_agent/schedule/bulk/publish | `c8aed57` |
| #3 publish_now auto-fires (HIGH) | removed auto-execute; explicit "Publish now" button + warning | `75ea11a` |
| #4 Repurpose/Bulk cards `?expanded=` (HIGH) | cards → `?tab=repurpose`/`?tab=bulk`; page accepts `?expanded=` fallback | `1b89c22` |
| #5 `/dashboard/ai` → `?tab=generate` (HIGH) | → `?tab=create` | `1b89c22` |
| #6 `/dashboard/image-studio` → `?tab=image` (HIGH) | → `?tab=create&subTab=image` (+ subTab reader) | `1b89c22` |
| #7 Analytics timezone off-by-one (HIGH) | date picker builds UTC ISO; range is UTC | `70adf05` |
| #8 No media affordance in Super Agent (MED) | paperclip upload + Media Library picker + thumbnails | `75ea11a` |
| #9 `/posts` `/calendar` legacy deep-links (MED) | → `?view=posts`/`?view=calendar` (+ view reader) | `1b89c22` |
| #10 SSE silent swallow (MED) | logs dropped events | `75ea11a` |
| #12 perChannelStats NULL publishedAt (MED) | `COALESCE(publishedAt, updatedAt)` | `70adf05` |
| #14 get_analytics impoverished (MED) | now includes engagement from `AnalyticsSnapshot` (matches dashboard) | `70adf05` |
| #16 Brand Leads/Outreach label (MED) | card → "Brand Outreach" | `1b89c22` |
| #18 Listening label (LOW) | sidebar → "Social Listening" | `1b89c22` |
| #19 Ambiguous empty state (LOW) | "connected but no data synced yet" banner | `70adf05` |
| (addendum) show available channels + agent clarity | welcome header lists connected channels + plain-English capabilities | `75ea11a` |
| (clarity) layman descriptions + empty states | dashboard cards, Content Studio per-tab helper, Analytics/Media headers | `1b89c22`, `70adf05` |

**Deferred (by design / low value, not fixed):** #11 untyped `executeAction` payloads (loose `any`; functional), #13 Sync Now 8s-timeout race (cosmetic staleness), #15 media editor image-only (Fabric.js limitation), #17 S3 pre-flight validation (already surfaces a 502). None block the modules from working as intended.