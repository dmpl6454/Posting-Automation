# Platform Issues + Repurpose Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 12 verified platform issues (production-down captions, autopilot review bypass, NewsGrid black cards, stale badges, missing approval entry-point, and 3 low-severity polish items) and add 3 Repurpose features (per-slide carousel text, postcard header+grid layout, Canva-like free-drag), shipped in risk-ordered phases without regressing any existing behavior.

**Architecture:** Each fix is traced to exact code with file:line evidence (verification workflow + adversarial re-check; 3 candidate issues were refuted and are NOT coded — see design spec Appendix A). The hard constraint is **additive-only with a byte-identical default render path** — new controls default OFF, and with defaults untouched every existing render is byte-identical (render-diff test on the Moviefied reference + a URL case). Work ships as separate PRs per phase: Phase 1 (HIGH/production), Phase 2 (MEDIUM), Phase 3 (LOW), Phase 4 (Repurpose features, one PR each).

**Tech Stack:** Next.js (App Router) + tRPC v11 + Prisma/Postgres + BullMQ worker + LangChain provider abstraction (`@postautomation/ai`) + Puppeteer HTML→PNG creative renderer + Vitest. Package manager: **pnpm** (NOT npm). Run filtered: `pnpm --filter @postautomation/<pkg> <cmd>`.

**Design spec:** [docs/superpowers/specs/2026-06-17-platform-issues-and-repurpose-overhaul-design.md](../specs/2026-06-17-platform-issues-and-repurpose-overhaul-design.md)

---

## ⚠️ Global rules for every task (read before starting)

1. **Additive-only.** Never remove or alter a working code path. Each task lists explicit "do NOT touch" lines.
2. **Verify the web build, not just tsc** (burned in Round 13): for any `apps/web` change, run `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (must exit 0). SWC rejects syntax tsc accepts.
3. **Run tsc BARE, not piped** (a pipe masks the exit code): `pnpm --filter @postautomation/<pkg> exec tsc --noEmit` (neither `@postautomation/ai` nor `@postautomation/api` has a `type-check` script).
4. **Keep security-regression suites green:** `creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, `creative-template-ownership.test.ts`, `chat-action-media.test.ts`, `chat-action-gating.test.ts`, `chat-channel-ownership.test.ts`, `s3-config.test.ts`, `billing-disabled.test.ts`.
5. **Frequent commits** — one commit per completed task (test + impl together).
6. **Phases ship as separate PRs**, in order. Do not start Phase N+1 in the same PR as Phase N.

---

# PHASE 1 — HIGH severity (production-down + safety) · ships FIRST as urgent PR

Branch: `fix/phase1-anthropic-fallback-autopilot-review`

## Task 1: Fix the dead Anthropic model ID (REP-1)

**Why:** `anthropic.provider.ts` hardcodes `claude-sonnet-4-20250514` — a date-suffixed, non-existent model ID that returns 404 `not_found_error`. It is the central Claude provider (used by Super Agent, NewsGrid, Autopilot, Repurpose via `provider.factory.ts`). When OpenAI is down, the `[openai → anthropic]` fallback hits this dead leg, so captions fail entirely (the production screenshots). Valid current IDs (per the claude-api skill, NO date suffix): `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`.

**Files:**
- Modify: `packages/ai/src/providers/anthropic.provider.ts` (whole file, 9 lines)
- Create: `packages/ai/src/__tests__/provider-chain.test.ts`

**Step 1: Write the failing test**

Create `packages/ai/src/__tests__/provider-chain.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTextProviderChain } from "../utils/provider-chain";
import { getAnthropicModel } from "../providers/anthropic.provider";

describe("buildTextProviderChain", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("GOOGLE_GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_AI_API_KEY", "");
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("falls back openai -> anthropic when chosen is openai", () => {
    expect(buildTextProviderChain("openai")).toEqual(["openai", "anthropic"]);
  });
  it("defaults to openai when chosen is undefined", () => {
    expect(buildTextProviderChain(undefined)).toEqual(["openai", "anthropic"]);
  });
});

describe("getAnthropicModel default model id", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses a date-suffix-free claude model id by default", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "");
    const model = getAnthropicModel();
    const modelName =
      (model as unknown as { modelName?: string; model?: string }).modelName ??
      (model as unknown as { model?: string }).model;
    expect(modelName).toBe("claude-sonnet-4-6");
    expect(modelName).not.toMatch(/-\d{8}$/); // load-bearing regression guard
  });
  it("honors the ANTHROPIC_MODEL env override", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-4-6");
    const model = getAnthropicModel();
    const modelName =
      (model as unknown as { modelName?: string; model?: string }).modelName ??
      (model as unknown as { model?: string }).model;
    expect(modelName).toBe("claude-opus-4-6");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test provider-chain`
Expected: FAIL — `expected 'claude-sonnet-4-20250514' to be 'claude-sonnet-4-6'` (and the `/-\d{8}$/` guard fails on the dated id).

**Step 3: Write minimal implementation**

Replace the ENTIRE contents of `packages/ai/src/providers/anthropic.provider.ts`:

```typescript
import { ChatAnthropic } from "@langchain/anthropic";

// Default to claude-sonnet-4-6 (current, non-deprecated alias — no date suffix).
// Operators can override via ANTHROPIC_MODEL without a code change if Anthropic
// rotates model IDs again. (Mirrors the OPENAI_MODEL override in openai.provider.ts.)
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export function getAnthropicModel(temperature = 0.7) {
  return new ChatAnthropic({
    modelName: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    temperature,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test provider-chain` → Expected: PASS
