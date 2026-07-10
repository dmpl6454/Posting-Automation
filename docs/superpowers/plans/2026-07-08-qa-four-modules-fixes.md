# Four-Module QA Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 16 verified true-positive issues from `PostAutomation_QA_FourModules_2026-07-03.docx` across Autopilot, Social Listening, Brand Campaigns, and Brand Outreach.

**Architecture:** Fixes are grouped by severity then module. Backend (worker/router/Prisma) changes come first where a UI change depends on them; each task is self-contained and independently committable. No schema migration is required for `PipelineRun.status` / `OutreachLead.status` (both are plain `String` columns in Prisma — new enum-like values need no migration). One migration IS added for SL-04 (a nullable sentiment flag) — optional, flagged as such.

**Tech Stack:** Turborepo monorepo · Next.js (apps/web) · BullMQ worker (apps/worker) · tRPC (packages/api) · Prisma/Postgres (packages/db) · React Query · Vitest.

**Verification note:** All 16 issues were verified as true positives against `main @ d4620ec`. Four (AP-04, CM-01, BO-01, BO-02) had inaccuracies in the QA report's description that are corrected in the relevant tasks below.

**Pre-flight for every web task:** the project's lesson is that `tsc` passing ≠ Next build passing. After any `apps/web` change, run:
```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```
and after any `packages/*` or `apps/worker` change, run the targeted vitest + `pnpm --filter <pkg> exec tsc --noEmit`.

---

## Branch setup (do first)

- [ ] **Step 1: Branch off main**

```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation
git checkout main && git pull
git checkout -b fix/qa-four-modules-2026-07-08
```

---

# HIGH SEVERITY

## Task 1: BO-01 — Route outreach EMAIL through SMTP (with Resend fallback) + honest copy

**Report correction:** the worker's email sender is `sendEmail()` inside the *worker* (Resend-only), NOT the shared mailer. The shared SMTP mailer at `packages/api/src/lib/email.ts` (exported `sendEmail({to, subject, html, text?}): Promise<boolean>`) is prod-configured (Google Workspace) and used for password-reset. **User decision: route outreach via SMTP.** We keep Resend as an optional primary (if `RESEND_API_KEY` is set) and fall back to SMTP.

**Critical gotcha:** the shared mailer returns `false` on send failure (never throws) and returns `true` from its *dev-console fallback* when `SMTP_HOST` is unset. The outreach worker's contract is **throw on failure, return "sent" only on real delivery**. So the adapter must (a) translate `false`→throw, and (b) NOT treat the console-preview path as a real send in production. We detect "SMTP actually configured" via `process.env.SMTP_HOST`.

**Files:**
- Modify: `apps/worker/src/workers/outreach-send.worker.ts` (the `sendEmail` function, ~lines 14-35)
- Modify: `apps/web/app/dashboard/brand-leads/page.tsx` (disclosure copy, ~lines 576-582)
- Test: `apps/worker/src/workers/__tests__/outreach-send-email.test.ts` (new)
- Ops (no code): ensure the worker container has the SMTP env vars set

**Production SMTP config (Google Workspace — same account already used for password-reset email):**

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` (STARTTLS) |
| `SMTP_USER` | `hr@digitalsukoon.com` |
| `SMTP_PASS` | **(Google App Password — NOT stored here; already present in prod `.env.prod`, gitignored)** |
| `SMTP_FROM` | `PostAutomation <hr@digitalsukoon.com>` |

> **⚠️ Secret handling — do NOT paste `SMTP_PASS` into this file or any committed file.** This plan is inside the git repo. The 16-char Google App Password lives ONLY in `.env.prod` on the server (gitignored). The worker code reads it from `process.env.SMTP_PASS` — the value never appears in source. These same `SMTP_*` vars already back transactional email in prod, so they are almost certainly already set for the *web* container; the ops step below only confirms the *worker* container also receives them.

**Ops step (run on the server, not in code) — confirm the worker sees the SMTP vars:**
1. Verify the web container already has them (it sends password-reset mail today):
   `ssh posting-automation 'docker exec postautomation-web-1 env | grep -E "^SMTP_(HOST|PORT|USER|FROM)="'` (do NOT grep/print `SMTP_PASS`).
2. Verify the worker container has the same:
   `ssh posting-automation 'docker exec postautomation-worker-1 env | grep -E "^SMTP_(HOST|PORT|USER|FROM)="'`.
3. If the worker is missing them: they are defined once in `.env.prod` and injected via `docker-compose.prod.yml`. Confirm the `worker` service in `docker-compose.prod.yml` inherits the `SMTP_*` keys (add them to its `environment:`/`env_file:` if absent), then `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps worker`.
4. Smoke-test after deploy: approve one seeded lead with a brand email and confirm the worker logs `[OutreachSend] Lead … → SENT` (not `→ FAILED`).

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/workers/__tests__/outreach-send-email.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The email dispatch helper is pure-ish: it picks Resend when RESEND_API_KEY is
// set, otherwise the SMTP mailer, and throws when neither can deliver.
// We import the extracted helper (see Step 3) rather than the whole worker.
import { dispatchOutreachEmail } from "../outreach-send.worker";

const smtpSendMock = vi.fn();
vi.mock("@postautomation/api/email", () => ({
  sendEmail: (...args: any[]) => smtpSendMock(...args),
}));

describe("dispatchOutreachEmail", () => {
  const OLD = { ...process.env };
  beforeEach(() => { smtpSendMock.mockReset(); });
  afterEach(() => { process.env = { ...OLD }; });

  it("uses SMTP and returns 'sent' when SMTP is configured and Resend is not", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_HOST = "smtp.gmail.com";
    smtpSendMock.mockResolvedValue(true);
    const out = await dispatchOutreachEmail("m1", "Hi", "body text", "brand@x.com");
    expect(out).toBe("sent");
    expect(smtpSendMock).toHaveBeenCalledOnce();
    expect(smtpSendMock.mock.calls[0][0]).toMatchObject({ to: "brand@x.com", subject: "Hi" });
  });

  it("throws when SMTP returns false (delivery failure)", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_HOST = "smtp.gmail.com";
    smtpSendMock.mockResolvedValue(false);
    await expect(dispatchOutreachEmail("m1", "Hi", "b", "brand@x.com")).rejects.toThrow(/SMTP/i);
  });

  it("throws when neither Resend nor SMTP is configured (no false 'sent')", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    await expect(dispatchOutreachEmail("m1", "Hi", "b", "brand@x.com"))
      .rejects.toThrow(/no email provider configured/i);
    expect(smtpSendMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/__tests__/outreach-send-email.test.ts`
