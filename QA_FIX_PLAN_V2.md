# PostAutomation — QA Fix Plan v2 (Final)

**Supersedes:** [QA_FIX_PLAN.md](QA_FIX_PLAN.md)
**Verified against HEAD:** `6b20acd` on `main` (2026-05-26)
**Author of plan:** Opus 4.7 (1M)
**Intended executor:** Sonnet 4.6, medium effort, no thinking
**Status of v1 plan:** ~80% of v1 items already shipped between f7a47e5 and 6b20acd.

> **STATUS — 2026-05-26: ALL MODULES IMPLEMENTED.**
> Every module below has been executed in this commit. See the per-section status banners. `pnpm` type-checks for `@postautomation/api`, `@postautomation/auth`, `@postautomation/social`, `@postautomation/worker`, and `@postautomation/web` all pass clean.

---

## How to use this plan

Each fix below is self-contained and ordered by user-visible blast radius. For each fix you will find:

- **File(s):** absolute paths and line numbers as of HEAD.
- **Problem:** one-line description.
- **Change:** exact code change.
- **Acceptance:** how to know it's done.

Do them in the order presented. After every module run:
```bash
pnpm type-check && pnpm lint
```

Do **not** combine unrelated fixes in the same commit.

---

# Part 1 — Verification of QA_FIX_PLAN.md v1

## ✅ Already shipped (no action needed)

| v1 # | Item | Where confirmed |
|------|------|-----------------|
| 0.1 | `humanizeError` helper | `apps/web/lib/errors.ts:1-35` |
| 0.2 | `useCurrentOrgId` hook | `apps/web/lib/org.ts` |
| 0.3 | `webhookUrlSchema` SSRF guard | `packages/api/src/lib/url-safety.ts` |
| 1 | RBAC role on session + sidebar role filter | `packages/auth/src/config.ts`, `apps/web/components/layout/sidebar.tsx:114-115` |
| 3 | No more `err.message` in toasts (zero grep hits) | sweep verified across `apps/web/` |
| 4 | Sidebar double-highlight fixed via role filter | `apps/web/components/layout/sidebar.tsx` |
| 19 | OAuth env var guard in TRPC + callback | `packages/api/src/routers/channel.router.ts:83-89`, `apps/web/app/api/oauth/callback/[provider]/route.ts:75-82` |
| 20 | Channel group create returns channels | `packages/api/src/routers/channel-group.router.ts:28-31` |
| 22 | Non-final publish attempts no longer re-set PUBLISHING | `apps/worker/src/workers/post-publish.worker.ts:536-542` |
| 24 | `Use in Post` uses sessionStorage | `apps/web/components/content-agent/GenerateTab.tsx:206-208` |
| 25 | CSV "ALL" filter literal removed | `packages/api/src/routers/bulk.router.ts:242-243` |
| 26 | CSV uses `\r\n` + UTF-8 BOM | `packages/api/src/routers/bulk.router.ts:289` |
| 27 | All CSV fields escaped | `packages/api/src/routers/bulk.router.ts:267-280` |
| 28 | papaparse installed and used for import | `packages/api/package.json:26`, `bulk.router.ts:5,127` |
| 34 | Empty-state CTAs link to channels | `apps/web/app/dashboard/analytics/page.tsx:237-239,426-430` |
| 36 | Chart tooltip clipping fix | `apps/web/app/dashboard/analytics/page.tsx:211,223-224` |
| 37/38/39 | Media lightbox + video controls | `apps/web/app/dashboard/media/page.tsx:212,296-342` |
| 40/41 | RSS placeholder fixed + help text | `apps/web/app/dashboard/rss/page.tsx:178,182-186` |
| 42/43 | RSS URL validated as RSS/Atom | `packages/api/src/routers/rss.router.ts:36-56` |
| 44/46 | `localStorage` org-id removed | RSS/Links pages |
| 47/50/55 | Workflow Alert blocks added | autopilot/trending/newsgrid pages |
| 52 | `Run Pipeline` reflects real RUNNING state | `apps/web/app/dashboard/autopilot/page.tsx:134-138` |
| 54 | `deleteLogo` nulls out `channel.metadata.logo_path` | `packages/api/src/routers/newsgrid.router.ts:597-614` |
| 56 | loremflickr replaced with local `/newsgrid-bg/*` | `apps/web/app/dashboard/newsgrid/page.tsx:135-137` |
| 62 | Sidebar says "Brand Outreach" | `apps/web/components/layout/sidebar.tsx:66` |
| 67 | `exportForClaude` redacts tokens/PII | `packages/api/src/routers/monitor.router.ts:200-225` |
| 69/70/71 | Email invitation flow (`OrganizationInvite` + `/invite/[token]`) | `packages/api/src/routers/team.router.ts:24-109`, `schema.prisma:163-178` |
| 72 | `transferOwnership` mutation | `packages/api/src/routers/team.router.ts:214` |
| 73/74 | Versions: DB is source of truth | `packages/api/src/routers/deployment.router.ts:44-54` |
| 75 | Rollback DB-only with honest banner | `apps/web/app/dashboard/settings/versions/page.tsx:103-109` |
| 76/77 | Audit-log column widths + ID hover | `apps/web/app/dashboard/settings/audit-log/page.tsx:320-369` |
| 78/79 | Audit-log writes in webhook/rss/user; `console.error` on catch | `webhook.router.ts:34-44`, `rss.router.ts:76-80`, `user.router.ts:36-45` |
| 80 | OpenAPI gated on OWNER/ADMIN or `EXPOSE_OPENAPI` | `apps/web/app/api/openapi/route.ts:5-23` |
| 81 | Expand All also expands procedures | `apps/web/app/dashboard/settings/api-docs/page.tsx:819-829` |
| 87 | API key cleared after copy | `apps/web/app/dashboard/settings/api-keys/page.tsx:42-45` |
| 88/90/91 | Webhook URL uses `webhookUrlSchema` | `packages/api/src/routers/webhook.router.ts:20` |
| 89 | Webhook toast uses `humanizeError` | `apps/web/app/dashboard/settings/webhooks/page.tsx:38` |
| 94 | Profile update reconciles state + session | `apps/web/app/dashboard/settings/page.tsx:40-44` |
| 95 | Phone removal requires OTP | `apps/web/app/dashboard/settings/page.tsx:382-396`, `packages/api/src/routers/user.router.ts:202-248` |