Then: `pnpm --filter @postautomation/ai exec tsc --noEmit` → Expected: no errors.

**Step 5: Commit**

```bash
git add packages/ai/src/providers/anthropic.provider.ts packages/ai/src/__tests__/provider-chain.test.ts
git commit -m "fix(ai): pin valid Claude model id (claude-sonnet-4-6) + ANTHROPIC_MODEL override — re-arms text fallback (REP-1)"
```

**Do NOT touch:** `provider.factory.ts` (correct caller), `provider-chain.ts` (the `[chosen→openai→anthropic]` policy is correct), or the 6 `ANTHROPIC_API_KEY` read sites. The `getAnthropicModel(temperature = 0.7)` signature is unchanged. `ANTHROPIC_MODEL` is read nowhere else (grep-confirmed), so adding it is safe; `.env.example` does not need it (the default applies when unset).

**Deploy note:** This fix only helps in production if `ANTHROPIC_API_KEY` is actually set on `.env.prod`. Confirm it is present before/after deploy; if the OpenAI failures are due to depleted OpenAI credits, this restores captions via the (now-working) Anthropic leg.

---

## Task 2: Remove the hidden autopilot review bypass (AP-1)

**Why:** `content-generate.worker.ts` auto-approves any autopilot post whose `sensitivity === "LOW"` — and LOW is the DEFAULT classification — so most posts skip the Review Queue even when the user's "Skip review gate" toggle is OFF. This lets unreviewed AI content publish.

**Files:**
- Modify: `apps/worker/src/workers/content-generate.worker.ts:325-329`
- Create: `apps/worker/src/workers/__tests__/autopilot-review-gate.test.ts`

**Step 1: Write the failing test**

The decision lives inside a worker closure with bullmq side-effects (not exportable), so mirror it as a pure helper — the same pattern as the existing `apps/worker/src/workers/__tests__/post-publish-state.test.ts`. Create `apps/worker/src/workers/__tests__/autopilot-review-gate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

/** Mirror of content-generate.worker.ts:325-329 skipReview decision (AP-1 fix). */
function decideStatus(args: {
  skipReviewGate?: boolean | null;
  sensitivity: "LOW" | "MEDIUM" | "HIGH";
}): "APPROVED" | "REVIEWING" {
  const skipReview = args.skipReviewGate === true;
  return skipReview ? "APPROVED" : "REVIEWING";
}

describe("autopilot review gate (AP-1)", () => {
  it("LOW sensitivity does NOT auto-approve when skipReviewGate is off", () => {
    expect(decideStatus({ skipReviewGate: false, sensitivity: "LOW" })).toBe("REVIEWING");
    expect(decideStatus({ skipReviewGate: undefined, sensitivity: "LOW" })).toBe("REVIEWING");
    expect(decideStatus({ skipReviewGate: null, sensitivity: "LOW" })).toBe("REVIEWING");
  });
  it("still auto-approves when the explicit skipReviewGate is on", () => {
    expect(decideStatus({ skipReviewGate: true, sensitivity: "LOW" })).toBe("APPROVED");
    expect(decideStatus({ skipReviewGate: true, sensitivity: "HIGH" })).toBe("APPROVED");
  });
  it("HIGH/MEDIUM go to review unless explicitly skipped", () => {
    expect(decideStatus({ skipReviewGate: false, sensitivity: "HIGH" })).toBe("REVIEWING");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/worker test autopilot-review-gate`
Expected: FAIL — the mirrored helper here already encodes the FIXED logic, so to make the test meaningfully red first, temporarily write the OLD logic (`args.skipReviewGate || args.sensitivity === "LOW"`) in the helper, run → the first test FAILS (LOW auto-approves). Then apply the fixed helper above → it passes. (This proves the test discriminates the bug.)

**Step 3: Write minimal implementation**

In `apps/worker/src/workers/content-generate.worker.ts`, replace lines 325-329:

OLD:
```typescript
        // 11. Determine review status
        const skipReview =
          agent.accountGroup?.skipReviewGate ||
          autopilotPost.sensitivity === "LOW";
        const finalStatus = skipReview ? "APPROVED" : "REVIEWING";
```

NEW:
```typescript
        // 11. Determine review status
        // Auto-approval is governed ONLY by the account group's explicit
        // skipReviewGate opt-in. Sensitivity is advisory metadata and must NOT
        // bypass review — a LOW classification (also the classifier's default
        // when no keywords match) previously auto-approved nearly every post.
        const skipReview = agent.accountGroup?.skipReviewGate === true;
        const finalStatus = skipReview ? "APPROVED" : "REVIEWING";
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/worker test autopilot-review-gate` → PASS
Then: `pnpm --filter @postautomation/worker exec tsc --noEmit` → no errors.

**Step 5: Commit**

```bash
git add apps/worker/src/workers/content-generate.worker.ts apps/worker/src/workers/__tests__/autopilot-review-gate.test.ts
git commit -m "fix(worker): autopilot review governed only by explicit skipReviewGate, not LOW sensitivity (AP-1)"
```

