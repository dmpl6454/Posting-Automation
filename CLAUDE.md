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
- **Configured in production**: `AUTH_GOOGLE_ID/SECRET`, `AUTH_SECRET`/`NEXTAUTH_SECRET`, `SMTP_*` (Google Workspace). GitHub OAuth was removed — not needed.

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

**YouTube specifics:** Uses the same Google Cloud project as Google sign-in (`Post Automation Web` OAuth client) but needs a separate set of env vars (`YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`). The app requests two scopes: `youtube.upload` (for posting) AND `youtube.readonly` (required by `getProfile` → `channels.list` API — without it you get 403 PERMISSION_DENIED). Redirect URI: `${APP_URL}/api/oauth/callback/youtube`. Google's OAuth consent screen must be in "Testing" mode with the user's account added as a test user, or "In production" (requires Google verification for sensitive scopes, ~1–2 weeks).

### Facebook / Instagram (Meta) specifics — read before debugging FB/IG

- **One Meta app for both:** "Post Automation 2", App ID `298449321694397` (Business type, Live, business-verified + Tech-Provider verified). Env vars: `FACEBOOK_CLIENT_ID`/`FACEBOOK_CLIENT_SECRET` and `INSTAGRAM_CLIENT_ID`/`INSTAGRAM_CLIENT_SECRET` (same App ID + secret for both). Redirect URIs (Facebook Login for Business → Settings, Strict Mode + Enforce HTTPS ON, lowercase, `.co.in` only): `https://postautomation.co.in/api/oauth/callback/facebook` and `.../instagram`.
- **App settings → Advanced → "Native or desktop app?" MUST be OFF.** If ON, the server-side `client_secret` token exchange fails with `OAuthException code:1 "the app is configured as a desktop app"`. (Fixed 2026-06-02.)
- **IG is posted via FB Pages:** the app resolves Instagram through `me/accounts → instagram_business_account`. A connecting user's IG must be a **Professional/Business account linked to a Facebook Page they admin**, else connect returns `?error=ig_no_business_account` and there's nothing to publish to. The count of IG accounts a user sees on connect = the subset of their admined Pages that have a linked IG Business account — NOT "their IG accounts".
- **Permissions need App Review Advanced Access for the public.** Of the requested scopes only `public_profile` (+ `email`, auto-granted) work for non-app-role users. `pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, instagram_manage_comments, business_management` all require **Advanced Access via App Review**. Until approved, ordinary users get Meta's "This app needs at least one supported permission" screen; only app roles (admin/dev/tester) can connect. Scopes in `channel.router.ts getDefaultScopes` (`email` was dropped 2026-06-02 — unused, slims review).
- **App Review "test API call" gate:** the dashboard won't activate a permission's "Request Advanced Access" button until the app has made one successful Graph call exercising THAT permission (≤24h propagation). Map: `me/accounts`=pages_show_list/business_management [connect]; `{page}/feed`+`/photos`+`/videos`=pages_manage_posts [publish]; `{post}?fields=reactions.summary,comments.summary`=pages_read_engagement [Analytics sync, runs in WORKER]; IG profile read=instagram_basic; `{ig}/media`+`/media_publish`=instagram_content_publish [publishes a LIVE post — IG has no draft mode]; `{media}/comments`=instagram_manage_comments. All 7 exercised 2026-06-03 via test account.
- **Token invalidation after scope/config change:** changing the Meta app's scopes/config invalidates ALL existing stored FB/IG tokens (`"session has been invalidated..."`), same class as the YouTube `invalid_grant` quirk above. After winning Advanced Access, existing connected accounts must **reconnect** (fresh OAuth) — Advanced Access does not revive dead tokens. A freshly-connected channel has a working token end-to-end (proves the code is fine).
- **Compliance URLs (App settings → Basic):** Privacy `https://postautomation.co.in/privacy`, Terms `/terms`, Data Deletion Instructions `/data-deletion` (page at [apps/web/app/data-deletion/page.tsx](apps/web/app/data-deletion/page.tsx)). All must be live (200) before App Review.

## AI Content — Repurpose / Content Studio (read before debugging image/video gen)

The repurpose flow ([packages/api/src/routers/repurpose.router.ts](packages/api/src/routers/repurpose.router.ts), UI [apps/web/components/content-agent/RepurposeTab.tsx](apps/web/components/content-agent/RepurposeTab.tsx)) turns a URL into captions + media (static / carousel / reel / ai_video). Fixed end-to-end in PR #44 (`b4b6772`, 2026-06-05). Key invariants:

- **Image generation: Gemini (Nano Banana) primary → OpenAI fallback.** `generateImageSafe` ([packages/ai/src/utils/safe-image-generator.ts](packages/ai/src/utils/safe-image-generator.ts)) tries Gemini, then falls back to OpenAI via [dalle.provider.ts](packages/ai/src/providers/dalle.provider.ts). **The OpenAI account has NO `dall-e-*` access — only `gpt-image-*`.** The provider MUST use `model: "gpt-image-1"` and MUST NOT send `response_format` (gpt-image-1 returns b64 by default and 400s on that param). Sizes: `1024x1024|1024x1536|1536x1024|auto`; quality `low|medium|high|auto`. Legacy `1024x1792`/`1792x1024`/`standard`/`hd` from older callers are normalized internally — do NOT re-introduce `dall-e-3`.
- **Text generation defaults to OpenAI** (mutation + UI), with auto-fallback to OpenAI (`repurposeContentResilient`/`generateContentResilient`) when a chosen provider throws. Reason: the Google-family providers (`gemini`/`gemma4`) share the billing-held Cloud project below, so defaulting to them killed captions before any media.
- **Static posts + carousel covers bake the headline onto the image** via `generateStaticNewsCreativeImage` ([packages/ai/src/tools/news-image-generator.ts](packages/ai/src/tools/news-image-generator.ts)) — the same renderer NewsGrid/autopilot use (AI image = background, deterministic headline + logo/handle footer + tag). It uses `waitUntil:"load"` (NOT `networkidle0`, which never settles for a ~5MB inline gpt-image-1 data-URL bg). Falls back to a stock SVG background so a branded creative ALWAYS renders.
- **AI-video (Veo3 / Seedance) plan gate** uses `requirePlan(orgId, "PROFESSIONAL", "AI video generation", ctx.isSuperAdmin)` — superadmins bypass. Do NOT revert to a hand-rolled `org.plan === "FREE"||"STARTER"` check (it ignored superadmin).
- **Seedance 2.0 video (fal.ai)** — the WORKING AI-video path (`FAL_KEY` set, billing fine), unlike Veo3. [seedance.provider.ts](packages/ai/src/providers/seedance.provider.ts). Two gotchas, both fixed (PR #45): (a) **model ID is `bytedance/seedance-2.0/text-to-video`** — the BARE `bytedance/...` namespace, NOT `fal-ai/bytedance/...` (older fal models like `fal-ai/wan/...` DO use the `fal-ai/` prefix; Seedance 2.0 does not). A wrong ID is accepted but instant-"COMPLETED" (0.027s, empty logs, 404 result) — it silently never generates. (b) **Poll the `status_url`/`response_url` that fal.ai returns in the submit response** — do NOT reconstruct the poll path from the model ID (the queue API uses the app-prefix `bytedance/seedance-2.0/requests/{id}`, and reconstructing the full path 405s every poll → "perpetual generating" timeout).
- **Error messages:** all AI failures route through `friendlyAIMessage` / `toFriendlyAIError` ([packages/api/src/lib/ai-errors.ts](packages/api/src/lib/ai-errors.ts)) — billing/permission/quota 403s become "temporarily unavailable", NEVER leak raw Google project IDs / `PERMISSION_DENIED` JSON. When all media fails the mutation returns `mediaFailed: true` (honest toast + UI failure card), not a false "success".
- **⚠️ Google Cloud billing hold (project `518560861182`):** native Gemini images + **Veo3 video** currently 403 with "Lightning dunning decision is deny … PERMISSION_DENIED" — a billing/dunning suspension, NOT a code bug. Static + carousel work via the OpenAI/gpt-image-1 fallback; **native Veo3 video stays dead until billing is resolved in Cloud Console** (project owned by admin@dashmani.com). No code change fixes the billing hold.

## Super Agent (chat assistant) — read before touching chat.router or super-agent UI

The Super Agent ([apps/web/app/dashboard/super-agent/page.tsx](apps/web/app/dashboard/super-agent/page.tsx), [packages/api/src/routers/chat.router.ts](packages/api/src/routers/chat.router.ts), prompt in [packages/ai/src/prompts/chat-agent.prompt.ts](packages/ai/src/prompts/chat-agent.prompt.ts)) is a conversational agent that emits ` ```action ` blocks. The streaming route ([apps/web/app/api/chat/stream/route.ts](apps/web/app/api/chat/stream/route.ts)) only *parses* the action and forwards it in the `done` SSE event; the **client** decides execution. Invariants (audit fix 2026-06-06, PR for `fix/audit-2026-06-06`):

- **Every `executeAction` case is plan-gated + channel-ownership-validated. Do NOT remove these.** `create_agent` → `requirePlan(STARTER)`; `schedule_post`/`bulk_schedule`/`publish_now` → `enforcePlanLimit(postsPerMonth)`; `generate_news_image` → `enforcePlanLimit(aiImagesPerMonth)`. All pass `ctx.isSuperAdmin`. Before 2026-06-06 the agent had ZERO gating — a FREE user could create STARTER agents and exceed quotas via chat.
- **`assertChannelsOwned(prisma, orgId, channelIds)`** (exported from `chat.router.ts`) runs before any action that writes channel targets — closes a cross-org IDOR where AI-supplied `channelIds` were written without an org check. Mirrors the block in `post.router.ts:create`. Keep it on `create_agent`/`schedule_post`/`bulk_schedule`/`publish_now`.
- **`publish_now` is NOT auto-executed.** It renders an explicit "Publish now" button with an "immediate, cannot be undone" warning, like every other action. Do NOT re-add the `if (event.action?.type === "publish_now") executeAction(...)` auto-fire — it pushed live posts with no review.
- **Media attachments:** the chat input has a paperclip (uploads via `/api/upload`, which returns `{ id, url, fileName, fileType }`) and a Media Library picker (`MediaPickerDialog`, whose `onSelect` is `(url, fileName, mediaId?)` — NOT an object). Attachments are sent as `sendMessage({ attachmentMediaIds })` (the backend already persisted these). The welcome screen lists the user's connected channels (`trpc.channel.list`, fields `name`/`username`/`platform`) so it's obvious where posts can go.
- **`get_analytics`** returns post counts AND an engagement summary (impressions/likes/comments/shares/reach) summed from the latest `AnalyticsSnapshot` per published target — the SAME source as `analytics.engagement`, so chat and dashboard agree.
- Regression tests: [packages/api/src/__tests__/chat-action-gating.test.ts](packages/api/src/__tests__/chat-action-gating.test.ts) (plan matrix), [chat-channel-ownership.test.ts](packages/api/src/__tests__/chat-channel-ownership.test.ts) (IDOR guard).

## Routing / deep-link contract (Content Studio)

`/dashboard/content-agent` reads **`?tab=`** (values: `compose | create | repurpose | bulk`) and **`?view=`** (`posts | calendar`) and **`?subTab=image`** (opens the Image generator under `create`). It also accepts legacy `?expanded=` as a fallback for `?tab=`. **Cards and redirects MUST emit `?tab=`/`?view=`, never `?expanded=` or a non-existent tab id.** Before 2026-06-06 the dashboard Repurpose/Bulk cards emitted `?expanded=` (silently landed on Compose) and `/dashboard/ai`→`?tab=generate`, `/dashboard/image-studio`→`?tab=image`, `/dashboard/posts`→`?tab=posts`, `/dashboard/calendar`→`?tab=calendar` all pointed at tab ids that don't exist. Fixed: cards use `?tab=repurpose|bulk`; redirect shims use `?tab=create`/`?tab=create&subTab=image`/`?view=posts`/`?view=calendar`.

## Analytics — date handling

- **Date ranges are UTC.** The date-range picker builds `YYYY-MM-DDT00:00:00.000Z` / `…T23:59:59.999Z` so a non-UTC user's "today" doesn't shift a day. The `postsOverTime` query already used `setUTCHours`; do NOT reintroduce local-time `new Date(value).toISOString()` on the date inputs (it parses as local midnight → off-by-one for e.g. UTC+5:30).
- **`perChannelStats` raw SQL uses `COALESCE(p."publishedAt", p."updatedAt")`** in its date predicates so PUBLISHED posts with a NULL `publishedAt` aren't silently dropped.
- The Channel Performance card shows a distinct "connected but no engagement synced yet" banner (vs. the "no channels connected" empty state) when all channels have zero metrics — so pending FB/IG Advanced Access reads as "not synced", not "zero performance".

## Patched dependencies

- `@auth/core@0.41.0` — see [patches/@auth__core@0.41.0.patch](patches/). Applied automatically via pnpm `patchedDependencies` on install.

## Testing

- Framework: Vitest ([vitest.config.ts](vitest.config.ts))
- Coverage: `@vitest/coverage-v8`
- Run all: `pnpm test`

## Roles & Access Control

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

## Conventions

- TypeScript strict, shared base config in [tsconfig.base.json](tsconfig.base.json)
- Workspace package names: `@postautomation/<name>`
- Cross-workspace imports use the package name, not relative paths