## ❌ Still outstanding from v1

| v1 # | Item | Status |
|------|------|--------|
| 30 | Post-publish watchdog worker | **MISSING** — no `post-publish-watchdog.worker.ts` |
| 33 | SuperAgent capability list sync | **PARTIAL** — `CAPABILITY_ICONS` lookup has 8 entries; backend `SUPPORTED_ACTIONS` has 13+. No `chat.capabilities` TRPC query. |
| 45 | Richer short-link analytics | **PARTIAL** — only clicks/referers/countries; no CTR / device / browser / OS / heatmap |
| 68 | N+1 query in approvals enrichment | **NOT FIXED** — still loops `prisma.post.findUnique` per request |
| 82 | OpenAPI error-responses section | **NOT VERIFIED** — needs check in `packages/api/src/openapi/generate-spec.ts` |
| 83 | Example outputs for select procedures | **NOT VERIFIED** |
| 85 | Centralised enum lists | **NOT VERIFIED** |
| 86 | OpenAPI rate-limit section | **NOT VERIFIED** |
| 93 | In-app payment-method card | **PARTIAL** — only Stripe portal link |
| 96 | Avatar upload UI | **NOT IMPLEMENTED** |

## ➕ Newly discovered issues (not in v1)

| # | Issue | Severity |
|---|-------|----------|
| N1 | Two production domains (`postautomation.in` AND `postautomation.co.in`) served by nginx with no canonical redirect → Google OAuth fails with "Server error" when user starts on the non-canonical domain. | **CRITICAL — user is blocked** |
| N2 | `packages/auth/src/config.ts` has no `trustHost: true`. NextAuth v5 rejects Host headers in production. | CRITICAL |
| N3 | `.env.production.example` defines `APP_URL` but no `AUTH_URL` / `NEXTAUTH_URL`. NextAuth v5 cannot resolve canonical URL without it. | CRITICAL |
| N4 | No custom NextAuth `pages.error` page. Users see default black "Server error" with no recovery affordance. | HIGH |
| N5 | `apps/web/app/dashboard/channels/page.tsx` never reads `?error=…` / `?success=…` from the OAuth callback redirect. Silent failure after Google bounce. | HIGH |
| N6 | `packages/social/src/providers/twitter.provider.ts:34-35` still uses `process.env.TWITTER_CLIENT_ID ?? ""` silent fallback. | LOW |
| N7 | Module guide blocks missing on Media, Listening, Approvals, Brand Leads, Campaigns, Autopilot Agents, Billing, Audit Log, Versions. | MEDIUM |
| N8 | `apps/web/app/api/openapi/route.ts` redirects to `/api/auth/signin` for unauth — should return 401 JSON. | LOW |
| N9 | `docker/Dockerfile.worker` fails to build (`pixman-1` missing for `canvas@2.11.2`). Documented in CLAUDE.md as a known issue. | MEDIUM |

---

# Part 2 — Fix Plan (execute in order)

## Module 0 — CRITICAL: Fix the OAuth/domain issue (N1–N5) — ✅ DONE

The user reported being redirected from `https://postautomation.in` to `https://postautomation.co.in` with a "Server error: There is a problem with the server configuration" message. Pick `postautomation.co.in` as the canonical domain (it already owns Google OAuth, sitemap, robots, layout metadata, and SMTP From).

### Fix 0.1 — NextAuth `trustHost` and canonical URL

**File:** `packages/auth/src/config.ts`

Add `trustHost: true` and a custom error page. Insert before the closing `}` of `authConfig` (currently at line 236):

```ts
  trustHost: true,
  pages: {
    signIn: "/login",
    newUser: "/register",
    error: "/auth/error",
  },
```

(Replace the existing `pages: { signIn, newUser }` block at lines 232-235 with the version above — same content plus `error`.)

**Acceptance:** `grep "trustHost" packages/auth/src/config.ts` returns a hit; `pages.error` is set.

### Fix 0.2 — Custom auth error page

**File:** create `apps/web/app/auth/error/page.tsx`

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";

const ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
  Configuration: {
    title: "Configuration error",
    description:
      "The sign-in service is not fully configured. Please contact support or try a different sign-in method.",
  },
  AccessDenied: {
    title: "Access denied",
    description: "Your account does not have permission to sign in here.",
  },
  Verification: {
    title: "Verification failed",
    description: "The verification link has expired or already been used.",
  },
  OAuthSignin: {
    title: "Sign-in failed",
    description: "We couldn't reach the sign-in provider. Please try again.",
  },
  OAuthCallback: {
    title: "Sign-in callback failed",
    description: "The sign-in provider returned an unexpected response.",
  },
  OAuthAccountNotLinked: {
    title: "Account already exists",
    description:
      "An account with this email already exists. Sign in with the original method and link this provider from your account settings.",
  },
  Default: {
    title: "Sign-in problem",
    description: "Something went wrong while signing you in. Please try again.",
  },
};

function ErrorContent() {
  const params = useSearchParams();
  const code = params.get("error") ?? "Default";
  const info = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.Default!;
  return (
    <div className="mx-auto max-w-md space-y-6 rounded-xl border bg-card p-8 text-center shadow-sm">
      <h1 className="text-2xl font-bold">{info.title}</h1>
      <p className="text-muted-foreground">{info.description}</p>
      <div className="flex justify-center gap-3">
        <Link
          href="/login"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Back to sign in
        </Link>
        <Link
          href="/"
          className="rounded-md border px-4 py-2 text-sm font-medium"
        >
          Home
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">Error code: {code}</p>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Suspense fallback={null}>
        <ErrorContent />
      </Suspense>
    </main>
  );
}
```

**Acceptance:** navigating to `/auth/error?error=Configuration` shows a styled card with "Configuration error" — not the default black page.

### Fix 0.3 — Add `AUTH_URL` to env templates

**File:** `.env.production.example`

After line `APP_URL=https://postautomation.co.in` (line 17), add:

```bash
# NextAuth v5 — both keys must equal the canonical public URL
AUTH_URL=https://postautomation.co.in
NEXTAUTH_URL=https://postautomation.co.in
AUTH_TRUST_HOST=true
```

**File:** `.env.example`

After the existing `NEXTAUTH_URL=http://localhost:3000` line, add:

```bash
AUTH_URL=http://localhost:3000
AUTH_TRUST_HOST=true
```

**Acceptance:** `grep -E "AUTH_URL|AUTH_TRUST_HOST" .env.example .env.production.example` returns hits in both files.

### Fix 0.4 — Nginx: canonicalize `.in` → `.co.in`

**File:** `docker/nginx/nginx.conf`

Find the second HTTPS server block that handles `postautomation.in` (around lines 234-402). REPLACE its entire body with a 301 redirect to `.co.in`:

```nginx
server {
    listen 443 ssl http2;
    server_name postautomation.in www.postautomation.in;

    ssl_certificate /etc/letsencrypt/live/postautomation.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/postautomation.in/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Canonicalize .in → .co.in (preserves path + query)
    return 301 https://postautomation.co.in$request_uri;
}
```

Also in the HTTP block (around line 58) make sure `postautomation.in` and `www.postautomation.in` are listed in `server_name` so HTTP→HTTPS still works for both. Then after the redirect they end up on `.co.in`.

**Acceptance:** `curl -I https://postautomation.in/dashboard` returns `301` with `Location: https://postautomation.co.in/dashboard`.

### Fix 0.5 — Make channels page surface OAuth callback errors (N5)

**File:** `apps/web/app/dashboard/channels/page.tsx`

1. Add `useSearchParams` + `useRouter` imports at the top:
   ```tsx
   import { useEffect } from "react";
   import { useSearchParams, useRouter } from "next/navigation";
   ```
2. After `const { toast } = useToast();` (around line 48), add:
   ```tsx
   const searchParams = useSearchParams();
   const router = useRouter();

   useEffect(() => {
     const errorCode = searchParams.get("error");
     const successCode = searchParams.get("success");
     const platform = searchParams.get("platform");
     if (errorCode) {
       const messages: Record<string, string> = {
         platform_not_configured: `${platform ?? "This platform"} is not configured by the admin. Please contact support.`,
         oauth_failed: "The sign-in to the platform failed. Please try again.",
         missing_params: "The platform did not return required parameters. Please try again.",
         auth_session_mismatch: "Your session expired during sign-in. Please sign in again and retry.",
       };
       toast({
         title: "Could not connect",
         description: messages[errorCode] ?? "Could not connect the channel. Please try again.",
         variant: "destructive",
       });
       router.replace("/dashboard/channels");
     } else if (successCode === "connected") {
       toast({ title: "Channel connected", description: `${platform ?? "Channel"} added successfully.` });
       router.replace("/dashboard/channels");
       void refetch();
     }
   }, [searchParams, router, refetch, toast]);
   ```
3. Wrap `useEffect` so it does NOT run when the params are absent (the guard above already does this).

**Acceptance:** opening `/dashboard/channels?error=platform_not_configured&platform=twitter` shows a destructive toast and removes the query string from the URL.

### Fix 0.6 — Twitter provider hygiene (N6)

**File:** `packages/social/src/providers/twitter.provider.ts:34-35`

Replace:
```ts
key: process.env.TWITTER_CLIENT_ID ?? "",
secret: process.env.TWITTER_CLIENT_SECRET ?? "",
```
with:
```ts
key: process.env.TWITTER_CLIENT_ID ?? (() => { throw new Error("TWITTER_CLIENT_ID is not configured"); })(),
secret: process.env.TWITTER_CLIENT_SECRET ?? (() => { throw new Error("TWITTER_CLIENT_SECRET is not configured"); })(),
```

**Acceptance:** initialising the provider without env vars throws — the channel.router/callback guards run before this, so production users still see the friendly toast from Fix 0.5.