**Do NOT touch:** the sensitivity classifier's LOW default or the `sensitivity` column (still useful advisory metadata). `finalStatus` keeps the same `"APPROVED" | "REVIEWING"` type, so the 3 downstream consumers (status write, the `if (finalStatus === "APPROVED")` schedule-queue gate, `postsApproved` increment) are unchanged. The explicit `skipReviewGate=true` path still auto-approves.

**Note (connects to Phase 2 APPR-1):** Posts that go to `REVIEWING` should ideally create an `ApprovalRequest`. That wiring is APPR-1 (Task 7). For Phase 1, the minimal safety fix is just stopping the bypass; the Review Queue already surfaces `REVIEWING` posts.

**Phase 1 close-out:** open PR `fix/phase1-anthropic-fallback-autopilot-review`; run full `pnpm --filter @postautomation/ai test` + `@postautomation/worker test`; merge; deploy; verify captions generate in prod (toggle AI Text Provider to Anthropic and confirm no 404) and that a fresh autopilot LOW post lands in the Review Queue.

---

# PHASE 2 — MEDIUM severity · separate PR

Branch: `fix/phase2-newsgrid-bg-logs-listening-approvals`

## Task 3: Fix NewsGrid black-background fallback (NG-1)

**Why:** The creative is rasterized via `page.setContent(html, { waitUntil: "load" })` (`news-image-generator.ts:118`), so the page base URL is `about:blank`. The stock fallback `background-image: url(/newsgrid-bg/bg-N.svg)` is a SITE-ROOT-RELATIVE url → never resolves under `about:blank` → `.bg-photo` stays transparent → `body{background:#000}` (line 239) shows through = a pure-black card. The happy path (real photo as a `data:` URI) is unaffected. Fix: replace the relative-url fallback with a self-contained inline CSS `linear-gradient`, deterministic per `seed` (mirroring the old 6-SVG hue rotation).

**Files:**
- Modify: `packages/ai/src/tools/news-card-template.ts:213-216` (the fallback) and `:240` (`.bg-photo`) and `:239` (`body` background base)
- Create: `packages/ai/src/__tests__/news-card-fallback.test.ts`

**Step 1: Write the failing test**

Create `packages/ai/src/__tests__/news-card-fallback.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateStaticNewsCreativeHtml } from "../tools/news-card-template";

const base = {
  headline: "Big news today about something important",
  channelName: "Acme News",
  handle: "@acme",
  // no backgroundImageUrl → exercises the fallback
};

describe("NewsGrid no-photo fallback (NG-1)", () => {
  it("does NOT reference a site-root-relative SVG (unresolvable under about:blank)", () => {
    const html = generateStaticNewsCreativeHtml(base as any);
    expect(html).not.toMatch(/url\(\/newsgrid-bg\//);
  });
  it("uses a self-contained CSS gradient fallback so the card is never pure-black", () => {
    const html = generateStaticNewsCreativeHtml(base as any);
    expect(html).toMatch(/linear-gradient/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/ai test news-card-fallback`
Expected: FAIL — the html still contains `url(/newsgrid-bg/bg-N.svg)` and no gradient fallback. (Confirm the exact exported function name first: `grep -n "export function generateStaticNewsCreativeHtml" packages/ai/src/tools/news-card-template.ts`; if the export name differs, update the import.)

**Step 3: Write minimal implementation**

In `packages/ai/src/tools/news-card-template.ts`, replace lines 213-216:

OLD:
```typescript
  // Fix #56: use local fallback backgrounds instead of loremflickr.com (external service)
  const LOCAL_BG_COUNT = 6;
  const localBg = `/newsgrid-bg/bg-${(seed % LOCAL_BG_COUNT) + 1}.svg`;
  const bgUrl = options.backgroundImageUrl || localBg;
```

NEW:
```typescript
  // Fix (NG-1): the template is rasterized via page.setContent (base URL = about:blank),
  // so a RELATIVE /newsgrid-bg/bg-N.svg never resolves → .bg-photo stays empty →
  // body{background:#000} showed through as a pure-black card. Use a self-contained
  // inline CSS linear-gradient as the no-AI fallback (deterministic per `seed`,
  // mirroring the old 6-SVG hue rotation). Real photos still arrive as a data: URI
  // in options.backgroundImageUrl and override this on .bg-photo.
  const LOCAL_BG_COUNT = 6;
  const fallbackHue = (seed % LOCAL_BG_COUNT) * 60; // 0,60,120,180,240,300 — same rotation as the old SVGs
  const fallbackGradient = `linear-gradient(135deg, hsl(${fallbackHue}, 38%, 18%) 0%, hsl(${fallbackHue}, 42%, 9%) 100%)`;
  const bgUrl = options.backgroundImageUrl || "";
```

Then update line 240 (`.bg-photo`) to apply the gradient as its background and only layer the photo when present:

OLD:
```typescript
.bg-photo{position:absolute;inset:0;background-image:url(${bgUrl});background-size:cover;background-position:center top;}
```

NEW:
```typescript
.bg-photo{position:absolute;inset:0;background:${fallbackGradient};${bgUrl ? `background-image:url(${bgUrl});background-size:cover;background-position:center top;` : ""}}
```

