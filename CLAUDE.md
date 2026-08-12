# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Project

**Posting-Automation** — multi-channel social posting platform. Next.js web app + BullMQ worker, backed by Postgres, Redis, and S3-compatible storage. Deployed to a Linode VPS via Docker Compose.

- Repo: https://github.com/dmpl6454/Posting-Automation.git
- **Canonical domain:** `https://postautomation.co.in` (Google OAuth callback registered here; sitemap, metadataBase, SMTP From all use this host).
- **Secondary domain:** `https://postautomation.in` — nginx 301-redirects all traffic to `.co.in` (preserves path + query). Do NOT serve the app from `.in` directly; OAuth and session cookies are scoped to the canonical host.
- Hosting: Linode VPS, deploy user `deploy`, app dir `/home/deploy/postautomation`
- SSH alias: `posting-automation` (configured in `~/.ssh/config`)

## Stack

- **Package manager**: pnpm@9.15.0 (NOT npm). Node >= 20.
- **Monorepo**: Turborepo (`turbo.json`, `pnpm-workspace.yaml`)
- **Web**: Next.js, port 3000 — [apps/web](apps/web/)
- **Worker**: BullMQ — [apps/worker](apps/worker/)
- **DB**: Postgres 16 + Prisma — [packages/db](packages/db/)
- **Queue**: Redis 7 — [packages/queue](packages/queue/)
- **Storage**: MinIO locally / S3 in prod
- **Auth**: NextAuth (Auth.js core, patched — see [patches/](patches/))
- **Deploy**: Docker Compose ([docker-compose.prod.yml](docker-compose.prod.yml)), GitHub Actions

## Workspace layout

```
apps/
  web/           @postautomation/web — Next.js app
  worker/        @postautomation/worker — BullMQ worker
packages/
  ai/            AI provider abstraction (OpenAI, Anthropic, Gemini, etc.)
  api/           Shared API layer
  auth/          NextAuth config
  billing/       Stripe integration
  db/            Prisma schema, client, migrations
  logger/        Shared logger
  queue/         BullMQ queue definitions
  social/        Social platform OAuth + posting (Twitter, LinkedIn, FB, IG, Reddit, YouTube, TikTok, Pinterest)
docker/          Dockerfiles (web, worker, migrate) + nginx config
scripts/         deploy.sh, server-setup.sh
.github/workflows/  CI/CD (deploy to Linode)
```

## Local setup

1. Install deps: `pnpm install`
2. Start infra: `docker compose up -d` (Postgres on 5433, Redis on 6380, MinIO on 9000/9001)
3. Copy env: `cp .env.example .env` and fill in secrets
4. Generate NextAuth secret: `openssl rand -base64 32` → `NEXTAUTH_SECRET`
5. Push schema: `pnpm db:push`
6. Seed (optional): `pnpm db:seed`
7. Run dev: `pnpm dev` (Turborepo runs web + worker)

Web: http://localhost:3000 · MinIO console: http://localhost:9001 (minioadmin/minioadmin)

## Common commands

```bash
pnpm dev               # turbo dev — all apps
pnpm build             # turbo build
pnpm lint              # turbo lint
pnpm type-check        # turbo type-check
pnpm test              # turbo test (vitest)
pnpm db:push           # prisma db push (no migration file)
pnpm db:migrate        # prisma migrate dev
pnpm db:seed           # seed dev data
pnpm db:studio         # prisma studio
pnpm db:backfill-orgs  # one-time: create personal orgs for users who have none (idempotent)
pnpm clean             # turbo clean + nuke node_modules
```

Filter to one workspace: `pnpm --filter @postautomation/web <cmd>`

## Environment variables

- **Local**: `.env` (gitignored). Template: [.env.example](.env.example).
- **Production**: `.env.production` on the server (gitignored). Template: [.env.production.example](.env.production.example).
- Many OAuth/API credentials are intentionally left blank (Twitter, LinkedIn, FB, IG, Reddit, YouTube, TikTok, Pinterest, OpenAI, Anthropic, Gemini, Stripe, Resend, Hunter, Sentry). The app boots without them; affected features just don't work until filled in.
- **Configured in production**: `AUTH_GOOGLE_ID/SECRET`, `AUTH_SECRET`/`NEXTAUTH_SECRET`, `SMTP_*` (Google Workspace), `TWITTER_CLIENT_ID/SECRET` (live — Consumer Key/Secret, public posting active), plus the Meta + YouTube OAuth creds. GitHub OAuth was removed — not needed. (TikTok creds intentionally unset — blocked by the India ban; see Channel Connections → TikTok specifics.)

## Deployment

- **Method**: Docker Compose on Linode VPS (NOT PM2)
- **First-time server bootstrap**: `bash scripts/deploy.sh setup`
- **Routine deploys**: `bash scripts/deploy.sh deploy` (also triggered by GitHub Actions on push to `main`)
- **Containers built**: `web`, `worker`, `migrate` (all three must be rebuilt on each deploy — see quirks below)

### Production quirks (read before debugging deploys)

1. **`.env.production` symlink**: The server's real env file is `.env.prod`, but `deploy.sh` looks for `.env.production`. A symlink exists: `/home/deploy/postautomation/.env.production -> .env.prod`. If you wipe/re-clone on the server, recreate the symlink or the deploy will fail with `.env.production not found`.

2. **Migrate container must rebuild every deploy**: `docker/Dockerfile.migrate` bakes in a copy of `packages/db/prisma/schema.prisma`. If only `web`/`worker` rebuild, the migrate container runs a stale schema and `prisma db push` may propose dropping live tables. Fixed in commit `17f260b` — but if a deploy ever proposes dropping tables, first check `docker inspect postautomation-migrate:latest --format='{{.Created}}'` vs `postautomation-web:latest`.

3. **Prisma `_AB_unique` on implicit M:N tables**: Newer Prisma drops the redundant `_AB_unique` constraint on implicit join tables. If `prisma db push` fails with `cannot drop index "_XXX_AB_unique" because constraint ... requires it`, run `ALTER TABLE "_XXX" DROP CONSTRAINT "_XXX_AB_unique";` manually, then retry. Safe — the PK already enforces the same uniqueness.

4. **Worker Docker build (canvas / pixman-1)**: **Fixed in QA_FIX_PLAN_V2 Module 9** — `docker/Dockerfile.worker` now installs `cairo-dev pango-dev jpeg-dev giflib-dev pixman-dev librsvg-dev build-base python3 pkgconfig` plus runtime libs (`cairo pango jpeg giflib pixman librsvg`). The worker container now builds cleanly with `canvas@2.x`. If a deploy ever proposes dropping the worker container, do NOT do a partial deploy — use the standard `bash scripts/deploy.sh deploy`. The older partial-deploy escape hatch is no longer needed but kept here for emergencies: `docker compose -f docker-compose.prod.yml --env-file .env.production build web migrate && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps web migrate`

5. **S3 key naming:** `apps/web/app/api/upload/route.ts` reads `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (AWS standard names) with `|| S3_ACCESS_KEY || S3_SECRET_KEY` fallbacks. `.env.example` uses the short names; production `.env.prod` must have at least one of each pair set or uploads will fail silently with "Upload failed" toast. Local `.env` should have `S3_ACCESS_KEY_ID=minioadmin` and `S3_SECRET_ACCESS_KEY=minioadmin` alongside the short-name variants. Also: the local MinIO bucket `postautomation-media` must exist — create it once with `docker exec dashmani-postautomation-minio-1 mc mb local/postautomation-media && docker exec dashmani-postautomation-minio-1 mc anonymous set download local/postautomation-media`.

7. **YouTube invalid_grant after scope change:** If the OAuth consent screen scopes are changed (e.g. adding `youtube.readonly`) after a user has already connected a channel, Google invalidates their existing refresh token. The next publish attempt will fail with "Access token expired". Fix: user disconnects the channel and reconnects via OAuth to get fresh tokens with the updated scopes. This is expected Google OAuth behaviour — no code change can prevent it.

8. **Upload route error surfacing:** `apps/web/app/api/upload/route.ts` now wraps both `file.arrayBuffer()` and `s3.send()` in try/catch and returns descriptive JSON errors. If uploads fail, check the `pnpm dev` terminal for `[upload]` prefixed logs showing the exact S3 or body-read error. The generic "Upload failed" toast with no detail means the catch blocks aren't firing — check for a 401/403 auth response instead.

6. **`.env.production` symlink lost**: If `.env.production` points to a broken symlink, recreate `.env.prod` from the running container: `docker inspect postautomation-web-1 --format "{{json .Config.Env}}" | python3 -c "import json,sys; [print(e) for e in sorted(json.load(sys.stdin)) if e.split('=')[0] not in {'PATH','NODE_VERSION','YARN_VERSION','PUPPETEER_EXECUTABLE_PATH','PUPPETEER_SKIP_CHROMIUM_DOWNLOAD','SKIP_ENV_VALIDATION','PORT','HOSTNAME','NODE_ENV'}]" > .env.prod`. **Important:** that recovery captures only what the web container reads at runtime — `DATABASE_URL` and `REDIS_URL` come through, but the raw `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `TWITTER_BEARER_TOKEN`, `OLLAMA_BASE_URL`, and `META_AD_LIBRARY_ACCESS_TOKEN` keys (which compose substitutes at compose-up time) are **not** baked into the container env and will be missing. After running it, also extract those from the worker (`docker exec postautomation-worker-1 env | grep -E "REDIS_URL|DATABASE_URL"` to read the passwords back out of the URLs) and append the five keys to `.env.prod`. Without them, the next deploy will fail with `P1000: Authentication failed against database server` because compose silently substitutes empty strings into `DATABASE_URL`, while the postgres role still expects the original password.

9. **⚠️ NEVER hand-edit tracked files (`docker-compose.prod.yml`, `nginx.conf`, etc.) directly on the server via SSH — always commit the change and deploy through git.** `deploy.sh update` ([scripts/deploy.sh](scripts/deploy.sh)) runs a bare `git pull origin main` with no stash/reconciliation step. If the server's working tree has ANY uncommitted local diff on a tracked file, and a later commit on `main` touches that same file, `git pull` aborts with `error: Your local changes ... would be overwritten by merge` — even when the local diff and the incoming commit are byte-identical. This is not a one-time failure: it silently blocks **every subsequent deploy** until someone notices and SSHes in to reconcile it. **Incident 2026-07-15:** an SMTP env-var fix was applied by hand on the server on 2026-07-10 (to unblock things quickly) instead of only via a merged commit, and never reconciled — it left prod stuck 5 days and 2 merged PRs (#116, #117) behind, both failing identically at the `git pull` step, with zero indication in the GitHub Actions UI beyond a generic red X on "Deploy via SSH." **If a deploy ever fails at "Deploy via SSH" / "Pulling latest code":** SSH in (`ssh posting-automation`), `cd /home/deploy/postautomation`, run `git status` — if it shows `modified:` on a tracked file, diff it against the incoming commit; if identical, `git checkout -- <file>` to discard, then re-run `bash scripts/deploy.sh update`. If the local diff is NOT identical to what's incoming (i.e. represents real unrecorded prod-only config), stop and reconcile manually — do not blindly discard. **The actual fix is behavioral, not technical:** any prod config change belongs in a commit on a branch, merged via PR, deployed via the normal pipeline — never applied ad hoc on the box, even as a "temporary" measure, even to unblock an incident. If a change absolutely must be hotfixed live on the server, immediately follow up in the same session with a matching commit + `git pull` to bring the tree back in sync before ending the session.

10. **⚠️ Adding a workspace package? `docker/Dockerfile.worker` needs TWO lines, not one — and you CANNOT validate it by building from your working tree.** The worker image is multi-stage: the **deps** stage copies each package's `package.json` then runs `pnpm install`, and the **builder** stage copies each package's installed `node_modules` back, **one explicit `COPY --from=deps` per package**. Add a package to only the first list and the image builds fine but the worker dies at boot with `Cannot find module '<dep>'` — pnpm's isolated layout means a dep is reachable ONLY via `packages/<pkg>/node_modules`, which never got copied. **Incident 2026-07-28:** `packages/super-text` was added to the `package.json` list but not the `node_modules` list; the worker crash-looped on `Cannot find module 'zod'`, taking down ALL queue processing (publishing, analytics sync, autopilot) for ~19 min. Web was unaffected (it is a single-stage build, so its in-image `pnpm install` survives). **The trap that let it through pre-flight: `.dockerignore` is EMPTY.** `COPY packages/ ./packages/` therefore copies the developer's LOCAL `node_modules`, so an image built from a working tree resolves deps that a server build — a clean `git pull` checkout with no `node_modules` — cannot. A local `docker build .` is NOT a valid deploy check. **Validate a new package like this:**
    ```bash
    rm -rf /tmp/cleanbuild && mkdir -p /tmp/cleanbuild
    git ls-files -z | tar --null -T - -cf - | tar -xf - -C /tmp/cleanbuild   # tracked files only
    cd /tmp/cleanbuild && docker build -f docker/Dockerfile.worker -t cleanworker .
    docker run --rm cleanworker sh -c "ls /app/packages/<pkg>/node_modules/"  # deps present?
    docker run --rm -e DATABASE_URL=postgresql://x:x@127.0.0.1:5432/x -e REDIS_URL=redis://127.0.0.1:6379 \
      cleanworker sh -c "cd /app && ./node_modules/.pnpm/node_modules/.bin/tsx apps/worker/src/index.ts" | head -30
    ```
    Smoke-testing a library function inside the image is NOT sufficient — it exercises a different resolution path than the worker entrypoint. **Boot the actual worker.**

## Authentication

NextAuth v5 beta (`next-auth@^5.0.0-beta.25`), PrismaAdapter, JWT sessions (30 days).

**Env vars required (production):** All of these must be set on the server, with `AUTH_SECRET === NEXTAUTH_SECRET`:
- `AUTH_SECRET` — NextAuth v5 reads this preferentially.
- `NEXTAUTH_SECRET` — same value (middleware / older import paths still read it).
- `AUTH_URL=https://postautomation.co.in` — canonical site URL for NextAuth v5.
- `NEXTAUTH_URL=https://postautomation.co.in` — kept for backwards compat with tRPC client / other callers.
- `AUTH_TRUST_HOST=true` — also set via `trustHost: true` in [packages/auth/src/config.ts](packages/auth/src/config.ts). Both must agree in proxied deployments.

**Domain canonicalization:** Nginx 301-redirects `postautomation.in` → `postautomation.co.in` so that all OAuth callbacks and session cookies live on the registered domain. Hitting the app directly on `.in` will silently bounce to `.co.in` before any auth logic runs. The Google OAuth client in Cloud Console has exactly two authorised redirect URIs: `https://postautomation.co.in/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`.

**Auth error page:** custom page at [apps/web/app/auth/error/page.tsx](apps/web/app/auth/error/page.tsx); declared via `pages.error: "/auth/error"`. Replaces NextAuth's default black "Server error" page. Receives `?error=<code>` and maps each NextAuth error code (Configuration, AccessDenied, OAuthAccountNotLinked, CredentialsSignin, etc.) to a friendly title + description.

**Providers:** Google and Credentials (email/password + phone OTP). GitHub was intentionally removed — Google + credentials covers all use cases.

**Unified email identity:** Same email = same user regardless of sign-in method. Enforced via:
- `allowDangerousEmailAccountLinking: true` on OAuth providers (links to existing credentials account)
- Case-insensitive, lowercased email storage
- Register route rejects re-registration with an OAuth-only email
- Login page detects OAuth-only users and shows the correct provider button
- `events.createUser` auto-creates a personal workspace org for new OAuth sign-ups

**Backfill:** If users exist without orgs (e.g. signed up via OAuth before `events.createUser` was added), run `pnpm db:backfill-orgs` once after deploying. The command uses `NODE_PATH=packages/db/node_modules` so `@prisma/client` resolves correctly. On production run it directly via docker exec:
```bash
docker exec postautomation-web-1 sh -c 'cd /app && NODE_PATH=/app/packages/db/node_modules /app/packages/db/node_modules/.bin/tsx scripts/backfill-user-orgs.ts'
```
Already ran on production 2026-05-26 — all users had orgs, nothing to fix.

## Email (SMTP)

Transactional emails (password reset, email verification) are sent via nodemailer (`packages/api/src/lib/email.ts`). If `SMTP_HOST` is not set, emails fall back to console logging — the app does not crash.

**Provider:** Google Workspace (`smtp.gmail.com:587`, STARTTLS). Sending account: `hr@digitalsukoon.com`.
**From:** `PostAutomation <hr@digitalsukoon.com>`

Required env vars (same keys in `.env` and `.env.prod`):
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=hr@digitalsukoon.com
SMTP_PASS=<Google App Password>   # myaccount.google.com/apppasswords
SMTP_FROM=PostAutomation <hr@digitalsukoon.com>
```

> **Google App Password:** 2-Step Verification must be enabled on the Google account. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create an app password for "Mail", and use that 16-character code as `SMTP_PASS`.

**Forgot-password security invariants** (in `packages/api/src/routers/auth.router.ts`):
- Always returns `{ success: true }` — never leaks whether an email exists
- Silently skips banned users, deleted users, and OAuth-only accounts
- `resetPassword` sets `passwordChangedAt` on the user and deletes all DB sessions
- JWT callback invalidates any token issued before the most recent `passwordChangedAt` (forces re-login everywhere after a reset)

## Channel Connections

Two connection paths exist:

### Token-based (no operator setup required)
Users enter their own credentials directly in a dialog. Implemented via `connectWithToken` tRPC mutation + per-platform validators in [packages/api/src/lib/channel-token-validators.ts](packages/api/src/lib/channel-token-validators.ts).

| Platform | What the user provides |
|----------|----------------------|
| TELEGRAM | Bot token (from @BotFather) + chat ID (auto-detected via `detectTelegramChats` mutation) |
| DISCORD | Webhook URL (from Discord channel settings) |
| BLUESKY | Handle + app password (from Bluesky settings) |
| MASTODON | Instance URL + access token (from Mastodon developer settings) |
| WORDPRESS | Site URL + username + application password (self-hosted WP REST API) |
| MEDIUM | Integration token (from Medium settings) |
| DEVTO | API key (from dev.to settings) |

### OAuth (operator must register an app per platform)
Requires `<PLATFORM>_CLIENT_ID` and `<PLATFORM>_CLIENT_SECRET` env vars. Until set, the Connect button shows "Setup required". Guide: [docs/OAUTH_SETUP.md](docs/OAUTH_SETUP.md).

Platforms: TWITTER, LINKEDIN, FACEBOOK, INSTAGRAM, REDDIT, YOUTUBE, TIKTOK, PINTEREST, THREADS, SLACK.

The `platformAuthInfo` tRPC query tells the UI which type each platform is and whether OAuth platforms are configured.

**🟡 SNAPCHAT — CONNECT-ONLY SLICE BUILT (branch `feat/snapchat-connect-2026-07-18`, 2026-07-18); posting/insights stubbed pending allowlist.** Built + live-verified: `SNAPCHAT` enum, [snapchat.provider.ts](packages/social/src/providers/snapchat.provider.ts) (OAuth authorize/token/refresh + `getProfile` via `/v1/public_profiles/my_profile`), factory registration, `snapchat-profile-api` scope, ghost icon, media-required guard, 12 provider tests + factory-count 18. UI verified in a real browser: the Snapchat card renders "Click to connect" and clicking redirects to Snap's live OAuth (`accounts.snapchat.com/accounts/oauth2/auth?client_id=61e77c7f-…&scope=snapchat-profile-api` — Snap recognizes the app). Callback probes return clean opaque errors. **`publishPost`/`deletePost` deliberately THROW "not available yet"** and `getPostAnalytics` returns null — do NOT wire posting until the allowlist lands AND the media pipeline (client-side AES encrypt → Create Media → multipart `add_path`/`finalize_path` → POST spotlights/stories) is built per [docs/SNAPCHAT-BUILD-PLAN.md](docs/SNAPCHAT-BUILD-PLAN.md). A live connect currently 403s at `getProfile` (allowlist-gated `my_profile`) — expected, not a bug. Snap-side OAuth app is created (name **PostAutomation**, Client ID `61e77c7f-6b79-4270-9304-555cabffb967`, redirect `https://postautomation.co.in/api/oauth/callback/snapchat`), allowlist request pending (Case #05443628). **Verified from developers.snap.com:** posting AND insights are the SAME Public Profile API (`businessapi.snapchat.com/v1/public_profiles/{profile_id}/…`), ONE scope `snapchat-profile-api`, allowlist-only (403 `AUTHORIZATION_PERMISSION_DENIED` until allowlisted). Auth `accounts.snapchat.com/accounts/oauth2/auth`+`/token`, refresh ROTATES the refresh_token, access TTL 1h. Posting = 3-step: Create Media (`POST …/media`, media must be **client-side AES-encrypted**, base64 key+iv) → multipart upload (`add_path`/`finalize_path`, ADD/FINALIZE, ≤32MB/chunk, ≤1GB) → `POST …/spotlights` (mp4 6–60s ≥540×960, description ≤160c, locale) or `…/stories`. Insights `GET …/spotlights/{id}/stats` — only `SPOTLIGHT_VIEWS` is public-tier (likes/subscribes need owner opt-in). **Full build plan: [docs/SNAPCHAT-BUILD-PLAN.md](docs/SNAPCHAT-BUILD-PLAN.md); Snap-side/emails: [docs/SNAPCHAT-INTEGRATION-PLAN.md](docs/SNAPCHAT-INTEGRATION-PLAN.md); implementation handoff: [docs/SNAPCHAT-HANDOFF-PROMPT.md](docs/SNAPCHAT-HANDOFF-PROMPT.md).** Model the provider on YouTube (post + analytics + refresh); callback uses the generic single-account path (no special branch). Update this note to "LIVE" only after it ships + a real post/allowlist is verified.

**YouTube specifics — LIVE in production for all users (2026-06-09):** Uses the same Google Cloud project as Google sign-in (`Post Automation Web` OAuth client) but needs a separate set of env vars (`YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`, both set on prod). The app requests two scopes: `youtube.upload` (for posting) AND `youtube.readonly` (required by `getProfile` → `channels.list` API — without it you get 403 PERMISSION_DENIED). Redirect URI: `${APP_URL}/api/oauth/callback/youtube` (= `https://postautomation.co.in/api/oauth/callback/youtube`, registered on the OAuth client alongside the localhost variant).

