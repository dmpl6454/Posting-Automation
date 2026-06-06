# Connecting Twitter & TikTok (connect + posting), like FB and YouTube

> **STATUS (updated 2026-06-06):**
> - **Twitter/X — ✅ LIVE in production for all users.** Consumer Key/Secret set, app moved to the Pay-Per-Use **Production** environment, public connect + posting verified end-to-end. Ongoing requirement: keep X API **credits** loaded (or move to a Basic/Pro subscription) — posting is billed per the operator's enrolled X account. See §3 + the CLAUDE.md "Twitter / X specifics" section.
> - **TikTok — ✅ code fixed (env var + scopes, committed), but 🚫 BLOCKED by the India ban.** `developers.tiktok.com` is unreachable from India and Indian users are blocked, so it cannot be registered or used for this India-based operation. The §4/§5 code work below is **already done**; what remains is purely the (currently impossible-from-India) TikTok app registration + Content Posting API audit. Shelved unless run via a non-India egress targeting a non-India audience.

This guide explains how to make **Twitter/X** and **TikTok** work end-to-end — channel
connect *and* posting — the same way Facebook/Instagram and YouTube already do.

It is split into:

1. [How the shared connect + posting machinery works](#1-how-the-shared-machinery-works) — the common pipeline every OAuth platform rides on.
2. [The FB / YouTube enablement template](#2-the-fbyt-enablement-template) — the exact checklist that made FB and YT work, so we can copy it.
3. [Twitter — what to do](#3-twitter--what-to-do) — operator steps only; code is complete.
4. [TikTok — what to do](#4-tiktok--what-to-do) — **two code fixes first**, then operator steps.
5. [Code changes required (TikTok)](#5-code-changes-required-tiktok) — exact files + lines.
6. [Verification checklist](#6-verification-checklist).

> **TL;DR**
> - **Twitter is code-complete** (connect + posting, incl. media). It needs only operator app registration. The env var names (`TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET`) already match the code — set them and redeploy. No platform "App Review" is needed for posting.
> - **TikTok's provider is complete**, but two in-repo defects block it: an env-var **name mismatch** (`TIKTOK_CLIENT_KEY` in the templates/docs vs `TIKTOK_CLIENT_ID` in every OAuth code path) and **empty scopes** in `getDefaultScopes`. Fix both, then follow a YouTube-style operator path. TikTok also needs its **Content Posting API audit** approved (until then: test users only, posts forced private — the analogue of Meta's Advanced Access gate).

---

## 1. How the shared machinery works

Every OAuth platform (FB, IG, YouTube, LinkedIn, Pinterest, Twitter, TikTok…) rides the same pipeline. Understanding it tells you exactly what each new platform needs.

### Connect flow

1. **`getOAuthUrl` mutation** — [packages/api/src/routers/channel.router.ts:133-199](../packages/api/src/routers/channel.router.ts#L133-L199)
   - Enforces the channel quota, re-validates the actor is a real `OrganizationMember` (closes the connect-on-behalf IDOR — no superadmin carve-out).
   - **Reads `process.env[`${PLATFORM}_CLIENT_ID`]` and `..._CLIENT_SECRET`** ([channel.router.ts:173-183](../packages/api/src/routers/channel.router.ts#L173-L183)). If either is missing → `BAD_REQUEST` "not configured by the administrator".
   - Builds the redirect URI as **`${APP_URL}/api/oauth/callback/${platform.toLowerCase()}`** and the scope list from `getDefaultScopes(platform)`.
   - Signs the OAuth `state` with the org + user ([oauth-helper.ts](../packages/social/src/utils/oauth-helper.ts), HMAC-SHA256, 10-min TTL).

2. **`platformAuthInfo` query** — [channel.router.ts:91-131](../packages/api/src/routers/channel.router.ts#L91-L131)
   - This is the **single source of truth for whether the Connect button lights up.** For OAuth platforms it computes `configured = Boolean(process.env[`${PLATFORM}_CLIENT_ID`] && ..._CLIENT_SECRET)`. If false, the UI shows the amber **"Setup required"** badge and points at `docs/OAUTH_SETUP.md`.
   - **Key takeaway:** the gate checks `_CLIENT_ID` / `_CLIENT_SECRET` *exclusively*. Any platform whose env var is named differently (TikTok's `_CLIENT_KEY`) will show "Setup required" forever, no matter what's set.

3. **Callback route** — [apps/web/app/api/oauth/callback/[provider]/route.ts](../apps/web/app/api/oauth/callback/[provider]/route.ts)
   - `assertSessionMatchesState` — the signed-in user must equal `state.userId` and have membership in `state.organizationId`.
   - **Twitter** has a dedicated branch ([route.ts:48-134](../apps/web/app/api/oauth/callback/[provider]/route.ts#L48-L134)) because OAuth 1.0a has no standard `state` param (it uses a custom `twitterstate`).
   - **TikTok** falls into the **generic OAuth 2.0 single-account branch** ([route.ts:389-421](../apps/web/app/api/oauth/callback/[provider]/route.ts#L389-L421)) — no TikTok-specific callback code is needed and none exists. (FB/IG/LinkedIn have multi-account fan-out branches; TikTok is one account, which is correct.)
   - The redirect URI is rebuilt with `.toLowerCase()` so it byte-matches the authorize-time `redirect_uri`.

4. **Token storage** — tokens land in `Channel.accessToken` / `refreshToken` (TEXT columns, [schema.prisma:203-206](../packages/db/prisma/schema.prisma#L203-L206)), transparently **AES-256-GCM encrypted** by a Prisma client extension (key = `SHA256(TOKEN_ENCRYPTION_KEY || NEXTAUTH_SECRET)`, [crypto.ts:19-27](../packages/db/src/crypto.ts#L19-L27)). Nothing platform-specific to do here.

### Posting flow

1. **Enqueue** — immediate via `post.router.ts` `publishNow`, or scheduled via the worker cron `publishScheduledPosts` (every 2 min). Both push a `PostPublishJobData` to `postPublishQueue`.
2. **Worker dispatch** — [apps/worker/src/workers/post-publish.worker.ts](../apps/worker/src/workers/post-publish.worker.ts):
   - Idempotency short-circuit if `publishedId` is already set.
   - `getSocialProvider(platform)` → factory ([social.factory.ts:21-52](../packages/social/src/abstract/social.factory.ts#L21-L52)). **Both `TWITTER` and `TIKTOK` are already registered.**
   - **Pre-publish token refresh** ([worker:248-285](../apps/worker/src/workers/post-publish.worker.ts#L248-L285)): if the token expires within 5 min and a `refreshToken` exists, it reads `${platform}_CLIENT_ID/SECRET` and calls `provider.refreshAccessToken`. (Twitter's intentionally throws — OAuth 1.0a tokens never expire; TikTok's works.)
   - Calls `provider.publishPost(tokens, payload)`.

---

## 2. The FB/YT enablement template

This is *exactly* what it took to make the working platforms work. Treat it as the checklist to clone.

### What it took for Facebook / Instagram
1. Register **one** Meta Business app (FB + IG share App ID `298449321694397`).
2. Add products: Facebook Login for Business, Pages API, Instagram Graph API.
3. Set redirect URIs (lowercase, `.co.in` + localhost) for **both** `/facebook` and `/instagram`.
4. App Settings → Advanced → **"Native or desktop app" = OFF** (else the server-side secret exchange fails with `OAuthException code:1`).
5. Declare scopes in `getDefaultScopes` ([channel.router.ts:435-436](../packages/api/src/routers/channel.router.ts#L435-L436)).
6. Set env vars `FACEBOOK_CLIENT_ID/SECRET`, `INSTAGRAM_CLIENT_ID/SECRET` — names matching `<PLATFORM>_CLIENT_*`.
7. Make compliance URLs live (Privacy / Terms / Data-Deletion, all HTTP 200).
8. Complete Meta **Business Verification** (separate, ~1–3 weeks).
9. Make **one** successful Graph call per permission to unlock each "Request Advanced Access" button (the test-call gate).
10. Submit **App Review** with per-permission justification + demo screencast (Advanced Access, ~1–3 weeks).
11. **Reconnect** after any scope/config change — it invalidates existing tokens.

### What it took for YouTube
1. Reuse the existing Google Cloud project (the Sign-in-with-Google one); enable YouTube Data API v3.
2. OAuth consent screen → add **`youtube.upload` + `youtube.readonly`** (both required; upload alone 403s on `channels.list`).
3. Create a separate Web OAuth client → `YOUTUBE_CLIENT_ID/SECRET`; redirect URIs localhost + `.co.in`.
4. Declare scopes in `getDefaultScopes` ([channel.router.ts:438-443](../packages/api/src/routers/channel.router.ts#L438-L443)).
5. Self-test via the Cloud Console "Test users" list; full public use needs Google verification (~2 weeks for the sensitive scope).
6. **Reconnect** after scope change (`invalid_grant`).

### The five recurring requirements
Every platform needs the same five things to work; the table below is the rest of this guide in miniature.

| Requirement | Facebook | YouTube | **Twitter** | **TikTok** |
|---|---|---|---|---|
| 1. App registered + redirect URIs | ✅ done | ✅ done | ⬜ operator TODO | ⬜ operator TODO |
| 2. Scopes in `getDefaultScopes` | ✅ | ✅ | ✅ (decorative — see below) | ❌ **missing → fix** |
| 3. Env var names match `_CLIENT_ID/_SECRET` | ✅ | ✅ | ✅ **already correct** | ❌ **mismatch → fix** |
| 4. Platform review / approval | Advanced Access | Google verification | **none needed for posting** | **Content Posting API audit** |
| 5. Reconnect after scope/config change | yes | yes | regenerating keys invalidates tokens | yes |

---

## 3. Twitter — what to do

**Code status: complete.** Full OAuth 1.0a 3-legged connect, profile fetch, posting with image + chunked video upload, all already implemented in [twitter.provider.ts](../packages/social/src/providers/twitter.provider.ts) and the dedicated callback branch. Env var names already match the code. **You only need operator setup.**

### Operator steps
1. Create an app at **developer.twitter.com** → Projects & Apps.
2. **User authentication settings:**
   - App permissions: **Read and write** (required to post).
   - Type of App: **Web App**.
   - Callback URLs (add both):
     - `http://localhost:3000/api/oauth/callback/twitter`
     - `https://postautomation.co.in/api/oauth/callback/twitter`
   - Website URL: `https://postautomation.co.in`
3. From **Keys and tokens**, copy:
   - **API Key** → `TWITTER_CLIENT_ID`
   - **API Key Secret** → `TWITTER_CLIENT_SECRET`
4. Put them in `.env` (local) and `.env.prod` (production). Redeploy.

### Important Twitter-specific notes (document these for maintainers)
- **The repo uses OAuth 1.0a, not OAuth 2.0.** Permissions are fixed at app-registration time ("Read and write" in the portal). The scope arrays in `getDefaultScopes` ([line 430](../packages/api/src/routers/channel.router.ts#L430)) and the callback (`["tweet.read","tweet.write","media.write"]`) are **decorative — OAuth 1.0a never sends them.** Do not "fix" them; set permissions in the Twitter portal instead.
- **No App Review needed to post.** This makes Twitter the *easiest* platform to enable.
- **Analytics needs a paid tier.** `getPostAnalytics` hits `/2/tweets/{id}?tweet.fields=public_metrics`, which requires at least the **Basic ($100/mo)** API tier. On the **Free** tier, posting works but analytics sync will 403. That's an account/billing gate, not a bug.
- **Regenerating Consumer Keys invalidates all stored tokens** → connected users must reconnect (the OAuth 1.0a analogue of the FB/YT "reconnect after scope change" quirk).
- **Known risks (not blockers):**
  - *Silent media-skip* — [twitter.provider.ts:164-173](../packages/social/src/providers/twitter.provider.ts#L164-L173) uses `Promise.allSettled`; a failed media upload silently degrades to a text-only tweet. Consider failing the target instead, to match FB/IG.
  - *Single-replica assumption* — the OAuth 1.0a request-token secret is held in process memory ([oauth1a-temp-store.ts](../packages/social/src/utils/oauth1a-temp-store.ts)). Fine on the current single-container prod deploy, but it breaks under horizontal scaling or a mid-flow container restart. If connect ever errors with "request token secret not found or expired" on a clean attempt, this is why. Longer-term: move to Redis.

---

## 4. TikTok — what to do

**Code status: provider complete, but blocked by two in-repo defects.** Fix [those](#5-code-changes-required-tiktok) first, then follow the operator path.

### Step A — apply the two code fixes (see §5)
1. Resolve the `TIKTOK_CLIENT_KEY` vs `TIKTOK_CLIENT_ID` env var mismatch.
2. Add TikTok scopes to `getDefaultScopes`.

Without #1, TikTok shows **"Setup required" forever** (and connect/exchange/refresh all fail). Without #2, the authorize URL is built with an empty scope and TikTok rejects/limits it.

### Step B — operator steps (after the fixes)
1. Create an app at **developers.tiktok.com**.
2. Add products: **Login Kit** + **Content Posting API**.
3. Redirect URIs (add both):
   - `http://localhost:3000/api/oauth/callback/tiktok`
   - `https://postautomation.co.in/api/oauth/callback/tiktok`
4. Ensure the app's **Privacy Policy** (`/privacy`) and **Terms of Service** (`/terms`) URLs are set and live (TikTok requires these).
5. Copy **Client Key** and **Client Secret** into env. Use the variable names the §5 fix standardizes on (recommended: `TIKTOK_CLIENT_ID` = the TikTok *Client Key*, `TIKTOK_CLIENT_SECRET` = the Client Secret). The provider already maps `clientId → client_key` internally, so the *value* is the TikTok Client Key regardless of the env var name.
6. Redeploy.

### Step C — the Content Posting API audit (the TikTok analogue of Meta Advanced Access)
- Until TikTok **audits/approves** your Content Posting API access, the app runs in **unaudited-client / sandbox** mode:
  - Only the app's **registered test users** can authorize.
  - **All posts are forced to `SELF_ONLY` (private)** regardless of requested privacy.
- The provider already defaults `privacy_level` to `SELF_ONLY` ([tiktok.provider.ts:102](../packages/social/src/providers/tiktok.provider.ts#L102)), which is sandbox-safe.
- Submit for review with a **demo video** (per [docs/OAUTH_SETUP.md:180](../docs/OAUTH_SETUP.md)). Approval typically takes ~1–3 weeks.

### Important TikTok-specific notes
- **Scopes needed:** `user.info.basic` (profile fetch via `/v2/user/info/`), `video.publish` (Direct Post — what the current `publishPost` uses via `PULL_FROM_URL`), and optionally `video.upload` (upload-to-drafts). `video.publish` and `video.upload` are **distinct products** in the TikTok portal — enable the ones you intend to use.
- **Video only.** `publishPost` requires a video and enforces `maxMediaCount: 1`, 287 MB ([tiktok.provider.ts:84-86](../packages/social/src/providers/tiktok.provider.ts#L84-L86)). Text/image-only TikTok posts throw a clear error. The compose/schedule UI should prevent scheduling non-video TikTok posts.
- **No programmatic delete.** TikTok has no delete endpoint; `deletePost` throws by design.
- **Post-approval follow-up (not a blocker now):** public posting needs the audited `privacy_level` plumbed from the compose UI into `payload.metadata.privacyLevel` ([tiktok.provider.ts:102](../packages/social/src/providers/tiktok.provider.ts#L102)). Nothing sets it today — add a privacy selector + Direct-Post vs drafts choice once the audit is approved.

---

## 5. Code changes required (TikTok)

> Twitter needs **no** code changes. These two fixes are TikTok-only and must land before TikTok can connect.

### Fix 1 — resolve the `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_ID` mismatch (hard blocker)

TikTok's OAuth uses `client_key` (not `client_id`). The provider already maps it internally, **but the env templates, the two analytics workers, and the docs name the variable `TIKTOK_CLIENT_KEY`, while every connect/publish code path reads `TIKTOK_CLIENT_ID`.** There is currently no single name that satisfies both groups.

Reads `TIKTOK_CLIENT_ID`:
- [channel.router.ts:174-175](../packages/api/src/routers/channel.router.ts#L174-L175) (`getOAuthUrl`) and [:113-114](../packages/api/src/routers/channel.router.ts#L113-L114) (the `platformAuthInfo` "configured" gate — **this one alone determines whether the Connect button lights up**).
- [route.ts:162-163](../apps/web/app/api/oauth/callback/[provider]/route.ts#L162-L163) (token exchange).
- [post-publish.worker.ts:255-256](../apps/worker/src/workers/post-publish.worker.ts#L255-L256) (pre-publish refresh).

Reads/writes `TIKTOK_CLIENT_KEY`:
- [.env.example](../.env.example) and [.env.production.example](../.env.production.example) (templates).
- [brand-content-sync.worker.ts:223](../apps/worker/src/workers/brand-content-sync.worker.ts#L223) and [listening-sync.worker.ts:362](../apps/worker/src/workers/listening-sync.worker.ts#L362) (analytics workers).
- [docs/OAUTH_SETUP.md:178-179](../docs/OAUTH_SETUP.md) (operator instructions).

**Recommended fix — Option B (standardize on `TIKTOK_CLIENT_ID` everywhere):** cleaner long-term, fewer branches. Update the env templates, the two analytics workers, and the docs to read `TIKTOK_CLIENT_ID` / `TIKTOK_CLIENT_SECRET`. Set `TIKTOK_CLIENT_ID` = the TikTok *Client Key* value.

**Alternative — Option A (accept both):** in each of the four OAuth read sites above, accept a fallback, e.g. `process.env.TIKTOK_CLIENT_ID || process.env.TIKTOK_CLIENT_KEY`. Safer if you can't touch the analytics workers right now, but leaves two names in play.

Whichever you choose, **the `platformAuthInfo` gate ([channel.router.ts:113-114](../packages/api/src/routers/channel.router.ts#L113-L114)) must end up reading whatever name you set in env**, or TikTok never leaves "Setup required".

### Fix 2 — add TikTok scopes to `getDefaultScopes`

[channel.router.ts:428-447](../packages/api/src/routers/channel.router.ts#L428-L447) — `scopeMap` has **no `TIKTOK` key**, so it returns `[]` and the authorize URL is built with an empty scope. Add:

```ts
TIKTOK: ["user.info.basic", "video.publish", "video.upload"],
```

(TikTok joins scopes with `,` — already handled in [tiktok.provider.ts:26](../packages/social/src/providers/tiktok.provider.ts#L26).)

### Related hygiene fix (recommended in the same pass)

The **production** env template uses `FACEBOOK_APP_ID/SECRET` and `PINTEREST_APP_ID/SECRET`, but the code reads `FACEBOOK_CLIENT_ID/SECRET` and `PINTEREST_CLIENT_ID/SECRET`. FB only works in prod today because the real `.env.prod` on the server was hand-corrected. Same class of bug as TikTok's — fix [.env.production.example](../.env.production.example) so the template operators actually edit is consistent.

---

## 6. Verification checklist

**Twitter**
- [ ] App registered, "Read and write", both callback URLs added.
- [ ] `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` set in `.env` + `.env.prod`; redeployed.
- [ ] Channels page shows Twitter **without** the "Setup required" badge.
- [ ] Connect completes and a Twitter channel row appears.
- [ ] Test post (text) publishes; test post with image/video publishes.
- [ ] (Optional) Confirm analytics tier if you need engagement sync (Basic+).

**TikTok**
- [ ] Fix 1 (env var name) + Fix 2 (scopes) merged.
- [ ] App registered with Login Kit + Content Posting API; both callback URLs added; Privacy/Terms URLs live.
- [ ] `TIKTOK_CLIENT_ID` (= Client Key value) / `TIKTOK_CLIENT_SECRET` set; redeployed.
- [ ] Channels page shows TikTok **without** "Setup required".
- [ ] Connect completes (as a registered test user pre-audit) and a TikTok channel row appears.
- [ ] Test **video** post publishes to `SELF_ONLY` (sandbox-expected).
- [ ] Content Posting API audit submitted (demo video) for public posting.
- [ ] After approval: plumb `privacyLevel` from the compose UI and reconnect affected accounts.

---

### Key files (quick reference)
- Connect machinery: [channel.router.ts](../packages/api/src/routers/channel.router.ts) — `getOAuthUrl` 133-199, `platformAuthInfo` 91-131, `getDefaultScopes` 428-447
- Callback: [apps/web/app/api/oauth/callback/[provider]/route.ts](../apps/web/app/api/oauth/callback/[provider]/route.ts) — Twitter 48-134, OAuth2 139-436
- Twitter provider: [twitter.provider.ts](../packages/social/src/providers/twitter.provider.ts)
- TikTok provider: [tiktok.provider.ts](../packages/social/src/providers/tiktok.provider.ts)
- Worker dispatch/refresh: [post-publish.worker.ts](../apps/worker/src/workers/post-publish.worker.ts) — dispatch 245, refresh 248-285
- Env templates: [.env.example](../.env.example), [.env.production.example](../.env.production.example)
- Operator OAuth doc: [docs/OAUTH_SETUP.md](./OAUTH_SETUP.md) — Twitter §1, TikTok §6
