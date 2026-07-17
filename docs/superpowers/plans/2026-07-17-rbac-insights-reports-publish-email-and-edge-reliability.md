# RBAC + Insights/Reports + Publish Emails + Edge Reliability (503/504) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add gated role-based access (User / Admin / Super-Admin), an Insights page with an analytical view + extractable per-post Reports (24h/7d/15d/30d, current-metrics AND metrics-at-age modes), publish-notification emails to the post creator, and eliminate the intermittent nginx 503s (rate-limiter friendly fire) and 504s (event-loop freeze from synchronous ffmpeg).

**Architecture:** Four independently shippable phases, each its own branch + PR through the normal deploy pipeline. RBAC is an app-level `User.appRole` enum (orthogonal to org `MemberRole` and to `isSuperAdmin`), enforced authoritatively in tRPC middleware (the JWT callback already re-reads the User row per request, so role changes take effect immediately server-side), with UI nav filtering as presentation. Reports reuse the existing append-only `AnalyticsSnapshot` time series; at-age metrics come from delayed BullMQ jobs enqueued at publish. The publish email is a redesign of the already-existing `sendPublishReportEmail` in the post-publish worker (the single funnel for ALL publish paths).

**Tech Stack:** Next.js/NextAuth v5 (JWT), tRPC, Prisma/Postgres (`prisma db push` in prod), BullMQ/Redis, nodemailer (SMTP already live), nginx (Docker), Vitest.

---

## Locked product decisions (owner-confirmed 2026-07-17)

| Decision | Answer |
|---|---|
| Default role for brand-new signups | **USER** (limited). All existing users backfilled to **ADMIN**. |
| Reports window semantics | **BOTH modes**: (a) posts published within window + current metrics (ships immediately); (b) metrics as-of 24h/7d/15d/30d after publish (accrues for new posts from deploy). |
| Publish email recipient | **Post creator only** (one email per post listing every channel, timestamps, URLs). |
| Channels page for USER role | **Fully accessible** (connect/disconnect included). |
| Super admin | `isSuperAdmin` boolean stays; implies Admin everywhere; can change roles and grant more super admins. Currently only `tabish@dashmani.com`. |

**USER-role feature areas:** Dashboard, Content Studio (compose/create/repurpose/bulk/image), Super Agent, Media, Analytics→Insights, **Channels** (incl. groups), plus account plumbing (profile/settings basics, notifications, approvals *submit*).
**ADMIN-only areas:** RSS Feeds, Short Links, Autopilot (+account groups), Social Listening, Campaigns, Brand Outreach, Approvals *review*, Team management (invite/role/remove), Billing mutations, Webhooks, API keys, Audit log, NewsGrid (hidden but routable), org create/update, notification.create, deployment views.
**SUPER-ADMIN-only:** `/admin` section, Monitoring page, deployment.rollback, role management.

## Recon facts the plan builds on (verified 2026-07-17)

- `session.user.role` **already exists and is the org MemberRole** ([packages/auth/src/config.ts:174-183](../../packages/auth/src/config.ts), consumed by [sidebar.tsx:95](../../apps/web/components/layout/sidebar.tsx)). The new claim MUST be named **`appRole`**.
- The JWT callback **re-reads the User row from DB on every `auth()` call** (config.ts:151-159, `select { isBanned, isSuperAdmin, passwordChangedAt }`) → adding `appRole` to that select gives per-request-fresh server-side roles at zero extra queries. Client `useSession()` may lag until refresh — UI-only staleness.
- Prod migrations are **`prisma db push`** (docker/Dockerfile.migrate:12) and deploy order is: build → migrate (old code still serving) → web → worker → nginx. `db push` cannot carry data backfills → **two-PR rollout for RBAC** (schema+backfill first, then gates) to guarantee no lockout window.
- Backfill convention: standalone tsx script à la [scripts/backfill-user-orgs.ts](../../scripts/backfill-user-orgs.ts), run in the web container via docker exec.
- `AnalyticsSnapshot` ([schema.prisma:389-406](../../packages/db/prisma/schema.prisma)) is **append-only time-series** (`@@index([postTargetId, snapshotAt])`, no unique) with columns `impressions, clicks, likes, shares, comments, reach, engagementRate, metadata Json?`. No `views` column — platforms map views→impressions. Sync cron: every 6h, only targets published within the **last 7 days**; FACEBOOK is currently excluded from the cron sync (quota) — its posts only get their at-publish snapshot.
- `PostTarget` stores `publishedId`, `publishedUrl`, `publishedAt` (written at [post-publish.worker.ts:623-633](../../apps/worker/src/workers/post-publish.worker.ts)). Every provider returns a canonical URL.
- **A publish email already exists**: `sendPublishReportEmail` ([post-publish.worker.ts:28-143](../../apps/worker/src/workers/post-publish.worker.ts)) — currently sent to ALL org OWNER/ADMINs, interpolates content into HTML **unescaped**, called at :683 (success) and :806 (failure). Worker has nodemailer + SMTP env (BO-01). Every publish path (compose, scheduled, autopilot, newsgrid bulk, chat publish_now) funnels through this one worker.
- Nav gating: `NavItem { roles?: MemberRole[]; minPlan?: PlanType }` + `visible()` in sidebar.tsx; there is NO per-page URL guard precedent (tRPC is the boundary). Known quirk: **Monitoring nav item is visible to everyone** (page errors for non-super-admins) — fixed in Phase 2.
- `/admin` (separate `admin-token` JWT, superadmin-only) already has a Users page with `toggleSuperAdmin`, `toggleBan`, `impersonate` — role management slots in there.
- **503 root cause (confirmed from prod logs + conf):** `limit_req_zone $binary_remote_addr zone=api rate=30r/s` + `limit_req zone=api burst=20 nodelay` on `location /api/` ([docker/nginx/nginx.conf:36,171-185](../../docker/nginx/nginx.conf)) with **no `limit_req_status`** → default **503**. Zone keyed per-IP → the whole office NAT shares 30 r/s; `/api/oauth/callback/facebook` falls under `/api/` → the screenshot's 503 mid-OAuth. 2,002 5xx in the last 7 days.
- **504 root cause (confirmed in code):** synchronous ffmpeg inside the web process — [packages/ai/src/tools/reel-generator.ts:195](../../packages/ai/src/tools/reel-generator.ts) `execSync(ffmpegCmd, { timeout: 180_000 })` and [packages/api/src/routers/repurpose.router.ts:2457-2465](../../packages/api/src/routers/repurpose.router.ts) `execSync("ffmpeg -y -f lavfi …")` — freezes the Node event loop up to 3 min → all requests hang → nginx 504.
- SMTP: **already configured in this repo's prod env** (web + worker). The owner's pointer to `apps/api/.env` refers to the *other* (Dashmani platform) repo — no new SMTP setup is required here; only copy those values into `.env.prod` if a different sender is desired (ops step, out of code scope).