### Fix 0.7 — Deployment runbook for the OAuth fix

After deploying the above, on the server:

```bash
ssh posting-automation
cd /home/deploy/postautomation

# 1. Append the new env vars
cat >> .env.prod <<'EOF'
AUTH_URL=https://postautomation.co.in
NEXTAUTH_URL=https://postautomation.co.in
AUTH_TRUST_HOST=true
EOF

# 2. Recreate the symlink if needed
ln -sf .env.prod .env.production

# 3. Rebuild + redeploy
bash scripts/deploy.sh deploy

# 4. Reload nginx in its container
docker exec postautomation-nginx-1 nginx -s reload

# 5. Verify
curl -I https://postautomation.in/dashboard
# expect: 301 Location: https://postautomation.co.in/dashboard

# 6. In Google Cloud Console (https://console.cloud.google.com/apis/credentials),
#    ensure the OAuth 2.0 Client has exactly these authorised redirect URIs:
#    - https://postautomation.co.in/api/auth/callback/google
#    - http://localhost:3000/api/auth/callback/google  (for local dev)
```

**Acceptance:** signing in via Google on `https://postautomation.in/login` redirects to `.co.in/login`, completes OAuth, and lands on `/dashboard` with no error page.

---

## Module 1 — Post-publish watchdog (v1 #30) — ✅ ALREADY DONE

