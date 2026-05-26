# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Project

**Posting-Automation** — multi-channel social posting platform. Next.js web app + BullMQ worker, backed by Postgres, Redis, and S3-compatible storage. Deployed to a Linode VPS via Docker Compose.

- Repo: https://github.com/dmpl6454/Posting-Automation.git
- Domains: https://postautomation.in, https://postautomation.co.in (primary SSL: postautomation.co.in)
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

4. **Worker Docker build fails (canvas / pixman-1)**: The worker image build fails with `gyp: Package 'pixman-1' not found` because `canvas@2.11.2` requires native libs not present in the alpine image. This is a pre-existing issue — the worker container keeps running on the previous image. If you need to deploy worker changes, either add the missing libs to `Dockerfile.worker` or replace `canvas` with a server-side alternative. To deploy web/migrate without worker, use: `docker compose -f docker-compose.prod.yml --env-file .env.production build web migrate && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps web migrate`

5. **`.env.production` symlink lost**: If `.env.production` points to a broken symlink, recreate `.env.prod` from the running container: `docker inspect postautomation-web-1 --format "{{json .Config.Env}}" | python3 -c "import json,sys; [print(e) for e in sorted(json.load(sys.stdin)) if e.split('=')[0] not in {'PATH','NODE_VERSION','YARN_VERSION','PUPPETEER_EXECUTABLE_PATH','PUPPETEER_SKIP_CHROMIUM_DOWNLOAD','SKIP_ENV_VALIDATION','PORT','HOSTNAME','NODE_ENV'}]" > .env.prod`

## Authentication

NextAuth v5 beta (`next-auth@^5.0.0-beta.25`), PrismaAdapter, JWT sessions (30 days).

**Env vars required:** Both `AUTH_SECRET` (v5) and `NEXTAUTH_SECRET` (middleware compat) must be set to the same value.

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

- **How it works**: `orgProcedure` reads `session.user.isSuperAdmin` and passes it as `ctx.isSuperAdmin`; all plan-limit helpers (`requirePlan`, `checkUsageLimit`, `enforcePlanLimit`) accept an optional `isSuperAdmin` flag and return early / return unlimited when true; `planExpiresAt` auto-revert is skipped for superadmin orgs; sidebar lock icons are skipped; superadmins bypass membership checks and can access any org.
- **Who has it**: `tabish@dashmani.com` — applied directly via psql on 2026-05-26.
- **Granting on local**: `UPDATE "User" SET "isSuperAdmin" = true WHERE email = 'you@example.com';` in `prisma studio` or psql. Also ensure an OWNER membership exists.
- **Granting on production** (psql): `ssh posting-automation 'docker exec postautomation-postgres-1 psql -U postgres postautomation -c "UPDATE \"User\" SET \"isSuperAdmin\" = true WHERE email = '\''you@example.com'\'';"'`
- After granting, the user must **sign out and back in** for the new JWT claim to take effect.

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