(Leave the `body{...background:#000...}` on line 239 as-is — it's now only a base layer behind the always-painted `.bg-photo` gradient, so it never shows through.)

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/ai test news-card-fallback` → PASS
Then: `pnpm --filter @postautomation/ai exec tsc --noEmit` → no errors.
Also run the existing creative suites to confirm no regression: `pnpm --filter @postautomation/ai test creative-templates creative-theme card-engine`.

**Step 5: Commit**

```bash
git add packages/ai/src/tools/news-card-template.ts packages/ai/src/__tests__/news-card-fallback.test.ts
git commit -m "fix(ai): self-contained gradient fallback for NewsGrid (relative SVG never resolved under about:blank) (NG-1)"
```

**Do NOT touch:** the happy path — when `options.backgroundImageUrl` is a real `data:` URI, `.bg-photo` still gets `background-image:url(<data-uri>)` which paints over the gradient. `fallbackHue`/`fallbackGradient` are pure numeric arithmetic (no user input) → do NOT wrap them in `safeColor()`/`escapeHtml()` (that would corrupt the valid `hsl()` syntax). The 6 SVG files in `apps/web/public/newsgrid-bg/` become dead assets — leave them (harmless) or delete in a follow-up.

**Optional secondary (same task or a follow-up):** add `generateImageSafe` (Gemini→OpenAI) to the NewsGrid generate mutation (`newsgrid.router.ts:282-317`) so the interactive path gets a real AI photo via OpenAI when Gemini is billing-held — mirroring `repurpose.router.ts`. Keep the existing `bgPrompt` (it already forbids text/words/logos and asks for dark tones) and do NOT pass `referenceImages`. The PRIMARY fix above already removes the black card, so this is purely an enhancement — gate it behind the byte-identical rule (no change when a photo is already present).

---

## Task 4: Fix Autopilot Pipeline Logs field names (AP-3)

**Why:** The logs UI reads camelCase keys that don't exist on the row (`run.discovered`, `run.generated`, `run.finishedAt`, …) instead of the real Prisma `PipelineRun` fields (`itemsDiscovered`, `postsGenerated`, `completedAt`, …). The query is a pass-through `findMany` with no aliasing, and the data is typed `any`, so tsc never caught it — every `run.X != null` is `undefined != null` = false, so the Stats row and Duration silently never render. Data IS captured; this is a pure UI rename.

**Files:**
- Modify: `apps/web/app/dashboard/autopilot/logs/page.tsx:69-101`

**Step 1 (verify-first, no automated test infra for this page):** confirm the real field names:
`grep -n "itemsDiscovered\|itemsScored\|postsGenerated\|postsApproved\|postsScheduled\|postsFailed\|completedAt" packages/db/prisma/schema.prisma` (expect lines ~853-861).

**Step 2: Apply the field-name fix.** In `apps/web/app/dashboard/autopilot/logs/page.tsx`, replace the Stats + Duration blocks (lines 69-101) using this mapping:

| UI old key | Real schema field |
|---|---|
| `run.discovered` | `run.itemsDiscovered` |
| `run.scored` | `run.itemsScored` |
| `run.generated` | `run.postsGenerated` |
| `run.approved` | `run.postsApproved` |
| `run.scheduled` | `run.postsScheduled` |
| `run.failed` | `run.postsFailed` |
| `run.finishedAt` | `run.completedAt` |

NEW:
```tsx
                {/* Stats */}
                <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {run.itemsDiscovered != null && (
                    <span>Discovered: {run.itemsDiscovered}</span>
                  )}
                  {run.itemsScored != null && <span>Scored: {run.itemsScored}</span>}
                  {run.postsGenerated != null && (
                    <span>Generated: {run.postsGenerated}</span>
                  )}
                  {run.postsApproved != null && (
                    <span>Approved: {run.postsApproved}</span>
                  )}
                  {run.postsScheduled != null && (
                    <span>Scheduled: {run.postsScheduled}</span>
                  )}
                  {run.postsFailed != null && run.postsFailed > 0 && (
                    <span className="font-medium text-destructive">
                      Failed: {run.postsFailed}
                    </span>
                  )}
                </div>

                {/* Duration */}
                {run.completedAt && run.startedAt && (
                  <span className="text-xs text-muted-foreground">
                    {Math.round(
                      (new Date(run.completedAt).getTime() -
                        new Date(run.startedAt).getTime()) /
                        1000
                    )}
                    s
                  </span>
                )}
```

**Step 3: Verify** — `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0). Manual: `/dashboard/autopilot/logs` after at least one pipeline run → counts + duration now render.

**Step 4: Commit**

```bash
git add apps/web/app/dashboard/autopilot/logs/page.tsx
git commit -m "fix(web): autopilot pipeline logs read real PipelineRun fields (itemsDiscovered/postsGenerated/completedAt) (AP-3)"
```

**Do NOT touch:** `run.status`, `run.startedAt`, `run.createdAt`, `run.id` (already correct). No DB migration, no API change.

---

## Task 5: Fix Social Listening stale mention badge (SL-1)

