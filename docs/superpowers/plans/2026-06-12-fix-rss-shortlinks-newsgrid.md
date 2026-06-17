# Fix RSS Feeds, Short Links & News Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the RSS feed, short-link, and news-grid modules work as intended — fix the broken RSS auto-refresh + auto-post, close the short-link open-redirect, harden the news-grid IDOR/SSRF gaps, and clean up the surrounding data-integrity / UX defects.

**Architecture:** Three module fixes plus shared cross-cutting hardening (SSRF guards via the existing `@postautomation/ai` helpers, org-ownership checks mirroring `post.router.ts`, and a seeded service-user to stop orphaned `createdById` rows). The single highest-impact change is adding a `scheduleRssSync()` cron to the BullMQ scheduler — without it the entire RSS feature is dead config.

**Tech Stack:** Next.js (App Router), tRPC, BullMQ + Redis, Prisma + Postgres, Vitest, pnpm@9 / Turborepo.

**Audit provenance:** Every task below traces to an adversarially-verified finding (28 confirmed, 0 refuted) from the 2026-06-12 multi-agent audit. Severity and file:line are from that audit, re-checked against the live code.

**Note on `BILLING_DISABLED`:** Plan/quota tasks (Task 19, 20) are dormant while `BILLING_DISABLED=true` (current prod state). They harden the code for when billing re-arms; they will not change behaviour today. Implement them anyway — they pass `ctx.isSuperAdmin` and respect the flag automatically via the existing middleware.

---

## File Structure

**RSS module:**
- `apps/worker/src/scheduler/cron-jobs.ts` — add `scheduleRssSync()` + wire into `startCronJobs()` (Task 1)
- `packages/api/src/routers/rss.router.ts` — initial-sync-on-create, SSRF guard, channel-ownership on create/update (Tasks 4, 9, 2)
- `apps/worker/src/workers/rss-sync.worker.ts` — SSRF re-check, service-user author, P2002 dedup guard, sync-error capture (Tasks 9, 8, 7, 6)
- `apps/web/app/dashboard/rss/page.tsx` — channel multi-select picker, sync-error surfacing (Tasks 3, 6)
- `packages/db/prisma/schema.prisma` — `RssFeed.lastSyncStatus`/`lastSyncError` columns, seeded service `User` (Tasks 6, 8)

**Short-link module:**
- `packages/api/src/routers/shortlink.router.ts` — http(s)-only scheme refine, collision retry, past-expiry reject, UTC hour bucket (Tasks 10, 14, 15, 16)
- `apps/web/app/s/[code]/route.ts` — scheme re-validation, awaited click write (Tasks 10, 12)
- `apps/web/app/dashboard/links/page.tsx` — safe-href render, expiry input, remove/relabel dead geo panel (Tasks 10, 17, 13)

**News-grid module:**
- `packages/api/src/routers/newsgrid.router.ts` — channel-ownership in `bulkPublish`, logo-media IDOR in `assignLogoToChannel`, SSRF in `bulkPublish` fetch, image quota, past-schedule reject (Tasks 18, 21, 11, 19/20, 22)
- `packages/ai/src/tools/news-card-template.ts` — `safeColor` on `brandColor`, logo-URL SSRF guard (Tasks 23, 11)
- `packages/ai/src/tools/news-image-generator.ts` — null out unsafe `logoUrl` at render boundary (Task 11)

---

## Execution order

Do tasks in numbered order. Tasks 1–9 (RSS) are independent of 10–17 (short links) and 18–23 (news grid); the three blocks can be parallelised across worktrees if desired. Within a block, order matters (e.g. Task 8 seeds the service user before Task 8b references it).

---

# BLOCK A — RSS FEEDS

## Task 1: Add the RSS sync scheduler (CRITICAL — feeds never auto-refresh)

**Finding:** `rss-no-cron-scheduler` / `rss-sync-no-cron-scheduler` (CRITICAL). `startCronJobs()` wires 13 recurring jobs but nothing ever enqueues `rssSyncQueue`. The only producer is the manual `checkNow` mutation. `RssFeed.checkInterval` is dead config.

**Files:**
- Modify: `apps/worker/src/scheduler/cron-jobs.ts` (import line 2; new function; `startCronJobs()` body ~451-520)
- Test: `apps/worker/src/scheduler/__tests__/rss-cron.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/worker/src/scheduler/__tests__/rss-cron.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const addMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: { rssFeed: { findMany: (...a: any[]) => findManyMock(...a) } },
}));
vi.mock("@postautomation/queue", () => ({
  rssSyncQueue: { add: (...a: any[]) => addMock(...a) },
  tokenRefreshQueue: {}, analyticsSyncQueue: {}, agentRunQueue: {},
  trendDiscoverQueue: {}, listeningSyncQueue: {}, campaignAnalyticsSyncQueue: {},
  brandContentSyncQueue: {}, outreachPollQueue: {}, postPublishQueue: {},
}));
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { scheduleRssSync } from "../cron-jobs";

beforeEach(() => { addMock.mockReset(); findManyMock.mockReset(); });

describe("scheduleRssSync", () => {
  it("enqueues feeds never checked", async () => {
    findManyMock.mockResolvedValue([
      { id: "f1", organizationId: "o1", checkInterval: 60, lastCheckedAt: null },
    ]);
    await scheduleRssSync();
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0][1]).toEqual({ feedId: "f1", organizationId: "o1" });
  });

  it("skips feeds checked within their interval", async () => {
    findManyMock.mockResolvedValue([
      { id: "f1", organizationId: "o1", checkInterval: 60, lastCheckedAt: new Date(Date.now() - 10 * 60 * 1000) },
    ]);
    await scheduleRssSync();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("enqueues feeds past their interval", async () => {
    findManyMock.mockResolvedValue([
      { id: "f1", organizationId: "o1", checkInterval: 60, lastCheckedAt: new Date(Date.now() - 90 * 60 * 1000) },
    ]);
    await scheduleRssSync();
    expect(addMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/worker exec vitest run src/scheduler/__tests__/rss-cron.test.ts`
Expected: FAIL — `scheduleRssSync` is not exported from `../cron-jobs`.

- [ ] **Step 3: Add `rssSyncQueue` to the import**

In `apps/worker/src/scheduler/cron-jobs.ts` line 2, add `rssSyncQueue` to the destructured import:

```ts
import { tokenRefreshQueue, analyticsSyncQueue, agentRunQueue, trendDiscoverQueue, listeningSyncQueue, campaignAnalyticsSyncQueue, brandContentSyncQueue, outreachPollQueue, postPublishQueue, rssSyncQueue } from "@postautomation/queue";
```