Expected: FAIL — `dispatchOutreachEmail` is not exported.

- [ ] **Step 3: Implement the SMTP-routed dispatcher**

In `apps/worker/src/workers/outreach-send.worker.ts`, add an import at the top (near the existing imports):

```ts
import { sendEmail as sendSmtpEmail } from "@postautomation/api/email";
```
(If `@postautomation/api` does not expose an `/email` subpath export, import from the package's resolved path used elsewhere in the worker — check an existing `@postautomation/api` import in this file and mirror its specifier; the function is `sendEmail` in `packages/api/src/lib/email.ts`.)

Replace the existing `sendEmail` function (the Resend-only one, ~lines 14-35) with an **exported** `dispatchOutreachEmail` and keep the Resend call as an internal helper:

```ts
async function sendViaResend(subject: string | null, body: string, brandEmail: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY!;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.OUTREACH_FROM_EMAIL ?? process.env.SMTP_FROM ?? "outreach@postautomation.co.in",
      to: brandEmail,
      subject: subject ?? "Partnership Opportunity",
      text: body,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API error ${res.status}: ${text}`);
  }
}

// Outreach email dispatcher. Prefers Resend if configured, otherwise routes
// through the shared SMTP mailer (the one prod uses for transactional email).
// Contract: return "sent" ONLY on real delivery; THROW on any failure. Never
// return "sent" from a dev-console preview (that would falsely claim delivery).
export async function dispatchOutreachEmail(
  _messageId: string,
  subject: string | null,
  body: string,
  brandEmail: string,
): Promise<SendOutcome> {
  if (process.env.RESEND_API_KEY) {
    await sendViaResend(subject, body, brandEmail);
    return "sent";
  }
  if (process.env.SMTP_HOST) {
    const ok = await sendSmtpEmail({
      to: brandEmail,
      subject: subject ?? "Partnership Opportunity",
      // Minimal HTML wrapper so the shared mailer (HTML-first) sends cleanly;
      // plain text preserved for text-only clients.
      html: `<div style="white-space:pre-wrap;font-family:sans-serif">${escapeHtmlText(body)}</div>`,
      text: body,
    });
    if (!ok) throw new Error("SMTP delivery failed (mailer returned false)");
    return "sent";
  }
  throw new Error("No email provider configured (set RESEND_API_KEY or SMTP_HOST)");
}

// Local, dependency-free HTML escaper for the outreach body.
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

Then update the EMAIL case in the dispatch switch (~line 133) to call the renamed function:

```ts
          case "EMAIL":
            if (!signal.brandEmail) throw new Error("No email for brand");
            outcome = await dispatchOutreachEmail(messageId, message.subject, message.body, signal.brandEmail);
            break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/__tests__/outreach-send-email.test.ts`
Expected: PASS (3/3). Then `pnpm --filter @postautomation/worker exec tsc --noEmit` → clean.

- [ ] **Step 5: Fix the disclosure copy**

In `apps/web/app/dashboard/brand-leads/page.tsx`, the "How Brand Outreach works" Alert (~lines 576-582) currently says email "goes out automatically". Read the exact lines first, then adjust the EMAIL sentence to reflect the SMTP path honestly, e.g. replace the "email goes out automatically" clause with: `Email is sent automatically through the platform mailer when a brand email was found.` Keep the LINKEDIN/INSTAGRAM "send manually" copy unchanged.