**Why:** After a Sync brings in new mentions, the per-query tab badge (`q._count.mentions`, line 317) stays stale until a page refresh. `syncMutation.onSuccess` invalidates `mentions` + `sentimentOverview` but NOT `listQueries` (where `_count.mentions` lives). Delete/create/update mutations already invalidate `listQueries` (that's why SL-2 was refuted — delete works); sync is the lone outlier.

**Files:**
- Modify: `apps/web/app/dashboard/listening/page.tsx:139-144`

**Step 1: Apply the one-line additive fix.**

OLD:
```typescript
  const syncMutation = trpc.listening.triggerSync.useMutation({
    onSuccess: () => {
      utils.listening.mentions.invalidate();
      utils.listening.sentimentOverview.invalidate();
    },
  });
```

NEW:
```typescript
  const syncMutation = trpc.listening.triggerSync.useMutation({
    onSuccess: () => {
      utils.listening.mentions.invalidate();
      utils.listening.sentimentOverview.invalidate();
      utils.listening.listQueries.invalidate();
    },
  });
```

**Step 2: Verify** — `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0). Manual: `/dashboard/listening`, note a tab badge count, click Sync Now, confirm the badge updates WITHOUT a refresh.

**Step 3: Commit**

```bash
git add apps/web/app/dashboard/listening/page.tsx
git commit -m "fix(web): invalidate listQueries after sync so mention badge updates without refresh (SL-1)"
```

**Do NOT touch:** the existing `mentions`/`sentimentOverview` invalidations (unchanged; one line appended). Match the file's 2-space indentation.

---

## Task 6: Add an "Submit for review" entry point (APPR-1)

**Why:** `approval.submit` (`approval.router.ts:6-77`) is fully implemented but has ZERO callers app-wide — there is no UI to raise an approval request. This is NEW UI calling an EXISTING, tested mutation (additive; do NOT modify the router).

**Verified facts:**
- Mutation input (zod): `{ postId: z.string(), reviewerIds: z.array(z.string()).min(1) }`. `reviewerIds` are **USER ids** (`ApprovalStep.reviewerId` is a userId), so pass `m.user.id`, NOT the membership id.
- Reviewer list source: `trpc.team.members.useQuery()` → `OrganizationMember[]` each with `.user {id,name,email,image}`. Already org-scoped (orgProcedure) — no extra IDOR work.
- Mount point: the post DETAIL page `apps/web/app/dashboard/posts/[id]/page.tsx` (a concrete `postId` exists there; `ComposeTab.createPost.onSuccess` already navigates here). Do NOT mount in ComposeTab — its success path clears state and routes away, so no `postId` is retained.
- Gate the button to `status === "DRAFT"` (the router rejects a 2nd PENDING request for the same post; `humanizeError` surfaces the conflict if it happens).

**Files:**
- Modify: `apps/web/app/dashboard/posts/[id]/page.tsx` (add the button + reviewer-picker dialog)
- Create: `packages/api/src/__tests__/approval-submit.test.ts`

**Step 1: Write the failing test** (prisma-mock pattern, like `chat-action-media.test.ts:1-19` — mock `ctx.prisma`, no live DB). Create `packages/api/src/__tests__/approval-submit.test.ts` asserting: given a DRAFT post owned by the org and `reviewerIds: ["u1"]`, `approval.submit` creates an `ApprovalRequest` + `ApprovalStep` and does NOT throw; and that an empty `reviewerIds` is rejected by zod. (Drive the resolver with a mocked ctx, or extract the submit body into a testable helper — see the router for the exact prisma calls to mock: `post.findFirst`, `approvalRequest.create`, the conflict check at lines 26-37.)

**Step 2: Run** `pnpm --filter @postautomation/api test approval-submit` → FAIL (helper/wiring not present yet).

**Step 3: Implement the UI.** In the `posts/[id]` client component add:

```tsx
  const [reviewerOpen, setReviewerOpen] = useState(false);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const { data: members } = trpc.team.members.useQuery();
  const utils = trpc.useUtils();
  const submitForReview = trpc.approval.submit.useMutation({
    onSuccess: () => {
      toast({ title: "Sent for review", description: "Reviewers have been notified." });
      setReviewerOpen(false);
      utils.post.getById.invalidate();        // refresh the post status badge
    },
    onError: (e) => toast({ title: "Couldn't submit", description: humanizeError(e), variant: "destructive" }),
  });
```

Render a "Submit for review" button (only when `post.status === "DRAFT"`) that opens a dialog listing `members` as checkboxes (`value = m.user.id`, label `m.user.name ?? m.user.email`, exclude the current user), with a confirm that calls `submitForReview.mutate({ postId: post.id, reviewerIds })` (disabled until `reviewerIds.length >= 1`). Reuse existing `Dialog/Button/Badge/Checkbox` components.

**Step 4: Verify** — `pnpm --filter @postautomation/api test approval-submit` PASS; `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0). Manual: open a DRAFT post → Submit for review → pick a reviewer → the reviewer sees it in `/dashboard/approvals`.

**Step 5: Commit**

```bash
git add apps/web/app/dashboard/posts/[id]/page.tsx packages/api/src/__tests__/approval-submit.test.ts
git commit -m "feat(web): add 'Submit for review' entry point wiring the existing approval.submit mutation (APPR-1)"
```

**Do NOT touch:** the `approval.router.ts` zod schema or resolver (already correct/tested). Note: `approval.list` only returns requests where the CURRENT user is a reviewer, so a submitter won't see their own request unless they're also a reviewer — expected.

**Optional follow-up (connects AP-1):** extract the submit body into a shared helper and have the autopilot path call it so `REVIEWING` autopilot posts create real `ApprovalRequest` rows. Out of scope for this task; note for a Phase 2.5 if desired.

**Phase 2 close-out:** PR `fix/phase2-newsgrid-bg-logs-listening-approvals`; full `@postautomation/ai` + `@postautomation/api` test runs + web build; merge; deploy.

