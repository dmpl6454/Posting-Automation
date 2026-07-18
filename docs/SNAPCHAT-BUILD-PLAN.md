# Snapchat Channel — Definitive End-to-End Build Plan (verification-passed)

**Prepared:** 2026-07-18 · **Method:** 6 parallel agents traced the real codebase → 1 synthesis → 1 adversarial verify pass. This document has the verify pass's **blocker + major + minor fixes folded in** (raw plan verdict was `needs-fixes`; corrected here).

Adds Snapchat as a first-class channel to PostAutomation: **auto-posting** (Stories/Spotlight/Saved Stories) AND **read insights** (Public Profile API). Built exactly like YouTube/Meta. Every step cites the real `file:line` it mirrors. Snap-specific endpoints/scopes are marked **`CONFIRM`** — verify them live against developers.snap.com at build time (see OPEN QUESTIONS); do NOT ship memorized values.

> **⚠️ Companion doc:** [SNAPCHAT-INTEGRATION-PLAN.md](SNAPCHAT-INTEGRATION-PLAN.md) covers the Snap-side bureaucracy (OAuth app creation, allowlist emails, account hygiene). THIS doc is the code build. Do the Snap-side app + emails first; you need a real token for Gate-3 (Phase 9).

---

## Architectural verdict up front (from the trace)

- Snapchat is **OAuth 2.0 (+ PKCE, CONFIRM)** → rides the **generic single-account path** in the callback route (`route.ts:439-482`) — **no special branch** like FB/IG/LinkedIn/Twitter.
- The **single hardest requirement** is authoring `SnapchatProvider` + registering it in `providerMap` (`social.factory.ts:21-39`). Once the provider exists + `SNAPCHAT` is in the enum + `getDefaultScopes` has a key, `getOAuthUrl` / `platformAuthInfo` / analytics-sync worker / at-age checkpoints / Reports all light up **with zero further code changes** (platform-agnostic).
- **The feasibility-guide's link-analytics layer does NOT exist in this repo.** `canonicalKey()`, `SUPPORTED_INSIGHT_PLATFORMS`, the `/t/→/p/` resolver, `link_content`/`link_metrics`, the "Facebook `/share/` resolver", coverage CTEs — **grep-confirmed zero hits.** They belong to a different (digitalsukoon) backend. Insights here are flat per-post counters keyed by `platformPostId`. **Do not hunt for them to mirror.** See Phase 7.

---

## PHASE 1 — Database: add `SNAPCHAT` to `enum SocialPlatform`

**1.1 — Edit the Prisma enum** · `packages/db/prisma/schema.prisma` (enum at 252-270)
Add `SNAPCHAT` inside `enum SocialPlatform { … }` (near `PINTEREST`/`THREADS`; order not significant). Mirrors the 17 existing values.
- **Gotcha:** Postgres enum → non-destructive `ALTER TYPE … ADD VALUE`. Hard prerequisite: `readonly platform: SocialPlatform = "SNAPCHAT"` won't type-check, and `SNAPCHAT:` can't be a `providerMap` key, until the generated `@postautomation/db` type includes it. The `input.platform as any` casts in `channel.router.ts` **mask the gap** — forgetting this fails at the DB write (invalid-enum), not at compile.

