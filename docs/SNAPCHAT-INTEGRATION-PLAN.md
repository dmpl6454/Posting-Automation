# Snapchat Integration — OAuth App, Allowlist Strategy & PostAutomation Build Plan

**Prepared:** 2026-07-18
**Owner:** Tabish / DIGITAL SUKOON PRIVATE LIMITED
**Scope:** Add Snapchat to PostAutomation (`postautomation.co.in`) as a first-class channel — **connect account + auto-post + read insights** — built the same way Meta (Facebook/Instagram) and YouTube were.
**Sources this plan is grounded in:** `SnapchatEmailThreadOne.pdf` (Case #05443628), `Snapchat-API-Feasibility-Guide.pdf` (2026-06-30), and the live PostAutomation codebase (`packages/social`, `apps/web`, `packages/db`).

---

## 0. TL;DR — what to do, in order

1. **Understand the split (critical):** Snapchat = **two different products, two different approvals.**
   - **Posting** (Stories/Spotlight/Saved Stories) → Snap's **content/Creative Kit** surface + its own scopes.
   - **Insights** (views/subscribers/top-links/captions) → the **Public Profile API** (`businessapi.snapchat.com/public/v1/...`), **allowlist-only**. This is what the feasibility guide is about. **It cannot post.**
   - The email thread asked the *Public Profile* team for *posting* — a mismatch that partly explains the stall. We fix that.
2. **Create ONE clean OAuth app named "PostAutomation"** at `kit.snapchat.com/manage`, redirect URI on **`postautomation.co.in`**, with the correct scopes. Supersede the misnamed "Dashmani Insights" app. (§2)
3. **Clear the two account-hygiene blockers** Snap flagged (business address + payment/funding source). Free, removes their stated objection, raises Account-Manager eligibility. (§3)
4. **Send two corrected emails** (§6): (A) an in-thread reply on Case #05443628 that fixes the record — new app, corrected callback, split posting-vs-insights, keeps AM escalation alive; (B) a standalone, technically-correct package to `profile-api-dev-support@snapchat.com` for the **insights** allowlist only.
5. **Build the provider in this repo** mirroring YouTube/Meta (§4–§5). Do the **make-or-break test call** the moment the allowlist lands, **before** finishing the insights build (§5, Gate 3).
6. **Set expectations:** allowlist + AM are external, relationship-gated, weeks-not-days, and may be declined. Posting approval and insights allowlist are independent — one can land without the other.

---

## 1. The two-products problem (read this before emailing Snap again)

The feasibility guide is emphatic and correct: Snapchat gates data into two **read** tiers —

| Tier | Path | Needs | Gives you (for third-party creators) |
|------|------|-------|--------------------------------------|
| **Public** | `/public/v1/...` | Allowlist only | Subscriber count · Spotlight **views + shares** · profile metadata · Spotlight/Story **listing** |
| **Authorized** | `/v1/...` | Each creator OAuth-authorizes you | Likes/favorites · full Story metrics · demographics |

**Both of those are read APIs.** Neither creates content. Nothing in the Public Profile API uploads a Story or publishes a Spotlight.

**Posting is a separate Snap capability** (Creative Kit / content publishing), with its own app config, its own scopes, and its own review. So "connect account + auto-post" (what PostAutomation does for every other network) is **track 1**, and "read insights" (the feasibility guide, the 124-link test, Top Links) is **track 2**. They share one OAuth app and one "Connect Snapchat" button in the UI, but they are approved by different Snap teams and must be *asked for separately and correctly*.

> **Why the thread stalled (diagnosis):** The email to `profile-api-dev-support` (the *insights/Public-Profile* team) requested *"Post content: Stories, Spotlight, Saved Stories, including media uploads."* That team does not own posting, so the request had no clean home → it degraded into generic "we'll try to assign an Account Manager" + unrelated ad-account nags. Splitting the two asks fixes the mismatch.

---

## 2. OAuth app strategy — create a clean "PostAutomation" app

### Why a new app (not just editing the old one)
The existing app (`Dashmani Insights`, Client ID `26a5531a-7692-4163-a5d8-33bfda7523ad`) has **three** problems for this use case:
1. **Wrong redirect URI** — points at `https://api.digitalsukoon.com/v1/snapchat/oauth/callback`; PostAutomation runs at `postautomation.co.in` and has **no** handler at that digitalsukoon URL.
2. **Wrong name/branding** — "Dashmani Insights" tells a reviewer this is a Dashmani analytics tool, not the PostAutomation SaaS that will post on users' behalf.
3. **Wrong lineage** — it surfaces "Marketing API Documentation" (the ads/insights surface).

The redirect URI *is* editable in place, so if you'd rather not disrupt the open case you *can* just repoint the old app. **Recommended: create a fresh app** so dev-support sees one coherent "PostAutomation" identity, and retire the old Client ID in the email. A clean identity is worth more in a relationship-gated review than avoiding a 10-minute re-registration.

### Steps to create the new OAuth app (you do this in the Snap portal)
> The exact menu labels shift over time; these are the stable checkpoints. `kit.snapchat.com` and `business.snapchat.com` are the two consoles.

1. **Confirm a Snapchat Business account exists** at `business.snapchat.com` (you already have `DIGITAL SUKOON PRIVATE LIMITED`, Org ID `25170f6b-d77f-4784-985a-0017b76fb9b9`).
2. Go to **`kit.snapchat.com/manage`** → **Create an OAuth App** (or "Add App").
3. **App name:** `PostAutomation` (match the product; not "Dashmani Insights").
4. **Redirect URI(s)** — add BOTH (mirrors every other provider in this repo):
   - `https://postautomation.co.in/api/oauth/callback/snapchat`
   - `http://localhost:3000/api/oauth/callback/snapchat` (for local dev)
   > This callback path is the convention this codebase uses for all providers: `${APP_URL}/api/oauth/callback/<platform>`. See `apps/web/app/api/oauth/callback/[provider]/route.ts`.
5. **Scopes** — request what maps to your two tracks:
   - `snapchat-profile-api` → the **Public Profile API** (insights track). *(This is the scope the feasibility guide names.)*
   - The **content-publishing** scope(s) for the posting track — confirm the current exact scope name in the portal's scope picker / Creative-Kit or content-publishing docs at app-creation time (Snap renames these; do not hardcode from memory). If posting scopes are not offered on this app type, that's your signal that posting requires a *separate* Snap product enrollment — capture that and we adjust track 1.
6. **Save** → record the new **Client ID + Client Secret** (secret shown once — store it in the password manager and, later, in `.env.prod`).
7. **Compliance URLs** (Snap will want these, same as Meta did): Privacy `https://postautomation.co.in/privacy`, Terms `https://postautomation.co.in/terms`. These already exist and return 200.

### After creating it
- The new Client ID **supersedes** `26a5531a-...` in all Snap correspondence.
- You may **delete** the old "Dashmani Insights" app once the new one is in the allowlist request (or leave it dormant — harmless, but deleting avoids confusion).

---

## 3. Account-hygiene blockers (do today — free, removes Snap's objection)

Mel's last email (18 Jul, 10:29) flagged two gaps. Your dashboard screenshots confirm both. Clearing them removes the stated reason they won't prioritize an Account-Manager assignment.

| # | Action | Where | Notes |
|---|--------|-------|-------|
| 1 | **Add Business Address** | Business Settings → Business Details → ✏️ next to *Organization Address* | Use your **GST-registered** address. GSTIN `27AAKCD3352K1ZF` → prefix `27` = **Maharashtra**, so State = Maharashtra. Fill Street/City/State/Postal → **Save Changes**. |
| 2 | **Add Payment Method / funding source** | Billing & Payments → Payment Methods → **Add Payment** | You do **not** need to run ads. A funding source on file materially raises AM-eligibility (AM coverage is prioritized to spending accounts). |
| 3 | **Complete Billing Address** | Business Dashboard → *Add Your Billing Address* card | Gets the onboarding checklist to **4/4** → account reads as a real advertiser. |

> These are *eligibility* moves, not the allowlist itself. The allowlist is a dev-support decision; hygiene just removes friction and the AM excuse.

---

## 4. How this repo does providers (the pattern Snapchat must follow)

Snapchat will be provider #18. Every provider implements the same `SocialProvider` interface and is registered in one factory. The **closest analog is YouTube** (Google OAuth: `authorization_code` grant, offline/refresh tokens, both `publishPost` and `getPostAnalytics`). Reference file: `packages/social/src/providers/youtube.provider.ts`.

**The interface surface a `SnapchatProvider` must implement** (from the YouTube provider):
- `getOAuthUrl(config, state): string` — build the authorize URL. YouTube uses `access_type: "offline"` + `prompt: "consent"` to guarantee a refresh token; Snap's analog is whatever forces refresh-token issuance on its authorize endpoint.
- `exchangeCodeForTokens(code, config): Promise<OAuthTokens>` — `grant_type: authorization_code` POST to Snap's token endpoint.
- `refreshAccessToken(refreshToken, config): Promise<OAuthTokens>` — `grant_type: refresh_token`.
- `getProfile(tokens): Promise<SocialProfile>` — resolve the connected profile (id/name/handle/avatar).
- `publishPost(tokens, payload): Promise<SocialPostResult>` — **posting track**; content/Creative-Kit endpoint.
- `getPostAnalytics(tokens, platformPostId): Promise<SocialAnalytics | null>` — **insights track**; Public Profile API metrics.

**Registration & wiring points (grep-confirmed):**
- Factory: `packages/social/src/abstract/social.factory.ts` → add `case "SNAPCHAT": return new SnapchatProvider()` in `getSocialProvider`.
- Enum: `packages/db/prisma/schema.prisma` → add `SNAPCHAT` to `enum SocialPlatform` (lines 252–270) → run `pnpm db:push`.
- Default scopes: `packages/api/src/routers/channel.router.ts` → add a `SNAPCHAT` branch to `getDefaultScopes` (~line 466), returning the scopes registered on the app.
- Callback: `apps/web/app/api/oauth/callback/[provider]/route.ts` already dispatches by `params.provider`; add any Snapchat-specific branch there **only if** the token/profile shape needs it (Meta/IG have special branches; simpler providers don't).
- Env vars (new): `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET` — read where the other `<PLATFORM>_CLIENT_ID/SECRET` are read; set in `.env` (local) and `.env.prod` (server).
- `platformAuthInfo` (the query that tells the UI which platforms are OAuth and whether they're configured) — Snapchat is an OAuth platform requiring operator app creds, so it shows "Setup required" until `SNAPCHAT_CLIENT_ID/SECRET` are set, exactly like the other OAuth networks.

> **Do NOT** hardcode Snap endpoint URLs or scope strings from memory in the provider — confirm each against `developers.snap.com` at build time. Snap's Marketing/Public-Profile API host is `businessapi.snapchat.com` per the feasibility guide; the auth host is under `accounts.snapchat.com` / Snap Kit — verify current paths when you write the code.

---

## 5. Build sequence (mirrors the feasibility guide's gates + this repo's conventions)

### Gate 1 — App + accounts (you control; hours) — §2 above
New "PostAutomation" OAuth app, correct redirect URIs + scopes, secret stored.

### Gate 2 — Approvals (external; the real risk; weeks; may be declined)
- **Insights:** allowlist the new Client ID for the **Public Profile API** via `profile-api-dev-support@snapchat.com` (Email B, §6).
- **Posting:** confirm and pursue the **content-publishing** approval path (separate). If the portal doesn't expose posting scopes on this app, that's the trigger to ask Snap which product/enrollment posting requires.
- Track them **independently** — one can land without the other.

### Gate 3 — The make-or-break test call (do BEFORE finishing the insights build)
The feasibility guide already proved (against your production data) that **all 124 Snapchat links resolve** to `/p/<profile_id>/<asset>` and that just **~4 creators cover 92%** of them — so the *insights* work is ~4 profile lookups, not 124. But three things can only be settled by one real call once you have a token:
- **Unknown #1:** does `caption` come back on the **public** tier? (decides Link Search)
- **Unknown #2:** do public Spotlight `views`/`shares` return for a *non-opted-in* creator, or 403?
- **Unknown #3:** are the 4 creators API-eligible public profiles?

Run the guide's §6 curl (`businessapi.snapchat.com/public/v1/public_profiles/<profile_id>/spotlights/<id>` with the Bearer token) and read the response **before** writing provider insight code. If it 403s → that capability is authorized-only for those creators and stays out.

### Gate 4 — Permanent limits (accept, don't fight)
No likes for non-opted-in creators; no fully-private creators; public views may lag the in-app UI ~24h.

### Build (only after Gate 3 returns real data)
1. **Enum + push:** add `SNAPCHAT` to `SocialPlatform`, `pnpm db:push`.
2. **Provider:** `packages/social/src/providers/snapchat.provider.ts` implementing the interface (§4), modeled on `youtube.provider.ts`. Posting via the content endpoint; insights via Public Profile API.
3. **Factory + scopes + env:** register in `social.factory.ts`, add `getDefaultScopes` branch, wire `SNAPCHAT_CLIENT_ID/SECRET`.
4. **Insights pipeline reuse** (from the guide): submit-time `/t/`→`/p/` resolver (fail-open, outside the DB txn, same pattern as the existing Facebook `/share/` resolver); `canonicalKey()` branches `sc:spotlight:<profileId>:<id>` / `sc:story:<profileId>:<id>`; provider keyed by `profile_id` (~4 calls); feed captions → Link Search, views/shares → Top Links; re-add `snapchat` to `SUPPORTED_INSIGHT_PLATFORMS` **only for the capabilities Gate 3 confirmed**.
5. **Reconnect quirk (expected):** like Meta/YouTube, any scope/config change **invalidates existing Snap tokens** — users must Disconnect → reconnect to re-mint. Force refresh-token re-issuance on reconnect (YouTube uses `prompt: consent`).
6. **Tests:** an `oauth-flow`-style test asserting the authorize URL carries the right redirect URI + scopes; provider unit tests mirroring the existing provider test suites.

---

## 6. The two emails

> **Rule:** keep the two threads clean. Do **not** cross-Cc `profile-api-dev-support` on the ad-support reply — ad-support will reply-all with billing nags and bury the dev team. Reference the case number in the body instead.
>
> **Honesty guardrail:** the build isn't done yet, so **do not claim** "ready for review / can demo today." Say **registered + in active development, can demo within N days on request.** Overclaiming to the one team that can allowlist you is the worst failure mode.

Fill the bracketed bits (`[N days]`, your new Client ID) before sending.

### Email A — reply IN-THREAD on Case #05443628 (to `ad-support@snapchat.com`)
**Subject:** (keep the existing thread subject) `Re: Snap Ad Support Request 05443628 [ thread::WvpbEAF1f82CULsxLoA-Hwc:: ]`

```
Hi team,

Thank you for the escalation and for flagging the account items.

Two updates from our side:

1) Account setup — DONE. I've added our Business Address under Business Details
   and added a payment method / funding source. Our onboarding checklist is now
   complete. Please reflect this against our eligibility for an Account Manager.

2) A correction to our request, so the record is clean:

   - We have created a dedicated OAuth app for our product, "PostAutomation".
     Please use this going forward:
        New OAuth Client ID: [NEW_CLIENT_ID]
        Redirect URI:        https://postautomation.co.in/api/oauth/callback/snapchat
     Our earlier Client ID (26a5531a-7692-4163-a5d8-33bfda7523ad) had its
     callback pointed at a non-production domain and has been superseded — please
     disregard it.

   - Splitting our two needs, since they map to different Snap products:
        (a) PUBLIC PROFILE API (read insights) — views, subscribers, top links,
            per-post engagement, for any Public Profile whose owner grants our app
            OAuth consent. This is the allowlist request, which we understand your
            developer support team owns; I have emailed
            profile-api-dev-support@snapchat.com separately with the full package.
        (b) CONTENT PUBLISHING (post Stories/Spotlight on a consenting owner's
            behalf) — please advise which Snap product/enrollment this requires,
            as it appears separate from the Public Profile API.

Org: DIGITAL SUKOON PRIVATE LIMITED
Org ID: 25170f6b-d77f-4784-985a-0017b76fb9b9
Primary Ad Account ID: 8bcfe784-f5a6-4157-8caf-3c09d659b08d

Requests:
  - Please attach the NEW Client ID + the above to Case #05443628.
  - Please keep the Account Manager assignment moving.
  - For (b), please point us to the correct posting/publishing product or team.

All access in both tracks is OAuth-consent-gated; owners can revoke anytime.
Appreciate your help.

Best regards,
Tabish
DIGITAL SUKOON PRIVATE LIMITED
admin@dashmani.com
```

### Email B — standalone to `profile-api-dev-support@snapchat.com` (INSIGHTS allowlist only)
**Subject:** `Public Profile API allowlist — new OAuth Client ID [NEW_CLIENT_ID] (Digital Sukoon / PostAutomation) — ref Case #05443628`

```
Hi Public Profile API team,

We'd like to request allowlist access to the Public Profile API for our OAuth app.
Snap Ad Support (Case #05443628) advised your team owns this process; full details
below so you can review directly. (This request is scoped to READ insights only —
our separate content-posting need is being routed through ad-support.)

Organization & app
  Organization:            DIGITAL SUKOON PRIVATE LIMITED (GST-registered, India)
  Organization ID:         25170f6b-d77f-4784-985a-0017b76fb9b9
  Primary Ad Account ID:   8bcfe784-f5a6-4157-8caf-3c09d659b08d
  OAuth App name:          PostAutomation
  OAuth Client ID:         [NEW_CLIENT_ID]
  Redirect URI:            https://postautomation.co.in/api/oauth/callback/snapchat
  Scope requested:         snapchat-profile-api
  Related support case:    #05443628
  (Supersedes our earlier Client ID 26a5531a-7692-4163-a5d8-33bfda7523ad, which
   pointed at a non-production callback and should be disregarded.)

What we're building
  PostAutomation is a multi-tenant social analytics & management platform. Public
  Profile owners (our own brands and third-party clients) connect their account and
  grant our app consent via OAuth (authorization_code grant + refresh tokens). Every
  call is scoped to a profile that has granted consent; we access no profile without
  authorization.

Access requested (Public tier, for consented Public Profiles)
  - Subscriber count, profile metadata
  - Spotlight views + shares
  - Spotlight/Story listing + captions (for content discovery / "top links")

Readiness & honest status
  - The OAuth app is registered with a valid production redirect URI (above).
  - The integration is in active development in our production app; we can provide a
    live OAuth consent-flow demonstration, screenshots, or a screen-share within
    [N] days of your review beginning.
  - Compliance: Privacy https://postautomation.co.in/privacy ,
    Terms https://postautomation.co.in/terms (both live).

Could you confirm the next steps to allowlist Client ID [NEW_CLIENT_ID], and whether
you need anything further (use-case form, app review, or an Account Manager as
intermediary)? We understand an AM assignment is pending; if AM sign-off is a hard
prerequisite, please tell us so we can coordinate.

Thank you,
Tabish
DIGITAL SUKOON PRIVATE LIMITED
admin@dashmani.com
```

---

## 7. Decision log

| Decision | Alternatives considered | Why chosen |
|----------|------------------------|-----------|
| Treat posting and insights as **two tracks** | Bundle into one ask (as the current email does) | They are different Snap products with different owners/approvals; bundling caused the stall. |
| **Create a new "PostAutomation" OAuth app** | Edit the existing "Dashmani Insights" app's redirect URI in place | Clean, correctly-named identity carries more weight in a relationship-gated review; old app had wrong name + lineage + domain. Editing in place is the fallback if you want to avoid disrupting the open case. |
| Callback at **`postautomation.co.in/api/oauth/callback/snapchat`** | `api.digitalsukoon.com/...` (the old app's URI) | PostAutomation runs on `.co.in`; every other provider uses this exact callback shape; the digitalsukoon URL has no handler. |
| **Build in THIS repo**, mirroring YouTube | Separate digitalsukoon backend | User confirmed it's this app; all 17 existing providers live here; YouTube is the exact analog (Google OAuth, refresh tokens, post + analytics). |
| **Don't cross-Cc** dev-support on the ad-support reply | Cc both (the other session's draft) | Keeps the technical thread clean of Tier-1 billing noise; case number in body is enough to link. |
| **Soften "ready to demo"** to "in active development, demo in N days" | Claim "ready for review / can demo now" | The provider isn't built; a failed reviewer consent-flow test is far costlier than a slightly slower queue. |
| Clear **account hygiene** now regardless | Wait until allowlist decision | Free, removes Snap's stated AM-eligibility objection, no downside. |
| Run the **Gate-3 test call before finishing insights build** | Build the full pipeline first | The guide's 3 unknowns (caption tier, public-stats-vs-403, creator eligibility) can each kill a capability; one call settles them and avoids wasted build. |

---

## 8. Honest risk register

- **Allowlist may be declined or slow** — external, relationship-gated, no SLA (Mel: "unable to provide a timeframe or guarantee an assignment"). Not in your control.
- **AM is the current bottleneck** — Snap won't file the allowlist without one and won't guarantee assigning one. Hygiene + a spending signal is the only lever you hold.
- **Posting approval is unmapped** — the feasibility guide never covered posting; we don't yet know Snap's exact product/scope/review for programmatic Story/Spotlight publishing. Email A asks them to point us to it. Treat posting as **higher uncertainty** than insights.
- **Insights ceiling is permanent** — no likes, no private creators for third-party profiles (only views/shares/captions on the public tier).
- **Token invalidation on config change** — expected (same as Meta/YouTube); plan the reconnect UX.
- **Two-app confusion** — mitigated by explicitly retiring `26a5531a-...` in both emails.

---

## 9. Immediate checklist (copy into your tracker)

- [ ] Add Business Address (Maharashtra, GST address) → Save
- [ ] Add Payment Method / funding source
- [ ] Complete Billing Address → checklist 4/4
- [ ] Create new OAuth app "PostAutomation" (`kit.snapchat.com/manage`), both redirect URIs, `snapchat-profile-api` + posting scope, store secret
- [ ] Record new Client ID → replace `[NEW_CLIENT_ID]` in both emails
- [ ] Send Email A (in-thread, Case #05443628, no dev-support Cc)
- [ ] Send Email B (standalone, dev-support, insights-only)
- [ ] (When token arrives) Run Gate-3 test call; record which capabilities return data
- [ ] (Build) enum+push → provider → factory/scopes/env → insights pipeline → tests
```
