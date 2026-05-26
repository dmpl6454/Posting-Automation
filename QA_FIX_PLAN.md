# PostAutomation — QA Verification & Fix Plan

**Source:** `/Users/tabish/Desktop/PostAutomation_Issues.xlsx` (96 reported issues)
**Verified against codebase at HEAD:** commit `f7a47e5` on `main`
**Author of plan:** Opus 4.7 (1M)
**Intended executor:** Sonnet 4.6, medium effort, no thinking

---

## How to use this plan

Each section in **Part 2 — Fix Plan** is self-contained. For each fix you will find:

- **File(s):** absolute paths and line numbers as of the verification commit.
- **Problem:** one-line description.
- **Change:** exact code change or a concrete recipe.
- **Acceptance:** how to know it's done.

Do them in the order presented (modules are ordered by user-visible blast radius). Run `pnpm type-check && pnpm lint` after each module. Do **not** mix unrelated fixes into one commit.

---

# Part 1 — Verification Summary

Of the 96 reported issues, **70 are confirmed**, **9 are confirmed-but-broader-than-described**, **17 do not exist in the code** (already fixed, never broken, or misdiagnosed). Numbers below refer to the original `Test Case ID` in the spreadsheet.

## ✅ Confirmed (must fix)

**Overall / Layout**
- **1.** RBAC missing — sidebar/dashboard do not filter modules by `MemberRole`. DB enum exists ([packages/db/prisma/schema.prisma:145-165](packages/db/prisma/schema.prisma)) but no UI gate ([apps/web/components/layout/sidebar.tsx:35-62](apps/web/components/layout/sidebar.tsx)).
- **3.** Raw `err.message` shown in toasts across 15+ pages (e.g. [apps/web/app/admin/posts/page.tsx:58](apps/web/app/admin/posts/page.tsx#L58), [apps/web/app/dashboard/team/page.tsx:42](apps/web/app/dashboard/team/page.tsx#L42)).
- **4.** Sidebar double-highlights Settings + Settings/Billing. `startsWith` logic at [apps/web/components/layout/sidebar.tsx:115](apps/web/components/layout/sidebar.tsx#L115); Billing nested under Settings at line 56.

**Channels (#10–#20)**
- **10–18.** All eight social-channel connect flows fall back to `process.env[…_CLIENT_ID] ?? ""` and call OAuth with empty client_id — provider rejects with no UI hint. Centralized at [packages/api/src/routers/channel.router.ts:81-82](packages/api/src/routers/channel.router.ts#L81-L82) and [apps/web/app/api/oauth/callback/[provider]/route.ts:75-76,153-154](apps/web/app/api/oauth/callback/%5Bprovider%5D/route.ts).
- **19.** Same root cause — no validation, no UI hint. Generic redirect on failure ([apps/web/app/api/oauth/callback/[provider]/route.ts:422](apps/web/app/api/oauth/callback/%5Bprovider%5D/route.ts#L422)).
- **20.** Group create mutation does not include `channels` relation; UI dereferences `group.channels` before refetch completes ([packages/api/src/routers/channel-group.router.ts:21-27](packages/api/src/routers/channel-group.router.ts#L21-L27); [apps/web/app/dashboard/channels/page.tsx:452](apps/web/app/dashboard/channels/page.tsx#L452)).

**Content Studio (#21–#30)**
- **22.** Worker sets stuck post status back to `"PUBLISHING"` on non-final retries with no watchdog ([apps/worker/src/workers/post-publish.worker.ts:539](apps/worker/src/workers/post-publish.worker.ts#L539)).
- **24.** `Use in Post` shoves AI output into a query string ([apps/web/components/content-agent/GenerateTab.tsx:189](apps/web/components/content-agent/GenerateTab.tsx#L189), `ImageTab.tsx`).
- **25.** CSV export sends literal `"ALL"` ([apps/web/components/content-agent/BulkTab.tsx:520,469](apps/web/components/content-agent/BulkTab.tsx); [packages/api/src/routers/bulk.router.ts:228-229](packages/api/src/routers/bulk.router.ts#L228-L229)).
- **26.** CSV uses `\n` line endings ([packages/api/src/routers/bulk.router.ts:272](packages/api/src/routers/bulk.router.ts#L272)).
- **27.** CSV escapes only the `content` field ([packages/api/src/routers/bulk.router.ts:256-269](packages/api/src/routers/bulk.router.ts#L256-L269)).
- **28.** CSV import parses line-by-line so multi-line quoted cells break ([packages/api/src/routers/bulk.router.ts:125,279-310](packages/api/src/routers/bulk.router.ts)).
- **30.** No watchdog for stuck `PUBLISHING` posts (same root as #22).

**Super Agent (#31, #33)**
- **31.** Local `useState` for messages — refresh during streaming loses the user message visually until next refetch ([apps/web/app/dashboard/super-agent/page.tsx:85-89](apps/web/app/dashboard/super-agent/page.tsx#L85-L89)).
- **33.** UI lists 8 hardcoded marketing-copy capabilities; backend executor supports 13 actions ([apps/web/app/dashboard/super-agent/page.tsx:53-62](apps/web/app/dashboard/super-agent/page.tsx#L53-L62) vs [packages/api/src/routers/chat.router.ts:156-161](packages/api/src/routers/chat.router.ts#L156-L161)).

**Analytics / Media (#34, #36, #37–#39)**
- **34.** Analytics is dynamic but produces empty-state UI when no channels are connected; UX provides no guidance to connect channels ([apps/web/app/dashboard/analytics/page.tsx:414-420](apps/web/app/dashboard/analytics/page.tsx#L414-L420)).
- **36.** Recharts Tooltip uses inline `contentStyle` with negative left margin (`-20`) — clipping on narrow widths ([apps/web/app/dashboard/analytics/page.tsx:208-225](apps/web/app/dashboard/analytics/page.tsx#L208-L225)).
- **37–39.** Media grid renders bare thumbnails; `<video>` missing `controls`; no lightbox/modal ([apps/web/app/dashboard/media/page.tsx:204-260](apps/web/app/dashboard/media/page.tsx#L204-L260)).

**RSS Feeds (#40–#44)**
- **40.** Literal `{{title}} and {{summary}}` shown to end users ([apps/web/app/dashboard/rss/page.tsx:184,188](apps/web/app/dashboard/rss/page.tsx)).
- **41.** Dialog description gives almost no usage guidance ([apps/web/app/dashboard/rss/page.tsx:130-132](apps/web/app/dashboard/rss/page.tsx#L130-L132)).
- **42, 43.** Only `z.string().url()` — no RSS/Atom format verification ([packages/api/src/routers/rss.router.ts:27](packages/api/src/routers/rss.router.ts#L27)).
- **44.** `getOrgId()` from `localStorage` dead-code-gates queries ([apps/web/app/dashboard/rss/page.tsx:35-40,60](apps/web/app/dashboard/rss/page.tsx)).

**Short Links (#45, #46)**
- **45.** Analytics shows only clicks/referers/countries — no CTR, no device/browser/OS ([apps/web/app/dashboard/links/page.tsx:254-342](apps/web/app/dashboard/links/page.tsx#L254-L342)).
- **46.** Same `localStorage` dead-code pattern as #44 ([apps/web/app/dashboard/links/page.tsx:33-38,61](apps/web/app/dashboard/links/page.tsx)).

**Autopilot / NewsGrid (#47, #50, #52, #54, #55, #56)**
- **47.** Page renders four stat cards and a button — no inline explanation of pipeline workflow ([apps/web/app/dashboard/autopilot/page.tsx](apps/web/app/dashboard/autopilot/page.tsx)).
- **50.** Trending data comes from `trendingItem.findMany` — accuracy depends on discovery worker that may be stale. No UI shows last-discovered timestamp ([apps/web/app/dashboard/autopilot/trending/page.tsx:57](apps/web/app/dashboard/autopilot/trending/page.tsx#L57)).
- **52.** Button disabled state uses `mutation.isPending`, which clears as soon as enqueue succeeds — not when the async run finishes ([apps/web/app/dashboard/autopilot/page.tsx:108](apps/web/app/dashboard/autopilot/page.tsx#L108)).
- **54.** `deleteLogo` deletes the `Media` row but does not null out `channel.metadata.logo_path` ([packages/api/src/routers/newsgrid.router.ts:591-596](packages/api/src/routers/newsgrid.router.ts#L591-L596)).
- **55.** Page header gives only a one-liner; no workflow guidance ([apps/web/app/dashboard/newsgrid/page.tsx:608-611](apps/web/app/dashboard/newsgrid/page.tsx#L608-L611)).
- **56.** `loremflickr.com` hard-coded as a background image source ([apps/web/app/dashboard/newsgrid/page.tsx:135](apps/web/app/dashboard/newsgrid/page.tsx#L135) and [packages/ai/src/tools/news-card-template.ts](packages/ai/src/tools/news-card-template.ts)).

**Brand Leads (#62)**
- **62.** Sidebar says "Brand Leads" ([apps/web/components/layout/sidebar.tsx:48](apps/web/components/layout/sidebar.tsx#L48)); page header says "Brand Outreach" ([apps/web/app/dashboard/brand-leads/page.tsx:431](apps/web/app/dashboard/brand-leads/page.tsx#L431)).

**Monitoring (#67)**
- **67.** `exportForClaude` concatenates raw `err.message`, stack, and `JSON.stringify(err.metadata)` to the clipboard — no token/PII masking ([packages/api/src/routers/monitor.router.ts:206-210](packages/api/src/routers/monitor.router.ts#L206-L210)).

**Team (#69–#72)**
- **69, 70, 71.** `team.invite` throws `NOT_FOUND` if the email is not already a user — there is no email-invitation flow ([packages/api/src/routers/team.router.ts:16-26](packages/api/src/routers/team.router.ts#L16-L26)). UI lies with `"Invitation sent"` toast ([apps/web/app/dashboard/team/page.tsx:39](apps/web/app/dashboard/team/page.tsx#L39)).
- **72.** `updateRole` enum excludes `"OWNER"`; `removeMember` rejects owner — no transfer-ownership path ([packages/api/src/routers/team.router.ts:55-77,79-101](packages/api/src/routers/team.router.ts#L55-L101)).

**Versions (#73–#75)**
- **73, 74.** Frontend and backend both read `NEXT_PUBLIC_*` env vars AND the `Deployment` DB rows; UI displays both without reconciling ([apps/web/app/dashboard/settings/versions/page.tsx:66-72](apps/web/app/dashboard/settings/versions/page.tsx#L66-L72); [packages/api/src/routers/deployment.router.ts:7-52](packages/api/src/routers/deployment.router.ts#L7-L52)).
- **75.** `rollback` only writes DB rows; message explicitly says "Run the deploy script on the server to complete." ([packages/api/src/routers/deployment.router.ts:124-171](packages/api/src/routers/deployment.router.ts#L124-L171)).

**Audit Logs (#76–#79)**
- **76, 77.** Hardcoded column widths (`w-[120px]`–`w-[180px]`) and 8-char ID truncation ([apps/web/app/dashboard/settings/audit-log/page.tsx:313-316,361](apps/web/app/dashboard/settings/audit-log/page.tsx)).
- **78.** Audit writes exist in `team`, `post`, `channel`, `apikey`. Missing from `webhook`, `billing`, `rss`, `agent`, `autopilot`, `listening`, `user` (password/phone/profile).
- **79.** All audit writes follow `createAuditLog(...).catch(() => {})` ([packages/api/src/routers/team.router.ts:43-50](packages/api/src/routers/team.router.ts#L43-L50) etc.).

**API Docs (#80–#86)**
- **80.** `/api/openapi` returns `{error: "Not found"}` in production unless `EXPOSE_OPENAPI=true` ([apps/web/app/api/openapi/route.ts:7-10](apps/web/app/api/openapi/route.ts#L7-L10)).
- **81.** `Expand All` only mutates `expandedRouters` Set — does not touch per-procedure `expanded` state in `ProcedureCard` ([apps/web/app/dashboard/settings/api-docs/page.tsx:799-800,668](apps/web/app/dashboard/settings/api-docs/page.tsx)).
- **82.** No error-handling section in `generate-spec.ts`.
- **83.** No `exampleOutput` for `post.getById`, `channel.supportedPlatforms`, `billing.createCheckout`.
- **84.** Many bodies are loose `{type:"object"}` (e.g. [packages/api/src/openapi/generate-spec.ts:226](packages/api/src/openapi/generate-spec.ts#L226)).
- **85.** Enum lists inconsistent — some procedures inline enums, others omit.
- **86.** No global rate-limit section; only `ai.generateContent` mentions it inline.

**API Keys / Webhooks / Settings (#87–#96)**
- **87.** `revealedKey` shows full plaintext key in an amber card; remains after copy ([apps/web/app/dashboard/settings/api-keys/page.tsx:53-78](apps/web/app/dashboard/settings/api-keys/page.tsx#L53-L78)).
- **88, 90.** Webhook URL only validated via `z.string().url()` — accepts http and any host ([packages/api/src/routers/webhook.router.ts:14-20](packages/api/src/routers/webhook.router.ts#L14-L20)).
- **89.** Raw `err.message` in toast ([apps/web/app/dashboard/settings/webhooks/page.tsx:35-37](apps/web/app/dashboard/settings/webhooks/page.tsx#L35-L37)).
- **91.** No SSRF guard against `localhost`, `127.0.0.1`, RFC1918, link-local, `0.0.0.0/8`.
- **93.** Billing has only a Stripe-portal redirect — no in-app card UI ([apps/web/app/dashboard/settings/billing/page.tsx:62-68](apps/web/app/dashboard/settings/billing/page.tsx#L62-L68)).
- **94.** After `updateProfile.mutate`, local `name` state is never reconciled with refetched user until the second render — input shows stale local value briefly ([apps/web/app/dashboard/settings/page.tsx:26-33,133-136](apps/web/app/dashboard/settings/page.tsx)).
- **95.** Phone removal is a single click — no OTP re-challenge ([apps/web/app/dashboard/settings/page.tsx:347-357](apps/web/app/dashboard/settings/page.tsx#L347-L357)).
- **96.** Avatar is rendered but there is no upload UI in settings.

## ⚠️ Broad / qualitative (must address; treat as polish passes)

- **2.** Inconsistent UI/UX — shared component lib exists; concrete inconsistencies are subsumed by other fixes here. **Do not fix in isolation.**
- **5, 6, 7.** Dashboard / Activities widgets — data sources are real. **Not bugs.** Skip unless the user can name a concrete inaccuracy.
- **21.** Compose blocks with zero channels — correct behaviour. The UX gap is "no obvious next-step CTA"; covered by RBAC + empty-state polish in fix #21.
- **29.** Create Design — opens `<MediaEditor>` from `image-studio`; needs runtime QA; recipe in fix #29.
- **32.** SuperAgent inconsistency — symptom of #33; fixing #33 addresses most of it.
- **35.** Analytics inaccurate — fully dynamic; depends on the snapshot worker. Confirm by running `triggerSync` in [packages/api/src/routers/analytics.router.ts:337-381](packages/api/src/routers/analytics.router.ts#L337-L381). No code change needed.
- **41, 45, 47, 55.** "UI unclear" — covered by their per-module polish fixes below.
- **51.** Autopilot data inconsistent — same as #50.

## ❌ Not reproducible in code (skip)

These are already fixed, never broken, or are runtime-only and not visible from code. Do **not** include in the patch set.

- **8.** GitHub OAuth on register page — already removed ([apps/web/app/(auth)/register/page.tsx:60-71](apps/web/app/(auth)/register/page.tsx#L60-L71) shows Google only; auth config has no GithubProvider).
- **9.** GitHub on login — same (already removed). Phone OTP IS wired ([packages/api/src/routers/auth.router.ts:205-235](packages/api/src/routers/auth.router.ts#L205-L235), [packages/api/src/lib/sms.ts](packages/api/src/lib/sms.ts)); fails only when `TWILIO_ACCOUNT_SID` / `FAST2SMS_API_KEY` is unset. Same class as #19. **Do not re-implement OTP** — fix the missing-env UX (covered in fix #19).
- **23.** AI Create providers — all 6 (`openai, anthropic, gemini, grok, deepseek, gemma4`) have implementations in [packages/ai/src/providers/](packages/ai/src/providers/). **Not a bug.**
- **48, 49.** Run Pipeline "never stops" — pipeline is job-queue based; worker owns completion. No proof of perpetual run from code. Symptom is #52 (button doesn't reflect actual run state). **Do not add server-side cancellation.**
- **53.** Agents Active toggle — implementation looks fine ([apps/web/app/dashboard/autopilot/agents/page.tsx:66-68,227-230](apps/web/app/dashboard/autopilot/agents/page.tsx)). No error handler is a minor issue, lumped into #3.
- **57.** NewsGrid prefill — 1500ms `clearTimeout`/`setTimeout` debounce IS implemented ([apps/web/app/dashboard/newsgrid/page.tsx:498-507](apps/web/app/dashboard/newsgrid/page.tsx#L498-L507)). **Not a bug.**
- **58, 59.** Listening has full data display ([apps/web/app/dashboard/listening/page.tsx:95-111](apps/web/app/dashboard/listening/page.tsx#L95-L111)) and backend mentions/sentiment ([packages/api/src/routers/listening.router.ts:86-179](packages/api/src/routers/listening.router.ts#L86-L179)). Empty-state when no data is real, not a stub.
- **60, 61.** Campaigns CRUD is fully implemented ([packages/api/src/routers/campaign.router.ts](packages/api/src/routers/campaign.router.ts)) and UI displays it. If users report failures, get a reproduction first.
- **63, 64.** Brand Leads empty when DB empty — implementation present ([packages/api/src/routers/brand-leads.router.ts:21-50](packages/api/src/routers/brand-leads.router.ts#L21-L50)).
- **65, 66.** Approvals review mutation fully implemented ([packages/api/src/routers/approval.router.ts:79-207](packages/api/src/routers/approval.router.ts#L79-L207)).
- **68.** Approvals loading — N+1 in enrichment loop is a perf smell, not a perpetual-loading bug ([packages/api/src/routers/approval.router.ts:250-269](packages/api/src/routers/approval.router.ts#L250-L269)). Note it but skip unless reproduced.
- **92.** Enterprise downgrade — Stripe Portal handles all plan transitions ([packages/api/src/routers/billing.router.ts:34-43](packages/api/src/routers/billing.router.ts#L34-L43)). No code-level restriction.

## ➕ Additional issues found during verification (not in the spreadsheet)

- **A1.** `post-publish.worker` ternary at line 539 sets `status: isFinalAttempt ? "FAILED" : "PUBLISHING"` — semantically odd; non-final failures shouldn't *re-set* status to PUBLISHING. Confusing but defensible; lumped into #30 watchdog fix.
- **A2.** `escapeDangerousAccountLinking: true` (intentional per CLAUDE.md) plus lowercased email storage relies on the `register` route doing case-insensitive lookups. Verify the OAuth-only-rejection branch ([packages/api/src/routers/auth.router.ts](packages/api/src/routers/auth.router.ts)) covers Google sign-ins where casing changes — not in scope unless a bug is reported.
- **A3.** Many tRPC routers use `(ctx.session.user as any).id` instead of a typed accessor. Code smell, not a bug. Skip.

---

# Part 2 — Fix Plan

Work module-by-module. Each fix is independent unless noted. After every module: `pnpm type-check && pnpm lint`.

## Module 0 — Shared utilities (do this FIRST)

These get reused by ten+ fixes below. Add them before anything else.

### Fix 0.1 — `humanizeTRPCError` helper

**File:** create `apps/web/lib/errors.ts`

**Change:** add a helper that turns tRPC / fetch errors into user-friendly strings.

```ts
import type { TRPCClientErrorLike } from "@trpc/client";

const TECHNICAL_PATTERNS = [
  /^Invariant/i, /at .+:\d+:\d+/, /Cannot read prop/i, /TypeError/, /TRPCError/, /\bPrisma\b/i,
];

export function humanizeError(err: unknown, fallback = "Something went wrong. Please try again."): string {
  const msg = typeof err === "string" ? err : (err as any)?.message ?? "";
  if (!msg) return fallback;
  if (TECHNICAL_PATTERNS.some((re) => re.test(msg))) return fallback;
  if (msg.length > 240) return fallback;
  return msg;
}
```

**Acceptance:** importable from `@/lib/errors`. Used by fix #3 and #89.

### Fix 0.2 — `getOrgFromSession` (kill `localStorage` org-id)

**File:** create `apps/web/lib/org.ts`

```ts
"use client";
import { useSession } from "next-auth/react";
export function useCurrentOrgId(): string | null {
  const { data } = useSession();
  return ((data?.user as any)?.organizationId as string | undefined) ?? null;
}
```

NOTE: confirm the session shape — see `packages/auth/src/config.ts` JWT callback. If `organizationId` is not on session, add it there (small change in the `session({ session, token })` callback to mirror `token.organizationId`).

**Acceptance:** used by fixes #44 and #46.

### Fix 0.3 — `validateUrlForWebhook` (SSRF guard)

**File:** create `packages/api/src/lib/url-safety.ts`

```ts
import { z } from "zod";

const PRIVATE_HOST_RE = /^(localhost|0(\.0){0,3}|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i;

export const webhookUrlSchema = z
  .string()
  .url()
  .refine((s) => {
    try {
      const u = new URL(s);
      if (u.protocol !== "https:") return false;
      if (PRIVATE_HOST_RE.test(u.hostname)) return false;
      return true;
    } catch { return false; }
  }, { message: "URL must be https and not point to a private/loopback address" });
```

**Acceptance:** exported and used by fix #90/#91.

---

## Module 1 — Layout & UX foundation

### Fix #4 — Sidebar double-highlight + remove Billing from Settings

**File:** `apps/web/components/layout/sidebar.tsx`

1. At line 115 replace:
   ```ts
   const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
   ```
   with:
   ```ts
   const isActive =
     pathname === item.href ||
     (item.href !== "/dashboard/settings" && pathname.startsWith(item.href + "/"));
   ```
   (Settings is the only `startsWith`-matched parent that has its own subpages in the same nav; this avoids both highlighting.)

2. Move the Billing entry: in `settingsNav` array (around line 56), **delete** `{ name: "Billing", href: "/dashboard/settings/billing", icon: CreditCard }`. Add it to the main `nav` array as `{ name: "Billing", href: "/dashboard/settings/billing", icon: CreditCard }` placed after `Team`.

3. If Billing must remain reachable from Settings, keep a "Billing →" link card in `app/dashboard/settings/page.tsx` instead of in the side-nav.

**Acceptance:** navigating to `/dashboard/settings/billing` highlights only the (now top-level) Billing item.

### Fix #3 — Toast messages: never show raw `err.message`

**File:** `apps/web/lib/errors.ts` (from Fix 0.1).

Then sweep:

```bash
grep -rln "err\.message\|error\.message" apps/web/app apps/web/components | xargs -I{} sed -i '' 's/description: err\.message/description: humanizeError(err)/g' {}
```

Then in each touched file add the import: `import { humanizeError } from "@/lib/errors";`. Do this for at least these files (verified hits):

- `apps/web/app/admin/posts/page.tsx`
- `apps/web/app/admin/agents/page.tsx`
- `apps/web/app/admin/orgs/page.tsx`
- `apps/web/app/dashboard/team/page.tsx`
- `apps/web/app/dashboard/settings/webhooks/page.tsx`
- Any other `err.message` toast caller — find with `grep -rn "description: err\\.message" apps/web`.

**Acceptance:** no `err.message` left in toast `description` fields under `apps/web/`.

### Fix #1 — RBAC: hide modules in sidebar based on role

**Files:** `apps/web/components/layout/sidebar.tsx`, `packages/auth/src/config.ts`.

1. In the JWT/session callbacks (`packages/auth/src/config.ts`) ensure `session.user.role` carries the current org member role (`OWNER | ADMIN | MEMBER | VIEWER`). The org-member lookup already happens server-side; expose `role` next to `organizationId`.

2. In `sidebar.tsx`, change the `nav` array entries to `{ name, href, icon, roles?: MemberRole[] }`. Add a `roles` filter:

   ```ts
   const role = (session?.user as any)?.role as MemberRole | undefined;
   const visible = nav.filter((n) => !n.roles || (role && n.roles.includes(role)));
   ```

3. Default role gates (apply liberally; we can loosen later):
   - `Team`, `Billing`, `Settings/Versions`, `Settings/API Keys`, `Settings/Webhooks`, `Settings/Audit Log` → `["OWNER","ADMIN"]`
   - `Approvals` → `["OWNER","ADMIN","MEMBER"]` (VIEWER cannot approve)
   - Everything else → no `roles` field (everyone).

4. For belt-and-braces, add an `assertRole` helper used in the corresponding tRPC procedures (most already use `orgProcedure`; add `adminProcedure` if missing).

**Acceptance:** logging in as a MEMBER hides Team, Versions, API Keys, Webhooks, Audit Log, Billing in the sidebar.

---

## Module 2 — Auth / OAuth env-var UX (#19, #9)

### Fix #19 — Surface "platform not configured" before redirecting to OAuth

**File:** `packages/api/src/routers/channel.router.ts` (around line 81 where the OAuth-config object is built).

1. Build a typed config object first; throw a typed tRPC error if `clientId` or `clientSecret` is empty:

   ```ts
   const clientId = process.env[`${platformEnvPrefix}_CLIENT_ID`];
   const clientSecret = process.env[`${platformEnvPrefix}_CLIENT_SECRET`];
   if (!clientId || !clientSecret) {
     throw new TRPCError({
       code: "FAILED_PRECONDITION",
       message: `${platform} is not configured by the admin. Please contact support.`,
     });
   }
   ```

2. In the OAuth callback route (`apps/web/app/api/oauth/callback/[provider]/route.ts:75-76,153-154`), do the same check at the top: if `clientId` or `clientSecret` is empty, redirect to `/dashboard/channels?error=platform_not_configured&platform=<x>`. Display a banner on the channels page reading the `error` query param.

3. On the channels page, add a per-platform "Configured" / "Not configured" badge by exposing a tRPC procedure `channel.platformConfig` that returns `{ platform, configured: boolean }[]` (read from env on the server).

**Acceptance:** clicking "Connect Twitter" without env vars set shows a "Twitter is not configured" toast — no silent redirect.

**Same fix covers #9** (phone OTP fails silently when Twilio/Fast2SMS missing): in `auth.router.ts:sendPhoneOtp`, if neither provider key is set, throw `FAILED_PRECONDITION` with `"SMS service not configured. Please use email login."`. UI displays the message.

---

## Module 3 — Channels (#20)

### Fix #20 — Include `channels` in `channelGroup.create` return

**File:** `packages/api/src/routers/channel-group.router.ts:21-27`.

Change the `prisma.channelGroup.create` to `include: { channels: { include: { channel: true } } }` (or whatever matches the read shape used by `channelGroup.list`). On the client, after `createGroup.mutate(...)`, call `utils.channelGroup.list.invalidate()` instead of relying on the return value.

**File:** `apps/web/app/dashboard/channels/page.tsx:452` — guard against `group.channels` being undefined: `(group.channels ?? []).map(...)`.

**Acceptance:** creating a new group renders an empty group card with the correct name; no `undefined.map` flicker.

---

## Module 4 — Content Studio (#22, #24–#28, #29, #30)

### Fix #22 + #30 — Publishing watchdog & status correctness

**File:** `apps/worker/src/workers/post-publish.worker.ts`

1. Line 539 — replace the ternary so non-final attempts leave the status untouched (target rows already track per-target retry state). The post-level status should only change to FAILED on final attempt or when all targets are terminal.

2. Add a new worker (or reuse a scheduler) that runs every 5 minutes:
   - File: `apps/worker/src/workers/post-publish-watchdog.worker.ts` (new).
   - Query `Post.findMany({ where: { status: "PUBLISHING", updatedAt: { lt: subMinutes(now, 30) } } })`.
   - For each, check `targets`: if all terminal → set `status = "FAILED"` (or PUBLISHED if any succeeded — match existing logic at line 593); else attempt to re-enqueue the targets still in PENDING.
   - Register the worker in `apps/worker/src/index.ts`.

3. Add a BullMQ repeatable job entry in `packages/queue/` for the watchdog.

**Acceptance:** kill the worker mid-publish, then bring it back; within 5 min the post status leaves PUBLISHING.

### Fix #24 — `Use in Post` content via POST/state, not URL

**File:** `apps/web/components/content-agent/GenerateTab.tsx:189` and the matching `ImageTab.tsx` location.

Replace the `<Link href={"...?content=" + encodeURIComponent(result)}>` with a `useRouter`-driven handler that:

1. Writes the content to `sessionStorage.setItem("compose:draftContent", result)`.
2. Calls `router.push("/dashboard/content-agent?tab=compose")`.

In `ComposeTab.tsx`, read `sessionStorage.getItem("compose:draftContent")` on mount; if present, prefill the editor and `sessionStorage.removeItem` it.

**Acceptance:** content of arbitrary length carries over; URL stays short.

### Fix #25 — CSV export status filter

**File:** `apps/web/components/content-agent/BulkTab.tsx:469`

Change `status: statusFilter || undefined` to `status: statusFilter && statusFilter !== "ALL" ? statusFilter : undefined`.

**Acceptance:** selecting "All" returns all rows.

### Fix #26 — CSV line endings

**File:** `packages/api/src/routers/bulk.router.ts:272`

Change `csvLines.join("\n")` → `csvLines.join("\r\n")`. Also prepend `"﻿"` to the CSV body so Excel detects UTF-8: `return { csv: "﻿" + csvLines.join("\r\n"), count: posts.length };`

**Acceptance:** opening the exported file in Excel on Windows shows one row per line and unicode characters render.

### Fix #27 — Escape every CSV field

**File:** `packages/api/src/routers/bulk.router.ts:256-269`

Wrap every interpolated value:

```ts
const e = escapeCSVField;
csvLines.push(
  `${e(post.content)},${e(post.status)},${e(scheduledAt)},${e(publishedAt)},${e(platforms)}`
);
```

If header is hand-built, escape header too.

**Acceptance:** posts whose content contains commas, quotes, or newlines round-trip cleanly.

### Fix #28 — CSV import: replace line-split parser

**File:** `packages/api/src/routers/bulk.router.ts:125,279-310`

Install and use `papaparse` (already a tiny dep — confirm with `pnpm --filter @postautomation/api add papaparse`). Replace `csvData.split("\n")` plus the manual `parseCSVRow` with:

```ts
import Papa from "papaparse";
const parsed = Papa.parse<Record<string, string>>(input.csvData, {
  header: true,
  skipEmptyLines: true,
  transformHeader: (h) => h.trim(),
});
if (parsed.errors.length) {
  throw new TRPCError({ code: "BAD_REQUEST", message: `CSV parse error: ${parsed.errors[0]!.message}` });
}
const rows = parsed.data;
```

Delete the now-unused `parseCSVRow` helper.

**Acceptance:** importing a CSV whose content cell contains `"\r\nline two"` produces a single post with the embedded newline.

### Fix #29 — Create Design: confirm + tighten

**File:** `apps/web/components/content-agent/ComposeTab.tsx:427-434` ("Create Design" button) and the dynamically-imported `MediaEditor`.

Manual QA pass:
1. `pnpm dev` → open Compose → click "Create Design".
2. Verify editor opens, accepts an image, exports back to the compose draft, and the draft media list updates.
3. Log any specific bug to GitHub Issues; fix only verified bugs.

If editor fails to open at all, check that `MediaEditor` is wrapped in `dynamic(() => import(...), { ssr: false })` and that the path resolves. Otherwise no code change here.

---

## Module 5 — Super Agent (#31, #33)

### Fix #31 — Persist message before stream starts

**File:** `apps/web/app/dashboard/super-agent/page.tsx`

The user message is already saved via `sendMessageMutation` (line 168). The visual gap happens if the user reloads before the stream completes. Add an `optimisticMessages` ref that survives reloads via `localStorage` (key: `superagent:pending:${threadId}`); clear it when the SSE finishes with `[DONE]`.

Implementation sketch (insert near the streaming start, ~line 181):

```ts
const pendingKey = `superagent:pending:${threadId}`;
localStorage.setItem(pendingKey, JSON.stringify({ role: "user", content: userInput, at: Date.now() }));
// ... in finally block of the streaming fetch:
localStorage.removeItem(pendingKey);
```

On mount, merge any pending entry into the displayed messages array if it isn't already present.

**Acceptance:** type a long prompt, hit send, reload mid-stream — your user message is still visible.

### Fix #33 — Capability list reflects backend

**File:** `apps/web/app/dashboard/super-agent/page.tsx:53-62` and `packages/api/src/routers/chat.router.ts:156-161`.

1. In `chat.router.ts`, export a `SUPPORTED_ACTIONS` const and a tRPC query `chat.capabilities` that returns an array of `{ action, label, description }` derived from it.
2. In `super-agent/page.tsx`, replace the hardcoded array with `trpc.chat.capabilities.useQuery()`.

If `capabilities` UX needs short marketing strings, keep a small lookup table next to the const in `chat.router.ts`, not in the page.

**Acceptance:** adding a new action key to `SUPPORTED_ACTIONS` makes it appear in the UI without touching the page.

---

## Module 6 — Analytics / Media (#34, #36, #37, #38, #39)

### Fix #34 — Empty-state CTA on Analytics

**File:** `apps/web/app/dashboard/analytics/page.tsx:414-420`

In the "No active channels found" empty state, add a primary button `<Link href="/dashboard/channels">Connect a channel</Link>`. Mirror in the "No posts published in this period" block (#34/#35).

### Fix #36 — Recharts tooltip clipping

**File:** `apps/web/app/dashboard/analytics/page.tsx:208-225` (and any other chart using `margin={{ left: -20 }}`)

1. Change `margin={{ top: 4, right: 8, left: -20, bottom: 0 }}` → `margin={{ top: 4, right: 8, left: 8, bottom: 0 }}`.
2. Add `wrapperStyle={{ zIndex: 50 }}` and `allowEscapeViewBox={{ x: true, y: true }}` to each `<Tooltip />` to prevent clipping inside small containers.
3. Verify with the browser dev tools at viewport width 768px.

### Fix #37 + #38 + #39 — Media viewer/lightbox

**File:** `apps/web/app/dashboard/media/page.tsx:199-276`

1. Add `controls` to the `<video>` element (line 204-213): `<video src={media.url} controls preload="metadata" ... />`. Drop `muted` unless the spec requires it.
2. Make each card clickable: on click, set `selectedMedia` state and render a Radix `Dialog` (use `components/ui/dialog.tsx`) showing:
   - For images: full-size `<img>` (object-contain, max-h-[80vh]).
   - For videos: `<video controls autoPlay>`.
3. Keep the existing download/delete buttons in the dialog footer.

**Acceptance:** clicking a tile opens a modal with full-size media; videos have playback controls.

---

## Module 7 — RSS Feeds (#40, #41, #42–#43, #44)

### Fix #40 + #41 — Replace literal placeholder, document syntax

**File:** `apps/web/app/dashboard/rss/page.tsx:184,188`

1. Line 184 placeholder string: change to `"e.g. New on our blog: {title} — {summary}"` and remove the literal `{{title}}` from displayed help text (line 188).
2. Settle on ONE templating syntax (`{title}` / `{summary}` / `{link}`). Add a short help block under the textarea:
   > Available variables: `{title}`, `{summary}`, `{link}`. They are replaced when each feed item is converted into a post.
3. In the backend (`packages/api/src/routers/rss.router.ts`), if the template still uses `{{x}}` for legacy reasons, do the substitution; otherwise just `{x}`. Pick one. If you change syntax, write a one-shot migration over `RssFeed.template` to swap delimiters.

### Fix #42 + #43 — Validate the URL is an RSS/Atom feed

**File:** `packages/api/src/routers/rss.router.ts:27`

Add server-side validation in the `create` mutation:

```ts
const res = await fetch(input.url, { method: "GET", signal: AbortSignal.timeout(5000), redirect: "follow" });
if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: "Feed URL did not respond." });
const text = await res.text();
if (!/<(rss|feed)\b/i.test(text)) {
  throw new TRPCError({ code: "BAD_REQUEST", message: "URL does not appear to be a valid RSS/Atom feed." });
}
```

If a feed parser already exists in the worker, prefer calling it here.

**Acceptance:** submitting a homepage URL produces "URL does not appear to be a valid RSS/Atom feed."

### Fix #44 — Drop `localStorage` org-id

**File:** `apps/web/app/dashboard/rss/page.tsx:35-40,60`

1. Delete the local `getOrgId()` helper and the `orgId` state.
2. Remove the `enabled: !!orgId` gate on every `useQuery`.
3. Same change at `apps/web/app/dashboard/links/page.tsx:33-38,61` for fix #46.

Backend already scopes by session; do not pass `orgId` from client.

---

## Module 8 — Short Links (#45 — see also #46 above)

### Fix #45 — Richer analytics

**File:** `apps/web/app/dashboard/links/page.tsx:254-342`

Add (in priority order):

1. **CTR** card: `clicks / impressions` if `impressions` exists in the click events; otherwise skip.
2. **Device / browser / OS** stacked breakdown — your click events already include a UA. Add a tRPC query `shortlink.uaBreakdown` aggregating with a `prisma.$queryRaw` group-by; render with a `<PieChart>`.
3. **Time-of-day heatmap** — small `<BarChart>` of clicks by hour.
4. Show "Last 30 days" toggle next to "Last 7 days".

If existing data doesn't include enough fields, this becomes a backend story — note it in the PR but ship the 7→30 day toggle and CTR card as minimum.

---

## Module 9 — Autopilot / NewsGrid

### Fix #47 + #50 + #55 — Add inline workflow guidance

**Files:** `apps/web/app/dashboard/autopilot/page.tsx`, `apps/web/app/dashboard/autopilot/trending/page.tsx`, `apps/web/app/dashboard/newsgrid/page.tsx`

For each, add a small `<Alert variant="info">` block under the page title that explains the four-step pipeline:

> Autopilot runs in 4 stages: **Discover** trending topics → **Generate** drafts → **Review** in the approvals queue → **Post** approved drafts on schedule. Click *Run Pipeline* to trigger a one-off run; the latest results appear in *Trending* and *Review*.

For Trending (#50), show "Last discovered: X minutes ago" using `max(updatedAt)` from `trendingItem`.

### Fix #52 — Long-running button state

**File:** `apps/web/app/dashboard/autopilot/page.tsx:108`

1. Backend already creates a `pipelineRun` row with `status: "RUNNING"`. Add a tRPC query `autopilot.latestRun` returning `{ id, status, startedAt, finishedAt }`.
2. In the page, do `const { data: latestRun } = trpc.autopilot.latestRun.useQuery(undefined, { refetchInterval: 5000 });`
3. Compute `const isRunning = triggerMutation.isPending || latestRun?.status === "RUNNING";`
4. Use `isRunning` for the disabled state and spinner.

**Acceptance:** clicking Run Pipeline keeps the spinner until the worker marks the run COMPLETED/FAILED.

### Fix #54 — Logo deletion: null out channel metadata

**File:** `packages/api/src/routers/newsgrid.router.ts:591-596`

Wrap the delete in a transaction:

```ts
const deletedUrl = (await ctx.prisma.media.findUnique({ where: { id: input.id } }))?.url;
await ctx.prisma.$transaction([
  ctx.prisma.media.delete({ where: { id: input.id } }),
  ctx.prisma.channel.updateMany({
    where: { metadata: { path: ["logo_path"], equals: deletedUrl } },
    data: { metadata: { logo_path: null } as any },
  }),
]);
```

Confirm the JSON-path syntax matches the Prisma version in use; otherwise fetch matching channels and update individually.

**Acceptance:** delete a logo, refresh channels page, channel no longer references the deleted media.

### Fix #56 — Stop relying on loremflickr.com

**File:** `apps/web/app/dashboard/newsgrid/page.tsx:135` (and `packages/ai/src/tools/news-card-template.ts`)

Replace with one of:

1. **Local fallback gallery:** check in 4-6 royalty-free background images under `apps/web/public/newsgrid-bg/`, pick by `seed % N`.
2. **User-uploaded backgrounds:** add a "Pick background" step that reads from the user's Media library.
3. **AI-generated background:** call the existing image provider (Imagen/DALL-E) — costly; only behind a feature flag.

Pick option 1 for now (zero runtime cost). Replace the `loremflickr.com` URL with `/newsgrid-bg/${seed % N}.jpg`.

---

## Module 10 — Brand Leads (#62)

### Fix #62 — Align sidebar label with page title

Pick ONE. Recommendation: rename sidebar entry to `"Brand Outreach"` since the page also calls it that and "Outreach" is the verb users perform.

**File:** `apps/web/components/layout/sidebar.tsx:48` — `{ name: "Brand Outreach", href: "/dashboard/brand-leads", icon: Star }`.

(Optionally rename the route from `/brand-leads` to `/brand-outreach`. Out of scope unless requested.)

---

## Module 11 — Monitoring (#67)

### Fix #67 — Mask secrets in "Copy for Claude"

**File:** `packages/api/src/routers/monitor.router.ts:184-217`

Add a `redact(text: string): string` helper alongside `exportForClaude`:

```ts
const REDACTORS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]"],
  [/(sk|pk)_(test|live)_[A-Za-z0-9]+/g, "[REDACTED_STRIPE_KEY]"],
  [/AIza[0-9A-Za-z_\-]{35}/g, "[REDACTED_GOOGLE_KEY]"],
  [/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[REDACTED_JWT]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
  [/\b\d{12,19}\b/g, "[REDACTED_NUMBER]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]"],
];
function redact(s: string) { return REDACTORS.reduce((acc, [re, rep]) => acc.replace(re, rep), s); }
```

Apply to every interpolated string in the report builder (lines 206-210).

**Acceptance:** copying a report containing a `Bearer ...` token replaces it with `Bearer [REDACTED]`.

---

## Module 12 — Team (#69–#72)

### Fix #69 + #70 + #71 — Email invitation flow

**Schema:** in `packages/db/prisma/schema.prisma`, add:

```prisma
model OrganizationInvite {
  id             String   @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  email          String
  role           MemberRole @default(MEMBER)
  token          String   @unique
  expiresAt      DateTime
  invitedById    String
  createdAt      DateTime @default(now())
  acceptedAt     DateTime?

  @@index([organizationId])
  @@index([email])
}
```

Run `pnpm db:push` (or `pnpm db:migrate` if creating a migration file).

**Router:** `packages/api/src/routers/team.router.ts`

1. Change `invite` mutation:
   - If a `User` with that email exists AND is already a member → throw `CONFLICT "Already a member."`.
   - If a `User` with that email exists AND not a member → create `OrganizationMember` directly AND send a "you've been added" email.
   - If no `User` exists → create `OrganizationInvite` with `token = randomUUID()` and `expiresAt = +7d`; send invite email containing `https://<host>/invite/${token}`.
2. Add a new mutation `team.acceptInvite({ token })` and procedure `team.getInvite({ token })`.

**Route:** create `apps/web/app/invite/[token]/page.tsx`. On load, fetch the invite. If signed-out, redirect to `/login?invite=${token}` and after login auto-accept. If signed-in, show "Join `<org>` as `<role>`" with an Accept button.

**Email template:** add to `packages/api/src/lib/email.ts` (sibling of existing transactional templates).

**Acceptance:** inviting a new email sends an email; clicking the link signs the user up and adds them to the org as the specified role.

### Fix #72 — Owner transfer + safe leave

**File:** `packages/api/src/routers/team.router.ts`

1. Add a new mutation `transferOwnership({ newOwnerMemberId })` (procedure: must be current OWNER):
   - In a transaction, demote current OWNER → ADMIN; promote target → OWNER.
   - Write audit log.
2. Loosen `updateRole` to allow `"OWNER"` only when called from `transferOwnership` (or accept any role here but enforce "max one OWNER" with a DB constraint).
3. In `removeMember`, if the member is OWNER, require `transferOwnership` first OR `deleteOrganization` if last admin. Error message: `"Transfer ownership before removing the owner."`.
4. In team UI (`apps/web/app/dashboard/team/page.tsx`), add a "Make owner" dropdown action visible only to the current owner; with a confirmation dialog.

**Acceptance:** owner can promote any member to owner and is auto-demoted to admin; organization is no longer orphanable.

---

## Module 13 — Versions (#73–#75)

### Fix #73 + #74 — Single source of truth

**File:** `apps/web/app/dashboard/settings/versions/page.tsx:66-72`, `packages/api/src/routers/deployment.router.ts:7-52`

Pick the DB as truth. Backend:

1. `deployment.current` returns only the DB row marked `status: "active"`. Drop the `process.env.NEXT_PUBLIC_*` fallbacks.
2. On deploy, the CI workflow (`.github/workflows/`) writes a new `Deployment` row before the container swap (already partially done — verify in `scripts/deploy.sh`).

Frontend:

3. Remove the `process.env.NEXT_PUBLIC_*` reads. Use `trpc.deployment.current.useQuery()` exclusively.
4. Display the env-derived build hash only as a small "Build" badge that fetches from `/_next/static/...` if you want a sanity check; otherwise drop.

**Acceptance:** the page shows one consistent version even if `NEXT_PUBLIC_*` is stale.

### Fix #75 — Either real rollback or honest UI

**File:** `packages/api/src/routers/deployment.router.ts:124-171`, `apps/web/app/dashboard/settings/versions/page.tsx`

Pick one:

**A. Real rollback (preferred):** invoke the GitHub Actions workflow_dispatch from the rollback mutation, passing the target commit SHA. Requires `GH_DEPLOY_TOKEN`. After success, mark the DB row.

```ts
await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/deploy.yml/dispatches`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.GH_DEPLOY_TOKEN}`, Accept: "application/vnd.github+json" },
  body: JSON.stringify({ ref: "main", inputs: { commit: target.commitHash } }),
});
```

**B. Honest UI:** keep rollback as DB-only and change the success toast + UI to say `"Rollback requested. Run \`bash scripts/deploy.sh deploy\` on the server to complete."` Add a banner pinned on the page until the active commit matches the rollback target.

Recommendation: **B** for now (less risky); track A as a follow-up issue.

---

## Module 14 — Audit Logs (#76–#79)

### Fix #76 + #77 — Drop hardcoded widths and ID truncation

**File:** `apps/web/app/dashboard/settings/audit-log/page.tsx:313-316,361`

1. Remove `w-[180px]` / `w-[120px]` from `TableHead`. Use a single `<div className="max-w-full overflow-x-auto">` wrapper around the table so columns auto-size; add `whitespace-nowrap` only on Timestamp + Action.
2. Replace `{log.entityId.slice(0, 8)}...` with a `<code className="font-mono text-xs" title={log.entityId}>{log.entityId.slice(0, 8)}…</code>` so hover reveals the full ID. Add a small copy-to-clipboard icon button.

### Fix #78 — Write audit entries from missing routers

**Files:** add `createAuditLog(...)` calls in each:

- `packages/api/src/routers/webhook.router.ts` — create/update/delete.
- `packages/api/src/routers/billing.router.ts` — `createCheckout`, `cancelPlan`, plan changes.
- `packages/api/src/routers/rss.router.ts` — create/update/delete.
- `packages/api/src/routers/agent.router.ts` — create/update/delete/toggle.
- `packages/api/src/routers/autopilot.router.ts` — `triggerPipeline`.
- `packages/api/src/routers/listening.router.ts` — query CRUD.
- `packages/api/src/routers/user.router.ts` — `updatePassword`, `updatePhone`/`removePhone`, `updateProfile`.

Add new action constants to `packages/api/src/lib/audit.ts` (or wherever `AUDIT_ACTIONS` lives): `WEBHOOK_CREATED/UPDATED/DELETED`, `BILLING_CHECKOUT_STARTED`, `BILLING_PLAN_CHANGED`, `RSS_FEED_CREATED`, etc.

### Fix #79 — Don't silently swallow audit failures

**File:** wherever `createAuditLog(...).catch(() => {})` appears.

Change to:

```ts
createAuditLog({ ... }).catch((err) => {
  logger.error("audit_log_write_failed", { err: err.message, action, entityId });
});
```

(Use the existing `@postautomation/logger`.) Do NOT block the user-facing path — keep `.catch`, just log.

**Acceptance:** killing the DB connection during a `team.invite` shows an audit-log error in worker logs without breaking the invite.

---

## Module 15 — API Docs (#80–#86)

### Fix #80 — OpenAPI download in production

**File:** `apps/web/app/api/openapi/route.ts:7-10`

Either:

1. **Keep gated**, but if the user is `OWNER`/`ADMIN`, serve the JSON. Wire the gate via session lookup at the top of the handler.
2. **Open it** (preferred — public OpenAPI is fine if no secrets are baked in): delete lines 7-10.

Either way, the download button in `api-docs/page.tsx:809` should hit the same endpoint. Verify after change.

### Fix #81 — Expand All also expands procedures

**File:** `apps/web/app/dashboard/settings/api-docs/page.tsx:799-800,668`

1. Lift `expanded` state out of `ProcedureCard` into the parent: `const [expandedProcs, setExpandedProcs] = useState<Set<string>>(new Set())` keyed by `${routerName}.${procedureName}`.
2. `expandAll()` populates both `expandedRouters` and `expandedProcs` with everything.
3. Add a sibling `collapseAll()` that empties both.

### Fix #82 — Error documentation section

**File:** `packages/api/src/openapi/generate-spec.ts`

Add a top-level `components.responses` block with the canonical 400/401/403/404/409/422/429/500 schemas. In the OpenAPI spec, reference these via `$ref` from each operation. Add a markdown section to the docs page that explains the error envelope and tRPC error codes.

### Fix #83 — Example outputs

**File:** `apps/web/app/dashboard/settings/api-docs/page.tsx` (lines ~110, ~182, ~364) — add `exampleOutput: { ... }` for `post.getById`, `channel.supportedPlatforms`, `billing.createCheckout`. Use representative shapes from the Prisma models / Stripe SDK.

### Fix #84 — Tighten loose schemas

**File:** `packages/api/src/openapi/generate-spec.ts:226` (and other `{ type: "object" }` hits)

Define proper object shapes. At minimum, `contentVariants` should be `{ type: "object", additionalProperties: { type: "string" } }`. Audit every `{ type: "object" }` and either define `properties` or `additionalProperties`.

### Fix #85 — Enum consistency

**File:** `packages/api/src/openapi/generate-spec.ts` and `apps/web/app/dashboard/settings/api-docs/page.tsx`

Centralise enum lists (e.g. `POST_STATUSES`, `MEMBER_ROLES`) as exported consts from `packages/api/src/lib/enums.ts`. Import everywhere in the spec generator and the docs page so the lists can't drift.

### Fix #86 — Rate limit section

**File:** `packages/api/src/openapi/generate-spec.ts`

Add an `info.description` paragraph documenting:

- Default per-user limit (look up from the rate-limit middleware in `packages/api/src/middleware/rate-limit.ts` if present; otherwise from upstash limits).
- Headers returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- Per-route overrides for AI endpoints.

---

## Module 16 — API Keys / Webhooks / Settings (#87–#96)

### Fix #87 — Mask API key after copy

**File:** `apps/web/app/dashboard/settings/api-keys/page.tsx:53-78`

1. After `navigator.clipboard.writeText(revealedKey)` (the copy handler around line 70-73), call `setRevealedKey(null)` so the warning card disappears.
2. Before disappearing, show a toast: `"Key copied. It will not be shown again."`
3. Display only the prefix + suffix (`sk_abc…xyz`) in any list view; never the full key.

**Acceptance:** key is shown exactly once on creation, hidden immediately after the copy click.

### Fix #88 + #90 + #91 — Strict webhook URL validation

**File:** `packages/api/src/routers/webhook.router.ts:14-20`

Replace `url: z.string().url()` with `url: webhookUrlSchema` (from Fix 0.3). Also enforce in `update` mutation.

### Fix #89 — Humanise webhook toast

**File:** `apps/web/app/dashboard/settings/webhooks/page.tsx:35-37`

Already covered by Fix #3 sweep, but explicitly: `description: humanizeError(err, "Could not create webhook. Check that the URL is HTTPS and reachable.")`.

### Fix #93 — In-app payment method UI (scope)

**File:** `apps/web/app/dashboard/settings/billing/page.tsx`

Full in-app card management is out of scope (Stripe Elements integration is substantial). Recommended minimum:

1. Add `<PaymentMethodCard>` showing brand + last4 + expiry, fetched from `billing.paymentMethod` (new tRPC query that proxies `stripe.paymentMethods.list` for the customer).
2. Provide "Update card" link that still uses the Stripe portal (same as today).

If full in-app cards are required by the user, this becomes its own multi-day story — log it as a follow-up.

### Fix #94 — Reconcile profile name state on success

**File:** `apps/web/app/dashboard/settings/page.tsx:26-33,133-136`

In the mutation's `onSuccess`:

```ts
onSuccess: async (updatedUser) => {
  setName(updatedUser.name ?? "");
  await refetch();
  await utils.user.me.invalidate();
  // also trigger NextAuth session update so the navbar avatar/name refresh:
  await update?.(); // from useSession()
  toast({ title: "Profile updated" });
}
```

`update` here is from `const { update } = useSession()`.

**Acceptance:** changing name reflects everywhere immediately, including the navbar and any other component reading `session.user.name`.

### Fix #95 — OTP re-confirmation for phone removal

**Files:** `apps/web/app/dashboard/settings/page.tsx:347-357`, `packages/api/src/routers/user.router.ts` (the `removePhone` mutation), `packages/api/src/routers/auth.router.ts:205-235` (`sendPhoneOtp` to reuse).

1. Backend: change `removePhone` to take `{ otp: string }` and verify against the same OTP store used for login. Reject if invalid.
2. Frontend: clicking "Remove Number" should:
   - Call `sendPhoneOtp({ phone: currentUser.phone })`.
   - Open a Dialog asking for the 6-digit code.
   - Submit calls `user.removePhone({ otp })`.

**Acceptance:** removing phone requires the OTP that was sent to the phone being removed.

### Fix #96 — Avatar upload

**File:** `apps/web/app/dashboard/settings/page.tsx:117-121`, possibly a new `apps/web/app/api/upload/avatar/route.ts`.

1. Add a file input behind the avatar circle (`<input type="file" accept="image/*" hidden>`); clicking the avatar triggers it.
2. On select: POST to a new `/api/upload/avatar` route that uploads to S3/MinIO (reuse helpers in `packages/api/src/lib/storage.ts` or similar). Return the public URL.
3. Call `user.updateProfile.mutate({ image: url })` and `update()` the session.

Constraints: max 2 MB, only `image/png|jpeg|webp`. Reject on the server too.

**Acceptance:** users can change their avatar; the new image appears in the navbar after save.

---

# Part 3 — Order of attack & sanity checks

1. **Foundations** (Module 0–1) — do the helpers and sidebar/toast/RBAC together. Single PR.
2. **Channels & OAuth UX** (Module 2–3) — gives users a working onboarding once env vars are populated. Single PR.
3. **Content Studio CSV + publishing** (Module 4) — biggest user-visible fix. Single PR; include a Vitest covering the CSV escape + parse round-trip.
4. **Super Agent + Analytics + Media** (Modules 5–6) — UI polish, low risk. Single PR.
5. **RSS + Short Links + Autopilot + NewsGrid + Brand Leads + Monitoring** (Modules 7–11) — group as one polish PR.
6. **Team invites + ownership** (Module 12) — schema migration; own PR; run `pnpm db:migrate` after merge.
7. **Versions + Audit logs** (Modules 13–14) — own PR; mostly backend.
8. **API Docs** (Module 15) — own PR; mostly content-only.
9. **API keys + webhooks + settings polish** (Module 16) — final PR.

After each PR: deploy to staging if available, smoke-test the touched modules, then ship.

## Smoke-test checklist (per deploy)

- `pnpm dev` boots without errors.
- Sign up new email → personal org auto-created → can log in.
- Connect a channel with env vars set → success.
- Connect a channel with env vars empty → toast says "Not configured", no silent redirect.
- Create a post → schedule → see status flow Pending → PUBLISHING → PUBLISHED (or FAILED) within the watchdog window.
- Export CSV → open in Excel on Windows → rows align; multi-line content stays in one row.
- Import that CSV back → identical posts created.
- Invite a non-user email → email arrives → click link → join org.
- Visit Settings/Versions → single version shown, matches `git rev-parse HEAD`.
- Trigger a webhook to `http://127.0.0.1` → rejected by validator.

---

## Out of scope (do NOT touch in this pass)

- Refactoring `(ctx.session.user as any).id` to a typed accessor.
- Replacing manual SSE parser with an SDK in `super-agent/page.tsx`.
- Full Stripe Elements in-app card management.
- Switching deployment from Docker Compose to anything else.
- Renaming routes (e.g. `/brand-leads` → `/brand-outreach`) — UI label change only.
- Adding ABAC on top of RBAC.

If you finish the above and have time, raise the N+1 query in `approval.router.ts:250-269` as a follow-up — not a bug per the QA report.