- [ ] **Step 6: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/worker/src/workers/outreach-send.worker.ts apps/worker/src/workers/__tests__/outreach-send-email.test.ts apps/web/app/dashboard/brand-leads/page.tsx
git commit -m "fix(outreach): route email via SMTP fallback, honest copy (BO-01)"
```

---

## Task 2: AP-01 — Surface autopilot content-generation failures in the UI

**Root cause:** failures ARE persisted (`AutopilotPost.status="FAILED"` + `errorMessage`, `PipelineRun.postsFailed`) but there is **no read path**: `autopilot.reviewQueue` filters `status:"REVIEWING"`, and `autopilot.posts` requires an existing `Post` (never created on a pre-post failure). No query returns FAILED autopilot posts; no UI renders them.

**Fix:** add a `failedPosts` tRPC query returning FAILED `AutopilotPost` rows with `errorMessage`, add a `failedCount` to `overview`, and surface both in the Review page.

**Files:**
- Modify: `packages/api/src/routers/autopilot.router.ts` (add `failedPosts` query; extend `overview`)
- Modify: `apps/web/app/dashboard/autopilot/review/page.tsx` (render a "Failed" section)
- Test: `packages/api/src/__tests__/autopilot-failed-posts.test.ts` (new)

- [ ] **Step 1: Read the current router shape**

Read `packages/api/src/routers/autopilot.router.ts` lines 14-120 (the `overview` and `reviewQueue` procedures) to copy the exact org-scoping pattern (`ctx.organizationId`, `orgProcedure`) and the `AutopilotPost` include shape used by `reviewQueue`.

- [ ] **Step 2: Write the failing test**

Create `packages/api/src/__tests__/autopilot-failed-posts.test.ts`. Mirror the existing router-test harness in this folder (find one that constructs a caller with a mocked `ctx.prisma` + `ctx.organizationId`). Assert:

```ts
// failedPosts returns only status:"FAILED" AutopilotPosts for the caller's org,
// newest first, including errorMessage + agent name + trending item title.
it("failedPosts is org-scoped and filters to FAILED with errorMessage", async () => {
  const findMany = vi.fn().mockResolvedValue([
    { id: "ap1", status: "FAILED", errorMessage: "Anthropic API key not found",
      agent: { name: "News Bot" }, trendingItem: { title: "Headline" }, createdAt: new Date() },
  ]);
  const caller = makeCaller({ prisma: { autopilotPost: { findMany } }, organizationId: "org1" });
  const out = await caller.autopilot.failedPosts({});
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ organizationId: "org1", status: "FAILED" }),
  }));
  expect(out[0].errorMessage).toContain("Anthropic API key not found");
});
```
(Adapt `makeCaller` to the harness actually used in this dir.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/autopilot-failed-posts.test.ts`
Expected: FAIL — `autopilot.failedPosts` does not exist.

- [ ] **Step 4: Add the `failedPosts` query + `overview.failedCount`**

In `packages/api/src/routers/autopilot.router.ts`, add after `reviewQueue` (mirror its `orgProcedure` + include shape):

```ts
  failedPosts: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(30) }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.autopilotPost.findMany({
        where: { organizationId: ctx.organizationId, status: "FAILED" },
        orderBy: { createdAt: "desc" },
        take: input?.limit ?? 30,
        include: {
          agent: { select: { name: true } },
          trendingItem: { select: { title: true } },
        },
      });
    }),
```

In the `overview` query (line 14), add a failed count alongside the existing counts (mirror the existing `count` calls at lines 25/32):

```ts
      const failedCount = await ctx.prisma.autopilotPost.count({
        where: { organizationId: ctx.organizationId, status: "FAILED" },
      });
```
and include `failedCount` in the returned object.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/autopilot-failed-posts.test.ts`
Expected: PASS. Then `pnpm --filter @postautomation/api exec tsc --noEmit` → clean.

- [ ] **Step 6: Surface failures in the Review page**

Read `apps/web/app/dashboard/autopilot/review/page.tsx` to match its card styling. Add a query + a "Generation failures" section rendered when `failedPosts.length > 0`:

```tsx
  const { data: failedPosts } = trpc.autopilot.failedPosts.useQuery({});
  // ...inside the returned JSX, above or below the review queue:
  {failedPosts && failedPosts.length > 0 && (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-destructive">
        Generation failures ({failedPosts.length})
      </h3>
      {failedPosts.map((p) => (
        <Card key={p.id} className="border-destructive/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {p.agent?.name ?? "Agent"} · {p.trendingItem?.title ?? "Untitled"}
            </span>
            <Badge variant="destructive">Failed</Badge>
          </div>
          {p.errorMessage && (
            <p className="mt-1 text-xs text-muted-foreground">{p.errorMessage}</p>
          )}
        </Card>
      ))}
    </div>
  )}
```
(Import `Card`/`Badge` if not already imported in this file.)

- [ ] **Step 7: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add packages/api/src/routers/autopilot.router.ts packages/api/src/__tests__/autopilot-failed-posts.test.ts apps/web/app/dashboard/autopilot/review/page.tsx
git commit -m "feat(autopilot): surface content-generation failures in Review page (AP-01)"
```

---

# MEDIUM SEVERITY

## Task 3: AP-02 — Pipeline run status must reflect all-failed / partial runs

**Root cause:** all three run-settle blocks in `content-generate.worker.ts` write `status:"COMPLETED"` unconditionally once `done >= totalItems`. No branch inspects the generated-vs-failed split.

**Fix:** derive the terminal status from the settled counts. Introduce a tiny pure helper so it's unit-testable and reused across the three blocks (and the trend workers).

**Files:**
- Create: `apps/worker/src/workers/lib/run-status.ts`
- Modify: `apps/worker/src/workers/content-generate.worker.ts` (3 settle blocks: ~L306, ~L383, ~L433)
- Modify: `apps/worker/src/workers/trend-score.worker.ts` (~L204-207)
- Modify: `apps/web/app/dashboard/autopilot/logs/page.tsx` (`runStatusBadge`)
- Test: `apps/worker/src/workers/lib/__tests__/run-status.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/workers/lib/__tests__/run-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveRunStatus } from "../run-status";

describe("deriveRunStatus", () => {
  it("all failed → FAILED", () => {
    expect(deriveRunStatus({ postsGenerated: 0, postsFailed: 9 })).toBe("FAILED");
  });
  it("some failed, some generated → COMPLETED_WITH_ERRORS", () => {
    expect(deriveRunStatus({ postsGenerated: 5, postsFailed: 2 })).toBe("COMPLETED_WITH_ERRORS");
  });
  it("none failed → COMPLETED", () => {
    expect(deriveRunStatus({ postsGenerated: 5, postsFailed: 0 })).toBe("COMPLETED");
  });
  it("empty run (0/0) → COMPLETED (legit empty discovery)", () => {
    expect(deriveRunStatus({ postsGenerated: 0, postsFailed: 0 })).toBe("COMPLETED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/lib/__tests__/run-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/worker/src/workers/lib/run-status.ts`:

```ts
export type TerminalRunStatus = "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";

/**
 * Derive a PipelineRun terminal status from its settled counts.
 * - all items failed (and at least one failed)  → FAILED
 * - some failed, some generated                  → COMPLETED_WITH_ERRORS
 * - none failed (incl. legit empty 0/0 run)      → COMPLETED
 */
export function deriveRunStatus(counts: { postsGenerated: number; postsFailed: number }): TerminalRunStatus {
  const { postsGenerated, postsFailed } = counts;
  if (postsFailed > 0 && postsGenerated === 0) return "FAILED";
  if (postsFailed > 0) return "COMPLETED_WITH_ERRORS";
  return "COMPLETED";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/lib/__tests__/run-status.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Wire the helper into all three content-generate settle blocks**

Add the import to `content-generate.worker.ts`:
```ts
import { deriveRunStatus } from "./lib/run-status";
```
In each of the three settle blocks (no-publishable-channels ~L306, success ~L383, error-catch ~L433), replace the hardcoded completion write:
```ts
              data: { status: "COMPLETED", completedAt: new Date() },
```
with a status derived from the *settled* row (`updated` already holds the post-increment counts):
```ts
              data: { status: deriveRunStatus(updated), completedAt: new Date() },
```
Leave the `scoringDone && updated.totalItems > 0 && done >= updated.totalItems && updated.status === "RUNNING"` guard exactly as-is — it governs *when* we settle; `deriveRunStatus` governs *what* status.

- [ ] **Step 6: Mirror in trend-score.worker.ts**

Read `trend-score.worker.ts` ~L201-207. It has the same `done = postsGenerated + postsFailed` completion write. Apply the same substitution (`import { deriveRunStatus }` + `status: deriveRunStatus(run)` using its settled row). Leave `trend-discover.worker.ts` 0-discovered path AS-IS (an empty discovery is legitimately COMPLETED, which `deriveRunStatus({0,0})` also returns — but that path has no counts row to pass; leave it hardcoded COMPLETED).

- [ ] **Step 7: Render the new statuses in the logs badge**

In `apps/web/app/dashboard/autopilot/logs/page.tsx`, extend `runStatusBadge` (the switch) with:
```tsx
    case "COMPLETED_WITH_ERRORS":
      return (
        <Badge variant="default" className="bg-amber-500">
          Completed with errors
        </Badge>
      );
```
(`FAILED` already renders a destructive badge; the `default` case handles any unknown value.)

- [ ] **Step 8: Build gate + commit**

```bash
pnpm --filter @postautomation/worker exec tsc --noEmit
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/worker/src/workers/lib/run-status.ts apps/worker/src/workers/lib/__tests__/run-status.test.ts apps/worker/src/workers/content-generate.worker.ts apps/worker/src/workers/trend-score.worker.ts apps/web/app/dashboard/autopilot/logs/page.tsx
git commit -m "fix(autopilot): pipeline status reflects failed/partial runs (AP-02)"
```

---

## Task 4: SL-01 — Suppress volume-surge alert without a real baseline

**Report correction:** the 5/11 numbers are REAL publish-date (`mentionedAt`) bucket counts, not fabricated. The bug is that a brand-new query's first sync backfills historical articles and the code reports the publish-date split as a "24h surge" with no baseline. **Fix: guard on query age** — skip the surge alert (and the negative-spike alert, which shares the buckets) until the query is old enough to have a genuine before/after.

**Files:**
- Modify: `apps/worker/src/workers/listening-sync.worker.ts` (~L522-567)
- Test: `apps/worker/src/workers/lib/__tests__/surge-guard.test.ts` (new) — via an extracted pure predicate

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/workers/lib/__tests__/surge-guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hasSurgeBaseline } from "../surge-guard";

const HOUR = 60 * 60 * 1000;
describe("hasSurgeBaseline", () => {
  const now = new Date("2026-07-08T12:00:00Z");
  it("false for a query created 1 minute ago (no baseline yet)", () => {
    expect(hasSurgeBaseline(new Date(now.getTime() - 60 * 1000), now)).toBe(false);
  });
  it("false for a query created 30h ago (< 48h window incomplete)", () => {
    expect(hasSurgeBaseline(new Date(now.getTime() - 30 * HOUR), now)).toBe(false);
  });
  it("true for a query created 3 days ago (full baseline)", () => {
    expect(hasSurgeBaseline(new Date(now.getTime() - 72 * HOUR), now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/lib/__tests__/surge-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the predicate**

Create `apps/worker/src/workers/lib/surge-guard.ts`:

```ts
const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;

/**
 * A volume-surge / negative-spike alert compares the last-24h bucket against
 * the 24-48h-ago bucket. That comparison is only meaningful once the query has
 * been monitoring for the full 48h window — before that, the "previous" bucket
 * is just backfilled historical content, not a real prior baseline.
 */