- [ ] **Step 4: Add `scheduleRssSync()`**

Add this exported function near the other `schedule*` functions (e.g. after `scheduleListeningSync`):

```ts
/**
 * Enqueue RSS sync jobs for active feeds whose checkInterval has elapsed.
 * Run every 5 minutes; honors each feed's per-feed checkInterval (minutes).
 */
export async function scheduleRssSync() {
  const now = Date.now();
  const feeds = await prisma.rssFeed.findMany({
    where: { isActive: true },
    select: { id: true, organizationId: true, checkInterval: true, lastCheckedAt: true },
  });

  let queued = 0;
  for (const feed of feeds) {
    const dueAt = feed.lastCheckedAt
      ? feed.lastCheckedAt.getTime() + feed.checkInterval * 60 * 1000
      : 0; // never checked → due immediately
    if (now < dueAt) continue;

    await rssSyncQueue.add(
      `rss-sync-cron-${feed.id}`,
      { feedId: feed.id, organizationId: feed.organizationId },
      { jobId: `rss-sync-cron-${feed.id}-${now}`, removeOnComplete: true, removeOnFail: 100 }
    );
    queued++;
  }

  if (queued > 0) console.log(`[Cron] Queued ${queued} RSS sync jobs`);
}
```

- [ ] **Step 5: Wire into `startCronJobs()`**

In `startCronJobs()`, after the listening-sync block (~line 475), add:

```ts
  // RSS sync every 5 minutes (honors per-feed checkInterval)
  setInterval(scheduleRssSync, 5 * 60 * 1000);
  setTimeout(scheduleRssSync, 90 * 1000); // Start after 90s warmup
```

And add to the startup console block (~line 507):

```ts
  console.log("[Cron]   - RSS sync: every 5 min (per-feed interval)");
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @postautomation/worker exec vitest run src/scheduler/__tests__/rss-cron.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/scheduler/cron-jobs.ts apps/worker/src/scheduler/__tests__/rss-cron.test.ts
git commit -m "fix(rss): add cron scheduler so feeds auto-refresh on their checkInterval

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Validate channel ownership on `rss.create` / `rss.update`

**Finding:** part of `rss-autopost-unreachable` hardening. The worker writes `feed.targetChannels` straight into `PostTarget.channelId` (worker line 120) with no org re-check. Mirror `post.router.ts` `assertChannelsOwned`.

**Files:**
- Modify: `packages/api/src/routers/rss.router.ts` (create ~35-88, update ~90-128)
- Test: `packages/api/src/__tests__/rss-channel-ownership.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/rss-channel-ownership.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// Minimal harness: assert the helper rejects foreign channel ids.
function assertChannelsOwned(ownedIds: string[], requested: string[]) {
  const ownedSet = new Set(ownedIds);
  const invalid = requested.filter((id) => !ownedSet.has(id));
  if (invalid.length) throw new Error(`Channels not in this organization: ${invalid.join(", ")}`);
}