> Watchdog was already implemented as `watchdogPublishingPosts()` in [apps/worker/src/scheduler/cron-jobs.ts:416-446](apps/worker/src/scheduler/cron-jobs.ts#L416-L446) and runs every 5 minutes via `startCronJobs()`. Original verification missed it because the implementation lives in the scheduler rather than as a standalone worker file. Behaviour matches Module 1 spec: posts `PUBLISHING` for >30 min have their post-level status reconciled from target statuses, or marked FAILED if non-terminal.

### Fix 1.1 — Create watchdog worker

**File:** create `apps/worker/src/workers/post-publish-watchdog.worker.ts`

```ts
import { Worker } from "bullmq";
import { prisma } from "@postautomation/db";
import { logger } from "@postautomation/logger";
import { connection, QUEUE_NAMES } from "@postautomation/queue";

const STUCK_THRESHOLD_MIN = 30;

export const postPublishWatchdogWorker = new Worker(
  QUEUE_NAMES.POST_PUBLISH_WATCHDOG,
  async () => {
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MIN * 60_000);
    const stuck = await prisma.post.findMany({
      where: { status: "PUBLISHING", updatedAt: { lt: cutoff } },
      include: { targets: true },
    });

    for (const post of stuck) {
      const allTerminal = post.targets.every((t) =>
        ["PUBLISHED", "FAILED"].includes(t.status)
      );
      const anySuccess = post.targets.some((t) => t.status === "PUBLISHED");

      if (allTerminal) {
        await prisma.post.update({
          where: { id: post.id },
          data: { status: anySuccess ? "PUBLISHED" : "FAILED" },
        });
        logger.info("watchdog_resolved", { postId: post.id, anySuccess });
      } else {
        // Targets still pending — flip to FAILED to break the loop; the
        // operator can re-queue manually.
        await prisma.post.update({
          where: { id: post.id },
          data: { status: "FAILED" },
        });
        logger.warn("watchdog_force_failed", {
          postId: post.id,
          targetStates: post.targets.map((t) => t.status),
        });
      }
    }
  },
  { connection }
);
```

### Fix 1.2 — Register the queue + repeatable job

**File:** `packages/queue/src/index.ts` (or wherever `QUEUE_NAMES` is defined)

Add to `QUEUE_NAMES`:
```ts
POST_PUBLISH_WATCHDOG: "post-publish-watchdog",
```

Also export a `postPublishWatchdogQueue` instance:
```ts
import { Queue } from "bullmq";
export const postPublishWatchdogQueue = new Queue(QUEUE_NAMES.POST_PUBLISH_WATCHDOG, { connection });
```

### Fix 1.3 — Boot the worker + schedule the recurring job

**File:** `apps/worker/src/index.ts`

1. Import the worker:
   ```ts
   import { postPublishWatchdogWorker } from "./workers/post-publish-watchdog.worker";
   ```
2. Reference it in the workers array so it boots.
3. At startup, schedule the repeatable job:
   ```ts
   import { postPublishWatchdogQueue } from "@postautomation/queue";
   await postPublishWatchdogQueue.add(
     "tick",
     {},
     { repeat: { pattern: "*/5 * * * *" }, removeOnComplete: true, removeOnFail: true }
   );
   ```

**Acceptance:** kill the worker mid-publish on a test post, restart it; within 5 minutes the post leaves `PUBLISHING`.

---

## Module 2 — SuperAgent capability sync (v1 #33) — ✅ ALREADY DONE

> The capabilities query was already wired: `SUPPORTED_ACTIONS` (with label, description, color) is exported from [packages/api/src/routers/chat.router.ts:7-21](packages/api/src/routers/chat.router.ts) and exposed via the `chat.capabilities` query at [chat.router.ts:25-32](packages/api/src/routers/chat.router.ts#L25-L32). The Super Agent page renders from `trpc.chat.capabilities.useQuery()` at [super-agent/page.tsx:91](apps/web/app/dashboard/super-agent/page.tsx#L91), iterating at [page.tsx:424](apps/web/app/dashboard/super-agent/page.tsx#L424).

### Fix 2.1 — Backend exports capability metadata

**File:** `packages/api/src/routers/chat.router.ts`

Near the `SUPPORTED_ACTIONS` const (around line 156-161), add (or extend) a metadata block + a TRPC query:

```ts
export const CAPABILITY_META: Record<
  string,
  { label: string; description: string }
> = {
  create_post: { label: "Create a post", description: "Draft a single post for any connected channel." },
  schedule_post: { label: "Schedule a post", description: "Schedule drafts to publish at a specific time." },
  bulk_generate: { label: "Bulk generate", description: "Generate multiple posts from prompts or topics." },
  analyze_channel: { label: "Analyze a channel", description: "Summarise engagement and audience metrics." },
  generate_image: { label: "Generate an image", description: "Create images for posts via AI providers." },
  trending_topics: { label: "Trending topics", description: "Find trending topics in your niche." },
  rss_to_post: { label: "RSS → Post", description: "Convert an RSS feed item into a post draft." },
  short_link: { label: "Shorten a link", description: "Create a trackable short link." },
  approve_post: { label: "Approve a post", description: "Approve a post that is waiting for review." },
  brand_outreach: { label: "Brand outreach", description: "Detect brand opportunities and queue outreach." },
  listening_query: { label: "Listening query", description: "Create a listening query for brand mentions." },
  team_invite: { label: "Invite teammate", description: "Send an org invite by email." },
  pipeline_run: { label: "Run autopilot", description: "Kick off the autopilot pipeline." },
};

// inside the chatRouter:
capabilities: orgProcedure.query(() => {
  return SUPPORTED_ACTIONS.map((action) => ({
    action,
    label: CAPABILITY_META[action]?.label ?? action,
    description: CAPABILITY_META[action]?.description ?? "",
  }));
}),
```

(If `SUPPORTED_ACTIONS` is not exported, export it as `export const SUPPORTED_ACTIONS = [...] as const;`.)

### Fix 2.2 — Frontend renders from backend

**File:** `apps/web/app/dashboard/super-agent/page.tsx:53-68`

Replace the hardcoded `CAPABILITY_ICONS` map / capabilities array with a TRPC query:

```tsx
const { data: capabilities } = trpc.chat.capabilities.useQuery();
// ... in the JSX welcome panel:
{capabilities?.map((cap) => (
  <div key={cap.action} className="rounded-lg border p-3">
    <p className="text-sm font-medium">{cap.label}</p>
    <p className="text-xs text-muted-foreground">{cap.description}</p>
  </div>
))}
```

Keep the `CAPABILITY_ICONS` lookup as a UI-only icon map (no labels/descriptions there).

**Acceptance:** adding a new action key to `SUPPORTED_ACTIONS` + `CAPABILITY_META` makes it appear in the welcome panel without touching the page.

---

## Module 3 — Approvals N+1 (v1 #68) — ✅ DONE

### Fix 3.1 — Single batched fetch

**File:** `packages/api/src/routers/approval.router.ts:250-269`

Replace the per-request `Promise.all([...findUnique, findUnique])` loop with batched queries:

```ts
const postIds = approvalRequests.map((r) => r.postId);
const requesterIds = approvalRequests.map((r) => r.requestedById);

const [posts, requesters] = await Promise.all([
  ctx.prisma.post.findMany({
    where: { id: { in: postIds } },
    include: { targets: true }, // match existing include shape
  }),
  ctx.prisma.user.findMany({
    where: { id: { in: requesterIds } },
    select: { id: true, name: true, email: true, image: true },
  }),
]);

const postById = new Map(posts.map((p) => [p.id, p]));
const userById = new Map(requesters.map((u) => [u.id, u]));

const enriched = approvalRequests.map((req) => ({
  ...req,
  post: postById.get(req.postId) ?? null,
  requester: userById.get(req.requestedById) ?? null,
}));
```

**Acceptance:** approvals list loads in 2 SQL round-trips instead of 1 + 2N.

---

## Module 4 — Module guide blocks (N7) — ✅ DONE

Each fix below inserts a single `<Alert variant="info">` block under the page title. The shared `Alert` component is at `apps/web/components/ui/alert.tsx`. Reuse the existing `Info` icon from `lucide-react`.

### Fix 4.1 — Media guide

**File:** `apps/web/app/dashboard/media/page.tsx` — directly under the header (search for `Upload and manage your media files`).

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>How Media works</AlertTitle>
  <AlertDescription>
    Upload images, videos, or GIFs to use across your posts. Click a tile to preview at full size.
    Files are stored privately to your organisation; deleting a file does not affect already-published posts.
  </AlertDescription>
</Alert>
```

### Fix 4.2 — Listening guide

**File:** `apps/web/app/dashboard/listening/page.tsx` — under the header subtitle (around line 175).

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>How Listening works</AlertTitle>
  <AlertDescription>
    Create a query of keywords + platforms to monitor. The system polls each platform on a schedule and
    captures mentions with sentiment. Sync now to refresh; open Alerts to be notified of spikes.
  </AlertDescription>
</Alert>
```

### Fix 4.3 — Approvals guide

**File:** `apps/web/app/dashboard/approvals/page.tsx` — under the header (around line 141).

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>How Approvals work</AlertTitle>
  <AlertDescription>
    Posts created by Autopilot, scheduled content, or teammates with restricted roles land here for review.
    Approve to send them to the publishing queue, or reject with a comment to send them back for edits.
  </AlertDescription>
</Alert>
```

### Fix 4.4 — Brand Leads guide

**File:** `apps/web/app/dashboard/brand-leads/page.tsx` — under the header (around line 434).

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>How Brand Outreach works</AlertTitle>
  <AlertDescription>
    Celebrity and brand mentions are detected automatically from your listening queries and campaigns.
    Each lead shows a signal score; approve high-confidence leads to queue personalised outreach DMs.
  </AlertDescription>
</Alert>
```

### Fix 4.5 — Campaigns guide

**File:** `apps/web/app/dashboard/campaigns/page.tsx` — under the header (around line 191).

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>How Campaigns work</AlertTitle>
  <AlertDescription>
    Track brands you want to follow, the influencers around them, and the content they release.
    Use the Brands tab to add a brand; the system will surface relevant posts in the Content tab.
  </AlertDescription>
</Alert>
```

### Fix 4.6 — Autopilot Agents guide

**File:** `apps/web/app/dashboard/autopilot/agents/page.tsx` — at the top of the main render.

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>How Agents work</AlertTitle>
  <AlertDescription>
    Agents are reusable templates that drive Autopilot runs: each agent has a persona, a list of topics,
    and channel targets. Toggle an agent Active to include it in the next pipeline run.
  </AlertDescription>
</Alert>
```

### Fix 4.7 — Billing guide

**File:** `apps/web/app/dashboard/settings/billing/page.tsx` — under the subtitle.

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>How Billing works</AlertTitle>
  <AlertDescription>
    Your subscription is managed through Stripe. Click "Manage Billing" to update card, change plan, or
    download invoices. Plan changes take effect immediately; downgrades are prorated.
  </AlertDescription>
</Alert>
```

### Fix 4.8 — Audit Log guide

**File:** `apps/web/app/dashboard/settings/audit-log/page.tsx` — under the header.

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>About the audit log</AlertTitle>
  <AlertDescription>
    Every significant action (invites, role changes, channel connects, billing events) is recorded with
    actor, timestamp, IP, and target. Use the filters to narrow by user or action; entries are immutable.
  </AlertDescription>
</Alert>
```

### Fix 4.9 — Versions guide

**File:** `apps/web/app/dashboard/settings/versions/page.tsx` — under the header.

```tsx
<Alert>
  <Info className="h-4 w-4" />
  <AlertTitle>About Versions</AlertTitle>
  <AlertDescription>
    Each deploy is recorded here with commit SHA and timestamp. Use Rollback to mark a prior version as
    active; the deploy script on the server completes the actual revert.
  </AlertDescription>
</Alert>
```

**Acceptance:** all nine pages render an info Alert with workflow guidance under the page title.

---

## Module 5 — Avatar upload (v1 #96) — ✅ DONE

### Fix 5.1 — Backend route

**File:** create `apps/web/app/api/upload/avatar/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth"; // or wherever the v5 session helper lives
import { uploadToStorage } from "@postautomation/api"; // existing storage helper

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  if (!ALLOWED.has(file.type)) return NextResponse.json({ error: "bad_type" }, { status: 415 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = file.type.split("/")[1];
  const key = `avatars/${(session.user as any).id}-${Date.now()}.${ext}`;
  const url = await uploadToStorage(key, buffer, file.type);
  return NextResponse.json({ url });
}
```

If `uploadToStorage` does not exist under that name, search `packages/api/src/lib/` for the existing S3/MinIO helper (likely `storage.ts` or `media.ts`) and import accordingly.

### Fix 5.2 — Settings page UI

**File:** `apps/web/app/dashboard/settings/page.tsx`

Around the avatar display (line 152-161), add a hidden file input and click handler:

```tsx
const fileInputRef = useRef<HTMLInputElement>(null);
const { update } = useSession();
const uploading = useRef(false);

async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  if (!file || uploading.current) return;
  uploading.current = true;
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/upload/avatar", { method: "POST", body: form });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "" }));
      throw new Error(
        error === "too_large" ? "Image is larger than 2 MB."
        : error === "bad_type" ? "Only PNG, JPEG, or WebP."
        : "Upload failed. Please try again."
      );
    }
    const { url } = await res.json();
    await updateProfile.mutateAsync({ image: url });
    await update?.();
    toast({ title: "Avatar updated" });
  } catch (err) {
    toast({ title: "Upload failed", description: humanizeError(err), variant: "destructive" });
  } finally {
    uploading.current = false;
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
}
```

In the avatar JSX, wrap the avatar in a clickable button:

```tsx
<button type="button" onClick={() => fileInputRef.current?.click()} className="group relative">
  <Avatar /* existing props */ />
  <span className="absolute inset-0 hidden items-center justify-center rounded-full bg-black/50 text-xs text-white group-hover:flex">
    Change
  </span>
</button>
<input
  ref={fileInputRef}
  type="file"
  accept="image/png,image/jpeg,image/webp"
  hidden
  onChange={onFile}
/>
```

The `updateProfile` mutation should already accept `{ image }` — if not, extend the Zod input schema in `user.router.ts` to accept `image: z.string().url().optional()` and persist it on the User row.

**Acceptance:** click the avatar → pick an image → toast shows "Avatar updated" → navbar avatar refreshes.

---

## Module 6 — Short-link analytics polish (v1 #45) — ✅ DONE

> Implemented WITHOUT a schema migration: UA parsing happens at query time from the existing `userAgent` column. No new npm dependency (inline regex parser) and no `db:push` required.

### Fix 6.1 — Track device/browser/OS in click events

**File:** check `packages/db/prisma/schema.prisma` for the click-event model (likely `ShortLinkClick` or similar). If it does not already have `userAgent`, `device`, `browser`, `os` columns, add them. Run `pnpm db:push` after.

**File:** locate the click handler (`apps/web/app/r/[code]/route.ts` or `packages/api/src/routers/shortlink.router.ts` `recordClick`). Parse `req.headers.get("user-agent")` with `ua-parser-js` (add as a dep: `pnpm --filter @postautomation/api add ua-parser-js`).

```ts
import { UAParser } from "ua-parser-js";
const ua = new UAParser(req.headers.get("user-agent") ?? "");
const device = ua.getDevice().type ?? "desktop";
const browser = ua.getBrowser().name ?? "unknown";
const os = ua.getOS().name ?? "unknown";
```

Persist alongside the existing click row.

### Fix 6.2 — Backend aggregation

**File:** `packages/api/src/routers/shortlink.router.ts`

Add a new query `analytics` that groups by device/browser/os/hour:

```ts
analytics: orgProcedure.input(z.object({ shortLinkId: z.string(), days: z.number().int().min(1).max(90).default(7) })).query(async ({ ctx, input }) => {
  const since = new Date(Date.now() - input.days * 86400_000);
  const clicks = await ctx.prisma.shortLinkClick.findMany({
    where: { shortLinkId: input.shortLinkId, createdAt: { gte: since } },
    select: { device: true, browser: true, os: true, country: true, createdAt: true },
  });

  const bucket = <T extends keyof typeof clicks[number]>(key: T) => {
    const counts: Record<string, number> = {};
    for (const c of clicks) {
      const k = String(c[key] ?? "unknown");
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  };

  const hours = new Array(24).fill(0);
  for (const c of clicks) hours[c.createdAt.getHours()]++;

  return {
    total: clicks.length,
    devices: bucket("device"),
    browsers: bucket("browser"),
    os: bucket("os"),
    countries: bucket("country"),
    hours: hours.map((value, hour) => ({ hour, value })),
  };
}),
```

### Fix 6.3 — UI: render breakdowns

**File:** `apps/web/app/dashboard/links/page.tsx`

In the analytics section (around line 254-342), add a tabbed panel showing the four breakdowns. Use existing `<Tabs>` + a small `<BarChart>` from recharts (already a dep). Add a "Last 7 days / 30 days" toggle that drives the `days` input.

**Acceptance:** opening a short link's analytics shows total, device pie, browser bar, OS bar, country bar, and hour-of-day bar; the 7/30 toggle refetches with the new range.

---

## Module 7 — In-app payment method (v1 #93) — ✅ DONE

### Fix 7.1 — Backend: fetch payment method

**File:** `packages/api/src/routers/billing.router.ts`

Add a query:

```ts
paymentMethod: orgProcedure.query(async ({ ctx }) => {
  const org = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { stripeCustomerId: true } });
  if (!org.stripeCustomerId) return null;
  const pms = await stripe.paymentMethods.list({ customer: org.stripeCustomerId, type: "card", limit: 1 });
  const pm = pms.data[0];
  if (!pm?.card) return null;
  return { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year };
}),
```

### Fix 7.2 — UI: render card details

**File:** `apps/web/app/dashboard/settings/billing/page.tsx`

Above the "Manage Billing" button, add:

```tsx
const { data: pm } = trpc.billing.paymentMethod.useQuery();
// ...
{pm ? (
  <div className="rounded-lg border p-4">
    <p className="text-sm font-medium">Payment method</p>
    <p className="text-sm text-muted-foreground">{pm.brand.toUpperCase()} •••• {pm.last4} — exp {pm.expMonth}/{pm.expYear}</p>
  </div>
) : (
  <p className="text-sm text-muted-foreground">No payment method on file.</p>
)}
```

Keep the existing "Manage Billing" button (still routes to Stripe portal for updates).

**Acceptance:** users see card brand/last4/exp on the billing page; clicking "Manage Billing" still opens Stripe portal.

---

## Module 8 — OpenAPI polish (v1 #82, #83, #85, #86) — ✅ DONE

### Fix 8.1 — Error responses

**File:** `packages/api/src/openapi/generate-spec.ts`

Add to the spec:

```ts
components: {
  responses: {
    BadRequest:   { description: "Invalid input.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
    Unauthorized: { description: "Authentication required.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
    Forbidden:    { description: "Insufficient permissions.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
    NotFound:     { description: "Resource not found.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
    Conflict:     { description: "Conflict with existing resource.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
    TooManyRequests: { description: "Rate limit exceeded.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
    ServerError:  { description: "Unexpected server error.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } },
  },
},
```

In each operation's `responses`, add `$ref` entries:
```ts
"400": { $ref: "#/components/responses/BadRequest" },
"401": { $ref: "#/components/responses/Unauthorized" },
"403": { $ref: "#/components/responses/Forbidden" },
"404": { $ref: "#/components/responses/NotFound" },
"500": { $ref: "#/components/responses/ServerError" },
```

### Fix 8.2 — Example outputs

**File:** `apps/web/app/dashboard/settings/api-docs/page.tsx`

Add `exampleOutput` props for `post.getById`, `channel.supportedPlatforms`, `billing.createCheckout` (use shapes that match the Prisma model / Stripe SDK).

### Fix 8.3 — Centralised enums

**File:** create `packages/api/src/lib/enums.ts` if absent. Export:
```ts
export const POST_STATUSES = ["DRAFT", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED"] as const;
export const MEMBER_ROLES  = ["OWNER", "ADMIN", "MEMBER"] as const;
export const PLATFORMS     = ["TWITTER", "FACEBOOK", "INSTAGRAM", "LINKEDIN", "YOUTUBE", "TIKTOK", "REDDIT", "PINTEREST", "THREADS", "TELEGRAM", "DISCORD", "BLUESKY", "WORDPRESS"] as const;
```
Import everywhere these arrays currently appear in `generate-spec.ts` and `api-docs/page.tsx`.

### Fix 8.4 — Rate-limit documentation

**File:** `packages/api/src/openapi/generate-spec.ts`

Extend `info.description`:

```
## Rate limits
Default: 60 requests/min per user.
AI endpoints: 10 requests/min per user.
Headers returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
Exceeding the limit returns a `429 Too Many Requests`.
```

**Acceptance:** downloaded OpenAPI JSON contains `components.responses`, the rate-limit paragraph in `info.description`, and example outputs in the docs UI for the three procedures.

---

## Module 9 — Worker Docker build fix (N9) — ✅ DONE (Option A)

The worker image fails to build because `canvas@2.11.2` requires native libs missing from the alpine base. The QA report didn't cover this; CLAUDE.md documents it.

### Fix 9.1 — Pick option A or B

**Option A (preferred — keep canvas):** add the missing libs to `docker/Dockerfile.worker`. After the `FROM node:20-alpine` line (or whichever base layer runs `pnpm install`), add:

```dockerfile
RUN apk add --no-cache \
    build-base \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    pkgconfig \
    python3
```

**Option B (preferred for cost):** replace `canvas` with a server-side image library that does not need native deps. The worker uses canvas in `packages/ai/src/tools/news-card-template.ts` for image composition. Switch to `@napi-rs/canvas` (drop-in prebuilt binaries):

```bash
pnpm --filter @postautomation/ai remove canvas
pnpm --filter @postautomation/ai add @napi-rs/canvas
```

Update imports: `import { createCanvas, loadImage } from "@napi-rs/canvas";` (API is identical to `canvas`).

**Acceptance:** `docker build -f docker/Dockerfile.worker .` succeeds on a clean machine; worker container starts and processes `news-card-generate` jobs.

---

# Part 3 — Smoke test checklist (run after each module)

```
[ ] `pnpm type-check` passes
[ ] `pnpm lint` passes
[ ] `pnpm dev` boots web + worker without errors
[ ] Sign in via Google on https://postautomation.in → redirects to .co.in, lands on /dashboard with no error page
[ ] Sign in via Google on https://postautomation.co.in directly → lands on /dashboard
[ ] Channels page: connect Twitter with TWITTER_CLIENT_ID unset → toast says "Twitter is not configured"
[ ] Channels page: returning from a failing OAuth → toast describes the error, query params cleared
[ ] Schedule a post; force-kill worker; bring worker back; within 5 min post leaves PUBLISHING
[ ] Export Bulk CSV; open in Excel on Windows; multi-line content stays in one row
[ ] Import the exported CSV; identical posts created
[ ] Invite a non-user email; email arrives; click link; join org
[ ] /api/openapi as OWNER returns JSON; as MEMBER returns 404
[ ] Webhook URL "http://127.0.0.1" rejected; "https://example.com" accepted
[ ] Avatar upload: pick a 5 MB image → rejected; pick a 500 KB JPEG → accepted, navbar avatar refreshes
[ ] Approvals list of 50 items loads with ≤2 DB queries (check logs)
[ ] Short link analytics shows device/browser/os/hour-of-day breakdowns
[ ] Billing page shows card brand + last4 + exp
[ ] Every dashboard module has an inline Alert "How X works" block under the title
[ ] No raw `err.message` toasts anywhere (grep `description: err.message` → 0 hits)
```

---

# Part 4 — Out of scope (do NOT touch in this pass)

- Refactoring `(ctx.session.user as any).id` to a typed accessor.
- Replacing manual SSE parser with an SDK in `super-agent/page.tsx`.
- Full Stripe Elements in-app card add/update (only display + Stripe-portal update).
- Switching deployment from Docker Compose.
- Renaming routes (`/brand-leads` → `/brand-outreach`).
- Adding ABAC on top of RBAC.
- Migrating canvas → @napi-rs/canvas if Option A (apk add libs) ships first.

---

# Part 5 — Suggested PR order

1. **Module 0** (CRITICAL — unblocks production OAuth). Own PR.
2. **Module 1** (watchdog) + **Module 3** (approvals N+1). Own PR (backend-heavy).
3. **Module 2** (SuperAgent capability sync) + **Module 4** (guide blocks). Own PR (UI-heavy).
4. **Module 5** (avatar) + **Module 7** (in-app card display). Own PR (settings polish).
5. **Module 6** (short-link analytics). Own PR (needs schema migration).
6. **Module 8** (OpenAPI polish). Own PR (docs-only).
7. **Module 9** (worker Docker build). Own PR (Dockerfile + lockfile changes).

After each PR: deploy to staging if available; run the Part 3 smoke checklist; ship.