---

# PHASE 3 — LOW severity (polish) · separate PR

Branch: `fix/phase3-zod-toast-plural-delete-confirm`

## Task 7: Stop raw Zod-JSON leaking into toasts (RSS-1)

**Why:** `humanizeError` (`apps/web/lib/errors.ts:22-34`) only filters known technical substrings + messages > 240 chars. A short (~128-char) Zod-error JSON (e.g. a malformed RSS feed URL) matches no pattern and is < 240 chars → it's shown verbatim in the toast. The errorFormatter (`packages/api/src/trpc.ts:35-44`) ALREADY exposes a structured `data.zodError` (`error.cause.flatten()`) — currently unused. This is SHARED across 15+ `humanizeError` call sites, so fixing the helper fixes them all.

**Files:**
- Modify: `apps/web/lib/errors.ts:22-34`
- Create: `apps/web/__tests__/errors.test.ts` (if no apps/web vitest config exists, see note below)

**Step 1: Write the failing test.** First check whether `apps/web` has a vitest setup (`ls apps/web/vitest.config.* 2>/dev/null` and check the root `vitest.config.ts` `include` globs). If apps/web tests aren't wired, place this in the root-discoverable test location used by other web utils, or skip the automated test and rely on the manual repro + the byte check. Test contents:

```typescript
import { describe, it, expect } from "vitest";
import { humanizeError } from "../lib/errors";

describe("humanizeError (RSS-1)", () => {
  it("does not leak raw Zod-issue JSON", () => {
    const zodJson = '[{"validation":"url","code":"invalid_string","message":"Invalid url","path":["url"]}]';
    const out = humanizeError({ message: zodJson });
    expect(out).not.toContain('"validation"');
    expect(out).not.toContain("[{");
  });
  it("prefers the structured data.zodError when present", () => {
    const out = humanizeError({
      message: "[{...}]",
      data: { zodError: { fieldErrors: { url: ["Invalid url"] }, formErrors: [] } },
    });
    expect(out.toLowerCase()).toContain("url");
  });
  it("still returns plain friendly messages unchanged", () => {
    expect(humanizeError({ message: "URL does not appear to be a valid RSS or Atom feed." }))
      .toBe("URL does not appear to be a valid RSS or Atom feed.");
  });
});
```

**Step 2: Run** → FAIL (current helper returns the raw JSON).

**Step 3: Implement.** Replace the body of `humanizeError` in `apps/web/lib/errors.ts`:

```typescript
export function humanizeError(
  err: unknown,
  fallback = "Something went wrong. Please try again."
): string {
  // Prefer the structured Zod error the tRPC errorFormatter already populates.
  const zodError = (err as any)?.data?.zodError;
  if (zodError && typeof zodError === "object") {
    const fieldErrors = zodError.fieldErrors as Record<string, string[] | undefined> | undefined;
    const formErrors = zodError.formErrors as string[] | undefined;
    const first =
      formErrors?.[0] ??
      (fieldErrors && Object.values(fieldErrors).flat().filter(Boolean)[0]);
    if (first) return String(first);
    return "Please check the highlighted fields and try again.";
  }

  const msg =
    typeof err === "string" ? err : (err as any)?.message ?? "";
  if (!msg) return fallback;
  // A raw Zod issue array leaks as JSON starting with "[{" — never show it.
  if (msg.trim().startsWith("[{")) return "Please check your input and try again.";
  if (TECHNICAL_PATTERNS.some((re) => re.test(msg))) return fallback;
  if (msg.length > 240) return fallback;
  return msg;
}
```

**Step 4: Run** → PASS. Then `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0).

**Step 5 (optional defense-in-depth):** in `apps/web/app/dashboard/rss/page.tsx` `handleCreate` (lines ~100-114), add a client-side URL-format check before `createFeed.mutate` so a malformed URL never reaches the server.

**Step 6: Commit**

```bash
git add apps/web/lib/errors.ts apps/web/__tests__/errors.test.ts apps/web/app/dashboard/rss/page.tsx
git commit -m "fix(web): humanizeError reads structured zodError + never leaks raw Zod JSON in toasts (RSS-1)"
```

**Do NOT touch:** `TECHNICAL_PATTERNS` (kept) or the errorFormatter (already correct). This is centralized — all 15+ callers benefit; verify no caller depended on the raw JSON (none do — they pass it straight to toasts).

## Task 8: Fix "1 channels" pluralization (NG-2)

**Files:** Modify `apps/web/app/dashboard/newsgrid/page.tsx:771` and `:884`.

Line 771 (the Generating button) — OLD:
```tsx
                <><Loader2 className="h-4 w-4 animate-spin" /> Generating for {selectedChannelIds.size} channels…</>
```
NEW (mirror line 773's existing correct pattern):
```tsx
                <><Loader2 className="h-4 w-4 animate-spin" /> Generating for {selectedChannelIds.size} channel{selectedChannelIds.size !== 1 ? "s" : ""}…</>
```

Line 884 (the results header) — OLD:
```tsx
                {results.length} channels generated
```
NEW:
```tsx
                {results.length} channel{results.length !== 1 ? "s" : ""} generated
```

**Verify:** `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0).
**Commit:** `git commit -am "fix(web): pluralize channel count strings in NewsGrid (NG-2)"`
**Do NOT touch:** line 773 (already correct).

## Task 9: Confirm before autopilot agent delete (AP-4)