- **Google verification COMPLETE (2026-06-09).** Google Auth Platform → **Data access** = *verified* (both sensitive scopes approved for the public), **Audience → Publishing status** = *In production*, **User type** = *External*. Public, no-allowlist, no "unverified app" warning. Any external Google account can connect their own channel and post — verified end-to-end via code trace (connect→store→post.create→worker publish has NO plan gate / allowlist / superadmin / test-user check beyond the normal `enforcePlanLimit("postsPerMonth")` at post-creation).
- **OAuth user cap (100) does NOT apply now.** The Audience page still *displays* a lifetime user-cap counter (e.g. "4 / 100") — that's historical accounting from the pre-verification period. Google's own text: the cap "does not apply if you are only requesting approved sensitive or restricted scopes." Our request is exactly the two approved scopes, so there is no cap and no unverified-app screen. Not a throttle.
- **Do NOT click "Back to testing" or "Make internal"** on the Audience page — either would re-lock connect (to the test-user allowlist / to the Workspace domain respectively). No reason to touch them.
- **Existing pre-verification connections have DEAD refresh tokens** (the scope/consent changes during verification invalidated them — see quirk #7 below). Those users (incl. earlier test connections) must Disconnect → reconnect ONCE to mint fresh tokens. `prompt: "consent"` in `getOAuthUrl` ([youtube.provider.ts](packages/social/src/providers/youtube.provider.ts)) guarantees a reconnect re-issues a refresh token. New connections from 2026-06-09 onward are clean.

**Twitter / X specifics — LIVE in production for all users (2026-06-06):**

- **Protocol is OAuth 1.0a, NOT OAuth 2.0.** [twitter.provider.ts](packages/social/src/providers/twitter.provider.ts) reads `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` as the **Consumer Key + Secret** (the "OAuth 1.0 Keys → Consumer Key" in the X Developer Console — **NOT** the "OAuth 2.0 Keys → Client ID", which is a different `UWZ5...`-style base64 value that will 401 against `oauth/request_token`). The connect flow is 3-legged: request_token → user authorize → access_token, HMAC-SHA1 signed. Tokens never expire (`refreshAccessToken` throws by design).
- **The scope arrays in `getDefaultScopes` (`tweet.read`, etc.) are decorative for Twitter** — OAuth 1.0a sends no per-request scopes; permissions are fixed at app-registration time ("Read and write" in the portal). Don't "fix" them.
- **Request-token secret is held in process memory** ([oauth1a-temp-store.ts](packages/social/src/utils/oauth1a-temp-store.ts), 10-min TTL). Fine on the single-container prod deploy; would break under horizontal scaling / mid-flow restart. Symptom: "request token secret not found or expired" on a clean connect attempt → just retry.
- **Public, multi-user posting = a BILLING gate, not a free review (unlike FB/YT).** Every post by every user is billed to the operator's enrolled X account; there is NO free "submit for review → open to public" path.
  - **App is on "Pay Per Use" and was MOVED from the Development → Production environment slot** (X Console → Apps → Move). This unlocked authorization for arbitrary (non-test) users. The move keeps the same keys/app ID (no redeploy needed). **Verified 2026-06-06:** a second, ordinary Twitter account connected + posted successfully.
  - On Pay Per Use, posting **draws down a loaded credit balance** — a saved card alone is NOT enough; credits must be purchased (Billing → Credits) or every post fails with `{"title":"CreditsDepleted", .../2/problems/credits}`. The alternative is a flat subscription tier (**Basic ~$100/mo ≈ 50k writes/mo**, Pro ~$5k/mo). The per-org `enforcePlanLimit(postsPerMonth)` is what protects the shared quota from one org draining it.
- **Account:** dev account `@admnaccn` (X account id `2063190127115968512`, project `33027825`). Redirect URIs registered (both): `http://localhost:3000/api/oauth/callback/twitter` and `https://postautomation.co.in/api/oauth/callback/twitter`. App permissions: Read and write; type: Web App.
- **Token invalidation:** regenerating the Consumer Key/Secret in the portal invalidates ALL stored Twitter tokens → users must reconnect (the OAuth 1.0a analogue of the YT `invalid_grant` quirk).
- **Analytics needs a paid tier:** `getPostAnalytics` hits `/2/tweets/{id}?tweet.fields=public_metrics` which 403s on Free; posting works regardless.
- Full operator guide: [docs/TWITTER_TIKTOK_SETUP.md](docs/TWITTER_TIKTOK_SETUP.md).

**TikTok specifics — code-ready, but BLOCKED by the India ban (2026-06-06):**

- **Code is complete and fixed** (commit on `fix/audit-2026-06-06`): env var standardized to `TIKTOK_CLIENT_ID` (the OAuth connect/publish paths + the "Setup required" gate read `${PLATFORM}_CLIENT_ID`; the value pasted is still TikTok's "Client Key"; analytics workers keep a `TIKTOK_CLIENT_ID || TIKTOK_CLIENT_KEY` fallback) and `getDefaultScopes` now has `TIKTOK: ["user.info.basic", "video.publish", "video.upload"]` (was empty `[]` → authorize URL had `scope=""` → TikTok rejected it). Provider is video-only (`PULL_FROM_URL` Direct Post, 287 MB, no programmatic delete).
- **🚫 Cannot be set up or used from India.** TikTok has been banned in India since 2020-06-29. `developers.tiktok.com` is unreachable from an Indian IP, so the operator cannot register the app / get the Client Key / pass the Content Posting API audit; and Indian end users are blocked regardless. **TikTok is shelved for this (India-based) operation** unless run via a non-India developer egress AND targeting a non-India user base. No code change fixes this — it's a geo/legal block.
- **Sandbox/audit gate (if ever pursued abroad):** until the Content Posting API review is approved, the app is an *unaudited client* — test users only + all posts forced `SELF_ONLY` (private). Provider defaults `privacy_level: SELF_ONLY`; public posting needs `payload.metadata.privacyLevel` plumbed from the compose UI post-approval. This is TikTok's analogue of Meta Advanced Access.

### Facebook / Instagram (Meta) specifics — read before debugging FB/IG

- **One Meta app for both:** "Post Automation 2", App ID `298449321694397` (Business type, Live, business-verified + Tech-Provider verified). Env vars: `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET` and `INSTAGRAM_CLIENT_ID`/`INSTAGRAM_CLIENT_SECRET` (same App ID + secret for both). Redirect URIs (Facebook Login for Business → Settings, Strict Mode + Enforce HTTPS ON, lowercase, `.co.in` only): `https://postautomation.co.in/api/oauth/callback/facebook` and `.../instagram`.
- **App settings → Advanced → "Native or desktop app?" MUST be OFF.** If ON, the server-side `client_secret` token exchange fails with `OAuthException code:1 "the app is configured as a desktop app"`. (Fixed 2026-06-02.)
- **IG is posted via FB Pages:** the app resolves Instagram through `me/accounts → instagram_business_account`. A connecting user's IG must be a **Professional/Business account linked to a Facebook Page they admin**, else connect returns `?error=ig_no_business_account` and there's nothing to publish to. The count of IG accounts a user sees on connect = the subset of their admined Pages that have a linked IG Business account — NOT "their IG accounts".
- **⚠️ App Review SUBMISSION 1 (2026-06-03) REJECTED → resubmission prepared 2026-06-22 (BLOCKED by Data Access Renewal, see below).** `instagram_manage_comments` → **"Disallowed Use Case" (Dev Policy 1.6)** — Meta correctly determined the perm isn't needed: `getPostAnalytics` ([instagram.provider.ts](packages/social/src/providers/instagram.provider.ts)) only reads the `comments_count` integer (which rides on `instagram_basic`), never reads/creates/hides/deletes comment threads. **Dropped from `getDefaultScopes` INSTAGRAM 2026-06-17, PR #89 `08a9544`, CONFIRMED LIVE on prod 2026-06-22** (verified inside the running web container: `.next/server`=0 occurrences; the sole `getDefaultScopes` array at `channel.router.ts:446` = the 6 scopes; raw-grep hits were all `.next/cache` build-scratch + 1 comment) (do NOT re-add without building real comment moderation). The other 6 (`instagram_content_publish, instagram_basic, pages_read_engagement, pages_manage_posts, business_management, pages_show_list`) → **"Screencast Not Aligned with Use Case Details"** — use cases fine, but the screencast (`ApprovalForMeta.mov`) showed the Facebook **returning-user** dialog ("Continue as … / previous settings") instead of the **first-time permission-grant consent screen with the scope checklist**, the IG grant was a blank flash, and there was no audio/captions. **FIXED 2026-06-22:** re-recorded via Loom, frame-by-frame VERIFIED satisfactory — both FB (≈1:24) and IG (≈4:30) now show Meta's **"Review Post Automation 2's access request"** screen listing all 6 scopes with cursor on Save (presenter clicked "Edit settings" to force the full grant wizard past the returning-user dialog), plus live FB+IG posts and Analytics, with audio narration. Final submission file `MetaNewSubmission_final.mp4` (in `~/Downloads`) = the Loom video with 130s of publish-wait dead-air trimmed + English captions burned in (this Homebrew ffmpeg lacks libass → captions rendered as PIL PNG `overlay` per cue; scripts in session scratchpad). Resubmission form filled (6 perms, video, non-contradictory reviewer notes declaring "standard web app using Facebook Login for Business, browser OAuth, NOT server-to-server"). See memory `project-meta-app-review-rejection-2026-06-17`.
- **⚠️ Data Access Renewal GATES App Review submission (2026-06-22).** Meta now requires the periodic **Data Access Renewal** (re-affirming data-handling for already-approved scopes `public_profile`+`email`; due Aug 19 2026) to be **cleared before a new App Review request can be submitted** — "Submit for review" is greyed out with "Complete data access renewal requirements to submit for App Review" until then. The renewal is its **own separate submission** (~10-day processing); clearing it only **unlocks** the App Review button — you must then go to App Review → Requests → Submit for review and submit the 6 perms. The **same `MetaNewSubmission_final.mp4`** serves both (renewal doc field is optional; renewal is judged mostly on the data-handling answers — processors=No, controller=Digital Sukoon Private Limited/India, nat-sec=No, policies=None — plus the live privacy policy `https://postautomation.co.in/privacy`). Do NOT change app config (scopes/redirect URIs) during the wait (invalidates tokens / resets review). Rotate test creds `tabish@dashmani.com / admin@123` after approval.
- **Permissions need App Review Advanced Access for the public.** Of the requested scopes only `public_profile` (+ `email`, auto-granted) work for non-app-role users. `pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management` all require **Advanced Access via App Review**. Until approved, ordinary users get Meta's "This app needs at least one supported permission" screen; only app roles (admin/dev/tester) can connect. Scopes in `channel.router.ts getDefaultScopes` (`email` dropped 2026-06-02, `instagram_manage_comments` dropped 2026-06-17 after rejection — both slim the review).
- **App Review "test API call" gate:** the dashboard won't activate a permission's "Request Advanced Access" button until the app has made one successful Graph call exercising THAT permission (≤24h propagation). Map: `me/accounts`=pages_show_list/business_management [connect]; `{page}/feed`+`/photos`+`/videos`=pages_manage_posts [publish]; `{post}?fields=reactions.summary,comments.summary`=pages_read_engagement [Analytics sync, runs in WORKER]; IG profile read=instagram_basic; `{ig}/media`+`/media_publish`=instagram_content_publish [publishes a LIVE post — IG has no draft mode]. All 6 exercised 2026-06-03 via test account (`{media}/comments`=instagram_manage_comments was also exercised then, but that perm is now dropped — see above).
- **Token invalidation after scope/config change:** changing the Meta app's scopes/config invalidates ALL existing stored FB/IG tokens (`"session has been invalidated..."`), same class as the YouTube `invalid_grant` quirk above. After winning Advanced Access, existing connected accounts must **reconnect** (fresh OAuth) — Advanced Access does not revive dead tokens. A freshly-connected channel has a working token end-to-end (proves the code is fine).
- **Compliance URLs (App settings → Basic):** Privacy `https://postautomation.co.in/privacy`, Terms `/terms`, Data Deletion Instructions `/data-deletion` (page at [apps/web/app/data-deletion/page.tsx](apps/web/app/data-deletion/page.tsx)). All must be live (200) before App Review.
- **✅ APP REVIEW APPROVED + APP IS LIVE (verified 2026-07-17).** The Data Access Renewal gate cleared; App Review shows "Submission approved". All 6 Advanced-Access perms (`pages_manage_posts, pages_show_list, instagram_content_publish, business_management, pages_read_engagement, instagram_basic`) = **Approved**; `public_profile`+`email` = **Renewed**. Verified WITHOUT trusting the dashboard alone: (a) approved set is an EXACT match for `getDefaultScopes` FACEBOOK(4)+INSTAGRAM(6) — zero unapproved scopes in the request array; (b) app is **Live** — probing FB `/dialog/oauth?client_id=298449321694397` 302s to `login.php` (routes anonymous users into consent), vs an invalid-app-id control that 200s with no login (Dev-mode/refused behavior); (c) prod `docker exec` env has FACEBOOK/INSTAGRAM `_CLIENT_ID`=…4397 + secrets set, `APP_URL=NEXTAUTH_URL=https://postautomation.co.in`. **Anyone can now connect+post** subject to Meta's own platform prerequisites (below). Full evidence: memory `project-meta-app-review-approved-2026-07-17`. Definitive final proof still recommended: one live post from a truly external account that HAS a Page.
- **⏳ INSIGHTS APP REVIEW SUBMITTED — IN PROGRESS (2026-07-24), awaiting Meta decision.** A SECOND App Review submission requesting the **3 analytics-read permissions** external users still lack: **`pages_read_user_content`** (FB comment counts + fields-reactions), **`read_insights`** (FB `post_clicks`/`post_video_views` VALUES), **`instagram_manage_insights`** (IG reach/views/saved). Prereqs done first: the IG v18 metric-set bug + FB impressions/reach "—" fixes shipped (PR #148, `3a06791`) so `getPostAnalytics` sends VALID calls; the test-call gate was satisfied (published FB+IG posts as admin `tabish@dashmani.com` + Sync Now → all 3 Graph calls fired, verified in prod snapshots) which un-greyed the "Request advanced access" buttons. Submission contents: per-permission usage descriptions (truthful to code — **`read_insights` describes ONLY `post_clicks`/`post_video_views`, NOT impressions/reach** since Meta deleted those; `pages_read_user_content` explicitly says "counts only, NO comment moderation" to preempt the `instagram_manage_comments`-style rejection), Data-handling answers unchanged from the approved renewal (processor "DS"=Digital Sukoon, controller Digital Sukoon Private Limited/India, nat-sec=No, policies=None), reviewer instructions (test creds `tabish@dashmani.com / admin@123`, and a **"click Sync Now" step** so the reviewer populates the dashboard). Screencast: **`MetaSubmissionTwo_captioned.mp4`** (`~/Downloads`, 18MB, burned-in captions via libass) — shows BOTH new grant screens ("Access insights for the Instagram account" + "Read user content on your Page"/"Access your Page and App insights") + publish + Insights. **KNOWN weak point (accepted risk):** the demo posts show near-0 metrics because insights only cover posts published THROUGH the app (never account-wide/pre-existing — a real data-minimization point, stated in the notes) and fresh posts start at 0; the reach-104/106 IG posts on the account are NOT app-published so are unreachable by the dashboard by design. **Do NOT during the wait:** change scopes/redirect URIs (resets review/invalidates tokens), click "Back to testing"/"Make internal", re-add `instagram_manage_comments` or any `post_impressions*`. **After approval:** existing FB/IG users reconnect once; verify prod SQL (`comments_gt0`/`reach_gt0` > 0 on engaged posts); rotate `admin@123`. The 8 already-approved scopes are UNAFFECTED by this new request (a new submission never revokes them). Full context: memory `project-insights-app-review-in-progress-2026-07-24`.
- **⚠️ NEW-USER CONNECT FAILS WITHOUT A PAGE / IG-BUSINESS (verified 2026-07-17 via `ConnectionIssue.mp4`) — this is a Meta PREREQUISITE, not an approval failure.** The video shows a fresh external user (with the returning-user "Continue as…" dialog) whose FB connect → toast `fb_no_pages` ("No Facebook Page found…") and IG connect → generic `oauth_failed` ("Sign-in to the platform failed"). Root causes:
  - **FB (correct behavior, user prerequisite; UX improved 2026-07-17):** `FacebookProvider.getPages` ([facebook.provider.ts](packages/social/src/providers/facebook.provider.ts) ~248) returns `[]` (does NOT throw) when `me/accounts` is empty → callback ([route.ts:193-202](apps/web/app/api/oauth/callback/%5Bprovider%5D/route.ts#L193)) cleanly redirects `?error=fb_no_pages`. The user must **admin a Facebook Page** AND (in Facebook Login for Business) actually **tick that Page in the "Edit settings" grant step** — the returning-user "Continue with previous settings" path can carry a stale/empty Page selection, so a user who taps "Continue" (not "Edit settings") may grant zero Pages even if they own one. `me/accounts` returns only Pages the user selected during consent. **FIX (2026-07-17, branch `fix/connect-flow-and-bulk-delete-2026-07-17`):** `getOAuthUrl` now sends **`auth_type=rerequest`** ([facebook.provider.ts:143-158](packages/social/src/providers/facebook.provider.ts#L143)) to force Facebook to RE-PRESENT the permission + Page-selection wizard instead of the silent "Continue as…/previous settings" shortcut; and the `fb_no_pages`/`ig_no_business_account` toasts now explicitly tell the user to click "Edit settings" and tick a Page. Regression test asserts `auth_type=rerequest` in [oauth-flow.test.ts](packages/social/src/__tests__/oauth-flow.test.ts). Do NOT remove `auth_type=rerequest`.
  - **🐛→✅ IG (a REAL CODE BUG on top of the prerequisite — misleading error; FIXED on branch `fix/connect-flow-and-bulk-delete-2026-07-17`):** the callback called `provider.getProfile(tokens)` at [route.ts:187](apps/web/app/api/oauth/callback/%5Bprovider%5D/route.ts#L187) for EVERY platform BEFORE the IG-specific branch. For IG, `getProfile` → `getInstagramBusinessAccountId` ([instagram.provider.ts:333-360](packages/social/src/providers/instagram.provider.ts#L333)) **THROWS** `"No Instagram Business Account found…"` (line 357) when the user has no linked IG-Business → hits the OUTER catch → generic `oauth_failed`, so the clean `getAllInstagramAccounts`→`[]`→`ig_no_business_account` guard ([route.ts:258-266](apps/web/app/api/oauth/callback/%5Bprovider%5D/route.ts#L258)) was **DEAD CODE for personal-IG users**. **FIX (2026-07-17):** (A) `getProfile` is now SKIPPED for `INSTAGRAM` (`const profile = platform === "INSTAGRAM" ? {id:"",name:""} : await provider.getProfile(tokens)`) — the IG branch never reads `profile` (builds channels from `getAllInstagramAccounts`), so the clean `ig_no_business_account` message now surfaces (also drops a duplicate `me/accounts` round-trip); (B) defense-in-depth: the outer catch remaps `/No Instagram Business Account|Instagram Professional account/i` → `ig_no_business_account`. FB is unaffected (its `getProfile` succeeds for a page-less user, so it doesn't pre-empt `fb_no_pages`). ⚠️ Do NOT re-add an unconditional `getProfile` before the IG branch. Tests: [instagram-connect-errors.test.ts](packages/social/src/__tests__/instagram-connect-errors.test.ts) (getProfile throws the matchable msg; getAllInstagramAccounts returns []). Prerequisite unchanged (user needs a Professional/Business IG linked to an admin'd Page) — the bug was only the label.
- **🐛→✅ CHANNEL BULK-DELETE >100 (verified + FIXED 2026-07-17, same branch) — was "Array must contain at most 100 element(s)".** `channel.bulkDisconnect` input is `z.array(z.string()).min(1).max(100)` ([channel.router.ts:392](packages/api/src/routers/channel.router.ts#L392)); the UI used to send the FULL selection uncapped `mutate({channelIds:[...selectedIds]})`. **FIX:** [channels/page.tsx](apps/web/app/dashboard/channels/page.tsx) now chunks client-side into ≤100-id batches via `runBulkDelete()` (`mutateAsync` in a loop over `BULK_DELETE_BATCH=100`, sums `deleted`, surfaces partial-progress on error), driven by a new `isBulkDeleting` state (spans the whole loop, unlike per-call `.isPending`). Server `.max(100)` kept as a guardrail. Do NOT revert to `.mutate({channelIds:[...selectedIds]})`. This account accrued 110+ channels (autopilot/test: filmiimemes, creatorspaparazzi, priyanshu123321123).

## NewsGrid Bot — HIDDEN FROM UI 2026-06-23 (code intact, not deleted)

NewsGrid Bot is a manual, on-demand multi-channel news-card publisher: type a headline (+ optional celeb/event/location), pick channels, and it fans out one AI-generated branded card **per channel** (per-channel logo/template/tone via `updateChannelProfile`/`assignLogoToChannel`), with per-channel approve + schedule, then `bulkPublish`. Backend: [packages/api/src/routers/newsgrid.router.ts](packages/api/src/routers/newsgrid.router.ts) (`generate`, `bulkPublish`, `prefillFromHeadline`, `updateChannelProfile`, `getLogos`/`assignLogoToChannel`/`deleteLogo`, `channelsWithProfiles`). UI pages: [apps/web/app/dashboard/newsgrid/page.tsx](apps/web/app/dashboard/newsgrid/page.tsx) + `/logos`. Renders via the legacy `generateStaticNewsCreativeImage` + the 8 news templates (`cinematic`/`breaking_news`/`paparazzi_stamp`/…) in [news-image-generator.ts](packages/ai/src/tools/news-image-generator.ts).

- **⚠️ HIDDEN FROM THE UI as redundant with Repurpose (user decision 2026-06-23).** For the single-card case it does what Repurpose's `static` format already does on the same Puppeteer + creative-template render stack, so it was confusing to keep as a peer nav item. The only thing it does that Repurpose does NOT is the **per-channel branded fan-out** (one headline → N differently-branded channels) and **no-URL headline-only** input — but the user opted to "do one thing" and removed it rather than reposition it.
- **What was changed (UI-only, fully reversible):** the sidebar nav entry ([apps/web/components/layout/sidebar.tsx](apps/web/components/layout/sidebar.tsx)) and the dashboard feature card ([apps/web/app/dashboard/page.tsx](apps/web/app/dashboard/page.tsx)) are **commented out** (with their `Newspaper` icon imports), dated `2026-06-23`. NOTHING ELSE was touched: the `/dashboard/newsgrid` + `/dashboard/newsgrid/logos` routes still compile and resolve (a bookmarked URL still works), `newsgrid.router.ts` is unchanged, the `activity-panel.tsx` `newsgrid.published` icon map stays (so historical NewsGrid posts still render in the activity feed).
- **To re-add later:** uncomment the three commented blocks (two icon imports + the sidebar entry + the dashboard card). No backend or route change needed. Search `NewsGrid Bot hidden from UI 2026-06-23`.

## AI Content — Repurpose / Content Studio (read before debugging image/video gen)

The repurpose flow ([packages/api/src/routers/repurpose.router.ts](packages/api/src/routers/repurpose.router.ts), UI [apps/web/components/content-agent/RepurposeTab.tsx](apps/web/components/content-agent/RepurposeTab.tsx)) turns a URL into captions + media (static / carousel / reel / ai_video). Fixed end-to-end in PR #44 (`b4b6772`, 2026-06-05); the creative renderer, brand templates, carousel/reel publish, and social-URL ingestion were overhauled again on `fix/audit-2026-06-06` (2026-06-09 — see the 4-style renderer + B1/B4/B5/B6 bullets below). Key invariants:

- **⚠️ KNOWN GAP — style-reference mimicry is COLOR/THEME ONLY, NOT LAYOUT (as of Round 9, 2026-06-15).** A style reference (`aestheticRefUrl`) can (a) PRE-SELECT which of the 4 hand-coded templates to use (`classifyStyleReference`→`suggestedStyle`) and (b) supply accent color + theme + logo. It CANNOT reproduce the reference's actual LAYOUT — the render is always one of the 4 fixed `buildStaticCreative` templates. So a ref the user pastes is "applied" for color/theme but the structure (centered vs bottom headline, filmstrip rows, footer) is the template's, not the ref's. The user has flagged this repeatedly ("you only change the colours, not the style"). Round 7 (PR #64) DID build true layout mimicry (`extract-card-layout.ts`→`cardLayoutToSpec`→`renderCard` block engine in [card-engine.ts](packages/ai/src/tools/card-engine.ts)) but Round 8 (PR #65) REVERSED it from the Repurpose path because the block engine ignored the user's picker. That block-engine code STILL EXISTS (used by NewsGrid/autopilot, exported from `@postautomation/ai`), just unwired from Repurpose. Gemini image-to-image (billing now ON) conditions the BACKGROUND, not the card chrome. **Do NOT write UI copy claiming "style mimicked" until the rendered LAYOUT actually matches the ref.** Resolving this (mimic-layout vs user-picks-style tension) is the open Round-10 design. Full context: memory `project-repurpose-style-mimicry-gap`. **Copy brought into compliance 2026-06-29 (PR #104):** the "Recreate this reference's layout" toggle helper in [RepurposeTab.tsx](apps/web/components/content-agent/RepurposeTab.tsx) no longer promises layout/alignment/logo-position unconditionally — it now states it's a best-effort AI image-to-image that FALLS BACK to colors & theme when it can't recreate (e.g. Gemini refusing celebrity images), matching the honest per-rung result chip. The default (mimicry-OFF) helper was already accurate (theme/accent/logo + closest style) and is unchanged.

- **Image generation: Gemini (Nano Banana) primary → OpenAI fallback.** `generateImageSafe` ([packages/ai/src/utils/safe-image-generator.ts](packages/ai/src/utils/safe-image-generator.ts)) tries Gemini, then falls back to OpenAI via [dalle.provider.ts](packages/ai/src/providers/dalle.provider.ts). **The OpenAI account has NO `dall-e-*` access — only `gpt-image-*`.** The provider MUST use `model: "gpt-image-1"` and MUST NOT send `response_format` (gpt-image-1 returns b64 by default and 400s on that param). Sizes: `1024x1024|1024x1536|1536x1024|auto`; quality `low|medium|high|auto`. Legacy `1024x1792`/`1792x1024`/`standard`/`hd` from older callers are normalized internally — do NOT re-introduce `dall-e-3`.
- **Text generation defaults to OpenAI** (mutation + UI), with auto-fallback to OpenAI (`repurposeContentResilient`/`generateContentResilient`) when a chosen provider throws. Reason: the Google-family providers (`gemini`/`gemma4`) share the billing-held Cloud project below, so defaulting to them killed captions before any media.
- **Static posts + carousel covers now use a 4-style creative renderer** (`fix/audit-2026-06-06`, 2026-06-09). New module [packages/ai/src/tools/creative-templates.ts](packages/ai/src/tools/creative-templates.ts): pure `opts → HTML` builders behind `buildStaticCreative(opts)`, one per **`CreativeStyle`** — `premium_editorial` (default; full photo + gradient scrim + italic brand label + big headline), `hook_bars` (viral desi-news 2-bar: punchy hook line with `**word**` brand-color highlight markup + factual headline + optional circular inset), `tweet_card` (tweet-screenshot: logo + verified tick + @handle + text + image pair), `bold_typographic` (huge headline on brand bg + accent band). Rendered to PNG by `generateStyledCreativeImage` ([news-image-generator.ts](packages/ai/src/tools/news-image-generator.ts)) — `waitUntil:"load"` (NOT `networkidle0`), screenshot-on-timeout fallback, 1080×1350. The repurpose router static + carousel-cover BOTH route through `buildHeadlineCreative` → the chosen style (so the cover inherits the look). UI picks the style + logo position in [RepurposeTab.tsx](apps/web/components/content-agent/RepurposeTab.tsx). The legacy `generateStaticNewsCreativeImage` is still used by NewsGrid/autopilot (unchanged).
  - **SECURITY — every brandColor/image-URL interpolation is sanitized.** `safeColor` (strict `^#[0-9a-fA-F]{3,8}$` → else DEFAULT_ACCENT) + `safeImageUrl` (https/data-image allowlist, rejects `"'()<>\\`/whitespace) gate ALL `brandColor`/`bgImageUrl`/`secondaryImageUrl`/`logoUrl` interpolations; text fields go through `escapeHtml`/`renderHighlightMarkup` (escape-then-markup). Do NOT interpolate any of these raw. Tests: [creative-templates.test.ts](packages/ai/src/__tests__/creative-templates.test.ts) asserts `</style><script>`, CSS `url()` breakout, and attribute breakout are all dropped.
- **Brand reference images + reusable templates** (B4, 2026-06-09). UI: logo uploader (`category:"logo"`) + corner-position picker + "Save as template" + a template dropdown. Backend: `CreativeTemplate` Prisma model (org-scoped; back-relations on Organization/Media/User) + `creativeTemplate` tRPC router (`list/create/update/delete`, `assertLogoMediaOwned` IDOR guard). The logo is (a) baked deterministically into the template corner + (b) passed as `referenceImages` to `generateImageSafe` so **Gemini (Nano Banana)** styles the AI background to the brand. **Reference conditioning is Gemini-only** — the OpenAI fallback has NO image-input path (do NOT add `images/edits`; `gpt-image-1` only supports it on `dall-e-2`, which this account lacks). When Gemini is on its billing hold, the AI background just isn't brand-conditioned, but logo+brand-color still bake via the template, so a branded creative always renders. **No-reference path** (no logo) renders cleanly logo-less with the default accent — generation never blocks on a missing reference.
- **Carousel/reel publish fix** (B1, 2026-06-09). The carousel branch now creates a `Media` DB row per slide (not just an S3 url) and returns an ordered `carouselMediaIds: string[]`; the UI's "Create Drafts" prefers `carouselMediaIds` over `mediaMap` so ALL slides attach to the post. The reel (slideshow) branch creates a `Media` row for the stitched MP4 and resets `carouselMediaIds` to `[videoMedia.id]` so publish attaches the VIDEO, not the slide images. Root cause of the old failure: slides had no Media rows → `post.create` got zero `mediaIds`.
- **Social-post URL ingestion** (B6, 2026-06-09). `decodeEntities` ([url-extractor.ts](packages/ai/src/utils/url-extractor.ts), named+decimal+hex+emoji, normalizes curly quotes→ASCII) is applied inside `getMeta`/`getTitle`/`stripHtml` at the extraction boundary — fixes the `&quot;`/`&#x1f37f;` garbled headlines from IG/FB post links. For `extracted.type === "social"` the router ALWAYS synthesizes a clean headline from the caption via `generateContentResilient` (not just for generic titles); `capHeadline` (~12 words / 80 chars) caps every format's headline so the template font-size logic stays readable. `capHeadline` caps every format's headline to **≤16 words / ≤90 chars** (sentence-aware — prefers cutting at the last sentence boundary, else appends "…", never mid-word; font ladder in creative-templates.ts renders 13–16 words at 46px so 16/90 is the real layout ceiling). All headline prompts ask for "one complete headline, max 14 words". `capBody` (word-aware, appends "…") replaces the raw `.slice(0,120)` / `.slice(0,100)` cuts on carousel slide/cover body text. `capHookLine` (≤7 words, hook_bars) is unchanged. `decodeEntities` is internal to url-extractor — NOT exported from `@postautomation/ai` root.
- **Video format menu** (B5): Veo3 is kept VISIBLE but disabled ("Temporarily unavailable" — billing hold); `reel` relabeled "Slideshow Reel", `seedance_video` relabeled "AI Video".
- **AI-video (Veo3 / Seedance) plan gate** uses `requirePlan(orgId, "PROFESSIONAL", "AI video generation", ctx.isSuperAdmin)` — superadmins bypass. Do NOT revert to a hand-rolled `org.plan === "FREE"||"STARTER"` check (it ignored superadmin).
- **Seedance 2.0 video (fal.ai)** — the WORKING AI-video path (`FAL_KEY` set, billing fine), unlike Veo3. [seedance.provider.ts](packages/ai/src/providers/seedance.provider.ts). Two gotchas, both fixed (PR #45): (a) **model ID is `bytedance/seedance-2.0/text-to-video`** — the BARE `bytedance/...` namespace, NOT `fal-ai/bytedance/...` (older fal models like `fal-ai/wan/...` DO use the `fal-ai/` prefix; Seedance 2.0 does not). A wrong ID is accepted but instant-"COMPLETED" (0.027s, empty logs, 404 result) — it silently never generates. (b) **Poll the `status_url`/`response_url` that fal.ai returns in the submit response** — do NOT reconstruct the poll path from the model ID (the queue API uses the app-prefix `bytedance/seedance-2.0/requests/{id}`, and reconstructing the full path 405s every poll → "perpetual generating" timeout).
- **Error messages:** all AI failures route through `friendlyAIMessage` / `toFriendlyAIError` ([packages/api/src/lib/ai-errors.ts](packages/api/src/lib/ai-errors.ts)) — billing/permission/quota 403s become "temporarily unavailable", NEVER leak raw Google project IDs / `PERMISSION_DENIED` JSON. When all media fails the mutation returns `mediaFailed: true` (honest toast + UI failure card), not a false "success".
- **⚠️ Google Cloud billing hold (project `518560861182`):** native Gemini images + **Veo3 video** currently 403 with "Lightning dunning decision is deny … PERMISSION_DENIED" — a billing/dunning suspension, NOT a code bug. Static + carousel work via the OpenAI/gpt-image-1 fallback; **native Veo3 video stays dead until billing is resolved in Cloud Console** (project owned by admin@dashmani.com). No code change fixes the billing hold.

### Repurpose overhaul 2026-06-17 (PRs #81–#86 — all MERGED) — read before touching the renderer or carousel/postcard paths

A 4-phase overhaul shipped 2026-06-17 (audit → design spec [docs/superpowers/specs/2026-06-17-platform-issues-and-repurpose-overhaul-design.md](docs/superpowers/specs/2026-06-17-platform-issues-and-repurpose-overhaul-design.md), plan [docs/superpowers/plans/2026-06-17-platform-issues-and-repurpose-overhaul.md](docs/superpowers/plans/2026-06-17-platform-issues-and-repurpose-overhaul.md)). Every change is **additive** and guarded by a byte-identical render gate.

- **🔒 GOLDEN-RENDER GATE — keep green, never `-u` blindly.** [packages/ai/src/__tests__/repurpose-render-golden.test.ts](packages/ai/src/__tests__/repurpose-render-golden.test.ts) snapshots `buildStaticCreative` output for all 5 styles + cover/body/cta slide roles + with/without brandColor (17 snapshots). It is the enforcement of "don't regress existing renders": any change that alters a default-path render fails it. When adding a render feature, gate it behind an OPTIONAL opt that defaults to the existing behavior so the gate passes with **0 snapshots written** — that 0-written result IS the byte-identical proof. Only run `-u` for a deliberately-approved change, and confirm the existing snapshots are unchanged (additions-only).
- **REP-1 — Claude model id.** [anthropic.provider.ts](packages/ai/src/providers/anthropic.provider.ts) defaults to `claude-sonnet-4-6` (current, NO date suffix) + an `ANTHROPIC_MODEL` env override (mirrors `OPENAI_MODEL`). The old hardcoded `claude-sonnet-4-20250514` 404'd → captions broke when OpenAI was down. Valid ids have NO `-YYYYMMDD` suffix. The `[chosen→openai→anthropic]` fallback ([provider-chain.ts](packages/ai/src/utils/provider-chain.ts)) is correct; it surfaces the LAST provider's error.
- **⚠️ REP-1b — `getAnthropicModel` MUST pass `topP: 1`; do NOT remove it or "simplify" to `undefined`/`null`** ([anthropic.provider.ts](packages/ai/src/providers/anthropic.provider.ts), PR #105, LIVE on prod 2026-06-29). `@langchain/anthropic@0.3.34` defaults `topP` to a `-1` "unset" sentinel and ONLY strips it for model names containing `opus-4-1`/`sonnet-4-5`/`haiku-4-5`. The default `claude-sonnet-4-6` matches NONE → ctor else-branch `this.topP = fields?.topP ?? this.topP` = `undefined ?? -1` = **-1** → ships literal `top_p:-1` → Anthropic 400 `"top_p cannot be set to -1 for this model"` (request_id `req_011C…`, an ANTHROPIC envelope — NOT OpenAI). Latent until the fallback chain reaches the anthropic hop (i.e. OpenAI depleted), so it READS like a credits bug but is NOT — don't chase OpenAI credits for this error. `topP:1` is the ONLY working value (matches ChatOpenAI's own default; `undefined`/`null` both collapse back to `-1`). `getAnthropicModel` is the SOLE `ChatAnthropic` construction site, so this one line protects every text path (repurpose, chat/super-agent, autopilot workers, hashtag/schedule). Regression test asserts `topP !== -1` in [provider-chain.test.ts](packages/ai/src/__tests__/provider-chain.test.ts). **Same PR:** `repurpose.regenerateImage`'s hook-line rewrite (~`repurpose.router.ts:3260`) was hardcoded `provider:"openai"` no-fallback → now wraps `generateContent` in `withTextProviderFallback(undefined, …)` so regenerate escalates `[openai→anthropic]` like initial-generate instead of silently degrading to the stale hook. Both fixes are inert unless `ANTHROPIC_API_KEY` is set — confirmed present in prod web+worker containers, prod-key `top_p:1`→HTTP 200 (2026-06-29). See memory `project-anthropic-topp-sentinel-2026-06-29`.
- **REP-2 — per-slide carousel text.** The main mutation returns `carouselSlides: {index,role,title,body,mediaId}[]` (built INSIDE the upload loop, lock-step with `carouselMediaIds` so a failed slide can't misalign). `regenerateImage` takes optional `slideRole` + `slideBody` to re-render one body slide. UI ([RepurposeTab.tsx](apps/web/components/content-agent/RepurposeTab.tsx)) has a per-slide title/body editor + per-slide regenerate. **All slide↔card lookups use the COMPACTED display position (`carouselSlides[i]`), NOT `.find(s => s.index === i)`** (s.index is the original allSlides index; they diverge on a mid-carousel failure).
- **REP-3 — `postcard_grid` CreativeStyle (the Moviefied-style posts).** New 5th `CreativeStyle` + `buildPostcardGrid` in [creative-templates.ts](packages/ai/src/tools/creative-templates.ts): tweet header (logo+name+tick+@handle+caption) ABOVE a fixed-preset collage — `two_up` / `three_up` (1 big top + 2 below, via `grid-column:1 / span 2`) / `grid_2x2`. Gated by optional `gridImageUrls?: string[]` + `gridPreset?`. Every tile through `safeImageUrl`. Router resolves N tiles via the existing `resolveImageSlot` (slot keys `grid:N`, IDOR-covered by the existing `imageAssignments` guard) and returns ONE composited image (single `mediaMap`, `carouselMediaIds` stays `[]`). **Precedence is user→article→AI:** `resolveImageSlot`'s AI rung fires on `aiToggle` ALONE (ignores `aiPrompt`), and `aiImages` defaults TRUE, so the postcard branch gates `aiToggle` OFF per-tile when a user/article photo exists — otherwise a real photo would be replaced by AI. UI: a "Postcard" format option that maps to `format:"static" + creativeStyle:"postcard_grid" + gridPreset` (the UI-only `"postcard"` never reaches the backend, whose format enum has no `"postcard"`). tweet_card/postcard_grid render the logo INLINE (no `.logo` corner wrapper).
- **REP-4 — Canva-like free-drag positioning — ⚠️ REVERTED 2026-06-17 (commit `git revert d581f15 9eb88be`).** Free-drag shipped a BROKEN static-post UX and was reverted (livelihood-critical): (R1) the draggable logo CHIP drew a SECOND logo OVER the one already baked into the PNG (`creative-templates.ts` `logoHtml`) — two logos; (R2) the draggable hook CHIP rendered `results.hookLine` RAW, showing literal `**markup**` asterisks instead of the accent-highlighted text the PNG bakes. The revert removed `logoPosXY`/`hookPosXY`/`clampPct`/`logoCssBody`/`posDragRef` + the drag-overlay DOM and restored the plain pre-REP-4 `<img>` preview. **Do NOT re-add the free-drag overlay** without verifying the RENDERED IMAGE + the publish flow (not just byte-identical snapshots — the snapshots passed while the UI overlay was broken; the lesson: adversarial-verify the END-USER visual output and the full Create-Drafts→publish flow, not just code additivity). REP-2 (#84) + REP-3 (#85) are independent and remain intact.
- **R3 (pre-existing, fixed 2026-06-17) — empty headline pill in `hook_bars`.** `buildHookBars` ([creative-templates.ts](packages/ai/src/tools/creative-templates.ts)) emitted the headline `.bar` (a white pill, `background:#fff`+box-shadow) UNCONDITIONALLY even when `opts.headline` was empty/whitespace → a blank white box in the PNG. Now guarded like the sibling hook bar: `${opts.headline?.trim() ? \`<div class="bar">…\` : ""}` (mirrors the Round-19 empty-pill guard in `card-engine.ts` `renderCaptionStack`). Golden gate stays 17/17 (0 written — all fixtures use non-empty headlines).
- **R4 (pre-existing, LIVELIHOOD-CRITICAL, fixed 2026-06-17) — render-fail no longer produces a media-less draft.** In `repurposeFromUrl` ([repurpose.router.ts](packages/api/src/routers/repurpose.router.ts)) BOTH static-image catches (the single-bg static catch + the `postcard_grid` catch) used to SWALLOW a render/upload error (log + `progress("…","error",…)`, no rethrow) → `mediaUrls=[]` → soft `mediaFailed:true` (200) → UI hid the preview ("not in draft") AND let "Create Drafts" create a **media-less draft** → IG/FB publish failed with "requires an image; none attached". Both catches now **rethrow** (mirroring the captions catch: classified errors via `toFriendlyAIError`, unknown render/upload failures via an actionable `BAD_REQUEST` "try again or add your own photo") — a hard, sanitized error, never a silent media-less success. This is reachable ONLY for `format:"static"` (the `if/else if` on `input.format` isolates it — ai_video/seedance/carousel/reel have their own branches + early returns and legitimately return `mediaFailed:false`/`videoPending`, so they are UNAFFECTED). The AI-fails-but-render-SUCCEEDS path (article-photo fallback) still returns `mediaFailed:false`. **Frontend defense-in-depth:** `shouldBlockMediaLessPublish(mediaIds, format, selectedPlatforms)` ([apps/web/lib/repurpose-media-guard.ts](apps/web/lib/repurpose-media-guard.ts)) blocks the Create-Drafts call (actionable toast) when `mediaIds` is empty AND the format is an IMAGE format (NOT `ai_video`/`seedance_video`/`reel`) AND a selected channel targets a media-required platform (INSTAGRAM/FACEBOOK); channel-less drafts are allowed (savable, channels added later). Pure/testable helper. Tests: [repurpose-render-fail.test.ts](packages/api/src/__tests__/repurpose-render-fail.test.ts) (mutation throws, not soft-fails) + [repurpose-media-guard.test.ts](apps/web/lib/repurpose-media-guard.test.ts). **NOTE:** a draft that already failed under the OLD media-less behavior won't self-heal — delete + recreate it.

#### Non-Repurpose fixes shipped in the same 2026-06-17 batch (Phases 1–3)
- **AP-1 (autopilot review gate, HIGH):** [content-generate.worker.ts](apps/worker/src/workers/content-generate.worker.ts) auto-approval is now governed ONLY by the explicit `agent.accountGroup?.skipReviewGate === true`. The old `|| autopilotPost.sensitivity === "LOW"` clause auto-approved most posts (LOW is the classifier default) → unreviewed AI content could publish. Do NOT re-add the `|| sensitivity === "LOW"` bypass; `sensitivity` stays advisory metadata.
- **APPR-1:** `approval.submit` (long-built, zero callers) now has a "Submit for review" entry point on the post detail page ([apps/web/app/dashboard/posts/[id]/page.tsx](apps/web/app/dashboard/posts/%5Bid%5D/page.tsx)) — reviewer picker from `team.members` (org-scoped), passes USER ids (not membership ids).
- **NG-1:** NewsGrid no-photo fallback is now a self-contained inline CSS `linear-gradient` ([news-card-template.ts](packages/ai/src/tools/news-card-template.ts)) — the old `/newsgrid-bg/bg-N.svg` site-root-relative URL never resolved under Puppeteer `page.setContent` (about:blank base) → black card. The `.bg-photo` rule emits the gradient FIRST then `background-image` (real photo overrides the shorthand) — order is load-bearing.
- **AP-3:** autopilot Pipeline Logs read the real Prisma `PipelineRun` fields (`itemsDiscovered`/`postsGenerated`/`completedAt`, not `discovered`/`generated`/`finishedAt`).
- **SL-1:** Social Listening `syncMutation.onSuccess` now also invalidates `listQueries` (the mention badge `_count.mentions` lives there) so it updates without a refresh.
- **RSS-1:** `humanizeError` ([apps/web/lib/errors.ts](apps/web/lib/errors.ts)) reads the structured `err.data.zodError` and never leaks raw `[{...}]` Zod JSON into toasts. SHARED by 15+ callers — the `zodError &&` truthy check MUST precede the `typeof === "object"` check (typeof null === "object").
- **AP-4:** autopilot agent delete is gated behind `confirm()`. **NG-2:** "1 channel" pluralization.
- **Refuted (NOT bugs, do not "fix"):** RSS-2 (empty-form submit is correctly disabled), AP-2 (Agents page doesn't hang — `runNow` enqueues + returns), SL-2 (delete already invalidates `listQueries`).

## Super Agent (chat assistant) — read before touching chat.router or super-agent UI

The Super Agent ([apps/web/app/dashboard/super-agent/page.tsx](apps/web/app/dashboard/super-agent/page.tsx), [packages/api/src/routers/chat.router.ts](packages/api/src/routers/chat.router.ts), prompt in [packages/ai/src/prompts/chat-agent.prompt.ts](packages/ai/src/prompts/chat-agent.prompt.ts)) is a conversational agent that emits ` ```action ` blocks. The streaming route ([apps/web/app/api/chat/stream/route.ts](apps/web/app/api/chat/stream/route.ts)) only *parses* the action and forwards it in the `done` SSE event; the **client** decides execution. Invariants (audit fix 2026-06-06, PR for `fix/audit-2026-06-06`):

- **Every `executeAction` case is plan-gated + channel-ownership-validated. Do NOT remove these.** `create_agent` → `requirePlan(STARTER)`; `schedule_post`/`bulk_schedule`/`publish_now` → `enforcePlanLimit(postsPerMonth)`; `generate_news_image` → `enforcePlanLimit(aiImagesPerMonth)`. All pass `ctx.isSuperAdmin`. Before 2026-06-06 the agent had ZERO gating — a FREE user could create STARTER agents and exceed quotas via chat.
- **`assertChannelsOwned(prisma, orgId, channelIds)`** (exported from `chat.router.ts`) runs before any action that writes channel targets — closes a cross-org IDOR where AI-supplied `channelIds` were written without an org check. Mirrors the block in `post.router.ts:create`. Keep it on `create_agent`/`schedule_post`/`bulk_schedule`/`publish_now`.
- **`publish_now` is NOT auto-executed.** It renders an explicit "Publish now" button with an "immediate, cannot be undone" warning, like every other action. Do NOT re-add the `if (event.action?.type === "publish_now") executeAction(...)` auto-fire — it pushed live posts with no review.
- **Media attachments:** the chat input has a paperclip (uploads via `/api/upload`, which returns `{ id, url, fileName, fileType }`) and a Media Library picker (`MediaPickerDialog`, whose `onSelect` is `(url, fileName, mediaId?)` — NOT an object). Attachments are sent as `sendMessage({ attachmentMediaIds })` (the backend already persisted these). The welcome screen lists the user's connected channels (`trpc.channel.list`, fields `name`/`username`/`platform`) so it's obvious where posts can go.
- **Multimodal vision — the agent CAN see uploaded/picked images** (`fix/audit-2026-06-06`, 2026-06-09). Root cause of the old "please describe the image" bug was the **stream route** ([apps/web/app/api/chat/stream/route.ts](apps/web/app/api/chat/stream/route.ts)) never loading the `attachments` relation + hardcoding `hasAttachments:false` — the bytes never reached the model. Fixed: the route loads `attachments → media`, builds multimodal messages (`content: [{type:"text"}, {type:"image_url", image_url:{url}}]`) for the last user message with image attachments; `ChatMessage.content` is widened to `string | ChatMessageContentPart[]` in [chat-agent.chain.ts](packages/ai/src/chains/chat-agent.chain.ts); the LangChain branch passes array content to `HumanMessage` (OpenAI/Anthropic read `image_url`); the Gemini branch builds `Content[]` with `inlineData` (via `fetchImageAsBase64`), and `callGemini` now accepts `string | Content[]`. **`FALLBACK_PRIORITY` is vision-only (`["gemini","openai","anthropic"]`) when images are attached** — grok/deepseek/gemma4 have NO vision API; never put them in the vision fallback.
- **SSRF guard on the Gemini image fetch:** `fetchImageAsBase64` ([chat-agent.chain.ts](packages/ai/src/chains/chat-agent.chain.ts)) fails CLOSED — only fetches from configured S3 hosts (`S3_PUBLIC_URL`/`S3_ENDPOINT`/s3.amazonaws.com), blocks RFC1918/loopback/link-local/metadata + IPv6 unique-local/link-local/mapped, and uses `redirect:"manual"`. Tests: [image-fetch-ssrf.test.ts](packages/ai/src/__tests__/image-fetch-ssrf.test.ts).
- **Post-with-image:** post actions (`publish_now`/`schedule_post`/`bulk_schedule`) now carry attachment `mediaIds` (the client merges the thread's last-attachment mediaIds into the action payload). `assertMediaOwned(prisma, orgId, mediaIds)` (exported from `chat.router.ts`) org-scopes them before they're attached to the created post — keep it alongside `assertChannelsOwned`. The prompt ([chat-agent.prompt.ts](packages/ai/src/prompts/chat-agent.prompt.ts)) has an **ATTACHED MEDIA** section so the agent knows it can see + attach images. Test: [chat-action-media.test.ts](packages/api/src/__tests__/chat-action-media.test.ts).
- **`get_analytics`** returns post counts AND an engagement summary (impressions/likes/comments/shares/reach) summed from the latest `AnalyticsSnapshot` per published target — the SAME source as `analytics.engagement`, so chat and dashboard agree.
- **`requireText(value, field)`** guards required string payload fields (post `content`, news-image `headline`) → clean `BAD_REQUEST` instead of an opaque Prisma error when the AI omits a field. `executeAction` payload is still `z.record(z.unknown())` (a full discriminated union was deemed too brittle for AI-emitted payloads); the per-field guards cover the crash-prone cases.
- Regression tests: [packages/api/src/__tests__/chat-action-gating.test.ts](packages/api/src/__tests__/chat-action-gating.test.ts) (plan matrix), [chat-channel-ownership.test.ts](packages/api/src/__tests__/chat-channel-ownership.test.ts) (IDOR guard), [s3-config.test.ts](packages/api/src/__tests__/s3-config.test.ts) (upload pre-flight).

## Campaigns & Brand Outreach — read before touching campaign.router / brand-leads / the brand-content + outreach workers

Two PROFESSIONAL-gated features backed by [packages/api/src/routers/campaign.router.ts](packages/api/src/routers/campaign.router.ts) (campaigns + brand trackers + influencer discovery) and [packages/api/src/routers/brand-leads.router.ts](packages/api/src/routers/brand-leads.router.ts). All campaign procedures call `gateCampaigns` (`requirePlan(PROFESSIONAL)`, dormant under `BILLING_DISABLED`). End-to-end verified 2026-06-29; the honesty relabel below is **PR #104** (branch `feat/campaigns-honesty-and-capability-copy-2026-06-29`).

**Brand Outreach — LIVE, real send pipeline, HONEST UI ([apps/web/app/dashboard/brand-leads/page.tsx](apps/web/app/dashboard/brand-leads/page.tsx)):** a detector cron finds brand-partnership leads (Meta Ad Library / news / social), enriches contacts, lists them. Operator **approves** a lead → `scheduleOutreachPoll` cron (every 5 min) → `outreach-poll.worker` LLM-drafts a personalized message per channel (`OutreachMessage` status DRAFT) + enqueues `outreach-send` → `outreach-send.worker` routes by channel: **EMAIL = real Resend API send**, **TWITTER = real X v2 DM**, **LINKEDIN/INSTAGRAM = `PENDING_MANUAL`** (their DM APIs need access we don't have — the UI shows "Send manually" with copy ready; we never mark those "Sent" unless delivered). No inbox automation — replies land in the operator inbox; outcomes are logged manually. Degrades silently to FAILED/PENDING_MANUAL if `RESEND_API_KEY` / `TWITTER_BEARER_TOKEN` / `HUNTER_API_KEY` are unset. The page's "How Brand Outreach works" Alert already discloses all of this — **do not** bolt on more disclaimer copy.

**Campaigns — a brand/influencer/content MONITORING tool, deliberately NOT a posting/scheduling engine (honesty relabel, PR #104, 2026-06-29).** A campaign groups `BrandTracker`s (+ niche-matched influencer discovery). The `brand-content-sync` cron fetches each active tracker's recent posts every ~6h. **Invariants — do NOT "fix" these as bugs:**
- **`CampaignPost` is never created anywhere** (`campaignPost.create` = 0 hits repo-wide; the only write is an `.update()` in [campaign-analytics-sync.worker.ts](apps/worker/src/workers/campaign-analytics-sync.worker.ts)). The worker IS alive and its queue name matches the cron enqueue (`QUEUE_NAMES.CAMPAIGN_ANALYTICS_SYNC`), so jobs are processed — they just aggregate an always-empty `campaignPosts`. This is **dormant by design**, not a dead worker. Per-campaign performance metrics (`totalImpressions` etc. on the `Campaign` model) are **never surfaced in the UI** and should not be claimed there. Don't wire post→campaign attachment unless the user explicitly reverses the "monitoring, not engine" decision.
- **The fake `ACTIVE/PAUSED` status + play/pause/archive buttons were REMOVED.** Replaced by a real **"Monitoring on/off"** toggle: `campaign.setMonitoring(id, enabled)` flips `isActive` on ALL the campaign's `BrandTracker`s — exactly the field `scheduleBrandContentSync` reads (`brandTracker.findMany({ where: { isActive: true } })`) — so the toggle has a REAL effect. Org-scoped `findFirstOrThrow` pre-check + org-scoped `updateMany` (IDOR-safe; foreign/unknown id throws, no cross-org write). `campaign.list` derives `{ monitoring, activeTrackers, totalTrackers }` (`monitoring = activeTrackers > 0`); mixed state shows "Monitoring N/M"; toggle disabled (with "Add a brand to monitor") when 0 trackers. The `Campaign.status` column is kept but no longer surfaced/mutated in the UI; `campaign.create` still defaults `status:"ACTIVE"` (invisible). Don't re-add the status badge or play/pause controls.
- **Capability copy:** dashboard card is "Brand Campaigns / Monitor brands & competitors… (not for scheduling your posts)" ([apps/web/app/dashboard/page.tsx](apps/web/app/dashboard/page.tsx)); page header + empty state say monitoring fetches recent posts ~6h and campaigns don't schedule your own posts.
- Test: [packages/api/src/__tests__/campaign-set-monitoring.test.ts](packages/api/src/__tests__/campaign-set-monitoring.test.ts) (org-scope/IDOR + list derivation). Design + decision log: [docs/superpowers/specs/2026-06-29-campaigns-honesty-and-capability-copy-design.md](docs/superpowers/specs/2026-06-29-campaigns-honesty-and-capability-copy-design.md).

**⏸️ DEFERRED — cost-breakdown page** (per model / per API spend). User deferred 2026-06-29. Accuracy tradeoff captured in the design doc above: official billing APIs = authoritative but account-level (no per-org/feature/model split); self-metered = granular but an estimate; recommended hybrid (self-meter + reconcile against official totals, show the delta). Providers: OpenAI (gpt-image-1/text), Anthropic, Gemini/Veo3, fal.ai (Seedance), + non-AI Resend/Twitter/Hunter/SMTP.

## Routing / deep-link contract (Content Studio)

`/dashboard/content-agent` reads **`?tab=`** (values: `compose | create | repurpose | bulk`) and **`?view=`** (`posts | calendar`) and **`?subTab=image`** (opens the Image generator under `create`). It also accepts legacy `?expanded=` as a fallback for `?tab=`. **Cards and redirects MUST emit `?tab=`/`?view=`, never `?expanded=` or a non-existent tab id.** Before 2026-06-06 the dashboard Repurpose/Bulk cards emitted `?expanded=` (silently landed on Compose) and `/dashboard/ai`→`?tab=generate`, `/dashboard/image-studio`→`?tab=image`, `/dashboard/posts`→`?tab=posts`, `/dashboard/calendar`→`?tab=calendar` all pointed at tab ids that don't exist. Fixed: cards use `?tab=repurpose|bulk`; redirect shims use `?tab=create`/`?tab=create&subTab=image`/`?view=posts`/`?view=calendar`.

## Edge reliability — nginx 503/504 (FIXED 2026-07-17, PR #119) — read before touching nginx.conf or adding exec calls

- **503s were nginx `limit_req` friendly fire, NOT outages.** `limit_req` rejections default to **503**; the api zone was 30r/s+burst20 keyed per client IP (an office NAT shares ONE bucket), and `/api/oauth/callback/*` fell under `/api/` — users got the bare "503 nginx" page mid-OAuth-consent (2,002 5xx/7d). NOW: `limit_req_status 429` (+`limit_conn_status`), api zone 60r/s burst=120, and a dedicated **un-rate-limited `location /api/oauth/callback/`** (one-shot consent codes must never bounce — do NOT remove it or re-tighten without keeping the exemption). Verified live: 150-request burst → 401s+429s, **zero 503s**.
- **504s were the web container's event loop FROZEN by synchronous ffmpeg.** `execSync` encodes (reel-generator up to 180s; repurpose bg-music tone) blocked EVERY request until nginx timed out. Both are now **async `execFile` with argv arrays** ([reel-generator.ts](packages/ai/src/tools/reel-generator.ts), [repurpose.router.ts](packages/api/src/routers/repurpose.router.ts) music bed). **NEVER add `execSync`/`execFileSync`/`spawnSync` to code the WEB process serves** (packages/ai, packages/api, apps/web) — argv-form async `execFile` only. Worker-side sync ffmpeg (video-overlay.ts) is tolerable (blocks a queue thread, not HTTP).
- **nginx healthcheck fixed**: `location = /nginx-health` on port 80 + compose probe hits it. The old probe (`/api/health`) followed the 301 to https://localhost and died on TLS → `(unhealthy)` for 3 weeks while serving fine. Verify after nginx changes: `curl http://127.0.0.1/nginx-health` on the box → 200, container → `(healthy)`.
- **Friendly maintenance page**: `error_page 502 503 504 @maintenance` (auto-retry HTML, Retry-After 6). Only nginx-GENERATED errors (upstream unreachable/timeout) — app JSON 5xx passes through (`proxy_intercept_errors` stays off).
- Remember the standing gotcha: nginx.conf changes need `docker compose … up -d --force-recreate nginx` after the pull.

## Phase-B batch — 2026-07-18 (branch `feat/snapchat-connect-2026-07-18`) — read before touching these areas

Seven-commit batch (`241ffcf`…`0c50f2d`), each independently gated. Full audit + design: [docs/PHASE-B-AUDIT-AND-PLAN.md](docs/PHASE-B-AUDIT-AND-PLAN.md).

- **Publish email (`65c4ecb`)**: Link column shows the raw URL as copyable text AND a `publish-report-<postId>.csv` attachment (platform/channel/handle/url/status/UTC/IST) rides every publish email. `buildPublishReportCsv` in [publish-email.ts](apps/worker/src/lib/publish-email.ts) replicates the `apps/web/lib/csv.ts` formula-injection guard (web lib not importable from worker — do NOT "deduplicate" by importing). CSV failure never blocks email; email failure never blocks publish.
- **Connect-path fetch timeouts (`299ad45`)**: `fetchT` ([fetch-timeout.ts](packages/social/src/utils/fetch-timeout.ts), 25s `AbortSignal.timeout`) on ALL providers' connect-path fetches (exchange/refresh/getProfile/getPages/IG account resolution). FB `graphFetch` takes opts `{maxSleepMs, retries, timeoutMs}` — connect callers clamp to 5s/1-retry; **worker publish paths pass no opts and keep the full 60s pause + 3-retry backoff (deliberate — protects shared app quota; do NOT clamp them)**. FB/IG pagination capped at 20 pages w/ warn. Do NOT remove signals or add timeouts to publish/upload fetches.
- **Stability (`4d98f16`)**: `repurposeFromUrl`/`regenerateImage` are rate-limited (shared `aiRateLimiter` 20/min); Chromium launches bounded by a FIFO semaphore (`CREATIVE_RENDER_CONCURRENCY`, default 3, releases on browser `disconnected` — covers crash + launchCreativeBrowser); worker ffmpeg is async `execFile` (identical argv — keep argv-form). **Chat RBAC side-door CLOSED**: `create_campaign`/`create_brand_tracker`/`create_listening_query` now carry the same `isAppAdmin` gate as `create_agent` (+ `requirePlan(PROFESSIONAL)` on campaigns), locked by [chat-rbac-side-door.test.ts](packages/api/src/__tests__/chat-rbac-side-door.test.ts) (23 tests). ai_video Veo3-fallback worker-offload DEFERRED (needs UI videoPending contract check first).
- **Insights freshness (`0f3ba23`)**: NEW once-daily long-tail sync (7–90d, non-FB) — metrics no longer freeze at 30d (they now freeze at 90d; a like after 90d is still never captured). Tagged at-age jobs rethrow so BullMQ attempts:3 engages (untagged cron jobs keep soft-null); daily reconciliation re-enqueues missed checkpoints (jobId `atage-late:{targetId}:{tag}` — BullMQ forbids 4-segment colon ids; `capturedLate:true` stamped; 45d floor so permanently-erroring targets aren't re-enqueued forever). `triggerSync` optional `days` (1–90, default 30). Reports: Captured (UTC) column + >24h stale hint + FB cadence note; Export refetches limit:1000 + `-truncated` filename marker. `analytics.emailReport` (rate-limited 5/h `emailReportRateLimiter`, audit-logged `ANALYTICS_REPORT_EMAILED`, CSV via [report-csv.ts](packages/api/src/lib/report-csv.ts) — another deliberate guard replica) + "Email report" button in ReportsTab. `sendEmail` gained optional `attachments` (the local [nodemailer.d.ts](packages/api/src/types/nodemailer.d.ts) shim governs tsc — extend it too if you extend options).
- **Per-channel unique captions (`0c50f2d`)**: `PostTarget.contentOverride String? @db.Text`; publish worker precedence `contentOverride ?? contentVariants?.[platform] ?? post.content` (NULL = byte-identical legacy path — do NOT reorder). Opt-in via Compose "Unique caption per channel (AI)" toggle (>1 channel only) or chat `uniqueCaptions:true` on `schedule_post`/`publish_now` → post parks as DRAFT + `metadata.captionFanout` + ONE `caption-fanout:{postId}` job → [caption-fanout.worker.ts](apps/worker/src/workers/caption-fanout.worker.ts) (chunked ~10/call via provider fallback chain, idempotent — skips non-null overrides) flips DRAFT→SCHEDULED exactly once; **safety valve: final failure still flips with null overrides (shared caption publishes — degraded, never lost)**. `publish_now` on this path skips direct enqueue (cron picks up post-flip — do NOT dual-enqueue). Per-target caption editor on post detail via `post.updateTargetContent` (org-scoped `assertTargetEditable`, NOT_FOUND for cross-org, PUBLISHED immutable). Quota unchanged: 1 post = 1 unit. Super Agent prompt does NOT yet advertise the flag (1-line follow-up in chat-agent.prompt.ts if wanted).

## Audit fixes 2026-07-27 (7-area sweep) — do NOT regress these

Verified against real code (a 155-agent audit surfaced them; each was then hand-confirmed by reading the source — the automated verification pass had died on a session limit, so none were trusted on the agents' word alone).

- **🔒 `bulk.*` was a cross-org IDOR.** All five procedures in [bulk.router.ts](packages/api/src/routers/bulk.router.ts) were `protectedProcedure` reading `ctx.organizationId`, which comes VERBATIM from the client's `x-organization-id` header — with no membership check. Any authenticated user could `csvExport` another org's entire post history or `bulkDelete` its posts. Now `orgProcedure`. **Never downgrade them back**: the per-query `organizationId` filters are only as strong as the membership check that produced that id.
- **🔴 Bulk Schedule never published anything.** `bulkSchedule` updated only the Post row; BulkTab lists **DRAFT** posts whose targets are also DRAFT, and the publish cron selects `targets: { where: { status: "SCHEDULED" } }` → zero jobs enqueued, post flipped to PUBLISHING anyway, watchdog reaped it FAILED ~45 min later, after the UI said "N post(s) scheduled successfully". Now flips DRAFT/FAILED targets too (never PUBLISHED/PUBLISHING/CANCELLED — that would re-post live content). Locked by [bulk-schedule-targets.test.ts](packages/api/src/__tests__/bulk-schedule-targets.test.ts).
- **🔴 Manually-approved autopilot posts all showed FAILED.** `autopilot.router` `approvePost` enqueues with `pipelineRunId: ""` (there is no pipeline run behind a human clicking Approve), and the worker's step 11 `pipelineRun.update({ where: { id: "" } })` THROWS P2025 → the catch stamped the AutopilotPost FAILED even though steps 7–10 had already scheduled the post successfully. Now guarded with `if (pipelineRunId)`.
- **📉 PR #148 regression — real FB video views were hidden as "—".** `platformMetricCapabilities` is a platform-wide constant, but FB capability varies PER POST: a FEED post genuinely has no impressions (Meta deleted the metric) while a VIDEO/REEL post returns REAL `total_video_views` through `video_insights`/the reel scraper. Marking FACEBOOK impressions+reach unavailable in the static map alone hid captured data in Reports/CSV/email. **Root cause: the per-capture `AnalyticsSnapshot.metadata.metricsAvailable` the worker writes was read by NOTHING.** `gatePostReportRow` now prefers it (explicit `false` ⇒ "—"; metadata present and key not false ⇒ trust the value; no metadata ⇒ static map, unchanged) and the SQL selects `s.metadata`. Locked in [report-metric-gate.test.ts](packages/api/src/__tests__/report-metric-gate.test.ts).
- **🔒 `analytics.postMetrics` cross-org read.** `orgProcedure` proved the CALLER's membership but nothing scoped the supplied `postTargetId` — any member could read another org's snapshot history. Now pre-checks ownership via the target's parent post. ⚠️ `AnalyticsSnapshot` has **no Prisma relation** to PostTarget (bare `postTargetId` column) — a nested `postTarget: {...}` filter does not exist; the separate lookup is required.
- **🔒 `campaign.createBrand`/`updateBrand` accepted a foreign `campaignId`** straight into `data`. Now ownership-checked, mirroring the existing `brandContent` guard.
- **Remaining (reported, NOT yet fixed):** ~40 lower-severity findings from the same sweep (auto-healer duplicate warning rows every 10 min; Monitoring showing the green all-clear on query failure; `listening` LinkedIn mentions never deduping (sourceUrl always null) + surge alerts with no cooldown; "Use in Post" not switching tabs; ImageTab double-attaching generated images; Compose schedule-picker `min` computed in UTC; CSV export end-date excluding the end day; several list caps presented as totals). Each has a file:line in the session's audit output — they were NOT independently re-verified, so treat them as leads, not facts.

## Super Text — burned-in video text strip (2026-07-27) — read before touching the burn path or Compose video tiles

Optional Instagram-style text strip (emoji + per-word colours + free positioning) burned into a video BEFORE it publishes, so **every** selected channel gets the same baked video. **Posting WITHOUT super text is byte-identical to before** — absent `metadata.superText`, every touched code path evaluates to its pre-feature branch (locked by [super-text-plan.test.ts](packages/api/src/__tests__/super-text-plan.test.ts) + [super-text-payload.test.ts](apps/web/lib/super-text-payload.test.ts)). Plan: [docs/superpowers/plans/2026-07-27-super-text-video-overlay.md](docs/superpowers/plans/2026-07-27-super-text-video-overlay.md).

- **ONE renderer for preview AND burn — do not add a second.** [packages/super-text](packages/super-text/src/html.ts) `buildStripInnerHtml` (strip markup) + `buildSuperTextFrameHtml` (transparent full-frame page) are consumed by BOTH the compose preview ([super-text-strip.tsx](apps/web/components/content-agent/super-text-strip.tsx), `dangerouslySetInnerHTML`) and the worker's Puppeteer page. This is the REP-4 lesson made structural: a preview drawn by a parallel path drifts from the baked artifact. Geometry is `em`-based off ONE font-size and positions are PERCENTAGES, so the ~280px preview stage and a 1080px video lay out identically.
- **Why HTML→PNG→ffmpeg `overlay`, NOT `drawtext`:** ffmpeg `drawtext` cannot render colour emoji or per-word colours. Chromium can. The strip renders to a transparent PNG at the video's native size, composited at `overlay=0:0` — so **no user text ever reaches ffmpeg** (the drawtext escaping minefield is bypassed entirely). The legacy `metadata.videoOverlayText` drawtext watermark path in [video-overlay.ts](apps/worker/src/lib/video-overlay.ts) is untouched and still dormant (nothing sets it).
- **SECURITY:** all text goes through `escapeHtml`, all colours through a strict `^#[0-9a-fA-F]{6}$` (`safeHexColor`) — the builder generates 100% of the markup and never accepts user HTML (same discipline as `creative-templates.ts`). XSS/CSS-injection locked by [super-text.test.ts](packages/super-text/src/__tests__/super-text.test.ts).
- **Burn once, publish everywhere:** [super-text.worker.ts](apps/worker/src/workers/super-text.worker.ts) probes → renders strip → streams source to /tmp (never let a long encode read http through nginx — PR #144) → ffmpeg composite → **duration integrity check (≥98% of source, else FAIL)** → uploads to `supertext/{org}/{mediaId}-{cfgHash}.mp4` → creates a **DERIVED Media row** → `postMedia.updateMany` repoints the attachment → enqueues the standard `optimize:{id}:v1`. Because the post ends up holding an ordinary video Media row, **the frozen IG/FB publish paths, media-optimize, streamed uploads and the watchdog need ZERO changes**. concurrency 1 (one ffmpeg on the 4-core box); Puppeteer additionally bounded by `CREATIVE_RENDER_CONCURRENCY`.
- **Gate coordination — [publish-gates.ts](apps/worker/src/lib/publish-gates.ts).** Super text and caption-fanout BOTH park a post as DRAFT. Each worker clears its OWN flag then calls `flipParkedPostIfReady`, which flips DRAFT→SCHEDULED only when NO gate remains, re-reading fresh metadata after its own write (so simultaneous completion can't strand the post). `caption-fanout`'s flip now defers when `superText.pendingBurn` is true. **Targets are flipped BEFORE the post** — a SCHEDULED post with DRAFT targets enqueues zero jobs (the bulkSchedule bug class).
- **FAIL-VISIBLE, unlike caption-fanout.** A shared caption is an acceptable degraded fallback; a MISSING text strip changes the post's meaning. On final retry exhaustion `markSuperTextFailed` marks the post + targets FAILED with an actionable message — it never publishes the un-burned video. `post.publishNow` also refuses while `pendingBurn` is true.
- **Retry idempotency:** `metadata.superText.results[mediaId].status === "done"` is persisted per entry, so a BullMQ retry never re-burns (the Media swap is not reversible). jobId `supertext:{postId}:v1` — **exactly 3 colon segments** (BullMQ >=5.70 rejects other counts).
- **Worker image fonts ([docker/Dockerfile.worker](docker/Dockerfile.worker)): `font-noto-emoji` + `ttf-liberation` are REQUIRED.** Without the emoji font the user's 😍 burns as tofu; Liberation Sans is Arial-metric-compatible so the strip wraps at the same words in preview and burn. Do not drop either.
- **Compose UI** ([SuperTextEditor.tsx](apps/web/components/content-agent/SuperTextEditor.tsx)): drag-to-position over a live stage, per-word colour swatches, S/M/L size, strip+text colour, 150-char cap. Video tiles only. **Inherits the OOM rules**: local files >256MB get a placeholder stage (never a `<video>`), the aspect probe is keyed on the URL STRING and released the moment metadata arrives, no `<img>` ever gets a video URL. `draftMediaSignature` includes `superText` so overlay edits re-persist the draft; restore re-validates via zod (a stale draft can never 400 the whole post).
- **Font picker — Classic / Sans (2026-07-28).** `SuperTextConfig.font` is an OPTIONAL `z.enum(["classic","sans"])`. Fonts live in ONE registry, `SUPER_TEXT_FONTS` in [constants.ts](packages/super-text/src/constants.ts), mapping the key → `{label, stack, weight, letterSpacingEm, embedded}`.
  - **`classic` is today's exact CSS** (same stack, same weight, and NO `letter-spacing` declaration — even `letter-spacing:0em` would be a byte change). `sans` is **Plus Jakarta Sans 800 (SIL OFL)** embedded as a base64 data-URI `@font-face` from [plus-jakarta-sans-800-latin.ts](packages/super-text/src/fonts/plus-jakarta-sans-800-latin.ts) (generated — `node scripts/gen-super-text-font.mjs`). Instagram Sans itself is Meta's proprietary typeface and is NOT licensable. Fidelity dial = `SUPER_TEXT_FONTS.sans.letterSpacingEm`.
  - **⚠️ Judge a candidate face by whether a user can TELL IT APART from Classic at ~23px — not by how well its metrics match Instagram Sans. Render it; don't reason about it.** `sans` first shipped as **DM Sans 700** because it was the closest match to Instagram Sans on paper (double-storey `a`, x-height, metrics). At the dialog's real size it was nearly indistinguishable from Arial — measured **0.4%** width delta on typical text — and the owner reported "I can see no difference" the same day. Plus Jakarta Sans 800 gives **4.8%**. Weight is **800 deliberately**: at 700 it sits too close to Arial Bold. The `@font-face` weight and `SUPER_TEXT_FONTS.sans.weight` must stay equal or Chromium synthesises bold (which rasterises differently on macOS vs Alpine) — test-locked.
  - **⚠️ `font` must stay `.optional()` and NEVER `.default()`.** A zod default INJECTS the key, changing `JSON.stringify` and therefore the worker's S3 burn-cache hash (`sha1(JSON.stringify(parsed.data))`) for every pre-existing config — needlessly re-burning correct videos. Absent ⇒ `resolveSuperTextFont()` ⇒ classic. The editor likewise OMITS `font` when it is classic.
  - **⚠️ `config.font` is NEVER interpolated into CSS.** `resolveSuperTextFont` looks the spec up via an **array `includes` allowlist**, deliberately not `key in SUPER_TEXT_FONTS` (`in` matches `__proto__`/`constructor`/`toString` and would return a garbage spec). Same discipline as `safeHexColor`. The emoji stack is appended in `buildStripInnerHtml` **outside** the registry so no font entry can forget it.
  - **⚠️ The worker MUST await the font before screenshotting — do NOT remove it.** `page.setContent(html, {waitUntil:"load"})` does **not** wait for `@font-face`; without the explicit `document.fonts.load()` + `fonts.ready` (10s-bounded) in `renderStripPng` ([super-text.worker.ts](apps/worker/src/workers/super-text.worker.ts)), Chromium screenshots early and **silently bakes the FALLBACK face** while the preview showed the real one. Skipped when the font needs no loading, so the classic path is untouched.
  - **No Dockerfile change:** embedding is what makes preview/burn parity structural (verified: local Chromium and the Alpine worker Chromium produce IDENTICAL layout — classic 2 lines 545×162, sans 2 lines 571×168), and it sidesteps quirk #10 / the empty `.dockerignore`. `font-noto-emoji` + `ttf-liberation` are still required (above); only the **latin** subset is embedded, so non-Latin still falls through to Noto exactly as before.
  - **🔒 Golden gate:** [super-text-render-golden.test.ts](packages/super-text/src/__tests__/super-text-render-golden.test.ts) snapshots the default render. It must pass with **0 snapshots written** — that is the byte-identity proof for existing posts. Never `-u` it blindly. Plan: [docs/superpowers/plans/2026-07-28-super-text-instagram-fonts.md](docs/superpowers/plans/2026-07-28-super-text-instagram-fonts.md).
- **Limits (v1):** configured at compose time only (no editing super text on an existing post), one strip per video, source ≤950MB (matches `OPTIMIZE_SIZE_BYTES`, refused at create with a friendly message). YouTube receives the burned video too — intended ("post it everywhere").

## Publish pipeline speed/fairness + exact-time scheduling (2026-07-18 PR #131 + 2026-07-20 Phase 2) — read before touching the publish queue

Full audit + phased plan: [docs/PUBLISH-PIPELINE-SPEED-PLAN.md](docs/PUBLISH-PIPELINE-SPEED-PLAN.md). Phase 1 (PR #131, deployed + E2E-verified on prod: X +14.6s, IG +32.3s from scheduled time, live URLs):
- **Platform-aware stagger** ([publish-stagger.ts](packages/queue/src/publish-stagger.ts), pure + tested): targets stagger only WITHIN a platform group (Meta/X 10s — shared app quota; other OAuth 5s; token-based 2s; first target of every platform = delay 0). Was a blind `index × 10s` — a 60-channel multi-platform post tailed out ~10 min. **Keep same-platform Meta/X spacing ≥10s** (FB error-368 throttles last hours).
- **Scheduled-post cron every 30s (was 2 min) + drain loop** (batches of 50, ≤10 batches/scan, module-level re-entrancy guard).
- **Worker `concurrency` 3→10 and limiter 3/5s→10/5s, env-tunable** (`PUBLISH_CONCURRENCY`, `PUBLISH_LIMITER_MAX`). The limiter is a GLOBAL safety valve, not platform protection — platform pacing = stagger + reactive rate_limit re-queue + FB provider backoff. At 3/5s, three slow jobs froze publishing for every org.
- **Priority lanes** ([publish-priority.ts](packages/queue/src/publish-priority.ts)): interactive publishes (post.router publishNow, chat publish_now, newsgrid bulkPublish) are deliberately **UNPRIORITIZED** — BullMQ drains the plain wait list before ANY prioritized job, so no-priority IS the fast lane. Cron + autopilot publish jobs = `priority: 5`, rate-limit retries = `priority: 10`. **Do NOT "fix" interactive producers by adding a priority** — that demotes them.

**Phase 2 — exact-time scheduling (branch `feat/exact-time-publish-2026-07-20`):** `post.create`/`post.update` enqueue per-target DELAYED jobs at save time via [schedule-publish.ts](packages/queue/src/schedule-publish.ts) — deterministic jobId **`sched:{targetId}:{scheduledAtEpoch}`** (exactly 3 colon segments), `delay = scheduledAt − now` + stagger, job data carries **`enqueuedFor`** (the scheduledAt epoch snapshot). The 30s cron is now a **reconciliation sweep with the SAME helper → SAME ids → BullMQ dedupe** (covers Redis-blip-at-save, caption-fanout flips, chat schedule_post, pre-Phase-2 posts). Invariants:
- **`isStaleScheduleJob` guard** ([publish-recovery.ts](apps/worker/src/lib/publish-recovery.ts)) runs BEFORE the atomic claim, ONLY for jobs with `enqueuedFor`: skip when the post's CURRENT `scheduledAt` no longer matches (reschedule keeps target ids, so old-time jobs survive and must never publish early; unschedule/publishNow/delete also mismatch). Do NOT remove, and do NOT set `enqueuedFor` on interactive producers.
- **Creation-path enqueue is best-effort** (try/catch, warn) — a queue error must never fail post.create/update; the cron reconciles (≤30s late).
- **Cron keeps the post-level SCHEDULED→PUBLISHING flip** — load-bearing for the rate-limit retry path (retried targets flip back to SCHEDULED; the post-level flip keeps reconciliation from re-enqueuing ahead of the long FB backoff).
- Correctness underneath is unchanged: atomic target claim (`SCHEDULED/FAILED/DRAFT→PUBLISHING`) + `publishedId` short-circuit make duplicate jobs harmless (no double-posting).

**Phase 4 — large-video (3–4GB) streaming (branch `feat/large-video-streaming-2026-07-20`, adversarially reviewed — 24-agent workflow, 5 real defects fixed pre-merge):** **`Media.fileSize` is now Prisma `BigInt`** (int4 capped ~2.1GB and crashed `media.create` AFTER a 3GB S3 upload; writes still accept plain numbers, READS return bigint — wrap with `Number(...)` at any new arithmetic/display site or tsc/web-build fails). Watchdog has a **12h hard reap ceiling** over the active-upload skip (perpetual rate-limit loops keep targets fresh). X/LinkedIn streamed uploads emit per-chunk `onProgress` (watchdog signal + UX — don't remove). creators upload 3–4GB Shorts/Reels source files. [ranged-media.ts](packages/social/src/utils/ranged-media.ts) (`headRemoteMedia` size-probe, `fetchByteRange` — **fail-closed: throws if the host ignores Range rather than silently buffering the full body**, `computeByteRanges`) lets the buffer-upload platforms stream: **YouTube** ≤64MB keeps the classic buffered path byte-for-byte (incl. buffer Shorts probe), larger files range-fetch each 16MB resumable chunk just before its PUT (large Shorts probed via `ffprobe <url>` — range-seeks, metadata-only); **X** probes type/size first and range-fetches each 5MB APPEND segment (INIT declares total_bytes → oversized files rejected before any transfer; images keep the buffered path); **LinkedIn** range-fetches each uploadInstruction. **Upload cap 500MB→4GB in [media.router.ts](packages/api/src/routers/media.router.ts) (presigned-multipart path ONLY — browser→S3 direct in 8MB parts; the proxied `/api/upload` route keeps old caps because it buffers in the web process — do NOT raise it)**. IG/FB watermark overlay skips videos > `VIDEO_OVERLAY_MAX_MB` (default 250 — multi-GB re-encode would exhaust worker disk/CPU) and posts the original. **Watchdog: a PUBLISHING post whose non-terminal target has a recent `updatedAt` (upload-progress writes) is SKIPPED, not failed** — long uploads must never be falsely FAILED at 30min; idle-target semantics unchanged ([watchdog.test.ts](apps/worker/src/scheduler/__tests__/watchdog.test.ts)). `maxMediaSize` constraint metadata deliberately untouched (informational; not in the publish path; test-locked).

**Phase 3 (2026-07-20, branch `feat/phase3-leader-activity-2026-07-20`):** (a) **`CRON_LEADER` gate** in [apps/worker/src/index.ts](apps/worker/src/index.ts) — crons run only when `CRON_LEADER !== "false"`; future extra worker replicas set `false` (pure queue processors). Do NOT run two cron leaders. (b) Autopilot channel stagger reuses `computePublishDelays`. (c) **Post archive** (owner-requested activity management): `Post.archivedAt DateTime?` — a VIEW-level soft archive, deliberately NOT a `PostStatus` (the pipeline's status machine must never see a new state); `post.archive` REFUSES SCHEDULED/PUBLISHING posts (their delayed jobs would still publish); `post.list` `archived`/`sort` inputs are additive with pre-Phase-3 defaults (`archivedAt: null` + `createdAt desc`) — locked by [post-archive.test.ts](packages/api/src/__tests__/post-archive.test.ts) (10 tests). PostsTab: sort dropdown + Archived tab + per-card archive; ActivityPanel: client-side status chips (header badges count the UNFILTERED feed). Per-platform token buckets + second worker container deliberately deferred (reasons in the plan doc).

## Insights data-accuracy overhaul + Meta metric reality (2026-07-22/23, branch `fix/insights-accuracy-and-caption-bug-2026-07-22`, PR #147+) — READ before touching analytics providers or claiming an insight needs a permission

Shipped to prod: providers declare honesty metadata (`likeKind` reactions/saves/upvotes · `reachIsDistinct` · `metricsAvailable` · `source` api/scrape) persisted into `AnalyticsSnapshot.metadata` ([snapshot-metadata.ts](apps/worker/src/lib/snapshot-metadata.ts)); [platform-metrics.ts](packages/api/src/lib/platform-metrics.ts) derives per-platform capabilities; the Channel Performance table + Reports render **`—` (unavailable) vs a real 0** ([metric-cell.ts](apps/web/lib/metric-cell.ts)), hide Reach when it just duplicates Impressions, and label Likes honestly per platform. Aggregation fixed: engagement rate pools only impressioned rows ([engagement-rate.ts](packages/api/src/lib/engagement-rate.ts)); `published ≤ totalTargets`; `engagement` proc filters `isActive` + `DISTINCT ON` tie-dedup. Snapshot dedup ([snapshot-dedup.ts](apps/worker/src/lib/snapshot-dedup.ts)) kills the FB 47×-per-target bloat. `social-scrapers` vendored as `@postautomation/social-scrapers` (consumed as SRC not dist — dist gitignored; `types/*.d.ts` committed) → FB-reel + Snapchat-spotlight scraper fallback (source=scrape, fail-open; **needs deploy-IP validation**). Full audit + fix list: [docs/INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md](docs/INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md).

**🔴🔴 DEFINITIVE ADMIN-vs-EXTERNAL TEST (2026-07-23) — the authoritative permission map. Tested the SAME calls with an admin token AND a genuinely external token (`karankumar1166dt@gmail.com`, real FB Pages):**
- **External FB users 400 (#10 `pages_read_user_content`) reading `reactions.summary`/`comments.summary` via the fields API.** The app read reactions+comments via FIELDS → for EXTERNAL users those 400 AND the OLD code returned NULL (lost ALL FB data). "reactions/comments work on pages_read_engagement" was WRONG — fields reactions/comments need **`pages_read_user_content`** (App Review; now requested).
- **FIX (1d28359): reactions now come from the INSIGHTS edge (`post_reactions_by_type_total`, external-safe on current perms); fields fetch is BEST-EFFORT (never NULL) — on 400 it retries shares alone + marks comments `metricsAvailable:false` → UI "—".** So external users get **reactions + shares + clicks** NOW; **comments stay "—" until `pages_read_user_content` App Review**.
- App-role users (admin/operator like tabish@/sudhanshu@) get EVERY requested scope free of App Review — so an "it works" test on those accounts proves NOTHING for external users. **Always test with a genuinely external token.**
- Per-call external result: reactions.summary/comments.summary→400 (pages_read_user_content); shares→200; insights post_clicks/post_reactions_by_type_total/post_video_views→200; page fan_count→200; ALL post_impressions*→#100 deleted.

**🔴 LIVE-VERIFIED META METRIC REALITY (2026-07-23) — do NOT re-add deleted metrics or claim a permission fixes them:**
- **⚠️ PARTLY SUPERSEDED 2026-08-11 (see the RECOVERABLE section below).** Still true: **EVERY `post_impressions*` (organic/paid/unique/fan) AND `post_engaged_users` = `#100 "must be a valid insights metric"`**, and requesting a dead metric **400s the WHOLE call** (zeroing even valid metrics), so those names must never be re-added. **No longer true:** the claim that impressions/reach are gone at the platform level and that "NO permission resurrects them" — Meta RENAMED them to `post_media_view` / `post_total_media_view_unique`, which work on the already-approved scopes. Reactions/comments/shares still come from post FIELDS (`pages_read_engagement`).
- **⚠️ IG insights REQUIRE `instagram_manage_insights` for EXTERNAL users (App Review) — the admin test does NOT generalize.** Live test `GET /{ig-media}/insights?metric=reach` → 200 `reach:2619` — BUT that account is the OPERATOR's (`sudhanshu@dashmani.com`, isSuperAdmin), i.e. effectively app-role. **Meta's v25 docs (Instagram Media Insights → Reading → Requirements) explicitly require `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement` for the Facebook-Login path.** App-role users (admin/dev/tester) get EVERY requested scope at Standard Access with NO App Review — that's the ONLY reason it worked. External users get only Advanced-Access-APPROVED scopes; `instagram_manage_insights` is REQUESTED (channel.router.ts:500) but NOT approved → external users' IG insights will FAIL until App Review grants it. **So IG DOES need the `instagram_manage_insights` App Review after all** (my earlier "IG needs no permission" was the app-role trap — corrected).
- **"Only two permissions remain" — partly true again:** IG genuinely needs `instagram_manage_insights` (App Review) for external users. FB's gap is a deleted-metric code fix (done) — `read_insights` won't restore impressions/reach (Meta deleted them), only helps `post_clicks`/`post_video_views` values. **Net: submit `instagram_manage_insights` (needed for external IG insights) + optionally `read_insights` (FB clicks/video-views values).**
  > **✅ SUPERSEDED 2026-08-06 — all three were submitted and APPROVED.** See the "Insight permissions APPROVED" section below for the post-approval reality, which corrects two things stated above: `read_insights` is **required** (not optional) for FB clicks/video-views — without it the feed edge returns a *silent* HTTP-200 empty rather than an error — and the approval does **not** reach tokens issued before it, so channels must be reconnected.
- **DECRYPT GOTCHA for any token probe:** only DIRECT `prisma.channel.findUnique/findFirst/findMany` auto-decrypts `accessToken` (the `$extends` in [packages/db/src/index.ts](packages/db/src/index.ts)); reading `channel` through a `postTarget` RELATION returns `enc:v1:` ciphertext → `#190 "Cannot parse access token"`. The analytics-sync worker uses direct `channel.findUniqueOrThrow` (correct). To probe: `docker cp` a tsx script into `postautomation-worker-1:/app/apps/worker/`, run `/app/node_modules/.pnpm/node_modules/.bin/tsx`.

## ✅ Insight permissions APPROVED + honest-capability plumbing (2026-08-06, branch `fix/insights-meta-permissions-2026-08-06`)

Meta approved all three analytics-read permissions (`pages_read_user_content`, `read_insights`, `instagram_manage_insights`; the 8 pre-existing scopes show **Renewed**). Everything below was **live-probed against the production Graph API** from inside `postautomation-worker-1` with real decrypted tokens — never inferred from the dashboard (the app-role trap makes an admin-token test worthless for external users). Full audit + plan: [docs/INSIGHTS-META-PERMISSIONS-GRANTED-2026-08-06.md](docs/INSIGHTS-META-PERMISSIONS-GRANTED-2026-08-06.md).

- **⚠️ SUPERSEDED 2026-08-11 — the metric NAMES are dead, but the CAPABILITY is not.** This bullet used to read "FB impressions/reach are DELETED … stop re-testing it." That was **wrong**: Meta **renamed** the metrics. See the "FB impressions/reach are RECOVERABLE" section below. What remains true: all nine `post_impressions*` variants PLUS `post_engaged_users`, `post_negative_feedback`, `post_clicks_unique`, `post_reach`, `post_views`, `post_activity*` return `#100 "must be a valid insights metric"` **on the same token that gets accepted rows for `post_clicks`** — so a missing permission is NOT the cause, and those names must never be re-added (one invalid name 400s the whole call). **The error was concluding "the metric is gone" from "the name is invalid."** `#100` says the NAME is wrong; the successor names are `post_media_view` and `post_total_media_view_unique`.
- **🔴 A missing scope on the FB feed-post `/insights` edge is a SILENT EMPTY: HTTP 200 + `{"data":[]}`, no error.** This was the core data bug — the empty array was read as "every metric is zero" and stored as a confident `0`, making a dead/under-scoped token indistinguishable from genuinely zero engagement. `post_clicks` + `post_reactions_by_type_total` ALWAYS return a row when permitted (even on a zero-engagement post), so they are reliable **sentinels**: *200 with zero rows ⇒ scope missing*. The FB **video** edge fails loudly instead (`#200 read_insights permission missing`). Classification lives in [meta-insight-diagnosis.ts](packages/social/src/utils/meta-insight-diagnosis.ts) — **`#100` is deliberately NOT mapped to `missing_scope`** (it means a deleted/unsupported metric NAME; mapping it would nag users to reconnect for data no permission can return).
- **⚠️ IG metric sets are per-`media_product_type` and MUTUALLY EXCLUSIVE — never union them.** Verified valid: **FEED** (incl. carousels — a carousel is `media_product_type: FEED` with `media_type: CAROUSEL_ALBUM`) gains `profile_visits,profile_activity,follows`; **REELS** gains `ig_reels_avg_watch_time,ig_reels_video_view_total_time`; **STORY** keeps `replies,navigation`. The FEED-only three are **NOT supported for REELS** — adding them to a shared set makes the combined REELS call fail outright (`#100 does not support the profile_visits… metric for this media product type`), zeroing EVERY metric for that Reel — the same all-or-nothing regression PR #148 already fixed once. A **3-rung ladder** (`preferred → base → reach`) in [instagram.provider.ts](packages/social/src/providers/instagram.provider.ts) makes this fail-safe: an unexpected rejection can only cost the extras, never the core metrics. Still invalid: `impressions` ("no longer supported" from v22.0), `plays`, `engagement`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `video_views`.
- **`metricsAvailable` is now derived from what Meta ACTUALLY returned, per metric.** The old IG `hasInsights = metrics.reach != null || impressions > 0` was one boolean for the whole call, so a partial success (product-type set fails, `reach`-only retry succeeds) declared impressions AND shares "available" while they were never returned. Presence is tracked per metric name.
- **Aggregates now honor per-capture capability — the other half of the PR #148 regression.** `gatePostReportRow` was taught to prefer `AnalyticsSnapshot.metadata.metricsAvailable` in 2026-07-27, but `perChannelStats`/`groupStats` still consulted the STATIC map only, so a FB **video** post's real views showed as a number in Reports and as "—" in Channel Performance *on the same page*. `fetchChannelStatRows` now aggregates declared availability in SQL (`BOOL_OR` over `s.metadata->'metricsAvailable'->>'<key>'`; uses `->>'key' IS NULL` rather than the jsonb `?` operator, which some drivers read as a placeholder) and `effectiveChannelUnavailable` ([platform-metrics.ts](packages/api/src/lib/platform-metrics.ts)) applies the same precedence: *some capture reported it ⇒ available; every capture said no ⇒ "—"; a legacy metadata-less capture ⇒ static map*. It returns the EFFECTIVE `unavailable` array — the shape `metricCellValue` already consumes, so no UI change was needed.
- **Engagement rate is gated on IMPRESSIONS availability.** It *is* engagement ÷ impressions, so it can only be as honest as its denominator: with impressions rendering "—", a printed rate is derived from a hidden number, and `0.00%` misreads as "no engagement" when the truth is "not reported". Gated in `gatePostReportRow` (Reports/CSV/email) and in the Channel Performance cell.
- **🔴 An App Review approval does NOT retro-add scopes to already-issued tokens** — scopes are granted only at consent time, and Meta additionally invalidated many sessions when the app config changed. Audited all **1328** active FB/IG channels via `debug_token`: only **1 FB + 1 IG** channel was simultaneously token-valid, holding the new scopes, AND had published posts. So **channel owners must reconnect once** for the approval to reach their data — no code change substitutes for that. `Channel.metadata.insightsHealth` (written by the analytics-sync worker via [channel-insights-health.ts](apps/worker/src/lib/channel-insights-health.ts), read via [insights-health.ts](packages/api/src/lib/insights-health.ts)) drives a reconnect banner on Insights, a per-row pill in Channel Performance, and an "Insights off" badge on Channels. **Health is derived from the Graph calls the pipeline ALREADY makes — deliberately NOT a `debug_token` sweep** (an N+1 over ~1300 channels; a batched version trips `#4 Application request limit reached`, which happened during the audit). Writes only when the verdict CHANGES, and the metadata merge MUST preserve sibling keys (`igUserId`/`orgId`/`instance`/`service`).
- **Meta serves `v20.0` for our `v18.0` requests** (visible in the `paging` URLs it echoes back) — we are silently auto-upgraded, which is why an IG error can cite a v22.0 removal. **Deliberately NOT changed:** bumping `apiVersion` touches the frozen publish path ("the posting process works — do NOT break it") and current behavior is correct. Schedule separately if ever needed.
- Tests: [meta-insight-diagnosis.test.ts](packages/social/src/__tests__/meta-insight-diagnosis.test.ts), [facebook-insights-metrics.test.ts](packages/social/src/__tests__/facebook-insights-metrics.test.ts), [instagram-insights-metrics.test.ts](packages/social/src/__tests__/instagram-insights-metrics.test.ts), [channel-metric-availability.test.ts](packages/api/src/__tests__/channel-metric-availability.test.ts), [channel-insights-health.test.ts](apps/worker/src/__tests__/channel-insights-health.test.ts), plus a **real-Postgres** suite [insights-availability-sql.e2e.test.ts](packages/api/src/__tests__/insights-availability-sql.e2e.test.ts) (skipped by default — the jsonb availability SQL cannot be covered by a mocked Prisma; run with `DATABASE_URL=… TOKEN_ENCRYPTION_KEY=… LIVE_E2E=1 npx vitest run insights-availability-sql`).

## ✅ FB impressions/reach are RECOVERABLE — Meta RENAMED them (2026-08-11)

**This overturns every earlier claim in this file that FB per-post impressions/reach were deleted and unrestorable.** From [Meta's own deprecated-metrics page](https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics):

```
post_impressions_unique*  (Alternative: post_total_media_view_unique)
page_impressions_unique*  (Alternative: page_total_media_view_unique)
```

Live-probed on production (real decrypted Page tokens, one metric per call, 5 mediaTypes + 25 reels). **Full plan: [docs/FB-MEDIA-VIEW-METRICS-PLAN-2026-08-11.md](docs/FB-MEDIA-VIEW-METRICS-PLAN-2026-08-11.md).**

| metric | photo | album | status | video | link | → |
|---|---|---|---|---|---|---|
| **`post_media_view`** | 14 | 144 | 3 | 276 | 58 | **impressions** |
| **`post_total_media_view_unique`** | 3 | 106 | 1 | 255 | 36 | **reach** |

- **🔑 NO App Review, NO reconnect, NO consent change.** `debug_token` on the answering token shows only already-approved scopes; **`read_insights` suffices**. Same edge, new names.
- **⚠️ The names are ASYMMETRIC and unguessable.** `post_media_view` is valid but `post_media_view_unique` is DEAD; `post_total_media_view_unique` is valid but `post_total_media_view` is DEAD. Also dead: `post_media_views`, `post_total_media_views`, `post_organic_media_view`, `post_paid_media_view`, `post_media_view_organic/_paid/_time`, `post_views`, `post_views_unique`. **Probe any new name individually against a live token** — one invalid name 400s the whole call. `post_engagements` returns a silent EMPTY200; unusable.
- **🔴 The new metrics exist ONLY on the POST node.** On a Video node → `#100`; `video_insights` → `EMPTY200`. That is why reels looked unrecoverable: the code was asking the *Video* node, which reports nothing for reels. `getPostAnalytics` routes bare video ids to `getVideoAnalytics`, so app-published videos need `resolveVideoPostId` first.
- **🔴🔴 THE FAKE-ZERO TRAP — Meta returns BOTH a `lifetime` AND a stale zero-valued `day` row** for `post_total_media_view_unique` (and `post_video_views`), and the `day` row comes **LAST**. A last-wins parse therefore stores **reach = 0 while declaring it available**. **ALWAYS select `period === "lifetime"`** — use `readMetricValue` from [fb-insight-metrics.ts](packages/social/src/utils/fb-insight-metrics.ts), never a plain `metrics[name] = value` loop.
- **The combined call is safe**: 5 requested names return 7 rows, HTTP 200, zero extra round-trips. The "network shape is FROZEN" comment on `getFeedPostAnalytics` means **round-trips, not query strings** — its enforcing test asserts call COUNT (`seen).toHaveLength(2)`), never the metric list. New names are **APPENDED** so that lock and `facebook-video.test.ts`'s prefix assertion both stay green.
- **Two-rung ladder** ([facebook.provider.ts](packages/social/src/providers/facebook.provider.ts)): rung 1 = base + the two new names; rung 2 = byte-identical to the pre-2026-08-11 call. **Descend ONLY on a metric-NAME error** — never on HTTP-200-with-zero-rows (the missing-scope sentinel) and never on 190/10/200/4. `#100` is **overloaded** (it is also object-not-found), so `classifyFbRung` requires code 100 **AND** `subcode !== 33` **AND** a name-error message. Because `#100` maps to NO degradation, the **loud `console.error` on descent is the ONLY signal** that Meta renamed a metric again — do not remove it.
- **The scraper was undercounting ~13×** (stored 6,421 where `post_media_view` reports 83,582). Still **KEEP** it: it is the only token-free path, ~49% of tokens are dead, and it is test-locked. It is **demoted** — fired only when the feed produced no POSITIVE count, gated on `(feed.impressions ?? 0) > 0` with an **EARLY return** (a fall-through would clobber the good value back to a declared-unavailable 0). The external merge is **MAX-preferring**, never `views ?? 0`, so a stored number can only go UP.
- **🔴 `SUM(reach)` is NOT reach.** `post_total_media_view_unique` is unique **per post**, so summing across posts counts the same person once per post they saw. Aggregate labels therefore say **"Reach (summed)"**; per-POST labels stay "Reach" (accurate there). A deduplicated figure needs the page-level edge — **the repo has no page-level insights code path at all**; that is a separate feature.
- **`CAPS.FACEBOOK.unavailable` stays `["impressions","reach"]` byte-identical.** Capability widens ONLY via per-capture `metricsAvailable` (editing CAPS was PR #148's mistake). Legacy metadata-less captures correctly fall back to the static map.
- **Kill switch `FB_MEDIA_VIEW_METRICS_ENABLED`, default OFF and fail-CLOSED (`=== "true"`, not `!== "false"`)** — the compose `environment:` allowlist means an unplumbed key arrives as `""`, and a fail-open check reads that as ENABLED (the PR #166 incident). It is plumbed in `docker-compose.prod.yml`.
- **Backfill** = `EXTERNAL_RECAPTURE_BEFORE` (ISO timestamp), a one-shot floor on `needsMetrics`. No new job, no new column: `metricsSyncedAt` is already the self-clearing progress marker. Metrics ordering measures **non-video first** (those rows have nothing today and are cheaper) — bucket with `isFacebookVideoLike`, never a bare `mediaType` equality check (mediaType carries two Meta vocabularies, so `added_video` would be mis-bucketed; locked by `external-video-budget.test.ts`).
- **Engagement rate is safe**: measured 0 of 120 live posts would trip `rate_impossible`. Both sides of the ratio now come from the same post's metrics, so the 200%/1400% class cannot recur.
- **METHOD LESSON:** a probe answers *"does name X work?"* — it can **never** answer *"does a name Y exist that I haven't thought of?"* The `#100 "must be a valid insights metric"` message was literally naming the problem. **When an API says a name is invalid, search the vendor's docs for the replacement before concluding the capability is gone.**
- Tests: [fb-insight-metrics.test.ts](packages/social/src/__tests__/fb-insight-metrics.test.ts) (19), [facebook-media-view-ladder.test.ts](packages/social/src/__tests__/facebook-media-view-ladder.test.ts) (11), [external-recapture-floor.test.ts](apps/worker/src/__tests__/external-recapture-floor.test.ts) (9).
- **⚠️ Run the real-Postgres availability suite before enabling the flag** — it is the ONLY executable proof the aggregate `has_meta`/`avail`/`BOOL_OR` jsonb logic works (a mocked Prisma cannot cover `$queryRawUnsafe`), and being `skipIf(!LIVE_E2E)` it never runs in a normal pass, so its fixtures rot silently. Verified 12/12 on 2026-08-11. Exact invocation (note: the psql role is `postautomation`, NOT `postgres`, and the key falls back to `NEXTAUTH_SECRET` from `.env`):
  ```bash
  cd packages/db && DATABASE_URL="postgresql://postautomation:postautomation_dev@localhost:5433/postautomation" \
    npx prisma db push --skip-generate            # local DB drifts; sync it first
  cd .. && set -a; source .env; set +a
  DATABASE_URL="postgresql://postautomation:postautomation_dev@localhost:5433/postautomation" \
    LIVE_E2E=1 npx vitest run insights-availability-sql
  ```
  One assertion in it had gone stale (`engagementRate` `toBe(0)` where `pooledEngagementRate` now correctly returns `null` for a zero base) — confirmed pre-existing by running the suite at `6482fa8` in a throwaway worktree, then fixed with a note. **When a skipped suite fails, check it against the pre-change commit before assuming your diff caused it.**

## 🔴 The scrape breaker counted SUCCESS as failure — FB reel measurement collapsed (2026-08-12)

**A capability improvement silently disabled the pipeline that fed it.** When
`FB_MEDIA_VIEW_METRICS_ENABLED=true` landed (2026-08-11 11:35 UTC), FB reel measurement stopped
within the hour. Found by audit, not by an alert.

- **Mechanism — three correct pieces composing into a stall.** (1) `getExternalPostAnalytics`
  returns EARLY with `source: "api"` whenever `post_media_view` yields a positive count — the happy
  path, no scrape needed. (2) The external-sync circuit breaker (which exists to detect a soft IP
  ban) inferred "a scrape missed" from `source !== "scrape"` — **which is also exactly what a clean
  API success looks like**. (3) After 5 consecutive *successes* it zeroed `scrapeBudget`, and the
  up-front `if (wantsScrape && scrapeBudget <= 0) continue;` then skipped **every remaining reel in
  the account without measuring it at all**.
- **Measured damage:** scrape-sourced captures `1,824/h → 0` inside the flag-flip hour and stayed
  0 for a day; **12,845 of 13,615 FB reels (94.3%) unmeasured or stale**, backlog *growing* ~163/day
  (933 new reels/day vs ~770 measured). Non-reel FB was fully caught up the whole time, which is why
  nothing looked broken. The scraper itself was fine — run live it returned real numbers in ~2s, so
  the "deploy IP is blocked" hypothesis was wrong.
- **Fix:** `SocialAnalytics.scrapeAttempted` is set ONLY when a scrape actually executed, and the
  breaker keys off that. **Never re-derive a scrape miss from `source`** — locked at the source
  level by [external-video-budget.test.ts](apps/worker/src/__tests__/external-video-budget.test.ts)
  (comments stripped before matching, since the explanatory note quotes the banned expression).
  Arithmetic extracted to pure [scrape-budget.ts](apps/worker/src/lib/scrape-budget.ts).
- **The up-front skip moved AFTER the capture** (`shouldDeferUnmeasured`): defer only when the row
  wanted a view count, no scrape was available, AND the API supplied no impressions either. The old
  guard predated the media-view metrics and was discarding good API captures to protect a fallback
  that is no longer needed.
- **🔴 Companion fix — availability must come from the SAME row as the value.** `presentMetricNames`
  iterates EVERY row, so a lone stale `period=day` row marked a metric present, while the value came
  from `selectLifetimeRow`. A day-only response therefore stored **0 declared available** — a
  fabricated zero. **Measured: 113 FB rows on 2026-08-12** with `impressions>0, reach=0,
  source=api, metricsAvailable.reach=true`, one storing reach 0 while Graph reported 16,438.
  `post_media_view` is lifetime-only, which is why impressions survived on the same row — that
  asymmetry fingerprints the bug. Use **`hasTrustedValue`**, never `present.has`, for any
  metricsAvailable key derived from insight rows.
- **⚠️ Two code comments were REFUTED by live probing and corrected** (facebook.provider.ts,
  social.types.ts): both claimed the feed edge "returns `post_video_views` = 0 for every video
  (measured 40/40)". It returns a real `lifetime` value (1,468 on a live reel) plus a trailing
  `period=day` row valued 0 — the 40/40 zero **was the last-wins parse**. That comment is what kept
  a working metric from ever being wired up. **A measurement taken through a known-buggy parser is
  not evidence about the API.**

## 🔁 The PERPETUAL "reconnect channels" banner — an ORPHANED channel row (2026-08-12)

**A channel left out of a later consent can never be healed by reconnecting, because the reconnect
never touches it.** Root-caused live on prod; fix on branch `fix/orphaned-channel-grant-2026-08-12`.

- **The mechanism.** The Meta OAuth callback upserts **only the pages/accounts the platform
  returns** for that consent. A page the user does not tick is never visited, so its
  `metadata.insightsHealth` keeps whatever it last had — and the only other thing that clears a
  verdict is a **clean capture** (`shouldApplyHealthVerdict`), which can never happen while the
  token keeps failing. **Measured:** one consent on 2026-08-11 granted 72 pages and healed all 72
  channels; the single page left out kept a verdict written 2026-08-10 reading *"The platform
  rejected the stored access token. Reconnect this channel."* The owner reconnected repeatedly on
  that advice. The banner was right about the symptom and **wrong about the remedy**.
- **🔴 `#190` + `error_subcode 492` is NOT a dead token.** *"The user must be an administrator,
  editor, or moderator of the page in order to impersonate it…"* — on the same request the backing
  **user token was `is_valid: true`**, held all 12 scopes, had `data_access_expires_at` 3 months
  out, and read **72 other pages fine — 33 of them in the SAME Business** as the failing one. So
  it is not the credential, not a scope, not the 90-day cliff, and **not business-wide 2FA**
  (ruled out by those 33). `diagnoseMetaError` now checks the **subcode BEFORE** the broad
  `TOKEN_INVALID_CODES` test — 492 arrives *with* code 190, so the generic branch swallowed it.
- **⚠️ Deselection vs role-loss is UNDETERMINABLE through the API** (`me/assigned_pages` → `#10`;
  `{page}/roles` needs the very page token you cannot mint). Do NOT assert either cause. Both are
  fixed by the same action, so the copy names the **action** ("reconnect → *Edit settings* → tick
  it; if it is not listed, pause/disconnect"), never a cause.
- **⚠️ `markChannelsMissingFromGrant` ([orphaned-grant.ts](packages/api/src/lib/orphaned-grant.ts))
  is deliberately NARROW — only channels ALREADY `needs_reconnect` are re-stamped.** A workspace
  can hold two platform logins granting different page sets; reconnecting login B must never
  slander login A's healthy channels. It also **fails CLOSED on an empty grant** (an empty page
  list is evidence of an upstream failure, not of mass revocation) and is **idempotent**. It runs
  best-effort after the upsert loop — a bookkeeping failure must never fail a connect that already
  succeeded.
- **⚠️ Every actionable `AnalyticsDegradeReason` MUST be listed in `deriveInsightsHealth`.** An
  unlisted reason falls through to `"ok"`, marking a channel that reports nothing as healthy —
  silent data loss with no explanation anywhere. `page_access_lost` outranks `token_invalid` in
  `worstDegradation` so the specific diagnosis is not discarded when both occur.
- **Scale (measured):** 67 of 100 Digital-Sukoon-owned pages are non-impersonable by that login;
  **84 channels** repo-wide carry `needs_reconnect`; **5 of 13** stored FB user tokens are already
  invalid. The banner shows a small number only because it is **scoped to the active workspace**.
- ⚠️ **`channel.connected` is not audited** (only `channel.disconnected`), so the audit log cannot
  confirm a reconnect. Token `issued_at` + row `updatedAt` is the reliable substitute. **Counting
  distinct DECRYPTED `userAccessToken` values per org = counting distinct consents** — that is
  what cracked this, and it costs zero API calls.
- **METHOD:** `me/accounts` returning N pages proves those N are granted; it proves **nothing**
  about *why* a missing one is missing. A single such call is an *effect*, not a *cause* — I first
  concluded "admin lost, reconnect can never fix it" from exactly that, and both halves were wrong.
- Tests: [orphaned-grant.test.ts](packages/api/src/__tests__/orphaned-grant.test.ts) (14),
  plus the 492 cases in [meta-insight-diagnosis.test.ts](packages/social/src/__tests__/meta-insight-diagnosis.test.ts)
  and [channel-insights-health.test.ts](apps/worker/src/__tests__/channel-insights-health.test.ts)
  — all three verified FAILING against `main` in a throwaway worktree before the fix.

## 🔑 Meta token lifetime — the 90-day DATA-ACCESS cliff (2026-08-06) — READ before debugging "insights stopped working"

**This is why Meta insights die every ~3 months, and it had ZERO monitoring.** All live-verified from prod with `debug_token` on freshly reconnected channels.

- **Meta tokens do NOT expire, but their DATA ACCESS does.** Both FB **Page** tokens and IG **user** tokens report `expires_at = 0` (⇒ never) **and** `data_access_expires_at = +90 days`. A token stays valid for **posting** indefinitely while losing the right to **read data** at the 90-day mark. So "the token expired" is almost never the right diagnosis — say "data access lapsed".
- **`Channel.tokenExpiresAt` is legitimately NULL for every Meta channel** (974 FB + 364 IG measured) because `expires_at` really is never. That is CORRECT — do not "fix" it by inventing an expiry.
- **⚠️ `scheduleTokenRefreshes` has never selected a single Meta channel, and cannot.** It filters `tokenExpiresAt: { lte: soon }`, and in SQL `NULL <= x` is NULL ⇒ row excluded. Measured: **1338 of 1339** active FB+IG channels unreachable by that cron. This is now documented in the function itself — it is NOT a bug to fix, because:
- **🔴 A SERVER-SIDE REFRESH CANNOT EXTEND DATA ACCESS — verified empirically.** Re-exchanging a live IG token via `grant_type=fb_exchange_token` returned a new token whose `data_access_expires_at` was **byte-identical (delta 0 days)**. Only a **user re-authorization** through the consent dialog resets the window. So auto-refresh is useless here; do not build it. The only remedy is a reconnect, and the only useful engineering is knowing the deadline in advance.
- **What was built instead:** [meta-data-access.ts](packages/social/src/utils/meta-data-access.ts) `fetchMetaTokenWindow` (one `debug_token` call) is called **ONCE PER CONSENT** in the OAuth callback (the same user token backs every Page/IG account from that consent) and stamps `Channel.metadata.dataAccessExpiresAt`. `evaluateChannelInsightsStatus` ([insights-health.ts](packages/api/src/lib/insights-health.ts)) then yields `ok | expiring_soon | needs_reconnect` (warn window `DATA_ACCESS_WARN_DAYS = 14`), driving the Insights banner + a per-channel "Insights end in Nd" badge. A live capability failure OUTRANKS a future deadline (it's broken now). `scheduleMetaDataAccessBackfill` (daily) fills the value for pre-existing channels — **token-DEDUPED and hard-capped at 40 calls/run**, because a naive 1328-channel `debug_token` sweep trips `#4 Application request limit reached` (that happened during the audit).
- **Probing tokens:** only DIRECT `prisma.channel.findUnique/findFirst/findMany` auto-decrypts `accessToken`. `/me/permissions` does NOT work on an FB **Page** token (`me` resolves to the Page, which has no `permissions` edge → `#100 nonexisting field`) — use `debug_token` with an app token (`{id}|{secret}`) for Page tokens.

## 📊 Engagement rate MUST pool over impressioned posts only (fixed 2026-08-06)

**The bug it prevents was live on prod: a channel showed `Eng. Rate 1400.00%`.** The rate summed
the numerator over **all** of a channel's posts but built the denominator from **only** the posts
that reported impressions. On Facebook only VIDEO posts carry an impression figure, so a
channel's entire reaction count got divided by one video's view count (14 reactions ÷ 1 view).

- The correct rule already existed in [engagement-rate.ts](packages/api/src/lib/engagement-rate.ts)
  (`computeEngagementRate`: only rows WITH impressions contribute to **both** sides) and
  `analytics.engagement` used it. **`perChannelStats` and `groupStats` never did** — they
  computed the rate inline from raw channel sums, and `group-stats.ts` `rateFromRows` pooled at
  *channel* granularity, inheriting the inflated numerator one level up (group "fb" showed
  32.76% where the truth was 10.34%).
- Fix: `fetchChannelStatRows` emits `impressioned{Impressions,Likes,Comments,Shares}` +
  `impressionedPosts` via `SUM(...) FILTER (WHERE s.impressions > 0)`. **Any new rate calculation
  must use those, never the raw sums.** Verified prod values: Bollywood `8.77% → 7.02%`,
  Contents of bollywood `1400% → 200%`.
- **Also disclose the base.** `engagementRateBasis {impressionedPosts, totalPosts}` renders as
  `7.02% (1/10)`. A rate derived from one post must not read as the channel's overall rate — on
  Facebook that is the *normal* case. Zero base ⇒ **"—"**, never `0.00%`.
- Locked by [engagement-rate-pooling.test.ts](packages/api/src/__tests__/engagement-rate-pooling.test.ts)
  (reproduces both prod numbers) and the real-Postgres
  [insights-availability-sql.e2e.test.ts](packages/api/src/__tests__/insights-availability-sql.e2e.test.ts).

## "Posts" ≠ the platform's post count (a recurring false bug report)

Channel Performance's **"Posts sent"** counts posts published **through PostAutomation** inside
the selected date range. The platform's own count is legitimately higher. **MEASURED 2026-08-06**
by diffing the Page's `published_posts` edge against our `PostTarget` rows:

| | Bollywood | Contents of bollywood |
|---|---|---|
| Facebook reports | 13 | 12 |
| our DB | 10 | 7 |
| id-matched both | 8 | 6 |
| only on Facebook (posted directly) | 5 | 6 |
| only in our DB | 2 | 1 |

Both sides close: `8+5=13`, `8+2=10`. ⚠️ **"only in our DB" is partly an artifact:** video
publishes store a bare **Video-node id** while `published_posts` returns `{page}_{post}` ids, so
videos can never be id-matched. One of Bollywood's two was still live (the reel scraper returned
57 views for it in the same run); only `1748002179986936` was genuinely deleted. Column renamed +
footnoted so the comparison stops looking like a bug.

## ✅ Disconnecting a channel is now a SOFT delete (2026-08-06) — history is preserved

`Channel.disconnectedAt DateTime?` replaces the old hard `delete`. Three states:

| State | `isActive` | `disconnectedAt` | Postable | Channels page | Insights |
|---|---|---|---|---|---|
| Connected | `true` | `null` | ✅ | ✅ | ✅ |
| Paused | `false` | `null` | ❌ | ✅ badge *Paused* | ✅ history |
| Disconnected | `false` | set | ❌ | hidden | ✅ history, badge *Disconnected* |

- **`channel.delete`/`deleteMany` must NEVER return** — locked by
  [channel-soft-delete.test.ts](packages/api/src/__tests__/channel-soft-delete.test.ts). `PostTarget.channel`
  is `onDelete: Cascade`, so a hard delete destroys every record of posts sent to the channel plus
  its Insights history (see the section below for the damage already done).
- Disconnect writes `accessToken = DISCONNECTED_TOKEN` (exported from `@postautomation/db`),
  **not `""`**: the column is NOT NULL and `encryptToken("")` returns `null`, so an empty string
  makes Prisma reject the update ("Argument `accessToken` must not be null") — i.e. disconnect
  would throw. Caught by the real-Postgres test, not by tsc. The real credential is still
  destroyed; if the sentinel ever reaches a platform call it fails auth, which the insights-health
  layer already surfaces as "reconnect this channel".
- **Reconnect REVIVES the same row** — every OAuth upsert clears `disconnectedAt` alongside
  `isActive: true`. This preserves history *and* stops the duplicate-channel proliferation that
  disconnect→reconnect used to cause. The test asserts one `disconnectedAt: null` per
  `isActive: true` site; **add both when adding a platform.**
- **Posting guards:** `post.create`/`post.update` and `assertChannelsOwned` (chat/agent actions)
  filter `disconnectedAt: null`. Without them a disconnected, token-less channel could be targeted
  and would only fail at publish time.
- **Insights count history from paused AND disconnected channels** (owner decision: "count all
  real history"). The stat aggregate no longer filters the Channel join on `isActive` — that
  filter is precisely why disconnecting made history vanish. ⚠️ Consequence: org totals are
  *higher* than before, because real engagement on paused/disconnected channels now counts. Rows
  carry `channelStatus` so the UI badges them, and they age out of the window naturally.

## 📊 Shares per platform — what is actually obtainable (settled 2026-08-07)

| platform | shares? | source | notes |
|---|---|---|---|
| **FACEBOOK** | ✅ yes | post-FIELDS edge `?fields=shares` | needs `pages_read_user_content`. Graph **OMITS** the key at zero, so absent ≠ 0. |
| **INSTAGRAM** | ✅ yes | insights `shares` metric | present in FEED/REELS/STORY sets. Measured max on prod: **27,119** on one post. |
| **YOUTUBE** | ❌ **never** | — | Data API v3 `statistics` has **no share count at all**. |

**🔴 YouTube shares are IMPOSSIBLE on the current API — do not try to "fix" this.**
`statistics` exposes only `viewCount` / `likeCount` / `commentCount` / `favoriteCount`. The
provider used to map `favoriteCount` into the shares slot, but Google deprecated that field
years ago and it returns **0 for every video, permanently**. Verified on prod 2026-08-07:
**263 YouTube snapshots, ZERO with shares > 0**, while 78 had likes and 137 had views — the
pipeline is healthy; the metric does not exist. Share counts are only available from the
**YouTube Analytics API** (`sharingService` dimension), a DIFFERENT API requiring
`yt-analytics.readonly` + channel ownership — not wired, and a separate project.
`metricsAvailable.shares: false` is therefore CORRECT for YouTube: the UI renders "—"
("not reported") rather than "0" ("measured as zero").

## 🔁 "Shares not visible in Insights" — an OMITTED key is NOT evidence of availability (2026-08-07)

User-reported. Two different causes, only one of them a bug:

- **INSTAGRAM (63 of 64 posts): not a bug.** Those captures declare `shares:false` AND carry
  `degraded` — dead tokens (`190/460`), so nothing is returned and "—" is correct. Fixed by
  reconnecting, not by code.
- **🐛 FACEBOOK (12 snapshots, 2026-08-02 → 2026-08-07): a real bug.** Those rows have the
  `shares` key **OMITTED** from `metricsAvailable` and `shares = 0`, so they rendered a
  confident **"0 shares"**.

**Root cause — a metric with an INDEPENDENT failure mode cannot inherit availability from
its siblings.** The honesty contract's general rule is *"this capture declared other keys,
so an omitted one must have worked"*. That holds only when every metric came from ONE
platform call. On Facebook it does not: `clicks`/`likes` come from the post-**insights**
edge while `shares` comes from the post-**fields** edge (which additionally needs
`pages_read_user_content`). Insights can succeed — declaring clicks/likes — while the
fields call silently fails, leaving `shares` omitted and stored as 0.

Compounding it: **Graph OMITS the `shares` field entirely for a post with genuinely zero
shares** (verified in the probes), so "0 shares" and "we could not read shares" are
indistinguishable in storage. "—" is the only honest render for a capture that never
declared it.

**Fix is in TWO halves — keep both:**
1. *Write side* (PR #161): `facebook.provider` now declares `shares: shares !== null`
   explicitly, so NEW captures are trustworthy.
2. *Read side* (this change): `requiresExplicitDeclaration(platform, key)` in
   [platform-metrics.ts](packages/api/src/lib/platform-metrics.ts) — currently
   `{ FACEBOOK: ["shares"] }` — makes `gatePostReportRow` AND
   `effectiveChannelUnavailable` render "—" for an undeclared FB `shares`, so the 12 stale
   rows stop lying immediately instead of waiting to self-heal.

⚠️ Deliberately NARROW. Do not widen it to other metrics/platforms without evidence of a
genuinely separate call path — over-applying it would hide real zeros.

**⚠️⚠️ The per-row rule must NEVER be applied to the AGGREGATE — I made exactly this mistake
and it hid real data on prod.** `effectiveChannelUnavailable` receives `declaredAvailable`
as a `BOOL_OR` across EVERY capture on the channel, so it already answers *"did ANY capture
report this metric?"*. An undefined key there means "no evidence at all", NOT "one call
failed". Applying `requiresExplicitDeclaration` there blanked the **Shares column for whole
channels** while the stored `metricsAvailable` held `shares: true` — 629 external posts with
real shares (one Instagram post at 27,119) rendered "—". Fixed by removing the clause from
the aggregate and keeping it in `gatePostReportRow`, which is per-row and where it belongs.
Regression-guarded in [shares-visibility.test.ts](packages/api/src/__tests__/shares-visibility.test.ts). IG reads everything
from one insights call, so its siblings ARE valid evidence and it is excluded.
⚠️ Two pre-existing tests asserted the OLD behavior (`shares === 3` / `=== 0` from an
undeclared key) — they encoded the bug as expected and were updated with a note.
Tests: [shares-visibility.test.ts](packages/api/src/__tests__/shares-visibility.test.ts)
(verified FAILING pre-fix), [facebook-shares-availability.test.ts](packages/api/src/__tests__/facebook-shares-availability.test.ts).

## 📥 Insights now cover ALL posts on a connected page, not just ones we published (2026-08-07)

Insights was built entirely on `PostTarget` — posts published **through** PostAutomation —
which is why it looked so sparse. **Measured on prod: reachable Pages average 17.7 posts
since 2026-08-01 while Pages we publish through average 3.7 — ~5x more activity was
invisible.** New `ExternalPost` model + ingestion pipeline closes that gap for FB/IG from
**2026-08-01 onward** (the product floor; never list older).

**Everything below was LIVE-PROBED against the production Graph API** — see
[docs/EXTERNAL-POSTS-INSIGHTS-GROUND-TRUTH-2026-08-06.md](docs/EXTERNAL-POSTS-INSIGHTS-GROUND-TRUTH-2026-08-06.md).
Do NOT re-derive these by reasoning; that document wins over any inference.

- **✅ We CAN read insights for posts we did NOT publish.** A Page token reads
  `/{post}/insights` for any post on that Page (HTTP 200, 4 metric rows on a foreign post).
  No extra permission beyond the approved set. Verified on 4 Pages we never posted through:
  **14 of 16 posts returned real engagement**.
- **Listing edge is `/{page}/published_posts`, NOT `/feed`.** Both respond, but `/feed`
  admits visitor posts. `since=<unix>` IS honored; paging is cursor-based; ids come back
  composite `{pageId}_{postId}`. IG uses `/{ig-user}/media` (bare ids; `media_product_type`
  captured because IG metric sets are per-product-type and mutually exclusive).
- **🔑 The FB video dedup problem is SOLVED.** `GET /{video-id}?fields=id,post_id` returns a
  `post_id` that is the **second half** of the composite id, so the match key is
  **`{pageId}_{post_id}`**. CLAUDE.md previously recorded that videos "can never be
  id-matched" — they can. [facebook.provider.ts](packages/social/src/providers/facebook.provider.ts)
  `resolveVideoPostId`; result persisted to `PostTarget.metadata.resolvedPostId` so the call
  never repeats. IG needs none of this (exact string match).
- **⚠️ Rate limits are PER-PAGE (Business Use Case), not one global pool.**
  `x-business-use-case-usage` is keyed by page id; measured `call_count: 1` (=1%) after a
  real listing call. A full cold sweep ≈ 4,000 calls ≈ 38/page. **Meta is NOT the
  constraint — the 4-core box is.** Hence sharding + concurrency 2, never burst parallelism.
- **🔴 Coverage is limited by DEAD TOKENS, not code.** Unbiased 30-Page sample: **23% of FB
  Pages reachable** (~95 of 409); **0 of 12 IG accounts** (all `190/460 session
  invalidated`). Only a user reconnect fixes it. ⚠️ Sibling-token failover sounds like it
  should double coverage but measured **zero** lift — `190/460` is a USER-level event so a
  user's tokens die together. Ranking still matters (19/20 succeed on the first ranked
  token); failover is a ~0-5% edge case, not a strategy.

**Architecture — fetch per ACCOUNT, store per CHANNEL.** 1339 active FB+IG channel rows
collapse to **524 distinct `platformId`s** (the same Page legitimately exists in many orgs).
One Graph call per account, then cheap rows fanned out to every channel sharing it (~4k rows
total). That buys account-level API efficiency while keeping the ordinary
`-> Channel -> organizationId` join every Insights query already uses, so org scoping needs
no new machinery.

- **🔒 Do NOT synthesize Post/PostTarget rows for external posts.** The publish cron only
  selects `SCHEDULED`, so that specific risk is containable — but synthetic `Post` rows
  would also leak into Content Studio's list, the calendar, the archive, bulk
  delete/export, the activity feed, the watchdog, and **`enforcePlanLimit("postsPerMonth")`**,
  burning a user's quota on posts they made directly on Facebook.
- **Read paths union ONLY `postTargetId IS NULL`** (posts we did *not* publish) on top of the
  existing PostTarget aggregates — purely additive, so a dedup mistake LOSES a row
  (conservative) instead of double-counting. `fetchChannelStatRows` is now a
  `WITH app_rows / ext_rows / all_rows` union; `analytics.engagement` was rewritten to reuse
  it, so the headline tiles and the Channel Performance table now agree BY CONSTRUCTION.
- **`metricsSyncedAt IS NULL` = listed but never measured ⇒ every metric renders "—", never
  a fake 0**, and the row contributes to NEITHER side of the engagement-rate ratio (the
  1400% bug class cannot recur through this population).
- **⚠️ `has_meta` and `avail` are SEPARATE columns in the aggregate.** Collapsing them into
  "avail IS NULL ⇒ unknown" silently changes behavior for snapshots carrying metadata
  WITHOUT a `metricsAvailable` claim (e.g. at-age captures stamped only with `windowTag`) —
  flipping them from "available" to the static map, which on Facebook turns a real number
  into "—".
- **Reports `at_age` mode deliberately EXCLUDES external posts** — at-age checkpoints are
  enqueued at publish time, so a post we didn't publish can never have one. Including them
  would render a table of "—".
- **Cron**: `scheduleExternalPostSync` every 2h, **sharded into quarters** (full sweep per
  8h) via a stable hash, 8-min warmup, `CRON_LEADER`-gated. jobId
  `extsync:{platform}-{platformId}:{bucket}` — **exactly 3 colon segments** (BullMQ rejects
  other counts). **Kill switch: `EXTERNAL_SYNC_ENABLED=false`.** Tunables:
  `EXTERNAL_SYNC_SHARDS`, `EXTERNAL_SYNC_CONCURRENCY`, `EXTERNAL_METRICS_PER_RUN`,
  `EXTERNAL_LIST_PAGE_SIZE`, `EXTERNAL_LIST_PAGE_HARD_STOP`.
- **🔴 LISTING RUNS TO EXHAUSTION — there must be NO cap that truncates a post count.**
  v1 used 4 pages × limit 25 = exactly 100, and every busy channel reported **"Posts: 100"**
  — a cap masquerading as a count (ten channels all showing precisely 100 on prod).
  A displayed number must be the truth, not a ceiling. Listing is the CHEAP half (ONE call
  per 100 posts vs TWO calls per post for metrics), so even a 5,000-post channel costs 50
  calls ≈ 1% of a Page's budget. `LIST_PAGE_HARD_STOP` (5000 pages) is a **runaway guard**
  for a non-terminating cursor, logged loudly as an anomaly — never a silent product cap.
  A repeated cursor also breaks the loop.
  **`METRICS_PER_RUN` (150) IS a legitimate throttle** — metrics cost 2 calls/post — and it
  is safe ONLY because an unmeasured post keeps `metricsSyncedAt = NULL`, renders "—" (not
  a fake 0), and contributes to neither side of the engagement rate. So the post COUNT is
  always complete immediately; the numbers fill in newest-first over later passes.
  **Rule of thumb: a cap that changes a displayed value is a bug; one that only defers a
  value is a budget.**
- **"Sync Now" (`analytics.triggerSync`)** refreshes BOTH populations: app-published targets
  AND direct posts (it enqueues external sync per ACCOUNT for the org's FB/IG channels).
  ⚠️ jobIds are bucketed to a **2-minute window** (`syncnow:{targetId}:{bucket}` /
  `extsyncnow:{platform}-{platformId}:{bucket}`). They previously used `Date.now()`, which
  is unique per click, so BullMQ dedup NEVER fired and N users clicking enqueued N copies
  of identical work. Do NOT reintroduce a timestamp in a jobId.
- **UI**: Channel Performance column renamed **"Posts sent" → "Posts"** (it is no longer only
  what we sent — this also resolves the long-standing "we show 10, Facebook says 13"
  complaint); Reports rows carry a **"Direct"** badge; a restrained partial-coverage notice
  appears only when the selected range starts before 2026-08-01 AND a Meta channel exists.
- Tests: [external-post-dedup.test.ts](apps/worker/src/__tests__/external-post-dedup.test.ts),
  [external-sync-accounts.test.ts](apps/worker/src/__tests__/external-sync-accounts.test.ts),
  plus **real-Postgres** [external-posts-insights.e2e.test.ts](packages/api/src/__tests__/external-posts-insights.e2e.test.ts)
  (`LIVE_E2E=1`) — a mocked Prisma cannot catch a broken CTE/UNION.

## 🧹 Orphaned AnalyticsSnapshot janitor

`AnalyticsSnapshot` has **no FK** to `PostTarget` (bare `postTargetId`, indexes only), so every
cascade-deleted target stranded its snapshots permanently — unreadable (no join path) and
uncollected. **MEASURED 2026-08-06: 1,324,188 FB + 2,953 IG + 487 TWITTER + 70 YOUTUBE orphans.**

`purgeOrphanedAnalyticsSnapshots` ([cron-jobs.ts](apps/worker/src/scheduler/cron-jobs.ts)) runs
daily, batched (5k) and capped (50k/run) so it never holds a long lock on the 4-core box.
**REPORT-ONLY until `ORPHAN_PURGE_ENABLED=true`** (owner decision: see the real count first —
deletion is irreversible). Soft delete stops the channel-driven source, but post deletion
(`bulk.bulkDelete`, `post.delete`) still cascades targets, so this is a permanent janitor.
**Deferred:** adding a real FK — the structural fix, but it needs the table clean first and would
lock 1.3M rows.

## ⚠️ Disconnecting a channel DESTROYED its post history (pre-2026-08-06 damage)

`PostTarget.channel` is `@relation(onDelete: Cascade)`, and `channel.disconnect` / `bulkDisconnect` do a **hard `delete`**. So disconnecting a channel permanently deletes **every PostTarget for it** — the entire record of posts sent to that channel plus its Insights history — and leaves **orphaned `AnalyticsSnapshot` rows forever** (AnalyticsSnapshot has NO FK to PostTarget, so nothing cleans them up).

Measured on prod 2026-08-06: **329 PUBLISHED + 1262 FAILED + 91 DRAFT posts already have zero targets** from past disconnects, and 111 `channel.disconnected` audit entries landed in a 14-minute window during one reconnect session. The confirm dialogs now say this explicitly and point at **Pause** (`isActive: false`) as the non-destructive alternative. **Open decision (NOT implemented):** making disconnect a soft-delete. It would preserve history but changes what "disconnect" means (the channel would linger), so it needs an owner call — don't change it unilaterally.

## Insights are scoped to the ACTIVE WORKSPACE (a common false bug report)

"No posts in the last 30 days" / an empty Insights page usually means **org isolation working correctly**, not data loss. Superadmin does NOT bypass org membership (see Roles & Access Control). Diagnosed 2026-08-06: `tabish@dashmani.com` is a member of exactly ONE org, and the posts they remembered lived in **other** members' workspaces (DASHMANI 60 targets, karankumar 9, kritika 8, Aditi 5, Digital Sukoon 4) while their own workspace had 0. Reconnecting also created channels in the ACTIVE org, so the same IG account can legitimately exist in 6 orgs at once (`@@unique([organizationId, platform, platformId])` is per-org). Before hunting a bug: check which org the session resolves to, and `SELECT ... GROUP BY organizationId` on the published targets. The "Nothing to sync" toast now names the workspace and says Insights only cover posts sent *from* it.

## Capability-driven Insights columns — no dead "—" furniture (2026-08-06)

`reportableMetrics(platforms, declaredAvailable?)` ([platform-metrics.ts](packages/api/src/lib/platform-metrics.ts)) returns the metrics ANY connected platform can ever populate. `analytics.engagement` and `analytics.postReports` both return it, and the UI **drops whole columns/tiles** rather than rendering an all-"—" column:
- An **FB-only org** loses the Impressions, Reach and Eng.% columns, the Impressions/Reach engagement tiles, and the "Total Reach" stat card (which becomes "Total Views", or "Total Engagement" when neither is reportable). Browser-verified.
- An **IG-only org** loses Clicks (Instagram has no click metric).
- A per-capture override widens it back: a Facebook channel that posted a **video** does report views, so Impressions stays.
- ⚠️ Derived from **platform capability, NOT from "are all values null?"** — an all-null column also means "not synced yet", and hiding it then would erase a column that is about to fill in. While the query loads, everything shows so the header doesn't reflow.
- The CSV export assembles its metric columns the same way, so a dropped column can't reappear as an all-empty CSV column; header and row indexes are built from one filtered list to stay aligned.
- **No scraper alternative exists for FB impressions/reach.** They are private Page Insights that Meta deleted from the API — they appear nowhere on a public page, so scraping cannot recover them (unlike FB **video/reel view counts**, which are public and already have a scraper fallback in `getVideoAnalytics`). Page-level `page_impressions` still exists but is page-wide, not per-post — a different feature, not a substitute.

## Insights page (Analytics) + Reports — 2026-07-17, PR #122

`/dashboard/analytics` is now **Insights** with two tabs (`?tab=insights|reports` deep link, Suspense-wrapped `useSearchParams`): the unchanged analytical view, and **Reports** — per-post × per-channel table over **24h/7d/15d/30d** windows with CSV export ([ReportsTab.tsx](apps/web/components/analytics/ReportsTab.tsx), [csv.ts](apps/web/lib/csv.ts)). Backed by `analytics.postReports` ([analytics.router.ts](packages/api/src/routers/analytics.router.ts)) — orgProcedure (USER-readable), `$queryRawUnsafe` + `LEFT JOIN LATERAL` latest-snapshot pattern.
- **Two modes (owner decision):** `current` = targets PUBLISHED in-window w/ latest snapshot (works on all existing data); `at_age` = metrics pinned to **at-age checkpoints**: [post-publish.worker.ts](apps/worker/src/workers/post-publish.worker.ts) step 4c enqueues 4 DELAYED analytics-sync jobs per published target (24h/7d/15d/30d, `jobId atage:{targetId}:{tag}` dedupes, best-effort) and [analytics-sync.worker.ts](apps/worker/src/workers/analytics-sync.worker.ts) stamps `AnalyticsSnapshot.metadata.windowTag`. At-age data **accrues from 2026-07-17 onward** — older posts show "—" (by design, no backfill possible). At-age jobs include FACEBOOK (the 6-hourly cron still excludes FB for quota; 4 one-shot calls/post are negligible).
- Metric caveats (platform APIs, NOT bugs — don't "fix"): views ride on `impressions` (YT/Threads/IG-Reels/DevTo/Reddit); Twitter metrics 0 on free tier; IG never fills clicks (Reels DO fill shares/saved); **FB impressions/reach are GONE (Meta deleted the metrics — see the metric-reality section above), render "—"**. `—` = "not reported by this platform / not synced", NOT zero.
- **CSV export is formula-injection-hardened** ([csv.ts](apps/web/lib/csv.ts)): string cells starting `= + - @ \t \r` get a neutralizing `'` prefix (numbers like `-7` unaffected). Test: [csv.test.ts](apps/web/lib/csv.test.ts). Don't remove.

## Admin gate + Channel Groups + Insights groupStats + Durable Logos + 429 toast (2026-07-18, branch `feat/groups-insights-admin-logos-2026-07-17`)

Five owner-reported issues, all fixed on one branch (off main @152a287), adversarially reviewed (5-lens workflow — every CONFIRMED finding fixed) and verified locally: a 17-assertion **real-Postgres** analytics e2e (`createCaller` against the actual SQL) + Playwright browser flows + 1437 tests green + web build 0. See memory `project-admin-groups-insights-logos-2026-07-18`.

### 1. `/admin` no longer has a parallel login (the OAuth-only super-admin lockout)
**Root cause:** `/admin` was gated by a bespoke `admin-token` cookie-JWT (`middleware.ts` `verifyAdminToken`) minted ONLY by `POST /api/admin/login`, which hard-required a bcrypt password (`if (!user || !user.password) → 401`). A Google-OAuth-only user (`User.password` NULL — incl. the owner) could NEVER mint it → permanent lockout on a dark "Super Admin — Sign in with your admin credentials" screen (no Google button). Admin DATA was already protected by `superAdminProcedure` over the NextAuth session, so the whole `admin-token` layer was redundant.
**FIX:** DELETED `app/admin/login/`, `app/api/admin/login/`, `app/api/admin/logout/`. [middleware.ts](apps/web/middleware.ts) now gates `/admin` on NextAuth **session-cookie presence** only (redirect to **`/login?callbackUrl=`** — the real route is `/login`, NOT `/auth/login`); the AUTHORITATIVE gate is [app/admin/layout.tsx](apps/web/app/admin/layout.tsx), now an async server component (`await auth()` → no session ⇒ `/login`, `!isSuperAdmin` ⇒ `/dashboard`). `AdminSidebar` logout → `signOut({callbackUrl:"/"})`. The `admin-impersonate` cookie is a SEPARATE mechanism — untouched. `jose` is now an unused dep (drop later); `ADMIN_JWT_SECRET` is read by nothing. **Do NOT re-introduce a second `/admin` login gate** — the session + `isSuperAdmin` layout check IS the gate. Verified: `curl /admin`→307 `/login?callbackUrl=%2Fadmin`, `POST /api/admin/login`→404; browser as super-admin → `/admin/users` renders the Users panel directly.

### 2. Channel-group quick-select in Content Studio Compose
[ComposeTab.tsx](apps/web/components/content-agent/ComposeTab.tsx) "Select Channels" card now has a **GROUPS** row (renders only when ≥1 group has an active member): one pill per group (color dot, name, active-member count). Per-group state is **derived** none/partial/all from `selectedChannels` vs the group's ACTIVE member ids — click-not-all unions active ids (Set-dedup), click-all removes them, partial shows "n/m". Backed by the existing USER-accessible `channelGroup.list` (no backend change; `post.create` still takes flat `channelIds`). **Only unions ids present in the LIVE `channel.list`** (`liveIds` intersection) so a stale/disconnected id can't make `post.create` reject the whole request. Group state is DERIVED, never persisted (draft still saves flat ids). [channels/page.tsx](apps/web/app/dashboard/channels/page.tsx) also got: enriched create-group toast + scroll-into-view + 2.5s highlight ring (clear-timer gated on the card actually being present so a slow refetch can't consume the window), add/remove-channel toasts, Enter-key double-create guard, `bulkDisconnect` no-op hook-`onError` (kills the double-toast per the react.tsx contract), and a **"Refresh logos"** header button (→ `channel.refreshAvatars`).

### 3. Insights `groupStats` (campaign view) + 6 accuracy fixes
NEW `analytics.groupStats` (orgProcedure) powers a **Group Performance** card in Insights (renders only when `groupCount>0`; `placeholderData` avoids CLS on range change). Pure helper [group-stats.ts](packages/api/src/lib/group-stats.ts) `sumChannelRowsIntoGroups` — a channel in multiple groups counts in EACH; an "Ungrouped" bucket; `engagementRate` from the SUMS ×100. The "Posts" column is labelled **"Publishes"** (a post to N channels counts N times — footnoted). A shared `fetchChannelStatRows` (ONE org-scoped `LEFT JOIN LATERAL` latest-snapshot aggregate) replaced the perChannelStats **N+1** AND feeds groupStats; it has `INNER JOIN "Channel" c … AND c."isActive"=true` so BOTH procedures are active-only and reconcile with each other. **The 6 accuracy fixes (all verified against real Postgres):**
- **`at_age` postReports** was structurally empty forever (row filter `pt.publishedAt >= now-window` contradicted the `windowTag = same-window` snapshot filter — the checkpoint fires exactly one window AFTER publish). Now selects posts OLD ENOUGH (`pt.publishedAt <= now-window`). ReportsTab copy corrected.
- **Reports Eng.%** was 100× off (stored `engagementRate` is a 0–1 fraction for YT/IG/FB/Reddit but a percent for Threads/Pinterest/DevTo). Now recomputed in SQL `(likes+comments+shares)/impressions*100`; `WHEN s."snapshotAt" IS NOT NULL THEN 0 ELSE NULL` so a captured **zero-impression** snapshot renders `0`, not "—" (which means "no snapshot").
- **overview.failed** undercounted (only FAILED targets of `status='PUBLISHED'` posts) → org-wide FAILED target count; the NULL-publishedAt branch keys on the **target's own `updatedAt`** (not the mutable parent `Post.updatedAt`, which a later edit would re-date).
- **overview.published** rescoped to a target-level count matching platformBreakdown's population (same-page cards agree).
- **platformBreakdown** ignored the date picker → optional `{from,to}` input (whole-object `.optional()` to keep the openapi bare-call working); copy "Published targets per platform".
- **postsOverTime** `setHours`→`setUTCHours` (analytics dates are UTC).
Hidden data surfaced: **Clicks** column (Channel Performance + Reports table), "across N targets" sub-caption. Everything stays orgProcedure (USER-readable — `app-role-gating.test.ts` locks it). New tests: [group-stats.test.ts](packages/api/src/__tests__/group-stats.test.ts).

### 4. Durable channel logos (avatars stop rotting)
**Root cause:** `Channel.avatar` stored a one-shot platform CDN URL; IG/FB signed URLs expire in days → the browser broken-image icon (no `onError` fallback existed). Shared **[ChannelAvatar](apps/web/components/channel-avatar.tsx)** (`onError`→initials; import via **`~/`**, NOT `@/` — apps/web has no `src` dir) replaced every raw `<img>` avatar site. Pipeline: an `avatar-cache` BullMQ queue + [avatar-cache.worker.ts](apps/worker/src/workers/avatar-cache.worker.ts) (resolve a fresh platform picture → `safeFetchPublicImage` SSRF-gated → S3 `avatars/{org}/{channel}.{ext}` → `Channel.avatar = ${base}/${key}?v=${Date.now()}` so the versioned URL busts the object's 24h `max-age` and "Refresh logos" is visible immediately) + a daily `scheduleAvatarCache` cron + **`channel.refreshAvatars`** (orgProcedure). Invariants: the worker threads **`Channel.metadata`** into tokens so Mastodon(`instance`)/Bluesky(`service`) `getProfile` hit the RIGHT host (else the bearer token is sent to the default host = wrong result + credential exposure); `refreshAvatars` enqueues **fire-and-forget off the request path** (the shared queue Redis is `maxRetriesPerRequest:null` — awaiting would hang the mutation on a Redis blip), active channels only, `removeOnComplete:{age:3600}` for real hour-bucket dedupe, and jobIds MUST be **exactly 3 colon-segments** (BullMQ throws otherwise → `avatar:{id}:manual-{yyyymmddhh}`). Provider fixes: FB `getPages` now requests `picture{url}` (Pages had NO avatar); Reddit stops stripping the signed query (decodes `&amp;` instead). The OAuth callback best-effort enqueues on connect (fire-and-forget) — the INSTAGRAM `getProfile`-skip + `fb_no_pages`/`ig_no_business_account` paths are UNTOUCHED.

### 5. tRPC "Unexpected token '<'…" 429 toast
nginx serves its HTML 429 page for rate-limited `/api/trpc`; `@trpc/client` parsed it as JSON → a raw `SyntaxError` in the toast. FIX: a `guardedFetch` wrapper in [react.tsx](apps/web/lib/trpc/react.tsx) — on `!res.ok` it intercepts ONLY when the content-type is **not** `application/json` (429→"Too many requests…", otherwise "unexpected response"). **A JSON 429 — the app's OWN `TOO_MANY_REQUESTS` envelope from [rate-limit.middleware.ts](packages/api/src/middleware/rate-limit.middleware.ts) — MUST pass through untouched** (content-type check gates the 429 check; order matters), else its actionable reset-time message and error code are lost. `humanizeError` [errors.ts](apps/web/lib/errors.ts) also gained JSON-parse patterns (defense-in-depth); the `zodError`-before-`typeof` invariant is kept.

## SSE reconnect storm + large-upload resilience (2026-07-20, branch `fix/sse-storm-upload-resilience-2026-07-20`) — read before touching ActivityPanel SSE or upload-multipart

Root cause of "multi-GB upload fails at some %, page flashes/reloads, nothing saved" (evidence: nginx logs showed ~20-25 SSE connections/sec per dashboard tab, ~700k `/api/notifications/sse` requests/day platform-wide since the panel shipped 2026-03-29; the crashing tab fetched Next's `global-error` chunk at the moment of the reload; `upload.initiate` with no matching `abort`/`complete`; one orphaned multipart in MinIO):

- **[activity-panel.tsx](apps/web/components/layout/activity-panel.tsx) SSE effect deps MUST stay referentially stable (`[utils]`).** The old deps `[refetch, postActivity]` contained the whole useQuery result object (new identity every render) → the EventSource was torn down + recreated EVERY render; each new connection instantly receives the SSE route's first frame → refetch → re-render → reconnect: a self-sustaining ~20-25/s connect+refetch storm in every dashboard tab (~40 notification `findMany`/s per tab on Postgres). Under a multi-GB Compose upload the storming tab eventually crashed into the global-error boundary → page reload → upload state annihilated. **Never put query results or refetch closures back in that dep array.** The effect also dedupes identical SSE payloads (server re-sends the unread list every 5s unconditionally) and reconnects after 10s on error, mirroring NotificationBell (whose `[utils]` effect was always correct).
- **[upload-multipart.ts](apps/web/lib/upload-multipart.ts) has per-part retry — keep it.** 4 attempts/part, FRESH presigned URL each attempt (URL expiry can't fail a retry), expo backoff 1s/3s/9s + jitter, 10-min XHR timeout, user-abort NOT retried, `api.abort` only after a part exhausts all attempts. Progress reports only whole-percent CHANGES (was ~40-80 setState/s for the whole upload). Locked by [upload-multipart.test.ts](apps/web/lib/upload-multipart.test.ts) (6 tests; 4 verified-failing against the pre-fix code).
- **ComposeTab warns on `beforeunload` while any media is uploading** — closing mid-multipart orphans the parts (no abort fires) and no Media row exists yet (`upload.complete` creates it).
- **MinIO hygiene:** incomplete multipart uploads from crashed tabs are invisible disk use — but MinIO's built-in janitor already purges them (`stale_uploads_expiry=24h`, swept every 6h; verified active on prod 2026-07-20, no ILM rule needed — this mc version has no incomplete-upload ILM flag anyway). The 2026-07-20 orphan was aborted manually. To inspect: `docker exec postautomation-minio-1 sh -c 'mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD && mc ls --incomplete --recursive local/postautomation-media'`.
- Scope note: only Compose uses multipart (files >8MB). Media page + chat use the proxied `/api/upload` (≤512MB, fails fast) — multi-GB uploads are Compose-only by design.

## Video/mobile/stress/insights scenario batch (2026-07-20, branch `fix/video-mobile-stress-insights-2026-07-20`) — read before touching these areas

44-agent scenario audit (upload lifecycle, mobile, multi-user stress, video insights accuracy): 38 findings → 33 confirmed, all fixed. Key invariants:

- **Compose survives tab switches**: the compose `TabsContent` has **`forceMount` + `data-[state=inactive]:hidden`** ([content-agent/page.tsx](apps/web/app/dashboard/content-agent/page.tsx)) — Radix unmounts inactive tabs by default, which killed in-flight uploads + state. ONLY compose gets forceMount. ComposeTab aborts in-flight uploads on TRUE unmount (route nav) via an unmount-only cleanup on `uploadAbortsRef`. Draft restore is hydration-aware (re-fires on `getTask` identity change; `restoredRef` + empty-state guards) and restores non-blob media (`draft.media`); submit-time uploads write `mediaId` back into `postMedia` (failed-retry no longer re-uploads finished files). Module-scope 2-slot semaphore bounds concurrent FILE uploads (spans image+video pickers).
- **Mobile upload**: wake lock while `anyUploading` (feature-detected, re-acquired on visibility); coarse-pointer-only visibility-return warning + inline keep-open hint (iOS never fires beforeunload — do NOT abort on pagehide, bfcache resume + retry ladder can recover); tile X/Edit controls always visible on no-hover devices via `[@media(hover:hover)]` variants (desktop pixel-identical).
- **`/api/upload` is 64MB-max for video** (route buffers ~2x file size in web-process RSS — the old 500MB cap was the OOM vector; nginx location now 100M — **force-recreate nginx on deploy**). Media page + BOTH chat paperclips route >8MB through [use-smart-upload.ts](apps/web/lib/use-smart-upload.ts) (multipart, progress, retry). Video cap is **4GB everywhere** (upload.router, media.router, ComposeTab).
- **`upload.complete` HEADs the finalized object** — authoritative `fileSize` (presigned part PUTs don't bind Content-Length; an understated size bypassed the overlay gate) + per-type cap enforced on the HEAD values w/ DeleteObject on violation; HEAD failure degrades to declared size (never fails a finished upload). Client `complete()` has its own budget: `COMPLETE_ATTEMPTS=10`, 60s-capped backoff (~5.7min — rides out a deploy window); deterministic BAD_REQUEST/FORBIDDEN break immediately; MinIO 507 is terminal at the part level with a friendly message.
- **Worker heavy-upload lane** ([post-publish.worker.ts](apps/worker/src/workers/post-publish.worker.ts)): streamed platforms (YT/X/LinkedIn) with media > `HEAVY_MEDIA_THRESHOLD_MB` (300) are capped at `HEAVY_MEDIA_CONCURRENCY` (3) — excess DEFERS via the rate-limit re-queue pattern (SCHEDULED flip + jittered 45-90s PRIORITY_RETRY re-add). **Never convert this to a blocking wait** (holds the slot + trips the watchdog). Counter increments immediately before the publish try (finally releases) — do not move it earlier. IG/FB are URL-pull and exempt.
- **Overlay bounded**: [video-overlay.ts](apps/worker/src/lib/video-overlay.ts) runs under a FIFO semaphore (`VIDEO_OVERLAY_CONCURRENCY`, default 2; `createSemaphore` re-exported from @postautomation/ai), STREAMS download+upload (no more 2× full-video heap), and re-checks the real Content-Length against `maxBytes` (fail-open when header absent).
- **Video insights are real now** ([packages/social](packages/social/src/providers)): FB video posts route to `video_insights` (views→impressions) + summary likes/comments and get a working `/videos/` URL; FB >64MB videos publish via `file_url` remote-pull (no worker buffering); IG picks metric sets by `media_product_type` (REELS plays/saved/shares; FEED byte-identical); LinkedIn org posts merge share-statistics (impressions/clicks/shares/reach were hardcoded 0) and finalize failure THROWS; X throws when all media/video uploads fail (no more silent text-only tweets) and the STATUS poll honors `check_after_secs` w/ size-scaled deadline; YT streamed chunks retry w/ protocol offset-query resume (≤64MB path test-locked byte-identical). analytics-sync threads `channel.metadata` into tokens.
- Post-detail: stale SSE percent no longer shadows the DB-polled `uploadProgress` (onerror deletes the live entry); action/target rows wrap/truncate at 360px.

## Video-upload tab-OOM + presign checksum (2026-07-21, branch `fix/video-upload-oom-2026-07-21`) — read before touching ComposeTab effects or lib/s3.ts

Root cause of "browser balloons to 17GB / whole PC dies while uploading a video (images fine, all browsers)" — live-confirmed via prod nginx logs (parts 200 OK, then all 4 in-flight parts cut with 400 the second the tab died) + a matching orphaned MinIO MPU:

- **Every whole-percent upload-progress tick rewrites `postMedia` with a new array identity.** Any ComposeTab effect keyed on `[postMedia]` therefore runs several times per SECOND on a fast uplink for the whole upload. Two effects did exactly that: the Shorts **aspect probe** created a fresh detached `<video>` (a whole media player + metadata demux) per tick — WebKit caps live players and frees them lazily, so Safari exhausted the pool in seconds and ballooned until macOS killed it (videos only — the expensive branch needs a video item, which is why images never triggered it); and the **active-task draft persist** did a synchronous localStorage JSON write + ActiveTaskProvider subtree re-render per tick. Both are now keyed on STABLE derivations (`firstVideoUrl` string; `draftMediaSignature` = JSON of url+mediaId pairs). **Never key a ComposeTab effect on the `postMedia` array identity** — same bug class as the ActivityPanel SSE-storm dep rule. The probe teardown must keep `removeAttribute("src") + load()` (setting `src=""` alone leaves the WebKit player alive until GC). Tile progress paints are throttled to ~4/s in `uploadFileToS3` (100% always paints).
- **`lib/s3.ts` MUST keep `requestChecksumCalculation/responseChecksumValidation: "WHEN_REQUIRED"` on BOTH clients.** AWS SDK ≥3.729 otherwise pins the CRC32 of the EMPTY server-side command body (`x-amz-checksum-crc32=AAAAAA==`) into every presigned UploadPart/PutObject query. MinIO ignores it today (parts return 200); AWS S3 or a future MinIO validates it and would reject EVERY part with BadDigest = all video uploads dead. Locked by [presign-no-pinned-checksum.test.ts](packages/api/src/__tests__/presign-no-pinned-checksum.test.ts) (verified fail-without-fix).
- **Video MIME normalization** ([apps/web/lib/video-mime.ts](apps/web/lib/video-mime.ts), used by Compose + Media page): empty `file.type` (Windows registry gaps for .mov/.mp4/.m4v/.webm) is mapped from the extension; `video/x-m4v` → `video/mp4`; `video/x-m4v` added to all three server allowlists (upload.router / media.router / api/upload route — keep in sync). mkv/avi stay rejected server-side with an actionable "convert to MP4" message — do NOT map them to mp4; platform publishes (IG/FB URL-pull, X chunked) reject those containers and a publish-time failure is worse than an upfront one.
- Capacity fact (2026-07-21): prod is ONE 4-core / 7.8GiB Linode with the disk at 82% (28GB free) shared by Postgres+MinIO. Part PUTs bypass Node (nginx→MinIO), so uploads don't block sign-in/tRPC — the binding constraint for simultaneous multi-GB uploads is DISK, and disk-full breaks Postgres too. MinIO's 24h stale-MPU janitor is the cleanup; watch `df` before raising caps.
- **ROUND 2 (same day, PR #140) — `<img>` must NEVER receive a video URL.** A 1.6GB 4K camera file still killed the Safari tab at ~30% AFTER the churn fix. Empirical matrix (Playwright WebKit 26.0, real file): `<img src={videoBlob}>` = **+1.57GB RSS full-file ingest** (WebKit buffers the whole blob before giving up; Chromium sniffs + cancels in 9ms, so Chrome hides the bug); `<video preload="metadata">` = flat ~+180MB but with a ~1.2GB transient read burst on idle; the multipart XHR loop itself = **flat 316MB for all 209 parts** (fully exonerated). The IG/FB/X/LI/generic previews all fed `mediaUrls[0]` into bare `<img>` — Instagram is the DEFAULT preview tab. FIX: all preview media renders through **[PreviewMedia](apps/web/components/previews/preview-media.tsx)** (`mediaKinds` prop threaded from ComposeTab; extension sniff fallback): image→`<img>`, remote video→metadata `<video>`, **local blob video→static placeholder (NO media element)**. ComposeTab tile skips its inline `<video>` for local files > 256MB, and the aspect probe releases its element the MOMENT metadata arrives. Locked by [preview-media-classify.test.ts](apps/web/lib/preview-media-classify.test.ts). Do NOT add any `<img src={mediaUrls[...]}>` back into previews, and route any new media rendering through PreviewMedia.
- **ROUND 5/6 LIVE RESULTS (2026-07-21 evening):** ✅ Instagram published the 1.6GB camera master's post end-to-end via the rendition (user-confirmed); ✅ lightbox playback "near flawless" (user's words). Addenda shipped after live E2E: **PR #144** — ffmpeg reading the S3 URL through nginx got silently TRUNCATED (63s→40s, exit 0) when encode stalls out-ran nginx's send timeout → source now streams to /tmp first AND the output's probed duration must be ≥ source−2% or the job fails (NEVER let ffmpeg read http via nginx for long encodes); **PR #145 (owner resolution constraint)** — stored originals are always untouched full-res; YouTube always gets the master; **FACEBOOK (4K-capable) publishes the full-res original unless probe shows a bad codec or >950MB**; Instagram always gets the 1080×1920 rendition (IG's own serving ceiling — nothing real lost). ⚠️ Owner: "the posting process works — do NOT break it": IG/FB publish paths are working and frozen; extend, don't rewrite.
- **ROUND 5 (same day, PR #143) — media-optimize pipeline (owner-approved pre-publish validation + auto-transcode).** New `media-optimize` queue + [media-optimize.worker.ts](apps/worker/src/workers/media-optimize.worker.ts) (concurrency 1 — ONE ffmpeg at a time on the 4-core box): on video upload (upload.router stamps `Media.metadata.optimize={status:"pending"}` + enqueues `optimize:{mediaId}:v1`), the worker ffprobes the S3 URL and — when out of spec (non-AAC audio, non-H.264, >950MB, >12Mbps, >1920 edge; pure verdicts in [media-optimize.ts](apps/worker/src/lib/media-optimize.ts), tested) — produces ONE web rendition (H.264 veryfast CRF23 ≤8Mbps, AAC, long-edge 1920, +faststart) at `optimized/{org}/{mediaId}.mp4`, recorded in `metadata.optimize`. **Publish worker: IG/FB video prefers the rendition (`choosePublishUrl`); >950MB originals are GATED (`planOptimizeGate`) — defer via SCHEDULED-flip + `OPTIMIZE_WAIT_MESSAGE` (a watchdog keep-alive marker like HEAVY_SLOT_WAIT_MESSAGE), self-heal-enqueue for legacy rows, 45-min wait ceiling, actionable failure messages. ≤950MB videos publish immediately (zero regression); YouTube always gets the MASTER.** post.create refuses KNOWN-fatal combos early ([media-constraints.ts](packages/api/src/lib/media-constraints.ts): optimize-failed, >15min on IG). Media lightbox plays the rendition (fixes 222Mbps stutter + PCM silence). `Media.metadata Json?` added to schema. Tests: media-optimize.test.ts (11) + media-constraints.test.ts (4).
- **ROUND 4 (same day, PR #142) — "videos never preview" + IG 2207076.** (a) **Safari never paints a poster frame for `preload="metadata"` videos** — every video tile (Media library, picker, previews) rendered as a BLACK box on Safari while Chrome showed frame 1. Fix: `withPosterHint(url)` ([apps/web/lib/video-poster.ts](apps/web/lib/video-poster.ts)) appends `#t=0.001` (WebKit-verified: frame available in ~0.4s) — use it on EVERY `preload="metadata"` video src. (b) Compose now swaps a tile's blob: URL to the durable S3 URL when its upload completes (`uploadFileToS3` returns `{id, url}`; deferred `revokeObjectURL`) — uploaded videos preview for real and drafts restore them. (c) **IG error 2207076 = the FILE violates Instagram's hard limits, not an app bug**: verified live with a 1.75GB 4K/50fps 222Mbps H.264 + **PCM-audio** camera master — IG requires MP4/MOV ≤1GB with AAC audio; IG pulls the S3 URL and rejects server-side (6/6 attempts). Pre-publish spec validation / auto-transcode is an OPEN product decision — `maxMediaSize` constraint metadata deliberately stays informational (test-locked); do not wire size gates into the publish path without an explicit owner decision.

## 🔴 The watermark overlay UNDID the optimizer and collapsed a 39-channel publish (2026-08-07)

**Symptom:** one post fanned out to 39 Instagram channels → **17 published, 22 FAILED** with
`Instagram media processing timed out after 90 seconds`. Perfect step function: everything
completing before 11:00 succeeded, everything after 11:04 failed. All live-measured on prod.

**Root cause — there were TWO ffmpeg paths and only one had rate control.**
[media-optimize.ts](apps/worker/src/lib/media-optimize.ts) correctly transcoded the source
(214MB HEVC 16.8Mbps, 102s, 1080×1920) down to a **35.7MB** H.264 rendition. The per-channel
watermark pass in [video-overlay.ts](apps/worker/src/lib/video-overlay.ts) then re-encoded that
rendition with `-preset ultrafast` and **no `-crf`/`-maxrate` at all** → **128MB output, a 3.6×
BLOAT (~10Mbps)**. The second stage silently undid the first.

`ultrafast` disables CABAC/B-frames/motion refinement; with no rate control the encoder still
holds its default quality, so it simply **spends more bits**. Fast preset ⇒ bigger file, not a
cheaper one.

**The chain:** 128MB × N served to Instagram from a **4-core** box whose CPU was already pegged
by the encodes themselves (measured `load 14.72`, **2% idle**, two ffmpeg at **350%** of 400%)
⇒ IG's own fetch was starved ⇒ container processing outran the publish poll budget ⇒ FAILED.

**⚠️ Retries AMPLIFY it — this is a congestion collapse, not a linear slowdown.** Every retry
re-runs the whole publish job including a fresh overlay encode + re-upload + new IG fetch.
Measured: **83 encodes for 39 targets (2.1×)**, ≈**10.6 GB egress for ONE post**. Failures
manufacture the load that causes more failures, which is why it flipped to 100% failure rather
than degrading gradually.

**Fixes (keep all of them):**
- `buildOverlayFfmpegArgs` moved to its own dependency-free
  [video-overlay-args.ts](apps/worker/src/lib/video-overlay-args.ts) and now pins
  `-c:v libx264 -preset veryfast -crf 23 -maxrate 6M -bufsize 12M -pix_fmt yuv420p` —
  **mirroring media-optimize's proven settings. The two ffmpeg paths MUST stay in step.**
- `-threads` capped (`VIDEO_OVERLAY_THREADS`, default 2). ffmpeg otherwise takes every core.
  ⚠️ Keep `VIDEO_OVERLAY_CONCURRENCY × VIDEO_OVERLAY_THREADS` under the core count.
- ffmpeg runs under **`nice -n 10`** (verified present at `/bin/nice` in the worker image).
  Encoding is throughput work; serving the file to Instagram is latency work — under contention
  the encode must yield, or it starves the very fetch the publish depends on.
- IG video poll budget was **duration-blind** (flat 90s for a 5s clip and a 102s reel alike) →
  now `IG_VIDEO_READY_TIMEOUT_MS`, default **240s**. Still bounded (it holds a worker slot) and
  far inside the watchdog's 30-min idle reap.
- The timeout message now reports **actual elapsed**, not the budget — each iteration sleeps
  *then* awaits a network read, so a busy worker overshoots and "after 90 seconds" was a lie
  that hid how close the containers were to finishing. It also states the video is still
  processing on Instagram's side, **not rejected**.
- **Kill switch `VIDEO_OVERLAY_ENABLED=false`** (`isVideoOverlayEnabled()`, checked before the
  semaphore). The overlay is the ONLY reason a publish re-encodes video at all; disabling it
  makes IG/FB pull the optimized rendition straight from S3 at **zero CPU**. Egress is
  ~unchanged (fixed overlay ≈ optimizer size) — the win is eliminating the encode entirely.
- ⚠️ The overlay ALWAYS runs for IG/FB videos ≤250MB: it early-returns only when text, logo AND
  `channelName` are all absent, and the worker always passes `channel.name`. So "no logo
  configured" does **not** mean "no re-encode" — it means a text watermark instead.

Tests: [video-overlay.test.ts](apps/worker/src/lib/video-overlay.test.ts) (rate-control guard
verified FAILING against the pre-fix args; the pre-existing shell-injection assertions still
pass). The pure argv builder was split out precisely so this guard runs in ms — importing
`video-overlay.ts` drags `@postautomation/ai` → langchain → langsmith and the test could not
execute at all.

## Publish notification email — creator-only (2026-07-17, PR #123)

`sendPublishReportEmail` in [post-publish.worker.ts](apps/worker/src/workers/post-publish.worker.ts) fires for EVERY publish path (compose/scheduled/autopilot/newsgrid/chat — single worker funnel). Redesigned: **recipient = the post CREATOR** (`post.createdById`; falls back to org OWNERs only for creatorless system posts — logged), per-channel rows (platform, channel name + @handle, **UTC + IST** timestamps, platform post URL w/ dashboard fallback), outcome subjects (`✅/⚠️/❌ N/M channels`). Template is PURE + tested in [publish-email.ts](apps/worker/src/lib/publish-email.ts) — **all user content HTML-escaped, hrefs must be http(s)** (the old inline template interpolated raw). Never let email failure break publish (try/catch preserved); console fallback when SMTP unset. SMTP already configured on the worker (BO-01).

## Analytics — date handling

- **Date ranges are UTC.** The date-range picker builds `YYYY-MM-DDT00:00:00.000Z` / `…T23:59:59.999Z` so a non-UTC user's "today" doesn't shift a day. The `postsOverTime` query already used `setUTCHours`; do NOT reintroduce local-time `new Date(value).toISOString()` on the date inputs (it parses as local midnight → off-by-one for e.g. UTC+5:30).
- **`perChannelStats` raw SQL uses `COALESCE(p."publishedAt", p."updatedAt")`** in its date predicates so PUBLISHED posts with a NULL `publishedAt` aren't silently dropped.
- The Channel Performance card shows a distinct "connected but no engagement synced yet" banner (vs. the "no channels connected" empty state) when all channels have zero metrics — so pending FB/IG Advanced Access reads as "not synced", not "zero performance".

## Monitoring (Error tracking) — read before touching the Monitoring page

Super-admin error dashboard at [apps/web/app/dashboard/monitoring/page.tsx](apps/web/app/dashboard/monitoring/page.tsx), backed by [packages/api/src/routers/monitor.router.ts](packages/api/src/routers/monitor.router.ts) over the cross-tenant `ErrorLog` table. All read/write procedures are `superAdminProcedure` (the table spans orgs and holds stack traces / PII).

- **⚠️ COUNT and LIST read DIFFERENT scopes — keep "Resolve All" tied to the COUNT scope, not the loaded page.** The big "Unresolved" stat comes from `monitor.stats` (a server-side `count({where:{resolved:false}})` over the WHOLE table). The list comes from `monitor.list` (paginated, `limit:50`, cursor). **Bug fixed 2026-06-22:** the "Resolve All" button used to map the IDs of only the 50 loaded list rows and call `bulkResolve` → clicking it on a 6294-row backlog resolved only 50 (6294→6244). It was a REAL DB write, just the WRONG scope (not UI-only). Now the button calls **`monitor.resolveAll`** — one `updateMany({where:{resolved:false, ...source/severity filter}})` over the same scope the count reports — so it drains the whole filtered backlog in one click. `resolved:false` is always pinned. The old `bulkResolve` endpoint is still exported but no longer called by this page; if you remove it, drop its caller-less endpoint too. Test: [monitor-resolve-all.test.ts](packages/api/src/__tests__/monitor-resolve-all.test.ts) asserts the WHERE scope (the whole point) + super-admin gate.
- **List uses `useInfiniteQuery` + "Load more"** (2026-06-22). `monitor.list` returns `{errors, nextCursor}`; the page flattens `data.pages.flatMap(p=>p.errors)` into `loadedErrors` and renders a "Showing N of {total}" line + a "Load more" button (`fetchNextPage`/`hasNextPage`). Before this, the page only ever showed the first 50 rows (the returned `nextCursor` was unused) — which is why "not all issues were visible" while the count showed thousands.
- **"Resolve" is bookkeeping, NOT remediation** — it marks the `ErrorLog` row acknowledged (`resolved/resolvedAt/resolvedBy`); it does not fix the underlying bug. **"Clear Resolved"** (`clearResolved`) is the only DESTRUCTIVE action — it hard-`deleteMany({where:{resolved:true}})`. Much of a large backlog is demo seed-noise (see the monitoring-hygiene work: daily `purgeOldErrorLogs` cron, `isSeedNoise` skip, `resolveChannelErrorsOnReconnect`).
- **`ERROR_LOG_SOURCES`** in `monitor.router.ts` is the single source of truth for the `source` enum (the log schema, list filter, and UI tabs all derive from it) — a worker can't write a `source` the UI can't filter on. Includes `auto-healer` (added 2026-06-22).

## Patched dependencies

- `@auth/core@0.41.0` — see [patches/@auth__core@0.41.0.patch](patches/). Applied automatically via pnpm `patchedDependencies` on install.

## Testing

- Framework: Vitest ([vitest.config.ts](vitest.config.ts))
- Coverage: `@vitest/coverage-v8`
- Run all: `pnpm test`
- Per-package: `pnpm --filter @postautomation/ai test` / `pnpm --filter @postautomation/api test`. (Neither package has a `type-check` npm script — run `pnpm --filter <pkg> exec tsc --noEmit`, or `pnpm type-check` at the root which builds all packages.) E2E suites (`*-live.e2e.test.ts`) are skipped by default — they hit live providers.
- Security-regression suites (keep green): `creative-templates.test.ts` (XSS/CSS-injection sanitizers), `image-fetch-ssrf.test.ts` (SSRF fail-closed), `creative-template-ownership.test.ts` + `chat-action-media.test.ts` (IDOR guards), plus the existing `chat-action-gating` / `chat-channel-ownership` / `s3-config`.

## Roles & Access Control

### ⭐ App-level RBAC (`User.appRole`) — LIVE on prod 2026-07-17 (PRs #120 schema+backfill, #121 gates)
A THIRD access concept, orthogonal to org `MemberRole` AND to `isSuperAdmin`: `enum AppRole { USER ADMIN }`, `User.appRole @default(USER)`.
- **USER** = Dashboard, Content Studio (incl. bulk), Super Agent (minus `create_agent`), Media, Insights (analytics), **Channels (FULL — incl. connect/disconnect + groups; owner decision)**, approvals *submit*, notifications, profile settings, `team.members` read, `billing.currentPlan` read. **ADMIN** = everything. `isSuperAdmin === true` implies ADMIN at every gate.
- **Enforcement (authoritative)**: `isAppAdmin` + `adminOrgProcedure`/`adminProtectedProcedure` in [packages/api/src/trpc.ts](packages/api/src/trpc.ts). Fully gated routers: rss, shortlink, agent, autopilot, account-group, listening, campaign, brand-leads, newsgrid, webhook(+delivery), apikey, audit. Selectively gated: team (invite/updateRole/transferOwnership/removeMember), billing (createCheckout/createPortalSession), approval (review), user (createOrganization), notification (create), deployment (current/list/register), chat executeAction `create_agent`. **Wiring locked by [app-role-gating.test.ts](packages/api/src/__tests__/app-role-gating.test.ts) (29 tests) — a procedure swapped back to bare `orgProcedure` fails CI-less local runs; keep green.**
- **Claim freshness**: the NextAuth jwt callback re-reads the User row on EVERY `auth()` (config.ts) — `appRole` was added to that select, so role changes enforce **immediately server-side**; only the client-cached `useSession()` nav lags until reload. **The claim is `appRole`, NEVER rename to `role`** — `session.user.role` is the org MemberRole the sidebar depends on.
- **UI**: `NavItem.appAdminOnly` / `superAdminOnly` flags in [sidebar.tsx](apps/web/components/layout/sidebar.tsx) (Monitoring is now superAdminOnly — it used to leak into every user's nav); dashboard cards filtered; 16 admin pages wrapped in [RequireAppAdmin](apps/web/components/auth/require-app-admin.tsx) (UX only — tRPC is the boundary).
- **Role management**: `/admin` → Users → "Access" selector (`admin.users.setAppRole`, superAdminProcedure, audited `admin.user.approle_changed`). Super-admin toggle + last-super-admin guard pre-existed. Selector is disabled for super admins (their appRole is moot).
- **Kill switch**: `RBAC_DISABLED=true` in `.env.prod` + `up -d --no-deps web` bypasses ALL appRole gates instantly (mirrors `BILLING_DISABLED`). Do NOT delete the checks — they are the toggle.
- **Backfill DONE on prod 2026-07-17** (`scripts/backfill-app-roles.ts`, idempotent, `RBAC_ADMIN_CUTOFF` env): 35 existing users → ADMIN, 0 USER, verified by SQL count + no-op re-run. New signups default USER. **Live-smoked on prod**: fresh account → session `appRole:"USER"` → `rss.list` FORBIDDEN ("requires an admin role"), `channel.list`/`billing.currentPlan` 200.
- ⚠️ Prod had **4 super admins** at backfill time (not just tabish@dashmani.com) — pre-existing data; review in /admin if unintended.

### Member roles
`MemberRole` enum (Prisma): `OWNER | ADMIN | MEMBER`. **VIEWER was removed** — never re-add it to the schema without also updating all routers and UI.

- **OWNER**: full access; can transfer ownership, manage billing, remove members, update roles
- **ADMIN**: same as OWNER except cannot transfer ownership or change billing
- **MEMBER**: standard access; cannot manage team, billing, webhooks, API keys, audit log, or versions
- Default role on new sign-up: **OWNER** (auto-created personal workspace)

### Super admin
`User.isSuperAdmin` (boolean DB column) is a separate concept from org membership roles.

- **How it works**: `orgProcedure` reads `session.user.isSuperAdmin` and passes it as `ctx.isSuperAdmin`; all plan-limit helpers (`requirePlan`, `checkUsageLimit`, `enforcePlanLimit`) accept an optional `isSuperAdmin` flag and return early / return unlimited when true; `planExpiresAt` auto-revert is skipped for superadmin orgs; sidebar lock icons are skipped.
- **HARD ISOLATION (changed 2026-06-03, commit on `fix/channel-org-isolation`):** Superadmin **NO LONGER bypasses org membership.** `orgProcedure` requires a real `OrganizationMember` for every actor (the `if (!membership)` gate at ~`trpc.ts:158`, and the `ctx.membership` is the real record — no implicit-OWNER fallback). `isSuperAdmin` is now ONLY a plan/billing exemption, NOT a cross-org access grant. **Do NOT re-add `&& !isSuperAdmin` to the membership gate.** Superadmins reach other orgs ONLY via the impersonation flow (which swaps the acting `session.user.id` to the target user, so `orgProcedure` runs as a real member of the target's own org). Cross-org support tooling lives in `/admin` (gated by the separate `superAdminProcedure`, `trpc.ts:106`), which is unaffected.
- **Who has it**: `tabish@dashmani.com` — applied directly via psql on 2026-05-26.
- **Granting on local**: `UPDATE "User" SET "isSuperAdmin" = true WHERE email = 'you@example.com';` in `prisma studio` or psql. Also ensure an OWNER membership exists.
- **Granting on production** (psql): `ssh posting-automation 'docker exec postautomation-postgres-1 psql -U postgres postautomation -c "UPDATE \"User\" SET \"isSuperAdmin\" = true WHERE email = '\''you@example.com'\'';"'`
- After granting, the user must **sign out and back in** for the new JWT claim to take effect.

### Org resolution & personal-org creation (invariants — 2026-06-03)
- **Deterministic active-org selection:** the "first/default membership" is selected with `orderBy: [{ role: "asc" }, { createdAt: "asc" }]` (OWNER-first via Postgres enum order, oldest tie-break) in THREE places that MUST stay identical: `orgProcedure` fallback (`trpc.ts`), `user.me` memberships (`user.router.ts`), and `org.current` fallback (`org.router.ts`). The OrgSwitcher default is driven by `user.me.memberships[0]`, so all three must agree or the active workspace diverges from the OAuth-state org — which caused channels to be connected into the WRONG org. Never drop these `orderBy` clauses.
- **Single personal-org provisioner:** `ensurePersonalOrg(prisma, userId, email)` in [packages/db/src/ensure-personal-org.ts](packages/db/src/ensure-personal-org.ts) is the ONLY place that creates a personal org. It guards on `userId` (existing OWNER membership → reuse) and catches `P2002` to recover from races. All four former inline `organization.create` sites (auth `events.createUser`, register route, `orgProcedure` fallback, `org.current`) call it. Do NOT re-introduce inline org creation — it caused duplicate personal orgs ("X's Workspace" ×2).
- **OWNER-org partial unique index (pending):** a migration at `packages/db/prisma/migrations/*_one_owner_org_per_user/` adds `CREATE UNIQUE INDEX ... ON "OrganizationMember"("userId") WHERE role='OWNER'`. Prisma can't express a partial unique, so it's raw SQL and `prisma db push` won't apply it — apply by hand (psql role/db are both `postautomation`, NOT `postgres`). **Apply only AFTER deduping existing duplicate OWNER orgs**, or `CREATE INDEX` fails.
- **getOAuthUrl pins to membership:** channel connect signs the OAuth state with the org ONLY if the user is a real member (`channel.router.ts` getOAuthUrl re-checks membership; no connect-on-behalf, no superadmin carve-out).
- **Channel IDOR guards:** `agent.getById` org-scopes channel resolution; `agent.create/update` and `channelGroup.add/removeChannel` validate every `channelId` belongs to `ctx.organizationId`. Keep these.
- **Bulk channel delete:** `channel.bulkDisconnect` (org-scoped `deleteMany`, max 100) backs the select-all + "Delete Selected" UI on the channels page.

### Plan enforcement
- `MemberRole` is independent of `Organization.plan`. Plans are `FREE | STARTER | PROFESSIONAL | ENTERPRISE`.
- Feature gates via `requirePlan(orgId, minPlan, featureName, isSuperAdmin?)` — throws `FORBIDDEN` if org plan is below minimum.
- Resource limits via `enforcePlanLimit(orgId, resource, isSuperAdmin?)` — throws `FORBIDDEN` if quota exceeded.
- `planExpiresAt` on `Organization`: if set and in the past, `orgProcedure` silently reverts the org to FREE on next request (except for superadmin orgs).
- Sidebar shows lock icons for plan-gated nav items (redirects to `/dashboard/settings/billing` when clicked).
- Team page shows an upgrade CTA banner when the team-member limit is reached.
- All limits are `-1` (unlimited) on ENTERPRISE and for `postsPerMonth`/`teamMembers` on PROFESSIONAL.

### ⚠️ Billing temporarily DISABLED — everyone has free rein (2026-06-11)
**Current state:** `BILLING_DISABLED=true` is set on production (`.env.prod`), so **all plan/quota gates are bypassed for every org** (new + old, any plan). This is a deliberate, reversible product decision — billing code is fully intact, NOT removed. Design spec: [docs/superpowers/specs/2026-06-11-disable-billing-temporarily-design.md](docs/superpowers/specs/2026-06-11-disable-billing-temporarily-design.md).
- **Switch:** `isBillingDisabled()` in [plan-limit.middleware.ts](packages/api/src/middleware/plan-limit.middleware.ts) reads `process.env.BILLING_DISABLED === "true"` at call time. Default (unset/other) = billing enforced exactly as the rest of this section describes.
- **Four bypass points**, each mirroring the existing `isSuperAdmin` early-return: `requirePlan` (returns), `checkUsageLimit` (returns `{allowed:true, limit:-1, planName:"Unlimited"}`), the `planExpiresAt` auto-revert in [trpc.ts](packages/api/src/trpc.ts) (skipped — no org-row mutation while disabled), and the UI `planAllowed()` predicates in [sidebar.tsx](apps/web/components/layout/sidebar.tsx) + [dashboard/page.tsx](apps/web/app/dashboard/page.tsx) (no lock icons / "Upgrade to X" cards). UI reads `billing.currentPlan.billingDisabled`.
- **All ~20 backend gate call sites are UNCHANGED** — they keep their `requirePlan(...)`/`enforcePlanLimit(...)` lines + `ctx.isSuperAdmin` arg, dormant until re-armed. Stripe, plan definitions, the billing settings page, and default-FREE-on-signup are untouched (usage UI just reads "unlimited"). Sign-up/sign-in never call these helpers, so they are unaffected.
- **Re-arm later:** set `BILLING_DISABLED=false` (or remove it) in `.env.prod` and redeploy. **Zero code change.** Do NOT delete the `isBillingDisabled()` checks — they ARE the toggle.
- **Regression guard:** [billing-disabled.test.ts](packages/api/src/__tests__/billing-disabled.test.ts) locks both flag-ON bypass (no DB read) and flag-OFF unchanged enforcement. Keep green.

## ⚠️ NEVER commit a macOS `" 2"` duplicate file — and there is exactly ONE CLAUDE.md

Finder appends `" 2"` when resolving a filename collision (duplicate-on-copy, or a sync client reconciling two versions). These are **never** intentional source files, and three have already reached this repo:

| File | What it was | Fate |
|---|---|---|
| `packages/social/src/providers/youtube 2.provider.ts` | a **pre-streaming** snapshot missing `fetchByteRange`/`headRemoteMedia`/`YT_STREAM_THRESHOLD_BYTES` — 305 diff lines behind | deleted 2026-08-08 |
| `packages/super-text/tsconfig 2.json` | unreferenced | deleted 2026-08-08 |
| `CLAUDE 2.md` | a stale 19-June snapshot, 351 lines vs 943 | deleted 2026-08-11 |

**Why it matters beyond tidiness:** an unreferenced duplicate still **compiles into the image** and sits one careless auto-import away from silently reverting the fix it predates. The YouTube one would have reintroduced multi-GB upload OOM.

**Rules:**
- **There must only ever be ONE `CLAUDE.md`.** If a second appears, diff it against the real one (`comm -23` on the headings confirms superset), back it up outside the repo, and delete it. Never merge a stale snapshot back in.
- Before any broad `git add`, run `find . -name "* 2.*" -not -path "./node_modules/*" -not -path "./.git/*"` — it must return nothing.
- A broad `git add -A` is how all three got committed. Prefer staging explicit paths.

## Conventions

- TypeScript strict, shared base config in [tsconfig.base.json](tsconfig.base.json)
- Workspace package names: `@postautomation/<name>`
- Cross-workspace imports use the package name, not relative paths