## Safety invariants (do NOT violate while implementing)

1. Never hand-edit tracked files on the server (CLAUDE.md quirk #9) — every change goes commit → PR → `deploy.sh`.
2. nginx.conf changes require `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --force-recreate nginx` after the pull (bind-mount gotcha) — verify by curling.
3. Do not touch: golden-render gate, org-isolation membership gate in trpc.ts, `BILLING_DISABLED` machinery, Meta app config (scopes/redirect URIs), `getDefaultScopes`.
4. Existing users must never lose access at any point → Phase 1 (backfill to ADMIN) fully deploys and is verified **before** Phase 2 (gates) merges.
5. `isSuperAdmin === true` implies ADMIN at every new gate (mirrors existing `ctx.isSuperAdmin` early-returns).

---

# Phase 0 — Edge reliability: kill the 503s and 504s

*Branch: `fix/nginx-rate-limit-and-event-loop-2026-07`. Independent; ship first — it directly affects every user today.*

### Task 0.1: nginx — 429 for rate limits, saner limits, OAuth-callback exemption, friendly 50x page, working healthcheck

**Files:**
- Modify: `docker/nginx/nginx.conf`
- Modify: `docker-compose.prod.yml` (nginx healthcheck block only)

- [ ] **Step 1: Update the rate-limit zones + add `limit_req_status`** — in the `http` block (around line 35-37), replace:

```nginx
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/s;
```

with:

```nginx
    # Rate limiting.
    # Zones are keyed per client IP — an office NAT shares one bucket across every
    # member's dashboard tabs (notification polling, tRPC batches), so the api zone
    # needs real headroom. Rejections MUST be 429 (not the default 503) so clients
    # and humans can tell "slow down" apart from "the site is down".
    limit_req_zone $binary_remote_addr zone=api:10m rate=60r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/s;
    limit_req_status 429;
    limit_conn_status 429;
```

- [ ] **Step 2: Raise the burst on `/api/`** — in `location /api/` (line ~171), change `limit_req zone=api burst=20 nodelay;` to:

```nginx
            limit_req zone=api burst=120 nodelay;
```

- [ ] **Step 3: Exempt OAuth provider callbacks from rate limiting** — add this block ABOVE `location /api/` (nginx picks the longest prefix match, so this wins for callback URLs). Copy the proxy directives exactly as below:

```nginx
        # OAuth provider callbacks (Facebook/Instagram/YouTube/Twitter/...).
        # One-shot, security-critical redirects carrying a single-use consent code.
        # NEVER rate-limit these: a 429/503 here burns the user's OAuth attempt
        # (incident: FB connect returning nginx 503 mid-consent, 2026-07-17).
        location /api/oauth/callback/ {
            proxy_pass $backend;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 120s;
        }
```

- [ ] **Step 4: Friendly maintenance page for real upstream failures** — inside the main HTTPS `server` block (same level as the `location` blocks), add:

```nginx
        # Real upstream failures (deploy window, crashed web container, frozen
        # event loop) get a human page that auto-retries instead of a bare
        # "503/504 nginx" screen. Rate-limit rejections are 429 and NOT covered.
        error_page 502 503 504 @maintenance;
        location @maintenance {
            default_type text/html;
            add_header Retry-After 6 always;
            return 503 '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="6"><title>Back in a moment</title></head><body style="font-family:system-ui,sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div style="text-align:center"><h2>PostAutomation is briefly updating or under heavy load</h2><p>This page retries automatically every few seconds. Your work is safe.</p></div></body></html>';
        }
```

- [ ] **Step 5: Deterministic health endpoint** — in the port-80 `server` block (line ~43, BEFORE the HTTPS redirect location), add:

```nginx
        location = /nginx-health {
            access_log off;
            return 200 "ok\n";
        }
```

- [ ] **Step 6: Fix the broken nginx healthcheck** — open `docker-compose.prod.yml`, find the `nginx` service's `healthcheck:` block (currently failing: container shows `(unhealthy)` for 3 weeks while serving fine), and replace it with:

```yaml
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1/nginx-health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
```

- [ ] **Step 7: Validate config syntax locally** (docker one-shot, no server changes):

Run: `docker run --rm -v "$PWD/docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:alpine nginx -t`
Expected: `syntax is ok` + `test is successful`. (The `$backend`/`resolver` variables resolve at runtime; `nginx -t` validates syntax only — if it complains about unknown upstream hosts, that is acceptable for the syntax check; confirm the directive lines parse.)

- [ ] **Step 8: Commit**

```bash
git add docker/nginx/nginx.conf docker-compose.prod.yml
git commit -m "fix(nginx): 429 for rate limits, exempt OAuth callbacks, raise api burst, friendly 50x page, working healthcheck"
```

### Task 0.2: un-freeze the web event loop — async ffmpeg

**Files:**
- Modify: `packages/ai/src/tools/reel-generator.ts:7,195`
- Modify: `packages/api/src/routers/repurpose.router.ts:2457-2465`

- [ ] **Step 1: reel-generator.ts — replace the sync shell exec.** Read the construction of `ffmpegCmd` above line 195. Convert the command string into an **argv array** (each token its own array element — this both removes the shell and keeps the repo's injection-safe convention from the Round-3 execSync→execFileSync fix), then replace:

```ts
// line 7:  import { execSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
```

and at the call site (line ~195), replace `execSync(ffmpegCmd, { timeout: 180_000, stdio: "pipe" });` with:

```ts
// Async: a 1-3 minute encode must never freeze the web process's event loop
// (root cause of the prod 504s — every other request hung while a reel stitched).
await execFileAsync("ffmpeg", ffmpegArgs, { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
```

The enclosing function must become `async` and its callers `await` it — follow the compiler errors up the chain (they are all within packages/ai + the repurpose router, which is already async).

- [ ] **Step 2: repurpose.router.ts:2457-2465 — same treatment for the music-bed tone.** Replace the dynamic-import `execSync` shell string with:

```ts
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const execFileAsync = promisify(execFile);
await execFileAsync(
  "ffmpeg",
  [
    "-y",
    "-f", "lavfi", "-i", `sine=frequency=110:duration=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=165:duration=${duration}`,
    "-filter_complex",
    `[0:a][1:a]amix=inputs=2,volume=0.3,afade=t=in:d=1,afade=t=out:st=${duration - 1}:d=1[out]`,
    "-map", "[out]",
    "-c:a", "libmp3lame", "-b:a", "128k",
    musicPath,
  ],
  { timeout: 30_000 }
);
```

(`duration` is a number and `musicPath` is server-generated, but argv form removes the shell entirely — strictly safer than the current backtick string.)

- [ ] **Step 3: Search for any remaining sync execs in web-served code**

Run: `grep -rn "execSync\|execFileSync\|spawnSync" packages/ai/src packages/api/src apps/web --include='*.ts' | grep -v __tests__`
Expected: zero hits in request-path code (worker-only sync calls are tolerable but convert them too if trivial).

- [ ] **Step 4: Build + test**

Run: `pnpm --filter @postautomation/ai test && pnpm --filter @postautomation/api test && SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: suites green (incl. golden-render 17/17, 0 written), build exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/tools/reel-generator.ts packages/api/src/routers/repurpose.router.ts
git commit -m "fix(perf): async ffmpeg (argv, no shell) — sync encodes froze the web event loop causing prod 504s"
```

### Task 0.3: Deploy + verify Phase 0

- [ ] **Step 1:** Open PR, merge, let GitHub Actions deploy.
- [ ] **Step 2:** Force-recreate nginx (bind-mount gotcha): `ssh posting-automation 'cd /home/deploy/postautomation && docker compose -f docker-compose.prod.yml --env-file .env.production up -d --force-recreate nginx'`
- [ ] **Step 3:** Verify: `curl -s -o /dev/null -w "%{http_code}" http://<server-ip>/nginx-health` → expect `200`; `docker ps` → nginx `(healthy)` within ~90s.
- [ ] **Step 4:** Burst test from your office IP: `for i in $(seq 1 200); do curl -s -o /dev/null -w "%{http_code}\n" https://postautomation.co.in/api/trpc/org.current & done | sort | uniq -c` → excess responses must be **429** (never 503); normal responses 200/401.
- [ ] **Step 5:** Have someone connect a Facebook channel during the burst — the callback must complete (no 429/503).
- [ ] **Step 6:** Generate a Slideshow Reel in Content Studio while a second browser reloads the dashboard — the dashboard must stay responsive (no 504).
- [ ] **Step 7:** Next day: `ssh posting-automation 'docker logs --since 24h postautomation-nginx-1 2>&1 | grep -cE "\" 50[34] "'` → expect ~0 (vs 2,002/7d baseline).

---

# Phase 1 — RBAC part A: schema + backfill (zero behavior change)

*Branch: `feat/app-role-schema-2026-07`. Must be fully deployed AND backfilled before Phase 2 merges.*

### Task 1.1: Prisma schema — `AppRole` enum + `User.appRole`

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1:** Next to `enum MemberRole` (line ~182), add:

```prisma
/// App-level access tier — ORTHOGONAL to org MemberRole (workspace membership)
/// and to User.isSuperAdmin (billing bypass + /admin access; implies ADMIN at
/// every appRole gate). USER = Dashboard, Content Studio, Super Agent, Media,
/// Insights, Channels. ADMIN = everything. Managed from /admin by super admins.
enum AppRole {
  USER
  ADMIN
}
```

- [ ] **Step 2:** In `model User` (fields start line ~12), after `isSuperAdmin`, add:

```prisma
  appRole          AppRole   @default(USER)
```

Default is `USER` (new-signup policy). Existing rows are protected by the Task 1.2 backfill, which runs before any code reads this column.

- [ ] **Step 3:** Local push + regenerate: `pnpm db:push` → expect `ALTER TABLE "User" ADD COLUMN "appRole" ... NOT NULL DEFAULT 'USER'` + CREATE TYPE, no destructive statements. Then `pnpm --filter @postautomation/db exec prisma generate`.

### Task 1.2: Backfill script — grandfather every existing user to ADMIN

**Files:**
- Create: `scripts/backfill-app-roles.ts`

- [ ] **Step 1: Write the script** (mirrors backfill-user-orgs.ts conventions: predicate-scoped, idempotent, summary counts, exit 1 on error):

```ts
/**
 * One-time RBAC grandfathering: every user created BEFORE the cutoff becomes
 * ADMIN (product decision 2026-07-17: existing users keep full access; only
 * NEW signups default to USER).
 *
 * Idempotent: re-runs are no-ops (predicate excludes already-promoted rows).
 * The cutoff is explicit so a later re-run cannot wrongly promote new users.
 *
 * Run (local):  RBAC_ADMIN_CUTOFF=2026-07-18T00:00:00Z pnpm tsx scripts/backfill-app-roles.ts
 * Run (prod):   docker exec -e RBAC_ADMIN_CUTOFF=2026-07-18T00:00:00Z postautomation-web-1 \
 *                 sh -c 'cd /app && NODE_PATH=/app/packages/db/node_modules /app/packages/db/node_modules/.bin/tsx scripts/backfill-app-roles.ts'
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const cutoffIso = process.env.RBAC_ADMIN_CUTOFF;
  if (!cutoffIso || Number.isNaN(Date.parse(cutoffIso))) {
    console.error("Set RBAC_ADMIN_CUTOFF=<ISO datetime>. Users created BEFORE it are promoted to ADMIN.");
    process.exit(1);
  }
  const cutoff = new Date(cutoffIso);

  const candidates = await prisma.user.count({
    where: { appRole: "USER", createdAt: { lt: cutoff } },
  });
  if (candidates === 0) {
    console.log("Nothing to do — all pre-cutoff users are already ADMIN.");
    return;
  }

  const res = await prisma.user.updateMany({
    where: { appRole: "USER", createdAt: { lt: cutoff } },
    data: { appRole: "ADMIN" },
  });
  console.log(`Promoted ${res.count} pre-cutoff user(s) to appRole=ADMIN (cutoff ${cutoff.toISOString()}).`);

  const [admins, users, supers] = await Promise.all([
    prisma.user.count({ where: { appRole: "ADMIN" } }),
    prisma.user.count({ where: { appRole: "USER" } }),
    prisma.user.count({ where: { isSuperAdmin: true } }),
  ]);
  console.log(`Totals now: ADMIN=${admins} USER=${users} superAdmins=${supers}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Local verify (idempotency is the test):** run twice with a cutoff in the future of your seed users; first run prints `Promoted N…`, second prints `Nothing to do`. Then `pnpm db:studio` → spot-check `appRole` values.
- [ ] **Step 3: Commit**

```bash
git add packages/db/prisma/schema.prisma scripts/backfill-app-roles.ts
git commit -m "feat(rbac): AppRole enum + User.appRole (default USER) + grandfathering backfill script"
```

### Task 1.3: Deploy Phase 1 + run the prod backfill

- [ ] **Step 1:** PR → merge → deploy (migrate container rebuilds + `db push` adds the column while old code serves — old code never selects `appRole`, so this is invisible).
- [ ] **Step 2:** Run the backfill on prod with cutoff = "now" (the moment you run it):
`ssh posting-automation "docker exec -e RBAC_ADMIN_CUTOFF=$(date -u +%Y-%m-%dT%H:%M:%SZ) postautomation-web-1 sh -c 'cd /app && NODE_PATH=/app/packages/db/node_modules /app/packages/db/node_modules/.bin/tsx scripts/backfill-app-roles.ts'"`
- [ ] **Step 3: VERIFY (hard gate for Phase 2):**
`ssh posting-automation 'docker exec postautomation-postgres-1 psql -U postautomation postautomation -c "SELECT \"appRole\", COUNT(*) FROM \"User\" GROUP BY 1;"'`
Expected: every existing user `ADMIN`, `USER` count = 0 (or only signups from the last minutes). **Do not merge Phase 2 until this is true.**

---

# Phase 2 — RBAC part B: enforcement + UI + role management

*Branch: `feat/app-role-gates-2026-07`.*

### Task 2.1: Fresh `appRole` claim in JWT + session

**Files:**
- Modify: `packages/auth/src/config.ts:144-159,188-198`

- [ ] **Step 1:** In the jwt callback sign-in seeding (lines ~144-149) add: `token.appRole = (user as any).appRole ?? "USER";`
- [ ] **Step 2:** In the per-call DB re-check (lines ~151-159) add `appRole: true` to the `select` and `token.appRole = dbUser.appRole;` to the assignment block. **This is what makes server-side role changes effective immediately** — the select already runs on every request.
- [ ] **Step 3:** In the session callback (lines ~188-198) add: `(session.user as any).appRole = token.appRole ?? "USER";` — do NOT touch the existing `role` (org MemberRole) line.
- [ ] **Step 4:** `pnpm --filter @postautomation/auth exec tsc --noEmit` → exit 0. Commit: `feat(rbac): appRole claim in JWT/session (DB-fresh per request)`.

### Task 2.2: tRPC enforcement middleware + kill switch

**Files:**
- Modify: `packages/api/src/trpc.ts` (below orgProcedure, ~line 225)

- [ ] **Step 1:** Add (mirroring superAdminProcedure's style):

```ts
/** App-level admin check. isSuperAdmin implies ADMIN. RBAC_DISABLED=true is the
 *  emergency kill switch (mirrors BILLING_DISABLED — env-only rollback, no redeploy). */
export const isAppAdmin = (sessionUser: unknown): boolean => {
  const u = sessionUser as { appRole?: string; isSuperAdmin?: boolean } | null | undefined;
  return u?.appRole === "ADMIN" || u?.isSuperAdmin === true;
};

const requireAppAdmin = t.middleware(({ ctx, next }) => {
  if (process.env.RBAC_DISABLED === "true") return next();
  if (!isAppAdmin(ctx.session?.user)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This area requires an admin role. Ask a workspace admin." });
  }
  return next();
});

/** orgProcedure + app-admin gate — use for admin-only feature areas. */
export const adminOrgProcedure = orgProcedure.use(requireAppAdmin);
/** protectedProcedure + app-admin gate — for admin routers not built on orgProcedure. */
export const adminProtectedProcedure = protectedProcedure.use(requireAppAdmin);
```

(Adapt `t.middleware` to the file's actual middleware helper if it differs — mirror how orgProcedure composes.)

- [ ] **Step 2:** Commit: `feat(rbac): adminOrgProcedure/adminProtectedProcedure + RBAC_DISABLED kill switch`.

### Task 2.3: Router sweep — apply the matrix

**Files (all in `packages/api/src/routers/`):** swap the base procedure per this table. Import `adminOrgProcedure` (or `adminProtectedProcedure` where the router isn't org-based) from `../trpc`.

| Router file | Change to admin-gated | Stays USER-accessible |
|---|---|---|
| `rss.router.ts` | ALL procedures | — |
| `shortlink.router.ts` | ALL | — |
| `agent.router.ts` (autopilot agents) | ALL | — |
| `autopilot.router.ts` | ALL | — |
| `account-group.router.ts` | ALL | — |
| `listening.router.ts` | ALL | — |
| `campaign.router.ts` | ALL (keep `gateCampaigns` plan gate too) | — |
| `brand-leads.router.ts` | ALL | — |
| `newsgrid.router.ts` | ALL (hidden UI but routes resolve) | — |
| `team.router.ts` | `invite`, `updateRole`, `transferOwnership`, `removeMember` | `members` (feeds approval reviewer picker), `getInvite`/`acceptInvite` (public) |
| `webhook.router.ts` + `webhook-delivery.router.ts` | ALL | — |
| `apikey.router.ts` | ALL | — |
| `audit.router.ts` | ALL | — |
| `billing.router.ts` | `createCheckout`, `createPortalSession` | `plans`, `currentPlan`, `usage`, `paymentMethod` (sidebar/dashboard read `currentPlan.billingDisabled`) |
| `approval.router.ts` | `review` (approve/reject) | `submit`, `list`, `getForPost`, `cancel` |
| `user.router.ts` | `createOrganization` | `me`, `updateProfile`, `changePassword`, phone trio |
| `notification.router.ts` | `create` | `list`, `unreadCount`, `markRead`, `markAllRead` |
| `deployment.router.ts` | `current`, `list`, `register` | — (`rollback` already superAdmin) |
| **UNCHANGED (USER areas):** `post`, `repurpose`, `media`, `upload`, `ai`, `image`, `chat` (see 2.4), `analytics`, `channel` (ALL — owner decision: full Channels page), `channelGroup` (lives on Channels page), `creativeTemplate`, `designTemplate`, `bulk`, `org.current`, `onboarding`, `auth`, `monitor.logError` | | |

- [ ] **Step 1:** Apply the swaps file-by-file (mechanical: change the base procedure identifier on each listed procedure).
- [ ] **Step 2:** ⚠️ While editing `bulk.router.ts` note (do NOT fix here, just add a `// TODO(security)` comment): its procedures are `protectedProcedure` taking org from input without a membership check — pre-existing gap, tracked separately.
- [ ] **Step 3:** `pnpm --filter @postautomation/api exec tsc --noEmit` → exit 0. Commit: `feat(rbac): gate admin-only routers behind adminOrgProcedure`.

### Task 2.4: Super Agent — per-action role gate

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts` (executeAction switch, `create_agent` case ~line 390+)

- [ ] **Step 1:** Import `isAppAdmin` from `../trpc`. At the top of the `create_agent` case add:

```ts
if (process.env.RBAC_DISABLED !== "true" && !isAppAdmin(ctx.session?.user)) {
  throw new TRPCError({ code: "FORBIDDEN", message: "Creating autopilot agents requires an admin role." });
}
```

All other action types (`generate_content`, `schedule_post`, `bulk_schedule`, `publish_now`, `generate_news_image`, `get_analytics`) stay USER — they map to posting/analytics features Users own. Keep every existing plan gate + `assertChannelsOwned`/`assertMediaOwned` untouched.

- [ ] **Step 2:** Commit: `feat(rbac): admin gate on chat create_agent action`.

### Task 2.5: Sidebar + dashboard nav filtering (and fix the Monitoring leak)

**Files:**
- Modify: `apps/web/components/layout/sidebar.tsx:42-50` (NavItem), `:94-121` (visible)
- Modify: `apps/web/app/dashboard/page.tsx:141-146` (cards predicate)

- [ ] **Step 1:** Extend the interface:

```ts
interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  roles?: MemberRole[];      // org-role filter (existing)
  minPlan?: PlanType;        // plan filter (existing)
  appAdminOnly?: boolean;    // NEW: app-level ADMIN (or super admin) only
  superAdminOnly?: boolean;  // NEW: isSuperAdmin only
}
```

- [ ] **Step 2:** In the component (near line 95): `const appRole = (session?.user as any)?.appRole as "USER" | "ADMIN" | undefined;` and `const isAppAdminUser = appRole === "ADMIN" || isSuperAdmin;` then extend `visible()`:

```ts
if (item.superAdminOnly && !isSuperAdmin) return false;
if (item.appAdminOnly && !isAppAdminUser) return false;
```

- [ ] **Step 3:** Flag the nav arrays: `appAdminOnly: true` on RSS Feeds, Short Links, Autopilot, Social Listening, Campaigns, Brand Outreach, Approvals, Team, Billing; `superAdminOnly: true` on Monitoring (fixes the every-user-sees-it quirk). Dashboard/Content Studio/Super Agent/Channels/Media/Analytics/Settings get no new flag.
- [ ] **Step 4:** Mirror the same predicate for the feature cards in `dashboard/page.tsx` (its `planAllowed`-style helper gains the two flags).
- [ ] **Step 5:** `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` → exit 0. Commit: `feat(rbac): role-filtered nav + dashboard cards; Monitoring nav superadmin-only`.

### Task 2.6: Direct-URL guard for admin-only pages

**Files:**
- Create: `apps/web/components/auth/require-app-admin.tsx`
- Modify: top of each admin-only page listed in Step 2.

- [ ] **Step 1:** Create the guard (UX layer only — tRPC remains the security boundary):

```tsx
"use client";

import { useSession } from "next-auth/react";

/** Presentation guard for admin-only dashboard pages. Real enforcement lives in
 *  tRPC (adminOrgProcedure) — this just replaces a wall of FORBIDDEN toasts with
 *  a clear message when a USER-role account deep-links into an admin area. */
export function RequireAppAdmin({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  if (status === "loading") return null;
  const u = session?.user as { appRole?: string; isSuperAdmin?: boolean } | undefined;
  const ok = u?.appRole === "ADMIN" || u?.isSuperAdmin === true;
  if (!ok) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="space-y-2 text-center">
          <h2 className="text-lg font-semibold">Admin access required</h2>
          <p className="text-sm text-muted-foreground">
            This area is limited to workspace admins. Ask an admin to upgrade your role.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
```

- [ ] **Step 2:** Wrap the page component's returned JSX in `<RequireAppAdmin>…</RequireAppAdmin>` for: `dashboard/rss`, `dashboard/links`, `dashboard/autopilot/**` (its pages), `dashboard/listening`, `dashboard/campaigns`, `dashboard/brand-leads`, `dashboard/approvals`, `dashboard/team`, `dashboard/settings/billing`, `dashboard/settings/webhooks(+/[id])`, `dashboard/settings/api-keys`, `dashboard/settings/audit-log`, `dashboard/newsgrid(+/logos)`.
- [ ] **Step 3:** Build again (exit 0). Commit: `feat(rbac): RequireAppAdmin page guard on admin-only pages`.

### Task 2.7: Role management in /admin (super admin only)

**Files:**
- Modify: `packages/api/src/routers/admin/users.router.ts`
- Modify: `apps/web/app/admin/users/page.tsx`

- [ ] **Step 1:** Add the mutation (next to `toggleSuperAdmin`):

```ts
setAppRole: superAdminProcedure
  .input(z.object({ userId: z.string(), appRole: z.enum(["USER", "ADMIN"]) }))
  .mutation(async ({ ctx, input }) => {
    return ctx.prisma.user.update({
      where: { id: input.userId },
      data: { appRole: input.appRole },
      select: { id: true, email: true, appRole: true },
    });
  }),
```

- [ ] **Step 2:** Add `appRole: true` to the `list`/`getById` selects so the table can render it.
- [ ] **Step 3:** Read `toggleSuperAdmin`; if it lacks a last-super-admin guard, add before the update:

```ts
const target = await ctx.prisma.user.findUniqueOrThrow({ where: { id: input.userId }, select: { isSuperAdmin: true } });
if (target.isSuperAdmin) {
  const others = await ctx.prisma.user.count({ where: { isSuperAdmin: true, id: { not: input.userId } } });
  if (others === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot remove the last super admin." });
}
```

- [ ] **Step 4:** In `admin/users/page.tsx`, add a Role column with a two-option Select (`User`/`Admin`) wired to `setAppRole`, using the per-row `mutation.isPending && mutation.variables?.userId === row.id` loader pattern (PR #108 convention). The existing Super-Admin toggle covers "adding more super admins".
- [ ] **Step 5:** Build + commit: `feat(rbac): super-admin role management (setAppRole) + last-super-admin guard`.

### Task 2.8: Regression tests

**Files:**
- Create: `packages/api/src/__tests__/app-role-gating.test.ts`

- [ ] **Step 1:** Mirror the harness style of `chat-action-gating.test.ts` (mocked ctx/session). Matrix to assert:

```ts
// USER-role session (appRole:"USER", isSuperAdmin:false):
//   rss.list, agent.create, team.invite, approval.review, shortlink.create,
//   listening.listQueries, campaign.list, brandLeads.list, webhook.list,
//   apikey.list, audit.list, notification.create, user.createOrganization,
//   billing.createCheckout, chat.executeAction({type:"create_agent"})
//     → ALL throw FORBIDDEN
//   post.create, channel.list, channel.getOAuthUrl, media.list,
//   analytics.engagement, approval.submit, team.members, billing.currentPlan,
//   chat.executeAction({type:"schedule_post"}) (plan gates mocked)
//     → NOT FORBIDDEN-by-role
// ADMIN-role session → all of the first list pass the role gate.
// isSuperAdmin:true + appRole:"USER" → passes (implies admin).
// process.env.RBAC_DISABLED="true" → USER passes everything (kill switch).
```

Write each as a real test using the same helpers `chat-action-gating.test.ts` uses to build callers; assert on `TRPCError.code === "FORBIDDEN"` and error message containing "admin role" (distinguishes role-gate from plan-gate failures).

- [ ] **Step 2:** `pnpm --filter @postautomation/api test` → green. Commit: `test(rbac): app-role gating matrix`.

### Task 2.9: Deploy + prod verification

- [ ] **Step 1:** PR → merge → deploy. (Phase 1 backfill already verified — gate cannot lock out existing users.)
- [ ] **Step 2:** Prod smoke as an EXISTING user (admin): nav unchanged, RSS/Autopilot/Team all load. As `tabish@dashmani.com`: /admin Users shows Role column; flip a test account USER↔ADMIN.
- [ ] **Step 3:** Create a BRAND-NEW signup → nav shows only Dashboard/Content Studio/Super Agent/Channels/Media/Insights/Settings; deep-link `/dashboard/rss` → "Admin access required"; `curl` the tRPC endpoint for `rss.list` with that session cookie → FORBIDDEN.
- [ ] **Step 4:** Promote that test account to ADMIN in /admin → API access works immediately; nav appears after page reload (document: UI may need a reload/re-login; server enforcement is instant).
- [ ] **Step 5:** Rollback note: emergency = set `RBAC_DISABLED=true` in `.env.prod` + `up -d --no-deps web` (no redeploy).

---

# Phase 3 — Insights page: analytical view + extractable Reports

*Branch: `feat/insights-reports-2026-07`.*

### Task 3.1: Rename Analytics → Insights with two tabs

**Files:**
- Modify: `apps/web/components/layout/sidebar.tsx` (nav label "Analytics" → "Insights"; href stays `/dashboard/analytics`)
- Modify: `apps/web/app/dashboard/analytics/page.tsx` (wrap existing content as the "Insights" tab; add a "Reports" tab via `?tab=insights|reports`, following the Content Studio `?tab=` deep-link contract)

- [ ] **Step 1:** Add a two-tab header (`Tabs` component already in the design system); default tab `insights` renders the EXISTING page content unchanged; `reports` renders the new `<ReportsTab />` (Task 3.3). Read `?tab=` via `useSearchParams` inside a `<Suspense>` child (same pattern as `OAuthCallbackToaster`) so static generation isn't broken.
- [ ] **Step 2:** Build; verify the insights tab is byte-identical behavior (no query changes). Commit: `feat(insights): tabbed Insights page (analytics view + reports shell)`.

### Task 3.2: `analytics.postReports` query (both modes)

**Files:**
- Modify: `packages/api/src/routers/analytics.router.ts`

- [ ] **Step 1:** Add (mirroring the file's existing raw-SQL conventions — quoted camelCase columns, `Prisma.sql`):

```ts
postReports: orgProcedure
  .input(z.object({
    window: z.enum(["24h", "7d", "15d", "30d"]),
    mode: z.enum(["current", "at_age"]).default("current"),
    limit: z.number().min(1).max(1000).default(500),
  }))
  .query(async ({ ctx, input }) => {
    const hours = { "24h": 24, "7d": 168, "15d": 360, "30d": 720 }[input.window];
    const since = new Date(Date.now() - hours * 3_600_000);
    // latest-snapshot-per-target (proven pattern from engagement/perChannelStats),
    // optionally pinned to the at-age checkpoint tag written by the delayed jobs.
    const snapshotSel =
      input.mode === "current"
        ? Prisma.sql`SELECT s2.* FROM "AnalyticsSnapshot" s2 WHERE s2."postTargetId" = pt.id ORDER BY s2."snapshotAt" DESC LIMIT 1`
        : Prisma.sql`SELECT s2.* FROM "AnalyticsSnapshot" s2 WHERE s2."postTargetId" = pt.id AND s2.metadata->>'windowTag' = ${input.window} ORDER BY s2."snapshotAt" DESC LIMIT 1`;
    const rows = await ctx.prisma.$queryRaw<Array<{
      targetId: string; postId: string; contentPreview: string;
      channelName: string; platform: string;
      publishedAt: Date | null; publishedUrl: string | null;
      impressions: number | null; likes: number | null; comments: number | null;
      shares: number | null; reach: number | null; engagementRate: number | null;
      snapshotAt: Date | null;
    }>>(Prisma.sql`
      SELECT pt.id            AS "targetId",
             p.id             AS "postId",
             LEFT(p.content, 140) AS "contentPreview",
             c.name           AS "channelName",
             c.platform::text AS "platform",
             pt."publishedAt",
             pt."publishedUrl",
             s.impressions, s.likes, s.comments, s.shares, s.reach,
             s."engagementRate", s."snapshotAt"
      FROM "PostTarget" pt
      JOIN "Post" p     ON p.id = pt."postId"
      JOIN "Channel" c  ON c.id = pt."channelId"
      LEFT JOIN LATERAL (${snapshotSel}) s ON TRUE
      WHERE p."organizationId" = ${ctx.organizationId}
        AND pt.status::text = 'PUBLISHED'
        AND pt."publishedAt" IS NOT NULL
        AND pt."publishedAt" >= ${since}
      ORDER BY pt."publishedAt" DESC
      LIMIT ${input.limit}
    `);
    return { rows, window: input.window, mode: input.mode, generatedAt: new Date().toISOString() };
  }),
```

Stays `orgProcedure` (USER-allowed per matrix). Note in a code comment: "views" = `impressions` (YT/Threads map views there); Twitter metrics are zero on the free API tier; IG never fills clicks/shares.

- [ ] **Step 2:** `pnpm --filter @postautomation/api exec tsc --noEmit` → exit 0. Runtime-verify locally against seeded data (`pnpm db:seed`): call via the UI or a scratch tRPC call; expect rows for seeded published posts. Commit: `feat(insights): postReports query (current + at-age modes)`.

### Task 3.3: Reports tab UI + CSV export

**Files:**
- Create: `apps/web/components/analytics/ReportsTab.tsx`
- Create: `apps/web/lib/csv.ts`

- [ ] **Step 1:** `csv.ts` — pure, testable:

```ts
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [header.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2:** `ReportsTab.tsx` — window selector (24h/7d/15d/30d segmented control), mode toggle (`Current metrics` / `At publish-age` with a tooltip: "At-age data accrues for posts published after <ship date>; older posts show —"), a table (shadcn `Table`) with columns: Post (preview + link to `/dashboard/posts/[id]`), Channel, Platform, Published (UTC), Views/Impressions, Likes, Comments, Shares, Reach, Eng. %, Metric time; an Export CSV button:

```tsx
const { data, isLoading } = trpc.analytics.postReports.useQuery({ window: win, mode });
// export:
const onExport = () => {
  if (!data) return;
  downloadCsv(
    `postautomation-report-${win}-${mode}-${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(
      ["Post", "Channel", "Platform", "Published At (UTC)", "URL", "Views/Impressions", "Likes", "Comments", "Shares", "Reach", "Engagement %", "Metric captured at (UTC)"],
      data.rows.map((r) => [
        r.contentPreview, r.channelName, r.platform,
        r.publishedAt ? new Date(r.publishedAt).toISOString() : "",
        r.publishedUrl ?? "",
        r.impressions ?? "", r.likes ?? "", r.comments ?? "", r.shares ?? "",
        r.reach ?? "", r.engagementRate ?? "",
        r.snapshotAt ? new Date(r.snapshotAt).toISOString() : "",
      ])
    )
  );
};
```

Empty-metric cells render "—". Table wraps in `overflow-x-auto` (mobile). All dates displayed as UTC (analytics invariant).

- [ ] **Step 3:** Unit test `csv.ts` (quote-escaping, null handling) in `apps/web/lib/csv.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("escapes quotes and handles nulls", () => {
    expect(toCsv(["a", "b"], [['say "hi"', null], [1, "x,y"]]))
      .toBe('"a","b"\n"say ""hi""",""\n"1","x,y"');
  });
});
```

- [ ] **Step 4:** Build + commit: `feat(insights): Reports tab with window/mode selectors + CSV export`.

### Task 3.4: At-age checkpoints (mode b data source)

**Files:**
- Modify: `apps/worker/src/workers/post-publish.worker.ts` (after the :623-633 PUBLISHED write)
- Modify: the analytics-sync worker (`apps/worker/src/workers/` — the worker consuming `QUEUE_NAMES.ANALYTICS_SYNC`)

- [ ] **Step 1:** At publish success (right after the postTarget PUBLISHED update, next to `notifyPublishOutcome`), enqueue four delayed one-shot snapshot jobs:

```ts
// At-age metric checkpoints for the Insights → Reports "at publish-age" mode.
// jobId dedupes retries; delayed jobs are exact-at-window (vs the ±6h cron).
const AT_AGE_WINDOWS: Record<string, number> = {
  "24h": 86_400_000, "7d": 604_800_000, "15d": 1_296_000_000, "30d": 2_592_000_000,
};
for (const [windowTag, delay] of Object.entries(AT_AGE_WINDOWS)) {
  await analyticsSyncQueue.add(
    "at-age-snapshot",
    { postTargetId: target.id, windowTag },
    { delay, jobId: `atage:${target.id}:${windowTag}`, removeOnComplete: true, removeOnFail: true }
  );
}
```

(Import/reuse the same queue handle `scheduleAnalyticsSync` uses; match its job-payload shape and add the optional `windowTag` field.)

- [ ] **Step 2:** In the analytics-sync worker's job handler: accept optional `windowTag`; after fetching metrics via the provider, write the snapshot with `metadata: { windowTag }` (plain `create`, same as existing writes). For `windowTag` jobs, ALLOW `FACEBOOK` targets (these are 4 one-shot calls per post — negligible vs the quota concern that excluded FB from the 6-hourly cron; keep FB excluded from the cron itself).
- [ ] **Step 3:** Verify locally: publish a test post, then manually add an `at-age-snapshot` job with `delay: 5_000`; after 5s confirm a new `AnalyticsSnapshot` row exists with `metadata->>'windowTag'` set, and `postReports({mode:"at_age"})` returns it.
- [ ] **Step 4:** Commit: `feat(insights): delayed at-age snapshot checkpoints (24h/7d/15d/30d) tagged in snapshot metadata`.

### Task 3.5: Deploy + verify Phase 3

- [ ] **Step 1:** PR → merge → deploy.
- [ ] **Step 2:** Prod: Insights tab renders identically to old Analytics; Reports (current mode) lists recent posts with metrics; CSV downloads and opens in Excel/Sheets with correct columns; at-age mode shows "—" (expected — data accrues from now).
- [ ] **Step 3:** 24h later: a post published after deploy shows its `24h` at-age row. (Manual check; note in ops calendar.)

---

# Phase 4 — Publish notification email (redesign of the existing report email)

*Branch: `feat/publish-email-creator-2026-07`.*

### Task 4.1: Redesign `sendPublishReportEmail`

**Files:**
- Modify: `apps/worker/src/workers/post-publish.worker.ts:28-143` (the function) — keep both call sites (:683 success, :806 failure) untouched.

- [ ] **Step 1:** Change the recipient from org OWNER/ADMIN broadcast to the **post creator**: replace the `organizationMember.findMany` block (~:36-39) with:

```ts
const post = await prisma.post.findUnique({
  where: { id: postId },
  select: { createdById: true },
});
const creator = post?.createdById
  ? await prisma.user.findUnique({ where: { id: post.createdById }, select: { email: true, name: true } })
  : null;
if (!creator?.email) {
  console.warn(`[publish-email] post ${postId} has no resolvable creator email — skipping`);
  return;
}
const recipients = [creator];
```

- [ ] **Step 2:** Add an `escapeHtml` helper at module top and route EVERY user-controlled interpolation through it (post content/title at :88, channel names, and URLs via `encodeURI` on `t.url`):

```ts
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
```

- [ ] **Step 3:** Rework the HTML body into a per-channel table — for each target: Channel name, Platform, Status (✅ Published / ❌ Failed + sanitized error), Published at (`YYYY-MM-DD HH:mm UTC` **and** IST via `toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })`), and a "View post" link using `target.publishedUrl` (fallback: `${APP_URL}/dashboard/posts/${postId}`). Subject:

```ts
const ok = allTargets.filter((t) => t.status === "PUBLISHED").length;
const subject = `${ok === allTargets.length ? "✅ Published" : ok > 0 ? "⚠️ Partially published" : "❌ Publish failed"}: "${postContent.slice(0, 60)}${postContent.length > 60 ? "…" : ""}" — ${ok}/${allTargets.length} channel(s)`;
```

- [ ] **Step 4:** Confirm the function stays **non-fatal**: the send is wrapped in try/catch (or `.catch`) so an SMTP failure can never fail the publish job, and the no-SMTP console fallback stays.
- [ ] **Step 5:** Commit: `feat(email): publish notification to post creator — per-channel rows, timestamps (UTC+IST), URLs, HTML-escaped`.

### Task 4.2: Test

**Files:**
- Create: `apps/worker/src/__tests__/publish-email.test.ts` (or the worker package's existing test dir convention)

- [ ] **Step 1:** Extract the pure template builder (`buildPublishEmailHtml(post, targets)`) so it's testable without SMTP; assert: (a) `<script>` in post content arrives as `&lt;script&gt;`, (b) each PUBLISHED target contributes a row with its `publishedUrl`, (c) subject counts `ok/total` correctly, (d) failed targets render the failure row. Real assertions, mock data inline.
- [ ] **Step 2:** `pnpm --filter @postautomation/worker test` → green. Commit: `test(email): publish email template escaping + per-channel rows`.

### Task 4.3: Deploy + live verification

- [ ] **Step 1:** PR → merge → deploy.
- [ ] **Step 2:** Publish a real test post (compose → publish now) from a test account → creator's inbox receives one email with correct channel rows, timestamps, working URLs. Org admins do NOT receive it (recipient change verified).
- [ ] **Step 3:** Volume note (flag to owner, no code): Gmail app-password SMTP caps ~500 sends/day — fine at current volume; revisit (Resend) if publishing scales.

---

## Rollout order & rollback matrix

| Order | Phase | Rollback |
|---|---|---|
| 1 | Phase 0 edge reliability | revert commit + redeploy + force-recreate nginx |
| 2 | Phase 1 schema+backfill | column is additive/inert; no rollback needed |
| 3 | Phase 2 RBAC gates | **env kill switch:** `RBAC_DISABLED=true` in `.env.prod` + `up -d --no-deps web` (instant, no redeploy); or revert PR |
| 4 | Phase 3 insights/reports | additive; revert PR if needed |
| 5 | Phase 4 publish email | revert PR (old broadcast email returns) |

## Risk register / known caveats

- **UI role staleness:** server gates are per-request fresh (JWT callback DB re-read); the client `useSession()` nav may lag until reload/re-login after a role change. Documented in /admin UI copy.
- **Twitter metrics are 0** on the free API tier (analytics 403) — Reports will show zeros/— for TW; label, don't "fix".
- **IG never exposes clicks/shares; FB cron sync is quota-excluded** (at-publish + at-age checkpoints only). At-age mode starts empty for posts published before Phase 3 ships.
- **`bulk.router` org-scoping gap** (protectedProcedure + org from input) — pre-existing; flagged with TODO in Task 2.3, fix as separate security PR.
- **SMTP:** already live in this repo (web+worker). The `apps/api/.env` pointer belongs to the other (Dashmani platform) repo — only relevant if a different sender identity is wanted (ops copies values into `.env.prod`).
- Impersonation flow forces `isSuperAdmin:false` on the swapped identity — `appRole` follows the *target* user naturally (correct behavior; verify in Task 2.9 smoke if impersonation is used).