**Files:** Modify `apps/web/app/dashboard/autopilot/agents/page.tsx:210`.

OLD:
```tsx
                    onClick={() => deleteMutation.mutate({ id: agent.id })}
```
NEW (matches the `confirm()` pattern used by rss/campaigns/channels):
```tsx
                    onClick={() => { if (confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) deleteMutation.mutate({ id: agent.id }); }}
```

**Verify:** `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` (exit 0). Manual: click trash → Cancel → no delete; OK → deletes.
**Commit:** `git commit -am "fix(web): confirm() before deleting an autopilot agent (AP-4)"`
**Do NOT touch:** the `deleteMutation` declaration (lines 71-73). `agent.name` is a plain JS template literal here (no HTML context) — no escaping needed.

**Phase 3 close-out:** PR `fix/phase3-zod-toast-plural-delete-confirm`; web build; merge; deploy.

---

# PHASE 4 — Repurpose features · ONE PR EACH

> These are NET-NEW capabilities. The HARD safety bar applies: every new control defaults OFF, and with defaults untouched the rendered output is **byte-identical** to today. Establish the render-diff gate FIRST (Task 10), then build each feature against it.

## Task 10: Establish the byte-identical render-diff safety gate (prerequisite)

**Why:** This is the testable form of "do not sabotage existing work." Before any feature code, capture golden renders so any later change that alters a default-path output fails CI.

**Files:** Create `packages/ai/src/__tests__/repurpose-render-golden.test.ts`.

**Steps:**
1. Identify the pure `opts → HTML` entry points already used by Repurpose: `buildStaticCreative(opts)` (creative-templates.ts) and the mimicry layout-extract path. (These are deterministic HTML builders — ideal for golden snapshots; PNG rasterization is non-deterministic so snapshot the HTML, not the PNG.)
2. Write a test that builds HTML for: (a) a `premium_editorial` static creative with a fixed opts object (the "Moviefied / Ranbir look"), (b) a `hook_bars` creative, (c) a `tweet_card` creative, (d) `bold_typographic`, each with NO new options set. Use vitest `toMatchSnapshot()`.
3. Run `pnpm --filter @postautomation/ai test repurpose-render-golden -u` once to capture the golden snapshots; commit them.
4. **Rule for Tasks 11-13:** after each feature, run this suite WITHOUT `-u`. If a snapshot changes while the new options are unset, the change sabotaged a default path → revert and make it opt-in.

**Commit:** `git commit -m "test(ai): golden HTML snapshots for the 4 creative styles — byte-identical default-path gate (Phase 4 prereq)"`

## Task 11: Per-slide carousel text editing (REP-2) — separate PR

Branch: `feat/repurpose-per-slide-text`

**Why:** Today carousel slide text is all AI-generated; only slide-0 (cover) has Regenerate, and the inline headline edit renders only for single static (`mediaUrls.length === 1`). Users cannot set/edit per-slide text.

**Scope (decided D7):** inline editable headline + body per slide (cover, every body slide, CTA) + per-slide Regenerate-image button.

**Approach (additive):**
1. **Backend:** the carousel branch in `repurpose.router.ts` already produces an ordered slide array with `{ title, body }` and `carouselMediaIds`. Add an OPTIONAL `slideOverrides?: Array<{ index: number; headline?: string; body?: string }>` input to the regenerate/render mutation. When absent → existing AI text (byte-identical). When present → the matching slide renders with the override text. Add a `regenerateSlide` mutation (or extend `regenerateImage` with a `slideIndex`) that re-renders ONE slide by index using its (possibly overridden) text + the existing branding — mirroring the existing slide-0 regenerate path, just parameterized by index.
2. **UI (`RepurposeTab.tsx`):** in the carousel result view, render per slide: an editable headline `Input` + body `Textarea` (seeded from the AI text) + a per-slide "Regenerate" button calling the indexed mutation. On "Create Drafts", pass the edited text through (the slides already attach via `carouselMediaIds`).
3. **State:** keep a `slideEdits: Record<number, {headline?,body?}>` map; default empty = no change.

**TDD:** add an api test asserting that with no `slideOverrides` the rendered slide text equals the AI text (byte-identical), and with an override the slide uses the override. Reuse the golden gate (Task 10) — the static/cover default path must not change.

**Do NOT touch:** the AI slide-generation (`enforceSlideCount`, the CTA default) — overrides layer ON TOP. The cover's existing slide-0 Regenerate must keep working. Verify: `pnpm --filter @postautomation/api test`, `@postautomation/ai test`, web build.

**Commit/PR:** `feat(repurpose): per-slide headline+body editing and per-slide regenerate for carousels (REP-2)`.

## Task 12: Postcard header + photo-grid layout (REP-3) — separate PR

Branch: `feat/repurpose-postcard-grid`

**Why:** The Moviefied-style layout (tweet-header above a photo collage in ONE static image) is not producible — the router only feeds one `bgImageUrl`; the engine has `renderTweetHeader` + `photoGrid`/`splitPhotos` primitives but they're unwired; no multi-image slot UI.

**Scope (decided D5/D6):** fixed-preset collages (**2-up, 3-up [1 big + 2 below], 2×2**) rendered as a single composited 1080×1350 PNG, header above grid; grid slots filled from **uploads (primary) / article-scraped images / AI-per-empty-slot**.