**1.2 — Push (NOT a migration file)** · `pnpm db:push`
Repo convention for ordinary schema changes (`package.json`, CLAUDE.md). `migrations/` holds only two hand-written special cases — do NOT author one here.
- **Deploy note (CLAUDE.md quirk #2):** prod `migrate` container bakes in `schema.prisma`; the enum propagates on `bash scripts/deploy.sh deploy` **only if migrate rebuilds** — verify `docker inspect postautomation-migrate:latest --format='{{.Created}}'` vs web.
- Run `pnpm --filter @postautomation/db exec prisma generate` if push doesn't auto-regenerate, so the TS type refreshes before the provider compiles.

---

## PHASE 2 — Environment variables

No central env schema/zod validator exists (confirmed: no `env.mjs`/`createEnv`). Vars are read by string-key convention `${PLATFORM_UPPER}_CLIENT_ID` / `_CLIENT_SECRET`. Only names needed: **`SNAPCHAT_CLIENT_ID`**, **`SNAPCHAT_CLIENT_SECRET`** — no code registration; they work once set.

**2.1** · `.env.example` (near 21-38) → add `SNAPCHAT_CLIENT_ID=""` / `SNAPCHAT_CLIENT_SECRET=""` (quoted-empty style).
**2.2** · `.env.production.example` (near 31-46) → add `SNAPCHAT_CLIENT_ID=` / `SNAPCHAT_CLIENT_SECRET=` (unquoted prod style).
**2.3** · Set real values in the server's `.env.prod` (untracked; **never hand-edit tracked files on the server** — CLAUDE.md quirk #9).
- **Gotcha:** missing either → `getOAuthUrl` throws `BAD_REQUEST "Snapchat is not configured…"` (`channel.router.ts:180-185`) and `platformAuthInfo` shows "Setup required" (`configured = Boolean(clientId && clientSecret)`, `channel.router.ts:117`). Read is derived (`${prefix}_CLIENT_ID`) — a typo silently yields "not configured."

---

## PHASE 3 — Provider: `packages/social/src/providers/snapchat.provider.ts` (NEW)

Model **method-for-method on `youtube.provider.ts`**. Imports from `../abstract/social.abstract` (`SocialProvider`) + `../abstract/social.types` (the types), mirroring `youtube.provider.ts:1-10`.

### 3.0 — Class + fields (mirror `youtube.provider.ts:85-93`)
```ts
export class SnapchatProvider extends SocialProvider {
  readonly platform: SocialPlatform = "SNAPCHAT";   // needs Phase 1 done first
  readonly displayName = "Snapchat";
  readonly constraints: PlatformConstraints = {
    maxContentLength: /* CONFIRM caption cap */ 250,
    supportedMediaTypes: ["video/mp4", "image/jpeg", "image/png"], // CONFIRM per surface
    maxMediaCount: 1,
    maxMediaSize: /* CONFIRM */ 300 * 1024 * 1024,
    supportsScheduling: false,
  };
```

### 3.1 — `getOAuthUrl(config, state): string` (mirror `youtube.provider.ts:95-106`)
`URLSearchParams` with `client_id`, `redirect_uri=config.callbackUrl`, `response_type="code"`, `scope=config.scopes.join(" ")` **(SPACE-joined — Snap is space-delimited like Google; do NOT comma-join, that's Meta-only)**, `state`, plus a **consent-forcing param** (Google's `prompt="consent"` equivalent — **CONFIRM** Snap's) so a reconnect re-mints the refresh token.
- Endpoint: **CONFIRM** Snap authorize URL.
- Do **NOT** add `auth_type=rerequest` (Meta-only).
- **PKCE:** append `code_challenge` + `code_challenge_method="S256"` — but the challenge value must be **plumbed in via Phase 5.3 (see the BLOCKER-FIX box below); it cannot be conjured inside this method.**
- **Load-bearing gotcha:** dropping the consent param → reconnect may return no `refresh_token` → channel dies on next expiry (the YouTube `invalid_grant`-class quirk).

> ### 🔴 BLOCKER-FIX — PKCE plumbing is a REQUIRED interface change, not an aside
> **Verified against real code:** `OAuthConfig` (`social.types.ts:34-39`) has ONLY `{clientId, clientSecret, callbackUrl, scopes}` — **no `codeChallenge`**. `getOAuthUrl` (abstract `social.abstract.ts:18`) takes **exactly 2 params** `(config, state)`. So the challenge has **no channel to reach the URL builder** without an explicit change. If Snap requires PKCE (OPEN QUESTION #3), you MUST:
> 1. Add `codeChallenge?: string` to `OAuthConfig` in `packages/social/src/abstract/social.types.ts`.
> 2. In `channel.router.ts getOAuthUrl`: generate the verifier, derive the S256 challenge, put it on `config.codeChallenge`, **and sign the verifier** via `signState({ organizationId, userId, codeVerifier })` — note the current call signs with **NO verifier** (trace: `channel.router.ts:170-173`).
> 3. `SnapchatProvider.getOAuthUrl` reads `config.codeChallenge`.
> Only then does the already-present callback passthrough work end-to-end: `route.ts:172` destructures `codeVerifier` from `verifyState`, `route.ts:205` passes it to `exchangeCodeForTokens`. (`signState`/`verifyState` **already carry** an optional `codeVerifier` — `oauth-helper.ts:30,36-46` — so those don't need extending; only the 3 steps above.) **If Snap does NOT require PKCE → delete all of this.**

### 3.2 — `exchangeCodeForTokens(code, config, codeVerifier?): Promise<OAuthTokens>` (mirror `youtube.provider.ts:108-130`)
`POST`, header `Content-Type: application/x-www-form-urlencoded`, body `URLSearchParams({ grant_type:"authorization_code", code, client_id, client_secret, redirect_uri: config.callbackUrl })`. `!res.ok` → `throw new Error("Snapchat token exchange failed: " + text)`. Return `{ accessToken, refreshToken, expiresAt: new Date(Date.now()+expires_in*1000), scopes: data.scope?.split(" ") }`.
- Token endpoint: **CONFIRM**.
- **Add `code_verifier: codeVerifier`** to the form body (PKCE). The third param is defined by the **abstract signature** (`social.abstract.ts:19` — `exchangeCodeForTokens(code, config, codeVerifier?)`), NOT inherited from YouTube (YouTube's is 2-param `(code, config)` — minor attribution fix).
- If posting needs a Snap `public_profile_id`/`organization_id`, capture it here and carry via **`tokens.metadata`** — the generic callback persists `tokens.metadata` (`route.ts:441`, WordPress pattern). **CONFIRM.**
- **Gotcha:** body MUST be form-urlencoded (not JSON). The `"Snapchat token exchange failed"` prefix is asserted verbatim in tests (Phase 10).

### 3.3 — `refreshAccessToken(refreshToken, config): Promise<OAuthTokens>` (mirror `youtube.provider.ts:132-152`)
Same token endpoint, form-urlencoded, `grant_type="refresh_token"` + `client_id`/`client_secret`/`refresh_token`, NO `redirect_uri`, NO `code`. Recompute `expiresAt` from `expires_in`. Real refresh (unlike Twitter's throw).
- **CRITICAL DIVERGENCE from YouTube:** YouTube reuses the incoming `refreshToken` and ignores `data.refresh_token` (Google-specific). **Snapchat may ROTATE.** Use `refreshToken: data.refresh_token ?? refreshToken` — else you persist a stale token and the channel dies. **CONFIRM** rotation behavior.

### 3.4 — `getProfile(tokens): Promise<SocialProfile>` (mirror `youtube.provider.ts:199-220`)
`GET` with `Authorization: Bearer <accessToken>`, read the account, throw if none, return `{ id, name, username?, avatar? }`, `@`-strip username via `.replace(/^@+/, "")`. `profile.id` → channel `platformId` + upsert key.
- Endpoint: **CONFIRM** Snap `/me`-style URL + field names.
- **Gotcha (the IG-bug lesson):** `getProfile` **IS called for Snapchat** (`route.ts:219-222` — only INSTAGRAM is skipped). It **MUST NOT throw for a validly-authed user** or you get a mislabeled `oauth_failed` toast (the 2026-07-17 IG bug). For a "no eligible profile" state use the return-`[]`/clean-guard pattern (Phase 6), not an unguarded throw.

### 3.5 — `publishPost(tokens, payload): Promise<SocialPostResult>` — POSTING TRACK
Mirror the dispatch/type-gate/multi-step-upload shape of `youtube.provider.ts:154-173` (gate), `256-262` (read `payload.metadata`), `254-373` (download → init → send bytes → build URL).
1. **Media-type gate** (mirror `youtube.provider.ts:158-171`): read `payload.mediaTypes?.[0]`. **Spotlight = video only** (`startsWith("video/")` else throw "Snapchat Spotlight requires a video file"); **Story/Saved Story = image or video**. Choose surface from `metadata`. Throw a clear message on mismatch.
2. **Read options from `payload.metadata`** (mirror `youtube.provider.ts:256-262`): `surface = metadata.snapSurface ∈ SPOTLIGHT|STORY|SAVED_STORY` (default **CONFIRM**), `caption`, `privacyLevel` (**CONFIRM** values), `onProgress = payload.onProgress`.
3. **Multi-step upload** (mirror `youtube.provider.ts:264-360`): download bytes (`fetch(mediaUrl)` → `Buffer.from(await res.arrayBuffer())`), then Snap's flow (**CONFIRM each endpoint**): (a) init/register upload, (b) PUT/POST bytes (chunk if required; drive `onProgress?.(pct)` on a 5→10 download / 10→95 upload / 100 ramp), (c) create creative/Story/Spotlight, (d) publish.
4. **Result** (mirror `youtube.provider.ts:361-373`): `{ platformPostId, url: /* CONFIRM canonical shape */, metadata: <full response> }`.
- **Gotcha 1:** parse the id defensively (YouTube recovers it from the `Location` header on empty 2xx body) — don't assume `finalData.id`.
- **Gotcha 2 (WEB vs WORKER):** `publishPost` runs in the **worker** (no HTTP) so sync helpers are tolerable (YouTube uses `execFileSync('ffprobe')`). **BUT** per CLAUDE.md edge-reliability, any Snapchat code reachable from the **web** process (`packages/api`/`apps/web`) MUST use async `execFile` (argv array) — never `execSync`/`execFileSync`/`spawnSync`. Keep sync probing worker-only.

### 3.6 — `deletePost(tokens, platformPostId): Promise<void>` (mirror `youtube.provider.ts:175-197`)
DELETE, success on 2xx. If Snap has no programmatic delete for the surface (Spotlight/Story often don't — the TikTok case), **throw a clear "Snapchat does not support programmatic deletion" error**. The abstract requires the method to exist. **CONFIRM.**

### 3.7 — `getPostAnalytics(tokens, platformPostId): Promise<SocialAnalytics | null>` — INSIGHTS TRACK (mirror `youtube.provider.ts:222-252`)
GET the Public Profile Insights endpoint (`businessapi.snapchat.com/public/v1/...` — **CONFIRM path**) with Bearer. Map into `SocialAnalytics` (`social.types.ts:16-24`): `impressions`=views, `reach`=views (or distinct if available), `shares`=shares||0, **`likes`=0 for non-opted-in public-tier creators** (guide fact — a correct 0, not a bug), `clicks`/`comments`=0 unless surfaced, `engagementRate = views>0 ? (likes+shares+comments)/views : 0`.
- **Convention (corrected framing):** **return `null`, do NOT throw.** Returning null is the right convention (matches the abstract default + other providers). *Correction from the raw plan:* the worker **already wraps the call in try/catch** (`analytics-sync.worker.ts:26-29` — a throw is caught, logged, and skips one snapshot), so a throw does NOT break the 6-hourly sync — it just degrades one snapshot. Return null anyway for cleanliness; the "would break sync" claim was overstated.
- **Allowlist gate:** the Public Profile API is allowlist-only and its returnable fields are **UNKNOWN until Gate-3 (Phase 9).** Until then, either return `null` for Snapchat OR exclude it from the sync predicate (Phase 7.4) so you don't hit a not-yet-approved endpoint.

---

## PHASE 4 — Factory registration

**4.1** · `packages/social/src/abstract/social.factory.ts` (1-56): (a) `import { SnapchatProvider } from "../providers/snapchat.provider";` after line 19; (b) add `SNAPCHAT: SnapchatProvider,` to `providerMap` (21-39). Mirrors `YOUTUBE: YouTubeProvider,` (line 27).
- **Why it's THE gate:** `getSupportedPlatforms()` = `Object.keys(providerMap)` (54-55). Until registered, Snapchat is invisible to `platformAuthInfo` AND `getSocialProvider("SNAPCHAT")` throws `No provider registered for platform: SNAPCHAT` (line 47) — **exact string**, matters only if a test asserts it.

**4.2** · `packages/social/src/index.ts` barrel export — only if a caller imports `SnapchatProvider` by name (the callback uses `getSocialProvider`, so not strictly needed).

---

## PHASE 5 — `channel.router.ts` wiring

**5.1 — `getDefaultScopes` SNAPCHAT entry (REQUIRED)** · `channel.router.ts` (`getDefaultScopes` 466-497, `scopeMap` Record with `|| []` fallback)
Add a `SNAPCHAT:` key in `scopeMap` (near `WORDPRESS` ~494):
```ts
// POSTING (Creative/Content Kit) + INSIGHTS (Public Profile API, read-only).
// Space-joined in getOAuthUrl. CONFIRM exact strings at build time.
SNAPCHAT: [
  /* CONFIRM */ "…user.display_name",
  /* CONFIRM posting */ "…",
  /* CONFIRM insights */ "…",
],
```
- **Gotcha:** `scopeMap` has a `|| []` fallback (line 496) — **NOT exhaustive, no compiler error** if forgotten → silent `scope=""` in the authorize URL (the exact TikTok failure the code comments warn about). You MUST add it.

**5.2 — `getOAuthUrl` mutation lights up automatically (no edit)** · verified `135-201`: resolves `getSocialProvider(input.platform as any)` (141), reads env `${platform.toUpperCase()}_CLIENT_ID/_SECRET` (175-177), builds `callbackUrl = ${APP_URL}/api/oauth/callback/${platform.toLowerCase()}` (190 → `/api/oauth/callback/snapchat`), `scopes: getDefaultScopes(...)` (191). Org-membership gate (157-168, no superadmin carve-out) + `signState` (170-173) unchanged — **except the PKCE additions in 5.3.**

**5.3 — PKCE plumbing (REQUIRED for Snap — see the BLOCKER-FIX in 3.1)** · `getOAuthUrl` mutation (~170-195)
Generate `codeVerifier` (43–128 char random), derive S256 `codeChallenge`, set `config.codeChallenge` (needs the `OAuthConfig` field added), and **change the sign call to `signState({ organizationId, userId, codeVerifier })`** (currently signs with no verifier). The callback already extracts `codeVerifier` (`route.ts:172`) and passes it to `exchangeCodeForTokens` (`route.ts:205`). **Skip entirely if Snap doesn't require PKCE (OPEN QUESTION #3).**

**5.4 — `platformAuthInfo` lights up automatically (no edit)** · verified `93-133`: iterates `getSupportedPlatforms()` (94); SNAPCHAT not in `TOKEN_PLATFORM_SET` (98) → OAuth else-branch (114-132): `configured = Boolean(SNAPCHAT_CLIENT_ID && SNAPCHAT_CLIENT_SECRET)` → `authType:"oauth"`.
- The `OAUTH_PLATFORMS` const (20-31) is **doc-only** — `platformAuthInfo` doesn't reference it. Add `"SNAPCHAT"` only for doc consistency.

**5.5 — `connectWithToken` stays OAuth-only (do NOT touch)** · verified `296-368`, input `z.enum(TOKEN_PLATFORMS)` (299). Do NOT add SNAPCHAT to `TOKEN_PLATFORMS`/`channel-token-validators.ts` — Snap posting is OAuth-based; keeping it out makes Zod reject any token-path attempt.

**5.6 — Media-required guard** · `packages/api/src/lib/media-required.ts` (`MEDIA_REQUIRED_PLATFORMS` Set 11-16 + `PLATFORM_LABEL`)
Add `"SNAPCHAT"` to the Set + `SNAPCHAT: "Snapchat"` to the label map. Snapchat has no text-only snaps.
- **Gotcha:** the Set is `Set<string>`, not enum-strict — forgetting compiles fine and silently lets a text-only SNAPCHAT post through to fail at publish.

---

## PHASE 6 — OAuth callback: GENERIC PATH (no special branch)

**Decision (from trace): Snapchat needs NO special branch.** It lands in the generic single-account block (`route.ts:439-482`) — one `channel.upsert` keyed on `(organizationId, platform, platformId=profile.id)`, persisting tokens/scopes/name/username/avatar + optional `tokens.metadata`, then `resolveChannelErrorsOnReconnect` + `queueAvatarCache`.

**No edit for the happy path** — Snapchat inherits the shared OAuth-2.0 spine (`route.ts:163-222`): `verifyState` + `assertSessionMatchesState` (org/user/membership), env-by-convention, lowercased byte-matched `callbackUrl`, PKCE `codeVerifier` passthrough (line 205). `getProfile` is called (219-222, only INSTAGRAM skipped).

**Optional defense-in-depth (only if Snap has a "no eligible profile" state):** in the outer catch (`route.ts:483-499`) add a message-regex arm (mirror the IG `/No Instagram Business Account…/i` at ~490) mapping a coined `getProfile` throw to a fixed slug (e.g. `snap_no_profile`). Prefer the return-`[]` clean-guard (FB `getPages`→`fb_no_pages`, `route.ts:225-292`) over the catch.
- **SECURITY gotcha:** NEVER reflect the raw Snap error into the redirect (token/PII leak) — use `genericErrorRedirect(code)` + `console.error` the real message (`route.ts:26-33`).

---

## PHASE 7 — Insights pipeline (scoping reality)

**Reality check (verified):** the feasibility-guide's `canonicalKey()`, `SUPPORTED_INSIGHT_PLATFORMS`, `/t/→/p/` resolver, `link_content`/`link_metrics`, the "FB `/share/` resolver", coverage CTEs **DO NOT EXIST here** (zero grep hits; only prose in the old integration doc). They're a different backend. **Don't hunt for them.**

**7.1 — No new resolver, no new tables (scoping decision)**
Insights here are flat per-post counters (`SocialAnalytics`, `social.types.ts:16-24`) keyed by `postTargetId`+`platformPostId`, captured from whatever `publishPost` returns (`post-publish.worker.ts`). There is **no submit-time URL resolver** (the `redirect:"manual"` hits in newsgrid/repurpose/rss are SSRF-safe image/RSS fetchers, not canonicalizers).
- **Decision:** for the **post→insights** loop, do NOTHING here — a Snapchat post auto-participates via 7.2–7.5. The `/t/→/p/` resolver / "Top Links / Link Search" for *arbitrary public creators' share links* is **OUT OF SCOPE** of this add-provider job — it's a separate feature needing net-new models + UI. **Flag to the product owner:** "insights for creators' share links" ≠ "insights for posts WE published"; only the latter fits the existing pipeline.

**7.2 — At-age checkpoints: automatic (no edit)** · `post-publish.worker.ts:615-672` (immediate snapshot + 4 delayed 24h/7d/15d/30d jobs, jobId-deduped, windowTag-stamped). Platform-agnostic.

**7.3 — Analytics-sync worker: automatic (no edit)** · `analytics-sync.worker.ts:10-58` (calls `getSocialProvider(platform).getPostAnalytics()` → writes one `AnalyticsSnapshot`). Platform-agnostic; **and** wraps the call in try/catch (26-29).

**7.4 — Recurring 6-hourly cron + manual sync: gating Snapchat out pre-Gate-3**
- **Cron** · `apps/worker/src/scheduler/cron-jobs.ts:39-89` enqueues sync for all PUBLISHED targets where `channel.platform != 'FACEBOOK'`. There is **NO `SUPPORTED_INSIGHT_PLATFORMS` allowlist** — it's include-all-except-FACEBOOK. To gate Snapchat out until Gate-3, change `platform: { not: 'FACEBOOK' }` → `platform: { notIn: ['FACEBOOK','SNAPCHAT'] }`.
- **⚠️ MAJOR-FIX — manual "Sync Now" (`analytics.router.ts triggerSync`) has NO existing platform filter to "mirror".** *Verified:* `triggerSync` (`483-510`) queues every published in-org target with **no** `platform` predicate at all. So to gate Snapchat out of the manual path you must **ADD a new** `platform: { notIn: ['SNAPCHAT'] }` to its `findMany` where-clause — there is nothing to extend. *(Corollary the trace surfaced: FACEBOOK is already reachable via manual Sync Now today — the exclusion is cron-only.)* If you skip this, "Sync Now" will hit Snapchat's not-yet-allowlisted endpoint; `getPostAnalytics` returning `null` is then your only safety net.
- **Add a code comment** citing the Gate-3 dependency; remove SNAPCHAT from both exclusions once Gate-3 (Phase 9) confirms the API returns data.

**7.5 — Reports + per-channel/group stats: automatic (no edit)** · `analytics.router.ts` uses `c.platform::text` opaque string (~589) + `LEFT JOIN LATERAL … LIMIT 1` latest-snapshot (20-72, 535-618); `at_age` reads `metadata->>'windowTag'`. No per-platform branching. Snapchat rows flow through unchanged.

---

## PHASE 8 — UI

**8.1 — Connect card: automatic** once `platformAuthInfo` returns Snapchat (Phase 5.4).
**8.2 — Platform icon + color (REQUIRED asset)** · `apps/web/components/icons/platform-icons.tsx` (146-162, 17 entries, no SNAPCHAT). Add a `SnapchatIcon` (ghost) + `SNAPCHAT: { icon: SnapchatIcon, color: "text-black", bgColor: "bg-[#FFFC00]" }` (Snap yellow). Without it: no icon on the card/list.
**8.3 — Audit hard-coded platform lists** in `RepurposeTab.tsx`, `autopilot/posts/page.tsx`, `analytics/page.tsx`, `channels/page.tsx` — most read the dynamic feed, but any static array omitting SNAPCHAT silently excludes it there.
**8.4 — Composer surface options (POSTING track):** expose the Snapchat surface picker (`SPOTLIGHT|STORY|SAVED_STORY`) + caption/privacy in the composer that writes `payload.metadata`, so `publishPost` (3.5) reads them. Mirror the YouTube per-post-options convention (`youtube.provider.ts:256-262`).

---

## PHASE 9 — Gate-3 "make-or-break" insights test (RUN THE MOMENT A TOKEN LANDS, BEFORE FINISHING INSIGHTS)

The Public Profile API is allowlist-only; returnable fields are UNKNOWN until one live call. **Do not finish the insights build until this passes.**

**9.1 — The curl** (fill from a real connected token + known asset id; **CONFIRM** host/path):
```bash
curl -sS -X GET \
  "https://businessapi.snapchat.com/public/v1/PROFILE_OR_ASSET_PATH?fields=views,shares,caption,top_links" \
  -H "Authorization: Bearer <ACCESS_TOKEN_FROM_CONNECTED_CHANNEL>" \
  -H "Accept: application/json" | tee /tmp/snap-gate3.json
# CONFIRM: base host, /public/v1/... resource path, id form
# (profile_id vs asset vs /t/<code>→/p/<profile_id>/<asset>), exact `fields` names.
```

**9.2 — Settles 3 unknowns:** (1) **caption tier** — captions present at all? (2) **views availability** — does `views` return for your tier + the target creator? (3) **likes/opt-in** — confirms likes absent for non-opted-in creators (`likes:0` correct), reveals `shares`/`top_links`.

**9.3 — Branch:** returns metrics → finalize `getPostAnalytics` mapping (3.7) + **remove** SNAPCHAT from BOTH exclusions (7.4). 403/empty → ship posting-only, keep `getPostAnalytics` returning `null`, keep SNAPCHAT in the `notIn` exclusions, and **don't claim insights work in UI** until Gate-3 is green (CLAUDE.md honesty convention).

---

## PHASE 10 — Tests

**10.1 — Provider OAuth/token tests** · new `packages/social/src/__tests__/snapchat-oauth.test.ts` (or extend `oauth-flow.test.ts`). Mirror `oauth-flow.test.ts:1-33` harness (`vi.stubGlobal("fetch",…)`, `mockResponse`, `baseConfig`, `beforeEach(clearAllMocks)`).
- `getOAuthUrl` (synchronous — like LinkedIn/FB, not skipped-Twitter): assert Snap authorize host, `client_id=`, `redirect_uri=${encodeURIComponent(callbackUrl)}`, `state=`, **space-joined scope** (LinkedIn/Discord idiom `oauth-flow.test.ts:65-83`, NOT FB `%2C`), and PKCE params (`code_challenge`, `code_challenge_method=S256`).
- `exchangeCodeForTokens`: `mockResolvedValueOnce(mockResponse({access_token,refresh_token,expires_in,scope}))`, assert `OAuthTokens`; error path `.rejects.toThrow("Snapchat token exchange failed")` **verbatim**; assert body carries `code_verifier`.
- `refreshAccessToken`: assert it prefers `data.refresh_token ?? refreshToken` (rotation divergence).
- Add `SnapchatProvider` to the cross-provider consistency loop (`oauth-flow.test.ts:303-327`).
- Regression-lock PKCE + consent param in a dated "Do NOT remove" `it()`.

**10.2 — Connect-error mapping** (only if the Phase-6 optional branch is added) · new `snapchat-connect-errors.test.ts`, mirror `instagram-connect-errors.test.ts:30-84` — `getProfile` rejects with the **same regex** the callback catch uses; graceful list method (if any) resolves to `[]`.

**10.3 — Provider-factory count** · `packages/social/src/__tests__/provider-factory.test.ts` (~209, "17 platforms"). Update **17 → 18** + add SNAPCHAT to `platformExpectations` in lockstep. This break is **intentional** (the registration guard) — failing to update fails CI.

**10.4 — Scope-lock** · new `packages/api/src/__tests__/snapchat-scopes.test.ts`: assert `getDefaultScopes("SNAPCHAT")` equals the exact confirmed array (CLAUDE.md treats these as approval-surface invariants, like Meta's).

---

## PHASE 11 — Verification (MANDATORY before merge)

**11.1 — Web build gate (REQUIRED — the callback lives in apps/web):**
```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build   # MUST exit 0
```
Next.js SWC is **stricter than tsc** (e.g. rejects `a || b ?? c` without parens) — that exact divergence failed a prod deploy before. `tsc --noEmit` alone is NOT sufficient for `apps/web` changes (feedback memory).

**11.2 — Package tests + type-check:**
```bash
pnpm --filter @postautomation/social test
pnpm --filter @postautomation/api test
pnpm --filter @postautomation/social exec tsc --noEmit
pnpm --filter @postautomation/api exec tsc --noEmit
pnpm test          # full suite (security-regression suites stay green)
pnpm type-check    # root — confirms @postautomation/db type includes SNAPCHAT
```

**11.3 — Live smoke after deploy:** set `SNAPCHAT_CLIENT_ID/SECRET` in `.env.prod`; register `https://postautomation.co.in/api/oauth/callback/snapchat` (lowercase, `.co.in`) + localhost in the Snap portal (byte-match matters — `route.ts:201` lowercases). Connect a real account → channel row created (generic branch) → publish one Story/Spotlight → confirm `platformPostId`/URL → run Gate-3 curl (Phase 9).

**11.4 — Reconnect / token-invalidation (document in CLAUDE.md):** changing Snap app scopes/config invalidates all stored Snapchat tokens (same class as YouTube `invalid_grant` / Meta "session invalidated"). Existing accounts must Disconnect → reconnect ONCE; the consent-forcing param (3.1) guarantees re-issuance. Surface the reconnect instruction in the channels UI error copy for the coined Snap error code(s).

---

## OPEN QUESTIONS / CONFIRM-AT-BUILD-TIME (verify live against developers.snap.com)

1. **Auth host** — OAuth2 authorize URL.
2. **Token endpoint** — for both grants; confirm form-urlencoded.
3. **PKCE** — required? `S256`? *(Drives the entire BLOCKER-FIX in 3.1/5.3 — if NO, delete that plumbing.)*
4. **Refresh-token rotation** — new `refresh_token` in the refresh response? (Drives `?? refreshToken` in 3.3.)
5. **Consent-forcing param** — Snap's `prompt=consent`/`access_type=offline` equivalent.
6. **Scope strings** — separate POSTING (Creative/Content Kit) + INSIGHTS (Public Profile API) scopes; space-joined? one OAuth app?
7. **Profile endpoint** — `/me` URL + id/name/username/avatar fields.
8. **Publish flow** — full multi-step upload/create/publish endpoints per surface (Spotlight/Story/Saved Story).
9. **Surface + privacy values** — `metadata.snapSurface` / `metadata.privacyLevel` enums + default.
10. **Canonical post URL** shape from the returned id.
11. **Programmatic delete** — possible per surface, or throw "not supported"?
12. **Publishing id** — needs `public_profile_id`/`organization_id` captured at exchange, carried via `tokens.metadata`?
13. **Insights host/path/fields** — settled by the Gate-3 call (Phase 9).
14. **Constraints** — real `maxContentLength`, `maxMediaSize`, `supportedMediaTypes` per surface.
15. **Snap review timelines** — POSTING (Content/Creative Kit) and INSIGHTS (Public Profile API allowlist) are two separate approvals on one OAuth app; ship posting-first, insights-on-approval.

---

## Key files touched (summary)
`packages/db/prisma/schema.prisma` · `.env.example` · `.env.production.example` · **`packages/social/src/providers/snapchat.provider.ts` (new)** · `packages/social/src/abstract/social.types.ts` (PKCE `codeChallenge` field) · `packages/social/src/abstract/social.factory.ts` · `packages/social/src/index.ts` (optional) · `packages/api/src/routers/channel.router.ts` (getDefaultScopes + PKCE plumbing) · `packages/api/src/lib/media-required.ts` · `apps/web/app/api/oauth/callback/[provider]/route.ts` (optional catch-remap only) · `apps/web/components/icons/platform-icons.tsx` · `apps/worker/src/scheduler/cron-jobs.ts` + `packages/api/src/routers/analytics.router.ts triggerSync` (both, only if gating insights out pre-Gate-3) · tests in `packages/social/src/__tests__/` + `packages/api/src/__tests__/` · CLAUDE.md (reconnect note).
