# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Project

**Posting-Automation** — a multi-channel social posting platform. Users connect social
accounts, compose once, and publish to many channels at once; a background worker handles
the actual delivery and collects engagement metrics afterwards.

Two deployable apps (a Next.js web app and a BullMQ worker) share a set of workspace
packages, backed by Postgres, Redis and S3-compatible object storage.

## Stack

- **Package manager**: pnpm@9.15.0 (NOT npm). Node >= 20.
- **Monorepo**: Turborepo ([turbo.json](turbo.json), [pnpm-workspace.yaml](pnpm-workspace.yaml))
- **Web**: Next.js (App Router), port 3000 — [apps/web](apps/web/)
- **Worker**: BullMQ — [apps/worker](apps/worker/)
- **API layer**: tRPC with the superjson transformer — [packages/api](packages/api/)
- **DB**: Postgres 16 + Prisma — [packages/db](packages/db/)
- **Queue**: Redis 7 — [packages/queue](packages/queue/)
- **Storage**: MinIO locally, S3-compatible in production
- **Auth**: NextAuth (Auth.js core, patched — see [patches/](patches/))
- **Deploy**: Docker Compose, GitHub Actions

## Workspace layout

```
apps/
  web/           @postautomation/web — Next.js app
  worker/        @postautomation/worker — BullMQ worker
  ios/           Native SwiftUI companion app (not a pnpm workspace — built with xcodebuild)
packages/
  ai/            AI provider abstraction (OpenAI, Anthropic, Gemini, fal.ai)
  api/           Shared tRPC routers, middleware and lib
  auth/          NextAuth config
  billing/       Stripe integration
  db/            Prisma schema, client, migrations
  logger/        Shared logger
  queue/         BullMQ queue definitions and cron scheduling
  social/        Social platform OAuth + publishing providers
  super-text/    Shared text-overlay renderer (preview + burn-in)
docker/          Dockerfiles (web, worker, migrate) + nginx config
scripts/         deploy + maintenance scripts
.github/workflows/  CI/CD
```

Cross-workspace imports use the package name (`@postautomation/db`), never a relative path.

## Architecture

**Request path.** The browser talks to Next.js, which exposes tRPC at `/api/trpc`. Routers
live in [packages/api/src/routers](packages/api/src/routers/) and are composed into one
root router. Procedures build on a small set of base procedures that layer on
authentication, organization membership and plan checks — pick the narrowest one that fits
rather than re-implementing a guard inline.

**Multi-tenancy.** Everything is scoped to an `Organization`. A user belongs to one or more
organizations through `OrganizationMember`; the active organization arrives with each
request and is resolved to a membership server-side. Any query that reads or writes tenant
data must be scoped by the resolved `organizationId` — never by a value the client supplied
directly.

**Publishing.** Composing a post writes a `Post` plus one `PostTarget` per selected channel.
Targets are enqueued onto the publish queue (immediately, or delayed to a scheduled time),
and the worker claims each one atomically before contacting the platform. Per-platform
logic lives behind a provider interface in [packages/social](packages/social/src/providers/)
so the worker stays platform-agnostic. Results are written back to the target, and the post
is finalized once every target reaches a terminal state.

**Analytics.** After a post publishes, scheduled jobs re-read engagement from each platform
and store `AnalyticsSnapshot` rows. Platforms differ in which metrics they expose, so each
capture records what was actually returned and the UI distinguishes "not reported" from a
measured zero.

**Media.** Large uploads go from the browser straight to object storage via presigned
multipart URLs; the web process never buffers them. The worker handles any transcoding or
compositing before publishing.

## Local setup

1. Install deps: `pnpm install`
2. Start infra: `docker compose up -d` (Postgres on 5433, Redis on 6380, MinIO on 9000/9001)
3. Copy env: `cp .env.example .env` and fill in the values you need
4. Generate an auth secret: `openssl rand -base64 32` → `NEXTAUTH_SECRET`
5. Push schema: `pnpm db:push`
6. Seed (optional): `pnpm db:seed`
7. Run dev: `pnpm dev` (Turborepo runs web + worker)

Web: http://localhost:3000 · MinIO console: http://localhost:9001

The local MinIO bucket must exist before uploads work — create it once via the MinIO
console or `mc`.

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
pnpm clean             # turbo clean + remove node_modules
```

Filter to one workspace: `pnpm --filter @postautomation/web <cmd>`

## Environment variables

Local config lives in `.env` (gitignored); [.env.example](.env.example) is the template.
Production uses its own file on the server, templated by
[.env.production.example](.env.production.example).

Most third-party credentials are optional. The app boots without them — the affected
feature simply stays unavailable until its keys are set.

## Testing

- Framework: Vitest ([vitest.config.ts](vitest.config.ts)), coverage via `@vitest/coverage-v8`
- **Run the whole suite with the root runner: `pnpm exec vitest run`** (378 files).
- `pnpm test` runs `turbo test`, which reaches only the five packages that define a `test`
  script — `ai`, `api`, `queue`, `social`, `super-text` — and therefore **skips 113 suites**:
  63 under `apps/worker/src`, 43 under `apps/web/lib`, and 7 across `packages/auth` and
  `packages/db`. Turbo reports a workspace with no `test` script as satisfied rather than
  missing, so `pnpm test` goes green without them. Prefer the root runner above.
- Per-package: `pnpm --filter @postautomation/api test` — each of those packages carries its
  own `vitest.config.ts` scoped to `src/**`, so a package-level run never reaches `apps/`.
- Type-check a single package: `pnpm --filter <pkg> exec tsc --noEmit`
- Suites named `*.e2e.test.ts` are skipped by default — they need live services or a real
  database, and are opted into with an environment flag.

Before merging a change to the web app, run the real Next.js build
(`pnpm --filter @postautomation/web build`) — `tsc --noEmit` alone does not catch
build-time failures.

## Conventions

- TypeScript strict, shared base config in [tsconfig.base.json](tsconfig.base.json)
- Workspace package names: `@postautomation/<name>`
- Match the surrounding file's style — naming, comment density and idiom
- Prefer extending an existing provider/router/helper over introducing a parallel one