export function hasSurgeBaseline(queryCreatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - queryCreatedAt.getTime() >= FORTY_EIGHT_HOURS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/lib/__tests__/surge-guard.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Gate both alert blocks in the sync worker**

In `apps/worker/src/workers/listening-sync.worker.ts`: the handler already loads `query` (used in the alert title at L541). Add the import:
```ts
import { hasSurgeBaseline } from "./lib/surge-guard";
```
Wrap the volume-surge block (L536) AND the negative-spike block (L557) so they only fire with a baseline. Change:
```ts
      if (previousCount > 0 && recentCount >= previousCount * 2) {
```
to:
```ts
      if (hasSurgeBaseline(query.createdAt) && previousCount > 0 && recentCount >= previousCount * 2) {
```
and the negative-spike condition at L557 from:
```ts
      if (recentCount > 0 && recentNegative / recentCount > 0.5 && recentNegative >= 3) {
```
to:
```ts
      if (hasSurgeBaseline(query.createdAt) && recentCount > 0 && recentNegative / recentCount > 0.5 && recentNegative >= 3) {
```
Confirm `query` in scope includes `createdAt` (the alert title already reads `query.name`; verify the `findUnique`/`findFirst` that loads `query` selects `createdAt` or selects the full row — if it uses a narrow `select`, add `createdAt: true`).

- [ ] **Step 6: Commit**

```bash
pnpm --filter @postautomation/worker exec tsc --noEmit
git add apps/worker/src/workers/lib/surge-guard.ts apps/worker/src/workers/lib/__tests__/surge-guard.test.ts apps/worker/src/workers/listening-sync.worker.ts
git commit -m "fix(listening): suppress surge/spike alerts without a 48h baseline (SL-01)"
```

---

## Task 5: CM-01 — Validate influencer email format

**Report correction:** the mutation is `createInfluencer` (the report said `addInfluencer`, which is the button label). Field is `contactEmail`.

**Files:**
- Modify: `packages/api/src/routers/campaign.router.ts` (`createInfluencer` input L240, `updateInfluencer` input L260)
- Test: `packages/api/src/__tests__/influencer-email-validation.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/influencer-email-validation.test.ts`. Validate the zod input schema directly (import the schema or the router and call `.createInfluencer` via a caller with a mocked prisma; assert a bad email throws before prisma is touched):

```ts
it("rejects a malformed contactEmail", async () => {
  const create = vi.fn();
  const caller = makeCaller({ prisma: { influencer: { create } }, organizationId: "org1", plan: "PROFESSIONAL" });
  await expect(caller.campaign.createInfluencer({
    name: "X", platform: "instagram", handle: "@x", contactEmail: "not-an-email",
  })).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it("accepts a valid contactEmail and an empty/omitted one", async () => {
  const create = vi.fn().mockResolvedValue({ id: "i1" });
  const caller = makeCaller({ prisma: { influencer: { create } }, organizationId: "org1", plan: "PROFESSIONAL" });
  await caller.campaign.createInfluencer({ name: "X", platform: "instagram", handle: "@x", contactEmail: "a@b.com" });
  await caller.campaign.createInfluencer({ name: "Y", platform: "instagram", handle: "@y" });
  expect(create).toHaveBeenCalledTimes(2);
});
```
(Adapt `makeCaller` + gate-bypass to the harness in this dir; note `gateCampaigns` requires PROFESSIONAL — check how sibling campaign tests bypass it, e.g. `BILLING_DISABLED` env or an `isSuperAdmin` ctx.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/influencer-email-validation.test.ts`
Expected: FAIL — `"not-an-email"` is currently accepted.

- [ ] **Step 3: Add `.email()` to both schemas**

In `packages/api/src/routers/campaign.router.ts`:
- `createInfluencer` input (L240): change `contactEmail: z.string().optional(),` to
  ```ts
      contactEmail: z.string().email().optional().or(z.literal("")),
  ```
- `updateInfluencer` input (L260): change `contactEmail: z.string().nullable().optional(),` to
  ```ts
      contactEmail: z.string().email().nullable().optional().or(z.literal("")),
  ```
The `.or(z.literal(""))` preserves the ability to clear/omit the field (an empty string stays valid; only a non-empty malformed string is rejected).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/influencer-email-validation.test.ts`
Expected: PASS. Then `pnpm --filter @postautomation/api exec tsc --noEmit`.

- [ ] **Step 5: (Optional) client-side hint**

If the "Add Influencer Manually" dialog input in `apps/web/app/dashboard/campaigns/page.tsx` should show inline validation, add `type="email"` to the contactEmail `<Input>`. Server validation (Steps 3-4) is the source of truth; this is a UX nicety.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/campaign.router.ts packages/api/src/__tests__/influencer-email-validation.test.ts
git commit -m "fix(campaigns): validate influencer contactEmail format (CM-01)"
```

---

## Task 6: BO-02 — Mark the lead FAILED when a send fails

**Report correction:** a red "Failed" IS partly visible in the row already via `ChannelDots` (tooltip). But the prominent lead-level chip never flips because the worker never sets `OutreachLead.status="FAILED"`. `STATUS_STYLES.FAILED` / `LEAD_STATUS_LABEL.FAILED` already exist in the UI — no UI work needed.

**Root cause:** the worker's only lead-level write is the SENT flip (the `pendingMsgs === 0` block); `if (error) throw` fires before any lead status write on failure.

**Files:**
- Modify: `apps/worker/src/workers/outreach-send.worker.ts` (before the `if (error) throw` at ~L181)
- Test: extend `apps/worker/src/workers/__tests__/outreach-send-email.test.ts` OR add `outreach-lead-fail.test.ts` — via an extracted pure reconciler

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/workers/lib/__tests__/lead-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reconcileLeadStatus } from "../lead-status";

describe("reconcileLeadStatus", () => {
  it("FAILED when a terminal message failed and no non-failed send remains", () => {
    expect(reconcileLeadStatus({ hasFailed: true, pendingCount: 0, sentCount: 0 })).toBe("FAILED");
  });
  it("SENT when nothing pending and at least one real send", () => {
    expect(reconcileLeadStatus({ hasFailed: false, pendingCount: 0, sentCount: 1 })).toBe("SENT");
  });
  it("null (no change) while sends are still pending", () => {
    expect(reconcileLeadStatus({ hasFailed: false, pendingCount: 2, sentCount: 0 })).toBeNull();
  });
  it("does NOT mark FAILED if a real send also succeeded on another channel", () => {
    expect(reconcileLeadStatus({ hasFailed: true, pendingCount: 0, sentCount: 1 })).toBe("SENT");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/lib/__tests__/lead-status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reconciler**

Create `apps/worker/src/workers/lib/lead-status.ts`:

```ts
/**
 * Decide the lead's terminal status from its message outcomes.
 * - still-pending messages (DRAFT/QUEUED/PENDING_MANUAL) → null (leave as-is)
 * - at least one real SENT → "SENT" (even if another channel failed)
 * - no pending, no real send, and a failure occurred → "FAILED"
 */
export function reconcileLeadStatus(x: {
  hasFailed: boolean;
  pendingCount: number;
  sentCount: number;
}): "SENT" | "FAILED" | null {
  if (x.pendingCount > 0) return null;
  if (x.sentCount > 0) return "SENT";
  if (x.hasFailed) return "FAILED";
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/worker exec vitest run src/workers/lib/__tests__/lead-status.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Wire it into the worker on the failure path**

In `apps/worker/src/workers/outreach-send.worker.ts`, add the import:
```ts
import { reconcileLeadStatus } from "./lib/lead-status";
```
Immediately **before** `if (error) throw new Error(error);` (~L181), reconcile the lead so a terminal failure downgrades it. Replace the existing SENT-only settle block (the `pendingMsgs === 0 → status:"SENT"` block) with a unified reconcile that runs on BOTH success and failure:

```ts
      // Reconcile the lead's terminal status from ALL its message outcomes.
      const [pendingMsgs, sentMsgs, failedMsgs] = await Promise.all([
        prisma.outreachMessage.count({ where: { leadId, status: { in: ["DRAFT", "QUEUED", "PENDING_MANUAL"] } } }),
        prisma.outreachMessage.count({ where: { leadId, status: "SENT" } }),
        prisma.outreachMessage.count({ where: { leadId, status: "FAILED" } }),
      ]);
      const leadStatus = reconcileLeadStatus({
        hasFailed: failedMsgs > 0,
        pendingCount: pendingMsgs,
        sentCount: sentMsgs,
      });
      if (leadStatus) {
        await prisma.outreachLead.update({ where: { id: leadId }, data: { status: leadStatus } });
        console.log(`[OutreachSend] Lead ${leadId} → ${leadStatus}`);
      }

      if (error) throw new Error(error);
```
This runs before the throw, so a FAILED-only lead is downgraded; a lead with a real send elsewhere stays SENT (the reconciler prioritizes SENT over FAILED).

- [ ] **Step 6: Commit**

```bash
pnpm --filter @postautomation/worker exec tsc --noEmit
git add apps/worker/src/workers/lib/lead-status.ts apps/worker/src/workers/lib/__tests__/lead-status.test.ts apps/worker/src/workers/outreach-send.worker.ts
git commit -m "fix(outreach): mark lead FAILED when send fails, surfacing existing chip (BO-02)"
```

---

# LOW SEVERITY

## Task 7: AP-03 — Refresh agent run count after Run Now

**Files:** Modify `apps/web/app/dashboard/autopilot/agents/page.tsx` (`runNowMutation`, L75-78).

- [ ] **Step 1: Add invalidation to onSuccess**

Read L54-78. The query at L54 is `trpc.agent.list.useQuery()`; siblings invalidate via `utils.agent.list.invalidate()`. Update `runNowMutation`:
```tsx
  const runNowMutation = trpc.agent.runNow.useMutation({
    onSuccess: () => {
      alert("Agent queued! Content will appear in the Review Queue shortly.");
      utils.agent.list.invalidate();
      // The AgentRun row is created asynchronously by the worker, so also
      // refetch shortly after to catch the incremented count.
      setTimeout(() => utils.agent.list.invalidate(), 3000);
    },
  });
```
(Confirm `utils` is already defined in this component — siblings use it.)

- [ ] **Step 2: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/app/dashboard/autopilot/agents/page.tsx
git commit -m "fix(autopilot): refetch agent list after Run Now (AP-03)"
```

## Task 8: AP-04 — Add accessible labels to icon-only buttons

**Report correction:** the Run button already has `title="Run Now"` (accessible). Only Edit + Delete (agent cards) and reject-✕ (lead cards) are nameless.

**Files:** Modify `apps/web/app/dashboard/autopilot/agents/page.tsx` (Edit L202-204, Delete L205-213); `apps/web/app/dashboard/brand-leads/page.tsx` (reject button L265-273).

- [ ] **Step 1: Add aria-labels**

Agents page — Edit button: add `aria-label={\`Edit ${agent.name}\`}`. Delete button: add `aria-label={\`Delete ${agent.name}\`}`.
Brand-leads page — reject button: add `aria-label="Reject lead"`.

- [ ] **Step 2: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/app/dashboard/autopilot/agents/page.tsx apps/web/app/dashboard/brand-leads/page.tsx
git commit -m "fix(a11y): label icon-only agent + reject buttons (AP-04)"
```

## Task 9: AP-05 — Replace native confirm() on agent delete with a styled dialog

**Note:** the app ships NO `AlertDialog` primitive. This task adds a minimal reusable `ConfirmDialog` and uses it for agent delete. (Broader rollout to the ~12 other native-confirm sites is out of scope for this QA pass — track separately.)

**Files:**
- Create: `apps/web/components/ui/confirm-dialog.tsx`
- Modify: `apps/web/app/dashboard/autopilot/agents/page.tsx` (delete handler L205-213)

- [ ] **Step 1: Build a ConfirmDialog on the existing Dialog primitive**

Read an existing use of `~/components/ui/dialog` in the repo to match the primitive's API. Create `apps/web/components/ui/confirm-dialog.tsx` — a controlled dialog with a title, description, Cancel + destructive Confirm buttons, driven by `open`/`onOpenChange`/`onConfirm` props.

- [ ] **Step 2: Use it for agent delete**

In `agents/page.tsx`, replace the `if (confirm(...)) deleteMutation.mutate(...)` (L210) with local state (`const [pendingDelete, setPendingDelete] = useState<Agent | null>(null)`), have the trash button `setPendingDelete(agent)`, and render `<ConfirmDialog open={!!pendingDelete} ... onConfirm={() => { deleteMutation.mutate({ id: pendingDelete!.id }); setPendingDelete(null); }} />`.

- [ ] **Step 3: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/components/ui/confirm-dialog.tsx apps/web/app/dashboard/autopilot/agents/page.tsx
git commit -m "fix(autopilot): styled confirm dialog for agent delete (AP-05)"
```

## Task 10: SL-02 — Consistent mention counts after background auto-sync

**Root cause:** badge (`_count.mentions` from `listQueries`), Total Mentions card (`overview.total`), and alert count come from 3 separate queries; nothing refetches them when the worker-driven auto-sync finishes.

**Fix (pragmatic):** poll `listQueries` (which carries the badge count) on a short interval while the page is mounted, so the badge converges without a manual Sync. This matches the existing "background sync we can't be notified of" reality.

**Files:** Modify `apps/web/app/dashboard/listening/page.tsx` (L97 query).

- [ ] **Step 1: Add a refetch interval to the listQueries query**

```tsx
  const { data: queries, isLoading: queriesLoading } = trpc.listening.listQueries.useQuery(
    undefined,
    { refetchInterval: 15_000 }
  );
```
Also add the same `refetchInterval: 15_000` to the `sentimentOverview` (L98) and `alerts` (L106) queries so all three converge together.

- [ ] **Step 2: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/app/dashboard/listening/page.tsx
git commit -m "fix(listening): poll counts so badge/card/alert converge after auto-sync (SL-02)"
```

## Task 11: SL-03 — Remove Facebook from the listening platform chips

**Files:** Modify `apps/web/app/dashboard/listening/page.tsx` (PLATFORMS array L65-73).

- [ ] **Step 1: Remove the Facebook entry**

Read L65-73 and delete the `facebook` object from the `PLATFORMS` array (the worker strips it anyway at L458; the banner says it's unsupported). Leave the worker filter in place as defense-in-depth.

- [ ] **Step 2: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/app/dashboard/listening/page.tsx
git commit -m "fix(listening): drop unsupported Facebook platform chip (SL-03)"
```

## Task 12: CM-02 — Pluralize "brand(s) tracked" and "content item(s)"

**Files:** Modify `apps/web/app/dashboard/campaigns/page.tsx` (L434, and L499 for parity).

- [ ] **Step 1: Conditional plural**

L434: `{campaign._count.brandTrackers} {campaign._count.brandTrackers === 1 ? "brand" : "brands"} tracked`.
L499: `{brand._count.contentItems} {brand._count.contentItems === 1 ? "content item" : "content items"}`.

- [ ] **Step 2: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/app/dashboard/campaigns/page.tsx
git commit -m "fix(campaigns): pluralize brand/content-item counts (CM-02)"
```

## Task 13: BO-03 — Refresh the lead modal chip after logging an outcome

**Root cause:** `previewLead` is a frozen state snapshot; `setStatus.onSuccess` invalidates `list`/`stats` but the modal reads `lead.status` from the stale prop.

**Fix:** after a successful `setStatus`, update the `previewLead` state (which the modal chip reads) to the new status. The mutation returns the updated lead — use it; otherwise patch the status locally.

**Files:** Modify `apps/web/app/dashboard/brand-leads/page.tsx` (`MessagePreviewDialog` L296-299, and lift/patch the `previewLead` state owned by the parent).

- [ ] **Step 1: Patch previewLead on success**

The cleanest fix keeps the modal driven by fresh data. Two options — pick per the component shape you read:
- **(a)** Have `MessagePreviewDialog` accept an `onStatusChange?: (status: string) => void` prop; call it in `setStatus.onSuccess`; the parent updates `previewLead` (`setPreviewLead(prev => prev ? { ...prev, status } : prev)`).
- **(b)** Or, if simpler, make the modal read its status from the live `list` query row by id instead of the frozen prop.

Implement (a): in `setStatus.onSuccess` (L297), after the existing invalidations, call `onStatusChange?.(variables.status)` (the mutation `variables` carry `{ leadId, status }`), and thread the prop from the parent's `<MessagePreviewDialog>` usage (L710) with `onStatusChange={(status) => setPreviewLead((prev) => prev ? { ...prev, status } : prev)}`.

- [ ] **Step 2: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/app/dashboard/brand-leads/page.tsx
git commit -m "fix(outreach): update lead modal chip after outcome (BO-03)"
```

---

# INFO SEVERITY

## Task 14: AP-06 — Label per-channel status chips on multi-channel posts

**Files:** Modify `apps/web/app/dashboard/autopilot/posts/page.tsx` (status-chip map L199-203, `StatusBadge` L42-51).

- [ ] **Step 1: Attach the channel label to each chip**

Read L199-203 + L42-51. The map iterates `targets`; each `t` has `t.channel?.platform`/`t.channel?.name`. Render the channel alongside the status so two same-status targets are distinguishable, e.g.:
```tsx
{targets.map((t) => (
  <span key={t.id} className="inline-flex items-center gap-1">
    <StatusBadge status={t.status} />
    <span className="text-[10px] text-muted-foreground">{t.channel?.name ?? t.channel?.platform}</span>
  </span>
))}
```

- [ ] **Step 2: Build gate + commit**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add apps/web/app/dashboard/autopilot/posts/page.tsx
git commit -m "fix(autopilot): label per-channel status chips (AP-06)"
```

## Task 15: SL-04 — Indicate degraded sentiment scoring + add provider fallback

**Two-part.** (a) Give the sentiment worker a provider fallback (mirror the repurpose/chat `withTextProviderFallback` pattern) so a single provider's absence doesn't silently zero everything. (b) Record a distinct "unscored" state and surface a UI banner when scoring didn't run.

**Files:**
- Modify: `apps/worker/src/workers/sentiment-analysis.worker.ts` (catch block ~L49-58)
- Modify: `packages/db/prisma/schema.prisma` (add `sentimentScored Boolean @default(true)` to `Mention`) — **optional migration**
- Modify: `packages/api/src/routers/listening.router.ts` (`sentimentOverview` to expose an `unscoredCount`)
- Modify: `apps/web/app/dashboard/listening/page.tsx` (banner when unscored > 0)
- Test: `packages/ai` fallback already tested; add a worker test asserting the unscored path.

- [ ] **Step 1: Decide scope with the reviewer**

This is the largest Info item. Confirm whether to do the full data-model change (Prisma migration + UI banner) or the lighter "provider fallback only" first. If lighter: only modify the worker to escalate `[openai→anthropic]` before giving up, and log a distinct `[Sentiment] scoring unavailable` — defer the schema/UI. Record the decision here before coding.

- [ ] **Step 2+ :** (Fill in per Step-1 decision — full steps deferred until scope confirmed; do NOT implement a Prisma migration without the reviewer's go-ahead per repo migration conventions.)

## Task 16: BO-04 — Gate outcome logging until a lead has been sent

**Report correction:** the backend `setStatus` mutation (brand-leads.router.ts L111-127) is ALSO unguarded — this is a backend gap, not only UI.

**Files:**
- Modify: `apps/web/app/dashboard/brand-leads/page.tsx` (`MessagePreviewDialog` outcome buttons L364-373)
- Modify: `packages/api/src/routers/brand-leads.router.ts` (`setStatus` L111-127)
- Test: `packages/api/src/__tests__/brand-leads-setstatus-guard.test.ts` (new)

- [ ] **Step 1: Write the failing backend test**

Assert `setStatus` rejects a manual outcome (REPLIED/INTERESTED/…) when the lead has no SENT message:
```ts
it("rejects marking a PENDING lead as REPLIED (no send yet)", async () => {
  const caller = makeCaller({ /* lead status PENDING, 0 sent messages */ });
  await expect(caller.brandLeads.setStatus({ leadId: "l1", status: "REPLIED" }))
    .rejects.toThrow(/cannot log an outcome before/i);
});
```

- [ ] **Step 2: Guard the mutation**

In `setStatus` (L111-127): for the manual outcomes (`REPLIED|INTERESTED|NOT_INTERESTED|CLOSED`), first check the lead has at least one `OutreachMessage` with `status:"SENT"` (or lead status is `SENT`); else throw `BAD_REQUEST` "Cannot log an outcome before outreach has been sent." Non-outcome status transitions (APPROVED/REJECTED) are unaffected.

- [ ] **Step 3: Disable the buttons in the modal**

In `MessagePreviewDialog` (L364-373), extend the outcome button `disabled` to also disable when the lead hasn't been sent:
```tsx
disabled={setStatus.isPending || lead.status !== "SENT"}
```
and add a one-line note under the outcome row when `lead.status !== "SENT"`: "Available after outreach is sent."

- [ ] **Step 4: Run tests + build gate + commit**

```bash
pnpm --filter @postautomation/api exec vitest run src/__tests__/brand-leads-setstatus-guard.test.ts
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
git add packages/api/src/routers/brand-leads.router.ts packages/api/src/__tests__/brand-leads-setstatus-guard.test.ts apps/web/app/dashboard/brand-leads/page.tsx
git commit -m "fix(outreach): gate outcome logging until sent, UI + server (BO-04)"
```

---

## Final verification

- [ ] **Full test suite:** `pnpm test`
- [ ] **Full type-check:** `pnpm type-check`
- [ ] **Web build:** `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
- [ ] **Worker build:** `pnpm --filter @postautomation/worker exec tsc --noEmit`
- [ ] Confirm the golden-render gate + security-regression suites are still green (they should be untouched — none of these tasks touch `creative-templates.ts` / SSRF / IDOR paths).

## Suggested PR grouping

Given 16 fixes, either one PR (`fix/qa-four-modules-2026-07-08`) with the commits above, or split by severity: PR-A = High+Medium (Tasks 1-6), PR-B = Low+Info (Tasks 7-16). High/Medium first so the two "invisible failure" issues (AP-01, BO-01) ship soonest.