**Approach (additive — reuses existing engine primitives):**
1. **Renderer:** add a new `CreativeStyle` (e.g. `tweet_grid`) OR a new builder `buildPostcardGrid(opts)` in `creative-templates.ts` that composes the EXISTING `renderTweetHeader` block above a NEW grid block. Add a `gridPreset: "two_up" | "three_up" | "two_by_two"` opt and a `gridImageUrls: string[]` opt. The grid block uses the existing `photoGrid` CSS approach from `card-engine.ts` (1-big-2-small / 2×2), gated by `safeImageUrl()` per slot. With `gridImageUrls` empty → falls back to the single-image behavior (byte-identical default).
2. **Router (`repurpose.router.ts`):** when the user picks the postcard layout, resolve N grid slots through the SAME precedence as the existing single slot resolver (user-assigned image → article-scraped image → AI-per-empty-slot via `generateImageSafe`), populating `content.heroImageUrls` / `gridImageUrls`. This is the wiring that's currently missing.
3. **UI (`RepurposeTab.tsx`):** add a "Postcard (header + photo grid)" option with a preset picker (2-up/3-up/2×2) and N image slots (`grid:0`, `grid:1`, …) reusing the existing IDOR-guarded upload + Media Library picker + the article-image candidates list. Each slot: upload / pick / use-article-image / leave-empty (AI fills).

**Security:** every grid image URL goes through `safeImageUrl()` (the existing allowlist); header text through `escapeHtml`/`renderHighlightMarkup`. Add to `creative-templates.test.ts` the same XSS/CSS-breakout assertions for the new grid block.

**TDD + safety gate:** golden snapshots (Task 10) must NOT change when the postcard option is unused. New tests: builder with 3 `gridImageUrls` emits a 3-up grid; with 0 emits the single-image fallback; malicious URL is dropped.

**Do NOT touch:** the 4 existing styles' default rendering, the deterministic mimicry engine, or `secondaryImageUrl` semantics. The postcard is a NEW style, opt-in.

**Commit/PR:** `feat(repurpose): postcard header + fixed-preset photo-grid layout (2-up/3-up/2x2) with per-slot images (REP-3)`.

## Task 13: Canva-like free-drag positioning (REP-4) — separate PR

Branch: `feat/repurpose-free-drag`

**Why:** User wants Canva-style freehand repositioning of the logo and the hook-layout text (currently only a fixed corner picker exists).

**Scope (decided D8):** pixel-precise freehand drag on a live preview for the logo and the hook text; capture as `{ xPct, yPct }` (% of canvas); render server-side at that coordinate.

**Approach (additive — the load-bearing safety design):**
1. **Renderer:** add an OPTIONAL `position?: { xPct: number; yPct: number }` prop to the logo block and the hook-text block in `creative-templates.ts`. **Absent → the existing corner/anchor CSS is emitted byte-for-byte** (this is what keeps every current render unchanged). **Present → emit `position:absolute; left:${xPct}%; top:${yPct}%; transform:translate(-50%,-50%);`** for that one element. Clamp xPct/yPct to [0,100] (numeric, no sanitizer needed, but validate the range).
2. **UI (`RepurposeTab.tsx`):** render a live preview box (the same aspect ratio as 1080×1350). Make the logo + hook-text draggable within it (pointer events → compute position as % of the box). Store `{xPct,yPct}` in component state; pass to the mutation only when the user actually dragged (a "reset to default" button clears it → back to corner default).
3. **Plumbing:** add the optional `logoPosition?` / `hookTextPosition?` fields to the mutation input (zod, optional). Default undefined = current behavior.

**TDD + safety gate:** golden snapshots (Task 10) must NOT change when no position is set. New tests: builder with `position` emits `position:absolute; left:X%`; builder without `position` emits the existing corner CSS (assert the golden string is unchanged); xPct/yPct out of range is clamped.

**Do NOT touch:** the corner-position picker (keep it as the default/quick option) or any element's default placement. Free-drag is a strictly-additive override.

**Commit/PR:** `feat(repurpose): Canva-like free-drag positioning for logo + hook text (opt-in, byte-identical default) (REP-4)`.

---

## Refuted candidates — DO NOT implement (verified not-a-bug)

Recorded so they are not re-reported. See design spec Appendix A for the code proof.

- **RSS-2** — empty-form submit is correctly blocked by `disabled={!name || !url}` (standard pattern).
- **AP-2** — Agents page doesn't hang; `runNow` enqueues and returns; loading state auto-clears.
- **SL-2** — deleted queries DO disappear; the delete handler already invalidates `listQueries` (it's SL-1's correctly-wired mirror).

---

## Execution order summary

| Phase | PR | Issues | Risk |
|---|---|---|---|
| 1 | `fix/phase1-anthropic-fallback-autopilot-review` | REP-1, AP-1 | HIGH — ship first |
| 2 | `fix/phase2-newsgrid-bg-logs-listening-approvals` | NG-1, AP-3, SL-1, APPR-1 | MEDIUM |
| 3 | `fix/phase3-zod-toast-plural-delete-confirm` | RSS-1, NG-2, AP-4 | LOW |
| 4a | `feat/repurpose-per-slide-text` | REP-2 (+ Task 10 gate) | feature |
| 4b | `feat/repurpose-postcard-grid` | REP-3 | feature |
| 4c | `feat/repurpose-free-drag` | REP-4 | feature |
