# Snapchat Integration — Handoff Prompt for the Next Session

This doc has TWO prompts:
- **Prompt A — WHAT WE NEED IT FOR** (business/product context): paste this first so the session understands the goal, the users, what "done" means, and the decisions already locked. Answers *why we're doing this*.
- **Prompt B — HOW TO BUILD IT** (verified technical spec): paste this to actually execute the build. Answers *how*.

Paste A then B into the same fresh Claude Code session in this repo.

---

## PROMPT A — What we need Snapchat for (context / goal)

```
CONTEXT: what PostAutomation is and why we're adding Snapchat.

PostAutomation (https://postautomation.co.in) is a MULTI-TENANT social posting +
analytics platform — the same category as Buffer/Hootsuite. Operators and their clients
connect their OWN social accounts via OAuth ("Connect Twitter/YouTube/Facebook…"), and the
platform then (a) publishes content to those accounts on the owner's behalf and (b) reads
back per-post analytics into a unified dashboard. It already supports 17 networks
(Twitter/X, LinkedIn, Facebook, Instagram, YouTube, Reddit, Pinterest, Threads, TikTok-code,
Telegram, Discord, Slack, Mastodon, Bluesky, Medium, Dev.to, WordPress). The operator is
DIGITAL SUKOON PRIVATE LIMITED (a GST-registered Indian company); end users are the
operator's own brands AND third-party clients they manage.

WHAT WE NEED SNAPCHAT TO DO — make Snapchat a first-class channel, at parity with YouTube:
  1. CONNECT: a user clicks "Connect Snapchat", OAuths into their own Snapchat, and the
     platform stores tokens for their owned Public Profile — exactly like connecting YouTube.
     (Multi-tenant: any user who consents, not just us — our brands + third-party clients.)
  2. AUTO-POST ("Content Management" in Snap's own terms): publish Spotlights / Stories /
     Saved Stories to the connected Public Profile on the owner's behalf, from the same
     Compose / Repurpose / scheduling flows the other channels use. This is the PRIMARY goal.
  3. READ INSIGHTS ("Creator Discovery"/analytics in Snap's terms): pull per-post metrics
     (Spotlight views, story views, subscribers where available) back into the existing
     Insights/Reports dashboard, so Snapchat posts show engagement like every other channel.
  Snap's Public Profile API is literally built for both — its two documented functions are
  "Content Management" (post on behalf of brands + view analytics) and "Creator Discovery"
  (metrics/insights). One API, one scope (snapchat-profile-api), one allowlist covers both.

WHY IT MATTERS (business): clients increasingly ask for Snapchat as a channel; without it,
PostAutomation can't be their single tool for all networks. This is revenue-relevant and
livelihood-critical — treat it as production work, not a spike.

WHAT "DONE" LOOKS LIKE (acceptance criteria):
  - A user can Connect Snapchat from the Channels page and see their profile appear as a
    channel (name + avatar), just like connecting YouTube.
  - From Compose/Repurpose, a user can publish a video to Snapchat as a Spotlight or Story,
    it appears live on their Public Profile, and the post shows in the dashboard with its
    Snapchat URL/id.
  - The Insights/Reports pages show Snapchat per-post metrics (at least Spotlight views)
    flowing through the existing analytics pipeline.
  - It's built exactly like the existing providers (no bespoke architecture), all the
    mandatory build/test gates pass, and nothing claims to work that hasn't been verified
    end-to-end.

WHAT'S OUT OF SCOPE (do NOT build these):
  - "Top Links / Link Search for arbitrary creators' public share links" (the /t/→/p/
    resolver + link_content/link_metrics layer). That belongs to a different backend and is
    a separate feature. Here we only do insights for posts WE published via connected owners.
  - Paid media / ads promotion of posts.

KNOWN EXTERNAL BLOCKER (not a code bug): Snapchat gates the Public Profile API behind a
manual ALLOWLIST. Our OAuth app (Client ID 61e77c7f-6b79-4270-9304-555cabffb967) is
allowlist-pending (Snap support Case #05443628). So you can build + unit-test everything
now and verify the OAuth connect flow, but LIVE publish/stats calls return 403
AUTHORIZATION_PERMISSION_DENIED until Snap allowlists the client ID. Build for the moment
allowlisting lands; don't block on it, and don't claim live posting works until it's proven.

Now read PROMPT B for the verified technical spec and the build plan, and implement it.
```

