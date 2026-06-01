# Design: FB/IG Connect, YouTube Shorts, AI Features, Channels-Page Cleanup

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Scope:** Four independent fixes on the existing PostAutomation codebase.

---

## 1. Facebook & Instagram Connection Failure

### Symptom
- **Normal users:** Meta shows *"This app isn't available — This app needs at least one supported permission."* and the OAuth flow never completes.
- **App admins/developers/testers:** Bypass the Meta dev-mode block, reach the consent screen, but the in-app callback still fails (no Pages / "No Instagram Business Account found").

### Root cause
This is primarily a **Meta App dashboard configuration problem**, not a code defect:
- The Meta app is in **Development/Standard mode** and/or requests permissions/products that have not been added & approved. Meta blocks all non-role users with the quoted message.
- Even admins succeed at OAuth but the **granted scopes don't return Pages / linked IG Business accounts**, so downstream channel creation throws.

The code paths are largely correct: env vars `FACEBOOK_CLIENT_ID/SECRET` and `INSTAGRAM_CLIENT_ID/SECRET` are read consistently
([channel.router.ts:152-154](../../../packages/api/src/routers/channel.router.ts), [callback route.ts:161-163](../../../apps/web/app/api/oauth/callback/[provider]/route.ts)),
and redirect URIs target the canonical `.co.in` host. Two secondary code issues compound diagnosis.

### Fix — code
1. **Redirect-URI case consistency.** `getOAuthUrl` lowercases the provider in the callback URL ([channel.router.ts:167](../../../packages/api/src/routers/channel.router.ts)), but the callback route reconstructs `redirect_uri` for token exchange from `params.provider` as-is ([route.ts:175](../../../apps/web/app/api/oauth/callback/[provider]/route.ts)). Force lowercase on the callback side so the `redirect_uri` at authorize and token-exchange match exactly (Meta rejects mismatches).
2. **Surface the real Meta error.** When the callback fails (Meta `error`/`error_description` query params, or "No IG business account" / "no pages"), pass the actual message through to `/auth/error` (or the channels page) instead of a generic `oauth_failed`. Makes future failures self-diagnosing.
3. **Scope alignment.** Keep Facebook scopes minimal and current; align Instagram scopes with current Graph API permission names. Document which scopes require App Review.

### Fix — operator runbook (the part that unblocks normal users)
Write `docs/META_APP_SETUP.md` (or extend `docs/OAUTH_SETUP.md`) with exact steps:
- Add **Facebook Login** and **Instagram Graph API** products to the Meta app.
- Add required permissions (`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`, `business_management`).
- Either add the end users as **Testers/Developers** (dev mode) OR submit those permissions for **App Review** and switch the app to **Live** mode.
- Requirement: each IG account must be a **Professional/Business** account **linked to a Facebook Page** the connecting user administers.
- Verify the two authorized redirect URIs (`https://postautomation.co.in/api/oauth/callback/facebook` and `.../instagram`).

### Out of scope
I cannot drive the Meta dashboard or App Review from here. The runbook + repro steps are the deliverable for the dashboard side.

---

## 2. YouTube Shorts Not Uploading as Shorts

### Symptom
Selecting "Short" in the compose Post Format still publishes a regular video.

### Root cause
YouTube has **no API flag** for Shorts. Classification is heuristic: **vertical aspect ratio + short duration (≤3 min)**, with `#Shorts` in title/description as a hint. Current code ([youtube.provider.ts:175-178](../../../packages/social/src/providers/youtube.provider.ts)):
- Checks `payload.content.includes("#Shorts")` but appends to `description` — inconsistent detection.
- Performs **no validation** of aspect ratio or duration, so a landscape/long video selected as "Short" silently uploads as a normal video.

The format value flows correctly end-to-end (ComposeTab → post.router → PostTarget.format → worker providerMetadata → provider).

### Fix
1. **Reliable `#Shorts` hint.** For SHORT format, ensure `#Shorts` is present in the description (correct presence check against the description string, not `content`). No duplication.
2. **Pre-upload validation (worker).** Probe video dimensions + duration with `ffprobe` (already in `docker/Dockerfile.worker`; existing FFmpeg usage pattern in [video-overlay.ts](../../../apps/worker/src/lib/video-overlay.ts) uses `execSync`). If SHORT is selected and the video is **not vertical** (width > height) or **duration > 180s**, **fail the job with a clear, actionable error** stating the actual dimensions/duration and the Shorts requirement. (Per decision: fail, do not silently upload.)
3. **No re-encoding.** We do not auto-crop/re-encode (user did not opt into auto-processing).

### Notes
- `ffprobe` ships with `ffmpeg`, already installed in the worker image. Confirm and add to Docker only if missing (it is present at `docker/Dockerfile.worker:8`).
- Validation runs only when format === "SHORT" to avoid overhead on normal videos.

---

## 3. AI Features — Fix What's Broken

### Scope (per decision: fix what's actually broken; no redesign, no new tests)
1. **Stale default model.** `getOpenAIModel` hardcodes `gpt-4-turbo` ([openai.provider.ts:5](../../../packages/ai/src/providers/openai.provider.ts)). Update to a current OpenAI model so the default text provider works.
2. **Path verification.** Confirm each AI tRPC procedure wires UI → tRPC → provider with no dead ends: `ai.generateContent`, `ai.suggestHashtags`, `ai.optimizeContent`, `repurpose.repurpose`, `image.generate`, `image.edit`. Fix any concrete breakage (error swallowing, UI-wired-but-no-backend).
3. **Report.** Produce a concise "works / needs API key / fixed" table. Features that merely need an unset API key are *configuration*, not bugs — flagged, not "fixed."

### Out of scope
Provider-abstraction redesign, env-configurable model IDs, and missing chat/image/video tests (that was the deeper "hardening" option, not chosen).

---

## 4. Remove "Max NNNN chars" Text on Channels Page

### Symptom
Each platform card shows `Max 25000 chars` (etc.), which is confusing.

### Fix
Remove the `Max ${p.constraints.maxContentLength} chars` branch from the card description at [channels/page.tsx:802](../../../apps/web/app/dashboard/channels/page.tsx). Keep the meaningful messages ("No developer app needed", "OAuth credentials missing"); render nothing where the char text was. The `maxContentLength` constant is retained — it powers server-side validation ([social.abstract.ts](../../../packages/social/src/abstract/social.abstract.ts)) and must not be deleted.

---

## Verification

- `pnpm type-check` and `pnpm build` pass after changes.
- AI feature paths exercised where API keys exist; report covers the rest.
- FB/IG: code logic verified + dashboard runbook & repro steps delivered (live Meta accounts can't be driven from here).
- YouTube Shorts: validation logic unit-checked against landscape/long inputs; `#Shorts` hint verified in the built payload.
- Channels page: visual confirmation the char text is gone and other messaging intact.

## Risk / sequencing
The four fixes are independent and can land together. The only deploy-sensitive item is FB/IG, which is gated on Meta dashboard action by the operator — code changes here are safe to ship regardless.