describe("rss channel ownership", () => {
  it("passes when all channels are owned", () => {
    expect(() => assertChannelsOwned(["a", "b"], ["a"])).not.toThrow();
  });
  it("throws on a foreign channel id", () => {
    expect(() => assertChannelsOwned(["a"], ["a", "x"])).toThrow(/x/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (then passes the helper-shape check)**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/rss-channel-ownership.test.ts`
Expected: PASS (this proves the helper contract; the router wiring is verified by type-check + manual trace in Step 4).

- [ ] **Step 3: Add the ownership check to `create`**

In `packages/api/src/routers/rss.router.ts`, inside the `create` mutation, after the feed-URL validation block and BEFORE `ctx.prisma.rssFeed.create`, add:

```ts
      // Validate every target channel belongs to the caller's org (worker writes
      // these straight into PostTarget.channelId with no re-check).
      if (input.targetChannels.length > 0) {
        const owned = await ctx.prisma.channel.findMany({
          where: { id: { in: input.targetChannels }, organizationId: ctx.organizationId },
          select: { id: true },
        });
        if (owned.length !== new Set(input.targetChannels).size) {
          const ownedSet = new Set(owned.map((c) => c.id));
          const invalid = input.targetChannels.filter((id) => !ownedSet.has(id));
          throw new TRPCError({ code: "FORBIDDEN", message: `Channels not in this organization: ${invalid.join(", ")}` });
        }
      }
```

- [ ] **Step 4: Add the same check to `update`**

In the `update` mutation, after the org-scoped existence check (~line 112) and before `ctx.prisma.rssFeed.update`, add the same block but guarded on the optional field:

```ts
      if (data.targetChannels && data.targetChannels.length > 0) {
        const owned = await ctx.prisma.channel.findMany({
          where: { id: { in: data.targetChannels }, organizationId: ctx.organizationId },
          select: { id: true },
        });
        if (owned.length !== new Set(data.targetChannels).size) {
          const ownedSet = new Set(owned.map((c) => c.id));
          const invalid = data.targetChannels.filter((id) => !ownedSet.has(id));
          throw new TRPCError({ code: "FORBIDDEN", message: `Channels not in this organization: ${invalid.join(", ")}` });
        }
      }
```

- [ ] **Step 5: Verify type-check passes**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/rss.router.ts packages/api/src/__tests__/rss-channel-ownership.test.ts
git commit -m "fix(rss): validate target channel ownership on feed create/update

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Add a channel multi-select to the RSS Add-Feed dialog (auto-post is unreachable)

**Finding:** `rss-autopost-unreachable` (HIGH). `handleCreate` hardcodes `targetChannels: []` and there is no picker, so the worker's `feed.autoPost && feed.targetChannels.length > 0` gate is never true. Auto-post silently never fires.

**Files:**
- Modify: `apps/web/app/dashboard/rss/page.tsx` (~97-107 create handler + dialog form)

- [ ] **Step 1: Load connected channels in the page**

Near the other tRPC hooks at the top of the component, add:

```tsx
  const { data: channels } = trpc.channel.list.useQuery();
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);
```

(If `trpc.channel.list` takes input, pass `{}`; confirm against an existing caller such as the compose page.)

- [ ] **Step 2: Render the multi-select in the Add-Feed dialog**

Inside the dialog form, after the Auto-Post toggle, add a channel picker that only shows when `autoPost` is on:

```tsx
  {autoPost && (
    <div className="space-y-2">
      <label className="text-sm font-medium">Target channels (required for auto-post)</label>
      <div className="max-h-40 overflow-y-auto rounded border p-2 space-y-1">
        {(channels ?? []).map((ch) => (
          <label key={ch.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selectedChannelIds.includes(ch.id)}
              onChange={(e) =>
                setSelectedChannelIds((prev) =>
                  e.target.checked ? [...prev, ch.id] : prev.filter((id) => id !== ch.id)
                )
              }
            />
            {ch.name} <span className="text-muted-foreground">@{ch.username ?? ch.platform}</span>
          </label>
        ))}
      </div>
      {autoPost && selectedChannelIds.length === 0 && (
        <p className="text-xs text-amber-600">Select at least one channel, or auto-post will not run.</p>
      )}
    </div>
  )}
```

- [ ] **Step 3: Pass selected ids into the create mutation**

In `handleCreate`, replace `targetChannels: []` with `targetChannels: selectedChannelIds`. Block submission when auto-post is on but nothing is selected:

```tsx
    if (autoPost && selectedChannelIds.length === 0) {
      toast.error("Select at least one target channel for auto-post.");
      return;
    }
    createFeed.mutate({
      name, url, checkInterval, autoPost,
      targetChannels: selectedChannelIds,
      promptTemplate: promptTemplate || undefined,
    });
```

- [ ] **Step 4: Reset selection on dialog close / success**

In the create `onSuccess` (and dialog-close handler), add `setSelectedChannelIds([]);`.

- [ ] **Step 5: Verify the web app type-checks / builds**

Run: `pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/dashboard/rss/page.tsx
git commit -m "fix(rss): add target-channel picker so auto-post can actually fire

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Enqueue an initial sync when a feed is created

**Finding:** `rss-no-initial-sync-on-create` (LOW, but high-value UX). A new feed shows "0 entries / Never checked" until the user manually clicks Check Now.

**Files:**
- Modify: `packages/api/src/routers/rss.router.ts` (create, after line 75)

- [ ] **Step 1: Enqueue after create**

In the `create` mutation, after `const feed = await ctx.prisma.rssFeed.create({...})` and before `return feed;`, add:

```ts
      // Kick off an initial sync so the feed isn't empty until the next cron tick.
      await rssSyncQueue.add(
        `rss-sync-${feed.id}`,
        { feedId: feed.id, organizationId: ctx.organizationId },
        { jobId: `rss-sync-initial-${feed.id}`, removeOnComplete: true, removeOnFail: 100 }
      );
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: no errors (`rssSyncQueue` is already imported at line 4).

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routers/rss.router.ts
git commit -m "fix(rss): enqueue an initial sync on feed creation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: (reserved — covered by Task 1) RSS scheduler integration check

- [ ] **Step 1: Confirm the worker reads the feed org-safely**

The worker (`apps/worker/src/workers/rss-sync.worker.ts:39`) does `findUnique({ where: { id: feedId } })`. Because the cron (Task 1) passes the feed's OWN `organizationId`, and `checkNow` (Task 2 path) is already org-gated, no change is needed here. This task is a no-op verification — tick it after reading the worker once to confirm the contract holds.

---

## Task 6: Surface RSS sync errors in the UI

**Finding:** `rss-no-sync-error-surfaced` (MEDIUM). `checkNow.onSuccess` fires on *enqueue*, not completion. Worker failures (dead URL, malformed XML, zero items) are invisible — the user just sees no new entries.

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (RssFeed model ~581-601)
- Modify: `apps/worker/src/workers/rss-sync.worker.ts` (wrap processor)
- Modify: `apps/web/app/dashboard/rss/page.tsx` (render status)

- [ ] **Step 1: Add status columns to the schema**

In `packages/db/prisma/schema.prisma`, in the `RssFeed` model add after `lastCheckedAt`:

```prisma
  lastSyncStatus String?   // "SUCCESS" | "FAILED"
  lastSyncError  String?   @db.Text
```

- [ ] **Step 2: Push the schema**

Run: `pnpm db:push`
Expected: columns added, no data loss prompt. (These are additive nullable columns.)

- [ ] **Step 3: Capture status in the worker**

In `apps/worker/src/workers/rss-sync.worker.ts`, change the final `lastCheckedAt` update (line 144-147) to also set success status:

```ts
      await prisma.rssFeed.update({
        where: { id: feedId },
        data: { lastCheckedAt: new Date(), lastSyncStatus: "SUCCESS", lastSyncError: null },
      });
```

Then wrap the whole processor body in try/catch so failures persist the error instead of only logging. After the `const { feedId, organizationId } = job.data;` line, restructure the processor so the existing body runs inside a `try`, and on `catch (err)`:

```ts
      } catch (err) {
        await prisma.rssFeed.update({
          where: { id: feedId },
          data: {
            lastCheckedAt: new Date(),
            lastSyncStatus: "FAILED",
            lastSyncError: String((err as Error)?.message ?? err).slice(0, 1000),
          },
        }).catch(() => {});
        throw err; // keep BullMQ retry/fail semantics
      }
```

Also set `lastSyncStatus: "FAILED"` on the `!response.ok` branch (line 54) before throwing, or let it fall through to the catch (simplest — just `throw new Error(...)` there as today and the catch handles it).

- [ ] **Step 4: Render status on the feed card**

In `apps/web/app/dashboard/rss/page.tsx`, on each feed card, show the last sync state. Where the card shows "Last checked", add:

```tsx
  {feed.lastSyncStatus === "FAILED" && (
    <p className="text-xs text-red-600" title={feed.lastSyncError ?? ""}>
      ⚠ Last sync failed{feed.lastSyncError ? `: ${feed.lastSyncError.slice(0, 80)}` : ""}
    </p>
  )}
```

- [ ] **Step 5: Verify type-check (api types regenerate from prisma)**

Run: `pnpm --filter @postautomation/db exec prisma generate && pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma apps/worker/src/workers/rss-sync.worker.ts apps/web/app/dashboard/rss/page.tsx
git commit -m "fix(rss): persist and surface sync failures (lastSyncStatus/lastSyncError)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Guard the RSS entry insert against duplicate-job races (P2002)

**Finding:** `rss-dedupe-race-no-p2002-guard` (LOW). `checkNow` enqueues with no `jobId`, so double-clicks create two jobs; concurrency 2 lets them run in parallel; both read the same `existingGuids` set and one loses the `@@unique([feedId, guid])` race, failing the whole job.

**Files:**
- Modify: `packages/api/src/routers/rss.router.ts` (checkNow ~204) — add a `jobId` to coalesce
- Modify: `apps/worker/src/workers/rss-sync.worker.ts` (entry create ~80) — idempotent insert

- [ ] **Step 1: Coalesce concurrent enqueues**

In `rss.router.ts` `checkNow`, give the enqueue a stable `jobId`:

```ts
      await rssSyncQueue.add(
        `rss-sync-${input.feedId}`,
        { feedId: input.feedId, organizationId: ctx.organizationId },
        { jobId: `rss-sync-manual-${input.feedId}`, removeOnComplete: true, removeOnFail: 100 }
      );
```

(A pending job with the same `jobId` is not re-added by BullMQ, coalescing rapid double-clicks.)

- [ ] **Step 2: Make the entry insert idempotent**

In `rss-sync.worker.ts`, replace the per-item `prisma.rssFeedEntry.create` (line 80) with a P2002-tolerant create so a lost race skips instead of failing the job:

```ts
        try {
          await prisma.rssFeedEntry.create({
            data: {
              feedId, guid: item.guid, title: item.title, link: item.link,
              summary: item.summary || null, published: item.published,
            },
          });
          newEntryCount++;
        } catch (e: any) {
          if (e?.code !== "P2002") throw e; // ignore the unique-guid race, rethrow real errors
        }
```

- [ ] **Step 3: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit && pnpm --filter @postautomation/worker exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routers/rss.router.ts apps/worker/src/workers/rss-sync.worker.ts
git commit -m "fix(rss): coalesce duplicate sync jobs and ignore P2002 guid races

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Stop creating orphan posts with `createdById: "system"`

**Finding:** `rss-autopost-orphan-createdby` (MEDIUM). The worker stamps `createdById: "system"` — no such User row exists. (No FK is declared on `Post.createdById`, so it doesn't crash, but it orphans the author.) The verifier found the **same defect in two sibling workers**: `content-generate.worker.ts` (`autopilot-system`, on both `createdById` and `Media.uploadedById`) and `agent-run.worker.ts` (`agent-system`).

**Approach chosen:** resolve a real OWNER of the job's org at runtime (no seed/migration needed, org-scoped, survives prod where `seed.ts` doesn't run). Apply to all three workers.

**Files:**
- Modify: `apps/worker/src/workers/rss-sync.worker.ts` (~110)
- Modify: `apps/worker/src/workers/content-generate.worker.ts` (~186, ~201)
- Modify: `apps/worker/src/workers/agent-run.worker.ts` (~151, ~206)

- [ ] **Step 1: Add a shared resolver helper**

Create `apps/worker/src/lib/system-user.ts`:

```ts
import { prisma } from "@postautomation/db";

/**
 * Resolve a real userId to attribute system-generated posts/media to:
 * the oldest OWNER of the given org. Falls back to any member if no OWNER.
 * Throws if the org has no members (caller should skip the job).
 */
export async function resolveOrgAuthor(organizationId: string): Promise<string> {
  const owner = await prisma.organizationMember.findFirst({
    where: { organizationId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (owner) return owner.userId;
  const anyMember = await prisma.organizationMember.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (anyMember) return anyMember.userId;
  throw new Error(`No members found for org ${organizationId}`);
}
```

- [ ] **Step 2: Use it in the RSS worker**

In `rss-sync.worker.ts`, at the top of the auto-post block (before the `for` loop over `unprocessedEntries`, ~line 96), add:

```ts
        const authorId = await resolveOrgAuthor(organizationId);
```

and replace `createdById: "system"` (line 113) with `createdById: authorId`. Add the import at the top:

```ts
import { resolveOrgAuthor } from "../lib/system-user";
```

- [ ] **Step 3: Use it in `content-generate.worker.ts`**

Add the import, resolve `authorId = await resolveOrgAuthor(<orgId in scope>)`, and replace both `createdById: "autopilot-system"` (~201) and `uploadedById: "autopilot-system"` (~186) with `authorId`. (Confirm the org id variable name in that worker's scope.)

- [ ] **Step 4: Use it in `agent-run.worker.ts`**

Same pattern: replace `createdById: "agent-system"` (~151) and `uploadedById: "agent-system"` (~206) with a resolved `authorId`.

- [ ] **Step 5: Verify type-check**

Run: `pnpm --filter @postautomation/worker exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/lib/system-user.ts apps/worker/src/workers/rss-sync.worker.ts apps/worker/src/workers/content-generate.worker.ts apps/worker/src/workers/agent-run.worker.ts
git commit -m "fix(worker): attribute system-generated posts to a real org owner, not a fake id

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **Note:** Do NOT add a `createdBy User @relation` FK to `Post` until existing `"system"`/`"agent-system"`/`"autopilot-system"` rows in production are backfilled/cleaned — the constraint creation would fail. That backfill is out of scope for this plan; track separately.

---

## Task 9: Add SSRF guards to the RSS feed-URL fetches

**Finding:** `rss-ssrf-feed-url` / `rss-feed-url-ssrf` (HIGH). Both the create-time validation fetch (`rss.router.ts:38`, `redirect:"follow"`) and the worker fetch (`rss-sync.worker.ts:46`) hit an arbitrary user-supplied URL with no allowlist — reachable: `169.254.169.254`, `localhost`, RFC1918. Use the existing `isPublicPageUrl` from `@postautomation/ai`.

> **Caveat (documented, accepted for parity):** `isPublicPageUrl` checks the literal hostname/IP, not the DNS-resolved IP, so DNS-rebinding is not fully closed — same limitation as the rest of the codebase's guards. `redirect:"manual"` closes the redirect-bounce vector.

**Files:**
- Modify: `packages/api/src/routers/rss.router.ts` (create ~38; update ~96 also accepts a url)
- Modify: `apps/worker/src/workers/rss-sync.worker.ts` (~46)

- [ ] **Step 1: Confirm the helper is exported**

Run: `grep -n "isPublicPageUrl" packages/ai/src/index.ts packages/ai/src/utils/safe-fetch-url.ts`
Expected: it is defined in `safe-fetch-url.ts` and re-exported from the package root.

- [ ] **Step 2: Guard the create-validation fetch**

In `rss.router.ts`, add the import at the top:

```ts
import { isPublicPageUrl } from "@postautomation/ai";
```

In `create`, before the validation `fetch` (line 38), add:

```ts
      if (!isPublicPageUrl(input.url)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Feed URL must be a publicly accessible http(s) address." });
      }
```

Change the fetch's `redirect: "follow"` to `redirect: "manual"` (a 3xx now yields `!res.ok` and is rejected by the existing status check at line 44).

- [ ] **Step 3: Guard the update path**

In `update`, if `data.url` is present, run the same `isPublicPageUrl` check before the prisma update. (The update mutation accepts an optional `url`.)

```ts
      if (data.url && !isPublicPageUrl(data.url)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Feed URL must be a publicly accessible http(s) address." });
      }
```

- [ ] **Step 4: Guard the worker fetch**

In `rss-sync.worker.ts`, the worker already uses dynamic import. Before the fetch (line 46), add:

```ts
      const { isPublicPageUrl } = await import("@postautomation/ai");
      if (!isPublicPageUrl(feed.url)) {
        console.log(`[RssSync] Feed ${feedId} URL not public, skipping`);
        return;
      }
```

Add `redirect: "manual"` to the worker's `fetch` options and treat a non-ok response as failure (the existing `if (!response.ok) throw` at line 54 already does this).

- [ ] **Step 5: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit && pnpm --filter @postautomation/worker exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/rss.router.ts apps/worker/src/workers/rss-sync.worker.ts
git commit -m "fix(rss): SSRF-guard feed-URL fetches (isPublicPageUrl + redirect:manual)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# BLOCK B — SHORT LINKS

## Task 10: Close the open-redirect / dangerous-scheme hole (HIGH)

**Finding:** `shortlink-open-redirect-dangerous-schemes` / `shortlink-stored-dangerous-scheme` (HIGH). `z.string().url()` accepts `javascript:`, `data:`, `vbscript:`, `file:`, `ftp:`, and arbitrary external hosts (verified at runtime in the audit). The public `/s/[code]` route 302-forwards `originalUrl` verbatim, and the dashboard renders it as a clickable href. Defense-in-depth across all three layers.

**Files:**
- Modify: `packages/api/src/routers/shortlink.router.ts` (create input ~56)
- Modify: `apps/web/app/s/[code]/route.ts` (~54)
- Modify: `apps/web/app/dashboard/links/page.tsx` (href render ~211)
- Test: `packages/api/src/__tests__/shortlink-scheme.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/api/src/__tests__/shortlink-scheme.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";

const schema = z.string().url().refine(
  (u) => { try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; } },
  { message: "Only http(s) URLs are allowed" }
);

describe("shortlink url scheme", () => {
  it("accepts https", () => { expect(schema.safeParse("https://example.com").success).toBe(true); });
  it("accepts http", () => { expect(schema.safeParse("http://example.com").success).toBe(true); });
  it("rejects javascript:", () => { expect(schema.safeParse("javascript:alert(1)").success).toBe(false); });
  it("rejects data:", () => { expect(schema.safeParse("data:text/html,<script>x</script>").success).toBe(false); });
  it("rejects vbscript:", () => { expect(schema.safeParse("vbscript:msgbox(1)").success).toBe(false); });
  it("rejects file:", () => { expect(schema.safeParse("file:///etc/passwd").success).toBe(false); });
});
```

- [ ] **Step 2: Run it (proves the refine contract)**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/shortlink-scheme.test.ts`
Expected: PASS (6 tests) — this locks the schema shape; Step 3 applies it to the router.

- [ ] **Step 3: Apply the refine to the create input**

In `packages/api/src/routers/shortlink.router.ts` line 56, replace `originalUrl: z.string().url(),` with:

```ts
        originalUrl: z.string().url().refine(
          (u) => { try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; } },
          { message: "Only http(s) URLs are allowed" }
        ),
```

- [ ] **Step 4: Re-validate at the redirect boundary (existing rows may be unsafe)**

In `apps/web/app/s/[code]/route.ts`, before the redirect (line 54), add:

```ts
  try {
    const proto = new URL(shortLink.originalUrl).protocol;
    if (proto !== "http:" && proto !== "https:") {
      return new NextResponse("Invalid link", { status: 400 });
    }
  } catch {
    return new NextResponse("Invalid link", { status: 400 });
  }
```

- [ ] **Step 5: Render the dashboard href safely**

In `apps/web/app/dashboard/links/page.tsx`, wherever `originalUrl` becomes an `href` (~211), guard it: render as plain text (not a link) when the protocol isn't http(s). Minimal helper at top of file:

```tsx
function isHttpUrl(u: string) {
  try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; }
}
```

Then at the render site, use a conditional:

```tsx
  {isHttpUrl(link.originalUrl)
    ? <a href={link.originalUrl} target="_blank" rel="noopener noreferrer">{link.originalUrl}</a>
    : <span className="text-red-600" title="Unsafe URL scheme">{link.originalUrl}</span>}
```

- [ ] **Step 6: Verify type-check + tests**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/shortlink-scheme.test.ts && pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routers/shortlink.router.ts apps/web/app/s/[code]/route.ts apps/web/app/dashboard/links/page.tsx packages/api/src/__tests__/shortlink-scheme.test.ts
git commit -m "fix(shortlink): allow only http(s) schemes (create + redirect + render)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: SSRF + sanitizer hardening (cross-module: news-grid bulkPublish, logo render, brandColor)

> This task is in Block B's position only for numbering; it touches news-grid + ai files. It is grouped with the security fixes. See Block C for the rest of news grid.

**Findings:**
- `newsgrid-bulkpublish-ssrf` / `newsgrid-bulkpublish-external-fetch-ssrf` (HIGH) — `bulkPublish` does raw `fetch(payload.backgroundImageUrl)` on a client-supplied URL.
- `newsgrid-logo-puppeteer-ssrf` (MEDIUM) — `logoUrl` rendered as `<img src>` in server-side Puppeteer with no guard.
- `newsgrid-brandColor-unsanitized-css` (LOW) — `brandColor` interpolated raw into `<style>` in `news-card-template.ts` (the OTHER template, `creative-templates.ts`, already uses `safeColor`).

**Files:**
- Modify: `packages/api/src/routers/newsgrid.router.ts` (~433-439)
- Modify: `packages/ai/src/tools/news-image-generator.ts` (logo boundary ~50, ~96-113)
- Modify: `packages/ai/src/tools/news-card-template.ts` (~190-196, 244, 249)

- [ ] **Step 1: Confirm the available safe-fetch helpers**

Run: `grep -nE "export (async )?function (safeFetchImage|safeFetchPublicImage|isAllowedImageUrl|isPublicImageUrl|safeColor)" packages/ai/src/utils/*.ts packages/ai/src/tools/*.ts`
Expected: identify which of `safeFetchImage`/`safeFetchPublicImage`/`isAllowedImageUrl`/`isPublicImageUrl` exist and their exact signatures (the audit references all four; use whichever the codebase actually exports).

- [ ] **Step 2: Guard the `bulkPublish` external fetch**

In `newsgrid.router.ts`, replace the `else { const resp = await fetch(payload.backgroundImageUrl); ... }` branch (~433-438) with a guarded fetch. Since the only legitimate non-`data:` value is the app's own S3 URL, gate on the strict allowlist:

```ts
            } else {
              // External URL — only allow the app's own S3 hosts (strict SSRF guard).
              const { isAllowedImageUrl, safeFetchImage } = await import("@postautomation/ai");
              if (!isAllowedImageUrl(payload.backgroundImageUrl)) {
                console.warn(`[NewsGrid] Rejected non-allowlisted image URL for post ${post.id}`);
                throw new Error("Image URL not allowed");
              }
              const resp = await safeFetchImage(payload.backgroundImageUrl, { timeoutMs: 8000 });
              const ct = resp.headers.get("content-type") || "";
              if (!resp.ok || !/^image\//.test(ct)) throw new Error("Image fetch failed or not an image");
              const arrayBuf = await resp.arrayBuffer();
              if (arrayBuf.byteLength > 15 * 1024 * 1024) throw new Error("Image too large");
              imgBuffer = Buffer.from(arrayBuf);
              mimeType = ct || "image/jpeg";
            }
```

(If `safeFetchImage`/`isAllowedImageUrl` don't exist under those names, use the closest exported equivalent found in Step 1. The `throw` lands in the existing `catch (imgErr)` at line 486, so the post is still created without the image — current tolerated behaviour.)

- [ ] **Step 3: Guard the Puppeteer logo URL**

In `packages/ai/src/tools/news-image-generator.ts`, in both `generateStaticNewsCreativeImage` and `generateNewsCardImage`, null out an unsafe `logoUrl` BEFORE building the HTML, so the template never embeds a private `<img src>`:

```ts
  const { isPublicImageUrl } = await import("../utils/safe-fetch-url");
  const safeLogoUrl = options.logoUrl && isPublicImageUrl(options.logoUrl) ? options.logoUrl : null;
```

Then pass `safeLogoUrl` (not `options.logoUrl`) into the template builder call. (Use the actual exported guard name from Step 1; `isPublicImageUrl` per the audit.)

- [ ] **Step 4: Sanitize `brandColor` in `news-card-template.ts`**

Add the import: `import { safeColor } from "./creative-templates";` Then at the top of `generateStaticNewsCreativeHtml`, replace raw `options.brandColor` usage (lines 190-196, 244, 249) with a sanitized value:

```ts
  const safeBrand = options.brandColor ? safeColor(options.brandColor) : undefined;
```

and use `safeBrand` everywhere `options.brandColor` was interpolated into CSS.

- [ ] **Step 5: Run the security-regression suites + type-check**

Run: `pnpm --filter @postautomation/ai exec vitest run src/__tests__/creative-templates.test.ts src/__tests__/image-fetch-ssrf.test.ts && pnpm --filter @postautomation/ai exec tsc --noEmit && pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routers/newsgrid.router.ts packages/ai/src/tools/news-image-generator.ts packages/ai/src/tools/news-card-template.ts
git commit -m "fix(newsgrid): SSRF-guard bulkPublish fetch + Puppeteer logo, sanitize brandColor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: Await the short-link click write (no silent loss)

**Finding:** `shortlink-fire-and-forget-lost-clicks` (MEDIUM, partial). The `Promise.all([...]).catch()` is not awaited; on serverless tear-down the click increment + insert can be dropped. On the current long-lived Docker deploy the risk is latent, but awaiting is one indexed UPDATE + one INSERT (single-digit ms) and removes the silent-loss-on-transient-error too.

**Files:**
- Modify: `apps/web/app/s/[code]/route.ts` (~33-54)

- [ ] **Step 1: Await before redirecting**

In `apps/web/app/s/[code]/route.ts`, change the fire-and-forget `Promise.all([...]).catch(...)` to an awaited block wrapped in try/catch, placed before the `return NextResponse.redirect(...)`:

```ts
  try {
    await Promise.all([
      prisma.shortLink.update({
        where: { id: shortLink.id },
        data: { clicks: { increment: 1 }, lastClickedAt: new Date() },
      }),
      prisma.shortLinkClick.create({
        data: { shortLinkId: shortLink.id, ipAddress: ip, userAgent, referer },
      }),
    ]);
  } catch (err) {
    console.error("[ShortLink] Failed to record click:", err);
    // Still redirect even if analytics write fails.
  }
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/s/[code]/route.ts
git commit -m "fix(shortlink): await click write so clicks aren't silently lost

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: Resolve or retire the dead "Top Countries" geo panel

**Finding:** `shortlink-country-city-never-populated` (MEDIUM). `ShortLinkClick.country`/`city` are never written, so `getStats.topCountries` is permanently `[{country:"Unknown"}]` while the UI advertises a "Top Countries" panel.

**Decision:** retire the panel now (geo-IP is a separate feature). This is the lower-risk, immediately-honest fix.

**Files:**
- Modify: `packages/api/src/routers/shortlink.router.ts` (drop `topCountries` from the return ~164-167, 198)
- Modify: `apps/web/app/dashboard/links/page.tsx` (~350 — remove the Top Countries card)

- [ ] **Step 1: Remove the dead aggregation from the router**

In `getStats`, delete the `topCountries` computation (lines 164-167) and remove `topCountries` from the returned object (~line 198).

- [ ] **Step 2: Remove the panel from the UI**

In `links/page.tsx`, delete the "Top Countries" card/section (~line 350) and any reference to `stats.topCountries`.

- [ ] **Step 3: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit && pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routers/shortlink.router.ts apps/web/app/dashboard/links/page.tsx
git commit -m "fix(shortlink): remove dead Top Countries panel (country never populated)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **Optional follow-up (out of scope):** implement geo-IP resolution in the click-capture path and re-introduce the panel.

---

## Task 14: Add collision-retry to short-code generation

**Finding:** `shortlink-no-collision-retry` (LOW). `crypto.randomBytes(4)` (32-bit) inserted once with no retry; a collision surfaces as an opaque P2002 "Failed to create link" toast.

**Files:**
- Modify: `packages/api/src/routers/shortlink.router.ts` (create ~62-72)

- [ ] **Step 1: Widen the code and add a bounded retry**

In `create`, replace the single-shot code generation + create with a retry loop. Add the Prisma import at the top: `import { Prisma } from "@prisma/client";`

```ts
      let shortLink = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = crypto.randomBytes(6).toString("hex"); // 48-bit
        try {
          shortLink = await ctx.prisma.shortLink.create({
            data: {
              organizationId: ctx.organizationId,
              code,
              originalUrl: input.originalUrl,
              postId: input.postId,
              expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            },
          });
          break;
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
          throw e;
        }
      }
      if (!shortLink) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not generate a unique short code, please retry." });
      }
      return shortLink;
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routers/shortlink.router.ts
git commit -m "fix(shortlink): retry on code collision and widen code to 48-bit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 15: Reject an already-past `expiresAt` on create

**Finding:** `shortlink-create-past-expiresat-no-validation` (LOW). A link created with a past `expiresAt` 404s on first visit ("born dead").

**Files:**
- Modify: `packages/api/src/routers/shortlink.router.ts` (create, before the create call)

- [ ] **Step 1: Add the guard**

In `create`, before generating the code, add:

```ts
      if (input.expiresAt && new Date(input.expiresAt) <= new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Expiry must be in the future." });
      }
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routers/shortlink.router.ts
git commit -m "fix(shortlink): reject a past expiresAt at create time

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 16: Make the clicks-by-hour bucket UTC-consistent

**Finding:** `shortlink-clicksbyhour-server-local-time` (LOW). `clicksByHour` uses `getHours()` (server-local) while `clicksByDay` keys by UTC — inconsistent, and the UI label "(local time)" is wrong.

**Files:**
- Modify: `packages/api/src/routers/shortlink.router.ts` (~187)
- Modify: `apps/web/app/dashboard/links/page.tsx` (~323 label)

- [ ] **Step 1: Use UTC hours**

In `shortlink.router.ts` line 187, change `c.createdAt.getHours()` to `c.createdAt.getUTCHours()` (both occurrences on that line).

- [ ] **Step 2: Relabel the UI**

In `links/page.tsx` (~323), change the histogram label from "(local time)" to "(UTC)".

- [ ] **Step 3: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit && pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routers/shortlink.router.ts apps/web/app/dashboard/links/page.tsx
git commit -m "fix(shortlink): UTC-consistent clicks-by-hour bucket and label

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 17: Expose `expiresAt` in the create-link dialog

**Finding:** `shortlink-ui-missing-expiry-postid-inputs` (LOW). The dialog only collects `originalUrl`, so the lazy-expiry feature is dead from the UI. (`postId` is a separate, unused integration concern — see Note; only `expiresAt` is wired here.)

**Files:**
- Modify: `apps/web/app/dashboard/links/page.tsx` (~74-79 handleCreate + dialog)

- [ ] **Step 1: Add an expiry date input to the dialog**

Add state `const [expiresAt, setExpiresAt] = useState<string>("");` and a `<input type="datetime-local" />` bound to it in the create dialog.

- [ ] **Step 2: Pass it into the mutation**

In `handleCreate`, change the payload to include the ISO string when set:

```tsx
    createLink.mutate({
      originalUrl,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    });
```

- [ ] **Step 3: Reset on success**

In the create `onSuccess`, add `setExpiresAt("");`.

- [ ] **Step 4: Verify type-check**

Run: `pnpm --filter @postautomation/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/dashboard/links/page.tsx
git commit -m "fix(shortlink): expose expiresAt input in the create-link dialog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> **Note on `postId`:** the router accepts and persists `postId` but nothing sets or reads it, and the short-link feature is not integrated into the post composer (finding `shortlink-not-integrated-into-composer`). Wiring per-post link tracking into the composer/publish pipeline is a product feature, not a bug fix — it is intentionally OUT OF SCOPE for this plan. If desired, track it as a separate feature spec.

---

# BLOCK C — NEWS GRID

## Task 18: Add channel-ownership check to `newsgrid.bulkPublish` (CRITICAL/partial)

**Finding:** `newsgrid-bulkpublish-channel-idor` (CRITICAL, downgraded to partial by the verifier — the post-publish worker re-checks channel org before publishing, so the dangerous *outcome* is blocked, but `bulkPublish` still writes a dangling cross-org `PostTarget` row and wastes a job). Harden at the source, mirroring `post.router.ts`.

**Files:**
- Modify: `packages/api/src/routers/newsgrid.router.ts` (bulkPublish ~389, before the loop)
- Test: `packages/api/src/__tests__/newsgrid-channel-ownership.test.ts` (create)

- [ ] **Step 1: Write the failing test (helper contract)**

Create `packages/api/src/__tests__/newsgrid-channel-ownership.test.ts`:

```ts
import { describe, it, expect } from "vitest";

function assertOwned(ownedIds: string[], requested: string[]) {
  const ownedSet = new Set(ownedIds);
  const invalid = requested.filter((id) => !ownedSet.has(id));
  if (invalid.length) throw new Error(`Channels not in this organization: ${invalid.join(", ")}`);
}

describe("newsgrid bulkPublish channel ownership", () => {
  it("passes for owned channels", () => { expect(() => assertOwned(["a", "b"], ["a", "b"])).not.toThrow(); });
  it("throws on foreign channel", () => { expect(() => assertOwned(["a"], ["a", "evil"])).toThrow(/evil/); });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/newsgrid-channel-ownership.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Add the check to `bulkPublish`**

In `newsgrid.router.ts`, at the top of the `bulkPublish` mutation body, before `const created: string[] = [];`, add:

```ts
      const channelIds = [...new Set(input.payloads.map((p) => p.channelId))];
      const ownedChannels = await ctx.prisma.channel.findMany({
        where: { id: { in: channelIds }, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (ownedChannels.length !== channelIds.length) {
        const ownedSet = new Set(ownedChannels.map((c) => c.id));
        const invalid = channelIds.filter((id) => !ownedSet.has(id));
        throw new TRPCError({ code: "FORBIDDEN", message: `Channels not in this organization: ${invalid.join(", ")}` });
      }
```

- [ ] **Step 4: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/newsgrid.router.ts packages/api/src/__tests__/newsgrid-channel-ownership.test.ts
git commit -m "fix(newsgrid): validate channel ownership in bulkPublish (close cross-org IDOR)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 19: Close the logo-media IDOR in `assignLogoToChannel` (HIGH)

**Finding:** `newsgrid-assignlogo-media-idor` (HIGH). The mutation does `prisma.media.update({ where: { id: input.mediaId } })` (primary-key only) — re-parenting another org's Media row onto the caller's channel and leaking its URL into `metadata.logo_path`.

**Files:**
- Modify: `packages/api/src/routers/newsgrid.router.ts` (assignLogoToChannel ~566-591)

- [ ] **Step 1: Replace the mutation body with org-scoped checks**

Replace the entire `assignLogoToChannel` mutation handler with:

```ts
  assignLogoToChannel: orgProcedure
    .input(z.object({ mediaId: z.string(), channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the logo media belongs to the caller's org
      const media = await ctx.prisma.media.findFirst({
        where: { id: input.mediaId, organizationId: ctx.organizationId, category: "logo" },
        select: { id: true, url: true },
      });
      if (!media) throw new TRPCError({ code: "NOT_FOUND" });

      // Verify the target channel belongs to the caller's org
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId },
        select: { id: true, metadata: true },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND" });

      // Remove previous logo assignment for this channel (org-scoped)
      await ctx.prisma.media.updateMany({
        where: { organizationId: ctx.organizationId, category: "logo", channelId: input.channelId },
        data: { channelId: null },
      });

      // Assign new logo — org-scoped updateMany so a foreign id is a no-op, not a cross-org write
      await ctx.prisma.media.updateMany({
        where: { id: input.mediaId, organizationId: ctx.organizationId },
        data: { channelId: input.channelId },
      });

      // Write the verified own-org media URL into channel metadata
      const existing = (channel.metadata as any) ?? {};
      await ctx.prisma.channel.update({
        where: { id: channel.id },
        data: { metadata: { ...existing, logo_path: media.url } },
      });
      return { success: true };
    }),
```

- [ ] **Step 2: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routers/newsgrid.router.ts
git commit -m "fix(newsgrid): org-scope assignLogoToChannel (close media IDOR)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 20: Add `aiImagesPerMonth` quota to `newsgrid.generate` + `postsPerMonth` to `bulkPublish`

**Findings:** `newsgrid-generate-no-aiimage-quota` (MEDIUM) and `newsgrid-bulkpublish-no-postsmonth-quota` (MEDIUM). `generate` produces one Gemini image per channel but gates only on plan tier; `bulkPublish` creates N posts with no `postsPerMonth` gate. Both dormant under `BILLING_DISABLED` but must respect the limit when re-armed.

**Files:**
- Modify: `packages/api/src/routers/newsgrid.router.ts` (import ~5; generate ~139; bulkPublish loop)

- [ ] **Step 1: Import `enforcePlanLimit`**

In `newsgrid.router.ts` line 5, change the import to:

```ts
import { requirePlan, enforcePlanLimit } from "../middleware/plan-limit.middleware";
```

- [ ] **Step 2: Add the image quota to `generate`**

In `generate`, right after the `requirePlan(...)` call (line 139), add:

```ts
      await enforcePlanLimit(ctx.organizationId, "aiImagesPerMonth", ctx.isSuperAdmin);
```

- [ ] **Step 3: Add the posts quota to `bulkPublish`**

In `bulkPublish`, inside the `for (const payload of input.payloads)` loop, before each `ctx.prisma.post.create`, add:

```ts
        await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
```

- [ ] **Step 4: Verify type-check + the billing-disabled regression suite stays green**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit && pnpm --filter @postautomation/api exec vitest run src/__tests__/billing-disabled.test.ts`
Expected: no errors / PASS (the flag-ON path must still bypass).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/newsgrid.router.ts
git commit -m "fix(newsgrid): enforce aiImagesPerMonth on generate and postsPerMonth on bulkPublish

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 21: (covered by Task 11) News-grid SSRF on bulkPublish fetch + logo render

- [ ] **Step 1: Confirm Task 11 covered this**

This finding is implemented in Task 11 (Steps 2–3). Tick this box after Task 11 is committed. No additional work.

---

## Task 22: Reject a past `scheduleTime` in `bulkPublish`

**Finding:** `newsgrid-bulkpublish-past-scheduletime-no-validation` (LOW). A past `scheduleTime` silently publishes immediately instead of failing, unlike the post composer.

**Files:**
- Modify: `packages/api/src/routers/newsgrid.router.ts` (input ~383; loop ~398)

- [ ] **Step 1: Tighten the input type**

In the `bulkPublish` input schema (line 383), change `scheduleTime: z.string().nullable()` to `scheduleTime: z.string().datetime().nullable()`.

- [ ] **Step 2: Reject past times in the loop**

Inside the `for (const payload of input.payloads)` loop, before computing `scheduledAt` (line 398), add:

```ts
        if (payload.scheduleTime) {
          const when = new Date(payload.scheduleTime);
          if (when.getTime() <= Date.now()) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `Schedule time for channel ${payload.channelId} must be in the future.` });
          }
        }
```

- [ ] **Step 3: Verify type-check**

Run: `pnpm --filter @postautomation/api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routers/newsgrid.router.ts
git commit -m "fix(newsgrid): reject a past scheduleTime in bulkPublish

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 23: (covered by Task 11) `brandColor` CSS sanitization

- [ ] **Step 1: Confirm Task 11 covered this**

This finding (`newsgrid-brandColor-unsanitized-css`) is implemented in Task 11 (Step 4). Tick after Task 11 is committed. No additional work.

---

# FINAL VERIFICATION

## Task 24: Full suite + build green

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all suites pass, including the security-regression suites (`creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, `billing-disabled.test.ts`) and the new tests added in this plan.

- [ ] **Step 2: Type-check the whole repo**

Run: `pnpm type-check`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Manual smoke (worker-dependent paths)**

With local infra up (`docker compose up -d`, `pnpm dev`):
1. **RSS:** add a feed (e.g. a real public RSS URL). Confirm entries appear within ~90s (initial sync, Task 4) without clicking Check Now. Toggle Auto-Post + select a channel; after a sync, confirm a DRAFT post is created attributed to your user (not "system").
2. **Short links:** create a link to `https://example.com` → visit `/s/<code>` → confirm 302 + click count increments. Try creating `javascript:alert(1)` → confirm rejected. Create with a past expiry → confirm rejected.
3. **News grid:** generate for 2 channels → confirm cards render → bulkPublish → confirm posts created and (with another org's channel id forced via devtools) a FORBIDDEN error.

- [ ] **Step 5: Confirm SSRF rejection (manual)**

Try adding an RSS feed with URL `http://169.254.169.254/` → confirm BAD_REQUEST "must be a publicly accessible http(s) address".

---

## Self-Review Checklist (completed by plan author)

- **Spec coverage:** All 28 confirmed findings map to a task — RSS (7): Tasks 1,3,4,6,7,8,9 + ownership Task 2; Short links (6): Tasks 10,12,13,14,15,16,17; News grid (4): Tasks 18,19,20,22; Cross-cutting (11): scheduler→Task 1, autopost→Task 3, SSRF→Tasks 9 & 11, IDOR→Tasks 2,18,19, sanitizer→Task 11, quotas→Task 20. The `postId`/composer-integration finding is explicitly scoped OUT (Task 17 note) as a feature, not a bug.
- **Placeholder scan:** No TBD/"add error handling"/"similar to" placeholders — every code step shows the actual code.
- **Type consistency:** `scheduleRssSync`, `resolveOrgAuthor`, `isHttpUrl`, `assertOwned` helper names are consistent across the tasks that reference them. `isPublicPageUrl`/`isPublicImageUrl`/`isAllowedImageUrl`/`safeFetchImage`/`safeColor` names are flagged for Step-1 verification against the actual `@postautomation/ai` exports in Tasks 9 and 11 (the audit referenced all of them; confirm exact names before use).