---

## PROMPT B — How to build it (verified technical spec)

```
Implement the Snapchat channel for PostAutomation end to end — connect + auto-post
(Spotlight / Story / Saved Story) + read insights — built exactly like the existing
YouTube/Meta providers. This is CRUCIAL and livelihood-relevant: no guesswork, verify
every claim against the real code and against Snap's live docs, and prove it works before
declaring done.

════════════════════════════════════════════════════════════════════════
START HERE (do these first, in order)
════════════════════════════════════════════════════════════════════════
1. Read docs/SNAPCHAT-BUILD-PLAN.md IN FULL — it is the authoritative 11-phase plan,
   already adversarially verified against this codebase (every step cites a real
   file:line to mirror). Follow it.
2. Read the memory file project-snapchat-integration-2026-07-18.md and the CLAUDE.md
   "SNAPCHAT — PLANNED, NOT BUILT" note.
3. Use the `superpowers:executing-plans` skill to work through the plan, and
   `superpowers:test-driven-development` for the provider (write the provider test first —
   the codebase treats getDefaultScopes arrays + the 17→18 factory count as guarded
   invariants).
4. Work on a NEW branch (e.g. feat/snapchat-provider-2026-07-18). Do NOT push or open a PR
   until I say so — the user sends the Snap allowlist emails only AFTER the code is built.

════════════════════════════════════════════════════════════════════════
VERIFIED SNAP API FACTS (from developers.snap.com, 2026-07-18) — use these, don't re-guess.
Re-confirm anything you're unsure of by fetching the live doc; do NOT invent endpoints.
════════════════════════════════════════════════════════════════════════
• ARCHITECTURE: posting AND insights are the SAME "Public Profile API" — ONE allowlist,
  ONE scope. There is NO separate posting product/team. Base host:
  https://businessapi.snapchat.com/v1/public_profiles/{profile_id}/...
• OAuth app (already created by the user):
    - Name: PostAutomation
    - Client ID: 61e77c7f-6b79-4270-9304-555cabffb967
    - Redirect URI: https://postautomation.co.in/api/oauth/callback/snapchat
      (Snap rejects http://localhost — HTTPS only. For LOCAL dev testing you need an
       HTTPS tunnel, e.g. `ngrok http 3000`, and register that https URL as a 2nd redirect
       URI + point APP_URL at it for that session.)
    - The old app 26a5531a-... is superseded/deleted.
• OAuth endpoints:
    - Authorize: https://accounts.snapchat.com/accounts/oauth2/auth
    - Token:     https://accounts.snapchat.com/accounts/oauth2/token
      (Public Profile API docs also show a legacy /login/oauth2/access_token — prefer the
       Login Kit /accounts/oauth2/token; confirm whichever your token exchange accepts.)
    - Body: application/x-www-form-urlencoded. grant_type=authorization_code | refresh_token.
    - Access token TTL: 3600s (1h).
    - client_secret is used (confidential/server-side client). PKCE is REQUIRED ONLY for
      public clients; since we have a secret, PKCE is OPTIONAL for us. => The build plan's
      "BLOCKER-FIX: add codeChallenge to OAuthConfig + PKCE plumbing" is very likely
      UNNEEDED. Verify by doing a server-side code exchange WITHOUT PKCE against a real
      token; only add PKCE plumbing if Snap actually rejects the no-PKCE exchange.
• REFRESH ROTATES: the refresh response returns a NEW refresh_token. In refreshAccessToken
  use `refreshToken: data.refresh_token ?? refreshToken` — do NOT copy YouTube's
  reuse-the-old-token behavior, or the channel dies on the next refresh.
• SCOPE: snapchat-profile-api (space-delimited if you ever pass more than one). This one
  scope covers posting + insights.
• ALLOWLIST: still required. Until Snap allowlists Client ID 61e77c7f-..., every call
  returns 403 AUTHORIZATION_PERMISSION_DENIED. So the code must be built and unit-tested
  now, but the LIVE end-to-end publish can only be smoke-tested once allowlisting lands.
• POSTING (3 steps — authorized-tier, needs the connected owner's OAuth):
    1) Create Media: POST /v1/public_profiles/{profile_id}/media
       body: type=VIDEO|IMAGE, name, key (base64 of 32-byte AES key), iv (base64 of 16-byte IV).
       => MEDIA MUST BE CLIENT-SIDE AES-ENCRYPTED before upload (Snap decrypts server-side).
       This is different from YouTube's plain byte upload. Returns media_id + an add_path +
       finalize_path.
    2) Multipart upload: POST https://businessapi.snapchat.com/{add_path} with action=ADD,
       file=<chunk>, part_number=1..35 (≤32MB/chunk, ≤1GB total; chunks may go in parallel);
       then POST {finalize_path} with action=FINALIZE.
    3) Post: POST /v1/public_profiles/{profile_id}/spotlights
       (media_id, description ≤160 chars incl hashtags, locale e.g. en_US, skip_save_to_profile)
       OR POST /v1/public_profiles/{profile_id}/stories (media_id).
       Constraints — Spotlight: .mp4, 6–60s, ≥540×960. Story: .mp4 5–60s (or image), ≥540×960.
• INSIGHTS (getPostAnalytics):
    - Per-asset: GET /v1/public_profiles/{profile_id}/spotlights/{id}/stats
      (also stories/{id}/stats, saved_stories/{id}/stats). NOTE /v1/ NOT /public/v1/.
    - Profile-wide: GET /v1/public_profiles/{profile_id}/stats
      ?assetType=SPOTLIGHT|STORY|SAVED_STORY|PROFILE &fields=CSV &granularity=DAY|TOTAL|LIFETIME
    - Metric field names (comma-separated in `fields`): SPOTLIGHT_VIEWS (the ONLY one marked
      public-tier), VIEWS, STORY_VIEWS, STORY_FAVORITES (=likes), *_SUBSCRIBES, etc.
    - Only SPOTLIGHT_VIEWS returns for non-opted-in public creators. Likes/subscribes/most
      metrics are authorized-tier (need the owner's OAuth) => map likes=0 for public-tier
      profiles; it's correct, not a bug.
• PROFILE ID: posting/stats are keyed by the {profile_id} (UUID) the connected user OWNS.
  getProfile must resolve the connected account's owned public profile id. Posting only works
  for profiles the user administers (same class as Meta's "must admin a Page" prerequisite).
  Confirm the exact "list my public profiles" endpoint from the Profiles / Creator Discovery
  docs at build time and capture the id (carry via tokens.metadata if needed — the generic
  callback persists tokens.metadata, WordPress-style).

════════════════════════════════════════════════════════════════════════
CODEBASE FACTS (already traced + verified — mirror these; don't re-discover from scratch)
════════════════════════════════════════════════════════════════════════
• SNAPCHAT is NOT in enum SocialPlatform (schema.prisma:252-270). Add it, run `pnpm db:push`
  (NOT a migration file), then `prisma generate` so the type includes SNAPCHAT before the
  provider compiles (input.platform as any casts mask the gap — it'll fail at the DB write).
• Provider file: packages/social/src/providers/snapchat.provider.ts (NEW), modeled
  method-for-method on youtube.provider.ts. Implement getOAuthUrl, exchangeCodeForTokens,
  refreshAccessToken, getProfile, publishPost, getPostAnalytics, deletePost.
• Register in packages/social/src/abstract/social.factory.ts providerMap.
• Env by convention: SNAPCHAT_CLIENT_ID / SNAPCHAT_CLIENT_SECRET (no central schema). Add to
  .env.example + .env.production.example; set real values in the server's .env.prod.
• getDefaultScopes SNAPCHAT key in channel.router.ts (~466): ["snapchat-profile-api"].
• Callback route apps/web/app/api/oauth/callback/[provider]/route.ts uses the GENERIC
  single-account path (route.ts:439-482) — NO special branch. getProfile IS called for
  Snapchat (only INSTAGRAM is skipped) so getProfile must NOT throw for a validly-authed
  user (the 2026-07-17 IG-bug lesson) — use a clean guard/return, and never reflect raw
  provider errors into the redirect (use genericErrorRedirect + console.error).
• Media-required guard: add "SNAPCHAT" to MEDIA_REQUIRED_PLATFORMS + PLATFORM_LABEL in
  packages/api/src/lib/media-required.ts (no text-only snaps).
• Platform icon: add SnapchatIcon (yellow #FFFC00) to
  apps/web/components/icons/platform-icons.tsx or the connect card renders icon-less.
• Insights gating pre-allowlist: cron-jobs.ts:39-89 syncs all-except-FACEBOOK; to keep
  Snapchat out until allowlisted, change to notIn:['FACEBOOK','SNAPCHAT']. ALSO
  analytics.router.ts triggerSync (483-510) has NO platform filter — ADD notIn:['SNAPCHAT']
  there too, or manual "Sync Now" hits the not-yet-allowlisted endpoint. getPostAnalytics
  returning null is the safety net (analytics-sync.worker.ts already try/catches it).
• The "top links for arbitrary creators' share links" feature (canonicalKey / /t/→/p/
  resolver / link_content / link_metrics) does NOT exist in this repo — it's a different
  backend. Only "insights for posts WE published" is in scope here. Do not build the
  link-analytics layer; flag it as a separate feature if asked.

════════════════════════════════════════════════════════════════════════
GUARDRAILS (non-negotiable)
════════════════════════════════════════════════════════════════════════
• NO GUESSWORK. If a Snap endpoint/field/behavior isn't in the verified list above, fetch
  the live doc (developers.snap.com) and confirm before coding it. State every assumption.
• Encryption for media upload is real work — implement AES encrypt + base64 key/iv exactly
  as Snap's Create Media requires. Do not stub it.
• WEB vs WORKER: publishPost runs in the worker (sync ffmpeg/ffprobe OK there). Any Snapchat
  code reachable from the WEB process (packages/api, apps/web) MUST use async execFile with
  an argv array — never execSync/execFileSync/spawnSync (CLAUDE.md edge-reliability rule).
• TESTS: write provider OAuth/token tests mirroring oauth-flow.test.ts (assert space-joined
  scope, the verbatim "Snapchat token exchange failed" throw, refresh prefers
  data.refresh_token ?? refreshToken). Update the factory-count test 17→18 (intentional
  break = the registration guard). Add a getDefaultScopes("SNAPCHAT") scope-lock test.
• VERIFY BEFORE DONE (mandatory gates):
    - SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build   # MUST exit 0
      (SWC is stricter than tsc — tsc alone is NOT sufficient for apps/web changes)
    - pnpm --filter @postautomation/social test && pnpm --filter @postautomation/api test
    - pnpm type-check   (root — confirms @postautomation/db type includes SNAPCHAT)
    - Use the `verification-before-completion` skill. Do NOT claim it works from types/tests
      alone — drive the connect flow (with the ngrok HTTPS redirect for local) and, once Snap
      allowlists the client ID, publish one real Spotlight/Story and confirm the returned id.
• HONESTY: until the allowlist lands and a real post succeeds, UI/status copy must NOT claim
  Snapchat publishing/insights "works". Ship it behind the normal "Setup required"/pending
  state if unverified end-to-end (CLAUDE.md honesty convention).
• When done, update CLAUDE.md's "SNAPCHAT — PLANNED, NOT BUILT" note and the memory file to
  reflect the real shipped state, and tell me what was verified live vs. still pending
  allowlist.

Deliverable: a working Snapchat provider (connect + post + insights) that passes all gates,
with the live-publish path verified as far as the allowlist currently allows, and a clear
report of what remains blocked on Snap's allowlist.
```

---

## Notes for you (Tabish) — not part of the prompt

- **Send the emails AFTER the build**, as you said. Because posting+insights turned out to be one API/one allowlist, you can simplify the two drafted emails into a single clean allowlist request if you prefer (the drafts still work as-is — they just over-split). The updated emails with your real Client ID are in the chat above; the plan docs have the full versions.
- **The live end-to-end test is gated on Snap allowlisting `61e77c7f-...`.** The next session can build + unit-test everything now, and verify the OAuth connect flow via an ngrok HTTPS tunnel, but the real publish/stats calls will 403 until allowlisting lands. That's expected — not a code bug.
- **Biggest correction from the research:** posting and insights are the same Public Profile API with one scope (`snapchat-profile-api`) and one allowlist — not two separate Snap products. Your existing `profile-api-dev-support` thread is the right channel for the whole thing.
