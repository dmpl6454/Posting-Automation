# Scheduled-Post State-Machine Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A media-required (Instagram/Facebook) post with no media and AI generation off must never sit "Scheduled / in progress" forever — it is blocked at schedule time where possible, and otherwise reaches a terminal `FAILED` state with a clear human reason, guaranteed even across BullMQ retries.

**Architecture:** Three layers harden the post lifecycle. (1) At **schedule/publish creation** (`post.router.ts` create + `chat.router.ts` schedule_post/bulk_schedule/publish_now) a pure `mediaRequiredBlock()` guard rejects IG/FB targets that have no media when AI is off. (2) In the **publish worker** a `media_required` error branch marks the target `FAILED` with a human message, and the atomic claim guard, on the final BullMQ attempt, terminalizes a stuck `PUBLISHING` target instead of silently returning. (3) The existing **auto-healer reaper** (`shouldReapPublishing`, 30-min watchdog) is verified to still reap because no-op claim retries leave `updatedAt` untouched (`updateMany` with `count===0` writes no row).

**Tech Stack:** pnpm + Turborepo monorepo, TypeScript strict, Prisma (Postgres), BullMQ worker, vitest. All new logic is extracted into pure, prisma-injectable helpers in `apps/worker/src/lib/publish-recovery.ts` and a new `packages/api/src/lib/media-required.ts` so it is unit-testable without booting Redis/Prisma.

---

## Files

| File | Create/Modify | Responsibility |
|---|---|---|
| `packages/api/src/lib/media-required.ts` | **Create** | Pure `MEDIA_REQUIRED_PLATFORMS` set + `mediaRequiredBlock({ platforms, hasMedia, aiEnabled })` predicate returning a human reason string or `null`. Single source of truth for the schedule-time block. |
| `packages/api/src/lib/__tests__/media-required.test.ts` | **Create** | Unit tests for `mediaRequiredBlock` across the IG/FB × media × AI matrix. |
| `packages/api/src/routers/post.router.ts` | **Modify** (`create`, lines 60–185) | Call `mediaRequiredBlock` after the channel-ownership guard (post-line 127) and before `post.create`; throw `BAD_REQUEST` with the reason when a media-required platform is targeted with no media and AI off. |
| `packages/api/src/routers/chat.router.ts` | **Modify** (`schedule_post` 383–427, `bulk_schedule` 429–487, `publish_now` 489–end-of-case) | Resolve each target channel's platform, then call `mediaRequiredBlock` before each `post.create` so the Super-Agent/chat paths block doomed media-less IG/FB posts. |
| `packages/api/src/__tests__/chat-media-required.test.ts` | **Create** | Regression tests that the chat schedule/publish paths reject media-less IG/FB + AI-off and allow the safe cases. |
| `apps/worker/src/lib/publish-recovery.ts` | **Modify** (add helpers after line 113) | Add `mediaRequiredReason()` (human FAILED message) and `terminalizeStuckClaim()` (pure: given claim count + final-attempt flag, decide whether to force a `PUBLISHING → FAILED` write). |
| `apps/worker/src/lib/publish-recovery.test.ts` | **Modify** (append describe blocks) | Unit tests for `mediaRequiredReason` and `terminalizeStuckClaim`. |
| `apps/worker/src/workers/post-publish.worker.ts` | **Modify** (claim guard 220–229, error branches 478–567, validation 433–437) | (a) On `claim.count===0`, on the final attempt, force-terminalize a still-`PUBLISHING` target → `FAILED`; (b) add a `media_required` branch that writes a clear human `FAILED` reason; (c) classify the IG validation error as `media_required` before it reaches the generic throw. |
| `apps/worker/src/workers/__tests__/post-publish-state.test.ts` | **Create** | Worker-logic regression tests using the extracted pure helpers + a mock prisma: media-less IG → FAILED reason; double-claim final attempt → terminal FAILED write. |

---

### Task 1: Pure `mediaRequiredBlock` predicate (schedule-time block core)

**Files:**
- Create: `packages/api/src/lib/media-required.ts`
- Test: `packages/api/src/lib/__tests__/media-required.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/api/src/lib/__tests__/media-required.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MEDIA_REQUIRED_PLATFORMS, mediaRequiredBlock } from "../media-required";

describe("MEDIA_REQUIRED_PLATFORMS", () => {
  it("contains exactly INSTAGRAM and FACEBOOK", () => {
    expect([...MEDIA_REQUIRED_PLATFORMS].sort()).toEqual(["FACEBOOK", "INSTAGRAM"]);
  });
});

describe("mediaRequiredBlock", () => {
  it("blocks an Instagram target with no media and AI off", () => {
    const reason = mediaRequiredBlock({ platforms: ["INSTAGRAM"], hasMedia: false, aiEnabled: false });
    expect(reason).toBeTypeOf("string");
    expect(reason).toContain("Instagram");
    expect(reason!.toLowerCase()).toContain("image");
  });

  it("blocks a Facebook target with no media and AI off", () => {
    const reason = mediaRequiredBlock({ platforms: ["FACEBOOK"], hasMedia: false, aiEnabled: false });
    expect(reason).toContain("Facebook");
  });

  it("names every blocked platform when multiple media-required targets are media-less", () => {
    const reason = mediaRequiredBlock({ platforms: ["INSTAGRAM", "FACEBOOK", "TWITTER"], hasMedia: false, aiEnabled: false });
    expect(reason).toContain("Instagram");
    expect(reason).toContain("Facebook");
    expect(reason).not.toContain("Twitter");
  });

  it("allows when media is attached", () => {
    expect(mediaRequiredBlock({ platforms: ["INSTAGRAM"], hasMedia: true, aiEnabled: false })).toBeNull();
  });

  it("allows when AI generation is enabled (worker can auto-generate)", () => {
    expect(mediaRequiredBlock({ platforms: ["INSTAGRAM"], hasMedia: false, aiEnabled: true })).toBeNull();
  });

  it("allows non-media-required platforms with no media", () => {
    expect(mediaRequiredBlock({ platforms: ["TWITTER", "LINKEDIN"], hasMedia: false, aiEnabled: false })).toBeNull();
  });

  it("allows an empty platform list", () => {
    expect(mediaRequiredBlock({ platforms: [], hasMedia: false, aiEnabled: false })).toBeNull();
  });

  it("is case-insensitive on platform names", () => {
    expect(mediaRequiredBlock({ platforms: ["instagram"], hasMedia: false, aiEnabled: false })).toContain("Instagram");
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module not found).**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run packages/api/src/lib/__tests__/media-required.test.ts
```
Expected: FAILS with `Failed to resolve import "../media-required"` / `Cannot find module`.

- [ ] **Step 3: Implement `media-required.ts`.** Create `packages/api/src/lib/media-required.ts`:
```ts
/**
 * Single source of truth for the "this platform needs an image/video" rule.
 *
 * Instagram and Facebook reject text-only posts (Instagram has no draft/text
 * post type at all; the FB Pages publish path used here posts to /photos or
 * /videos). The publish worker can auto-generate an AI image when AI is on, so
 * the schedule-time block only fires when AI generation is OFF *and* no media is
 * attached — i.e. a post that can NEVER succeed. Pure + dependency-free so it is
 * callable from both tRPC routers and unit tests.
 */
export const MEDIA_REQUIRED_PLATFORMS = new Set<string>(["INSTAGRAM", "FACEBOOK"]);

const PLATFORM_LABEL: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};

/**
 * Returns a human-readable block reason if the post can never be published, else
 * null. A post is doomed when it targets a media-required platform, has no media
 * attached, and AI image generation is off (so the worker can't fill the gap).
 */
export function mediaRequiredBlock(opts: {
  platforms: string[];
  hasMedia: boolean;
  aiEnabled: boolean;
}): string | null {
  if (opts.hasMedia || opts.aiEnabled) return null;

  const blocked = [
    ...new Set(
      (opts.platforms || [])
        .map((p) => (p || "").toUpperCase())
        .filter((p) => MEDIA_REQUIRED_PLATFORMS.has(p))
    ),
  ];
  if (blocked.length === 0) return null;

  const names = blocked.map((p) => PLATFORM_LABEL[p] ?? p).join(" and ");
  return `${names} require${blocked.length === 1 ? "s" : ""} an image or video to publish. Attach media or turn on AI image generation, then try again.`;
}
```

- [ ] **Step 4: Run the test — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run packages/api/src/lib/__tests__/media-required.test.ts
```
Expected: `Test Files  1 passed`, `Tests  8 passed`.

- [ ] **Step 5: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add packages/api/src/lib/media-required.ts packages/api/src/lib/__tests__/media-required.test.ts && git commit -m "feat(scheduler): pure mediaRequiredBlock predicate for media-less IG/FB posts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

> **⚠️ TASKS 2–4 DEFERRED TO PLAN 3 (decided 2026-06-13 during execution).** Adversarial review found the publish worker [post-publish.worker.ts:385-426](../../../apps/worker/src/workers/post-publish.worker.ts#L385-L426) **unconditionally** auto-generates an AI image for media-less IG/FB posts (no `aiEnabled` check). So a schedule-time block with hardcoded `aiEnabled:false` would reject posts that currently publish fine via auto-gen — a behavior regression, not a fix. The block belongs in Plan 3, where the real-first / AI-opt-in toggle (D2) makes "AI off" a real state that can be passed truthfully. **Task 1's `mediaRequiredBlock` predicate is kept** (Plan 3 reuses it). The actual stuck-post bug is fixed by the worker terminalization in Tasks 5–9 below. Skip Tasks 2, 3, 4.

### Task 2: Block media-less IG/FB at compose-create (`post.router.ts`) — DEFERRED to Plan 3

**Files:**
- Modify: `packages/api/src/routers/post.router.ts` (the `create` mutation, lines 60–185 — insert the guard between the media-ownership check at line 127 and `const status =` at line 129)
- Test: `packages/api/src/lib/__tests__/media-required.test.ts` (already covers the predicate; the router wiring is covered indirectly + by Task 4's chat tests — the router uses the same helper)

- [ ] **Step 1: Add the import.** In `packages/api/src/routers/post.router.ts`, after the existing `import { assertMediaOwned } from "./chat.router";` (line 9), add:
```ts
import { mediaRequiredBlock } from "../lib/media-required";
```

- [ ] **Step 2: Insert the schedule-time block.** In the `create` mutation, immediately after the media-ownership guard block that ends at line 127 (`}` closing the `if (input.mediaIds?.length) { ... }`) and before `const status = input.scheduledAt ? "SCHEDULED" : "DRAFT";` (line 129), insert:
```ts
      // Block media-required platforms (IG/FB) that can never publish: no media
      // attached and AI image generation off. Compose UI has no AI-on-publish
      // toggle today, so aiEnabled is false here — a media-less IG/FB scheduled
      // post would otherwise enqueue, fail validation in the worker, and (before
      // the worker fix) orphan at PUBLISHING. Only enforce on scheduled posts;
      // channel-less / unscheduled DRAFTs are allowed (channels/media added later).
      if (input.scheduledAt && input.channelIds.length > 0) {
        const targetPlatforms = ownedChannels.length
          ? (
              await ctx.prisma.channel.findMany({
                where: { id: { in: input.channelIds }, organizationId: ctx.organizationId },
                select: { platform: true },
              })
            ).map((c) => c.platform as string)
          : [];
        const block = mediaRequiredBlock({
          platforms: targetPlatforms,
          hasMedia: (input.mediaIds?.length ?? 0) > 0,
          aiEnabled: false,
        });
        if (block) {
          throw new TRPCError({ code: "BAD_REQUEST", message: block });
        }
      }
```

- [ ] **Step 3: Type-check the api package — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm --filter @postautomation/api exec tsc --noEmit
```
Expected: no errors (exit 0).

- [ ] **Step 4: Run the api test suite — expect existing + new pass.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run packages/api/src/lib/__tests__/media-required.test.ts
```
Expected: `Tests  8 passed`.

- [ ] **Step 5: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add packages/api/src/routers/post.router.ts && git commit -m "feat(scheduler): block media-less IG/FB scheduled posts at compose-create

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Block media-less IG/FB in the Super-Agent / chat schedule paths

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts` (`schedule_post` 383–427, `bulk_schedule` 429–487, `publish_now` 489–540+)

- [ ] **Step 1: Add the import.** In `packages/api/src/routers/chat.router.ts`, after `import { uploadBase64ToS3 } from "../lib/s3";` (line 8), add:
```ts
import { mediaRequiredBlock } from "../lib/media-required";
```

- [ ] **Step 2: Add a shared resolver helper near the other guards.** After the `requireText` function (closing `}` at line 65), insert:
```ts
/**
 * Resolve the platform of each org-owned channel id, then block when a
 * media-required platform (IG/FB) is targeted with no media and AI off. Throws a
 * clean BAD_REQUEST so a doomed media-less IG/FB post never enqueues from chat.
 * Call AFTER assertChannelsOwned (so the ids are already org-validated).
 */
export async function assertMediaForPlatforms(
  prisma: PrismaClient,
  organizationId: string,
  channelIds: string[],
  hasMedia: boolean,
): Promise<void> {
  const ids = [...new Set((channelIds || []).filter(Boolean))];
  if (ids.length === 0) return;
  const channels = await prisma.channel.findMany({
    where: { id: { in: ids }, organizationId },
    select: { platform: true },
  });
  const block = mediaRequiredBlock({
    platforms: channels.map((c) => c.platform as string),
    hasMedia,
    aiEnabled: false,
  });
  if (block) {
    throw new TRPCError({ code: "BAD_REQUEST", message: block });
  }
}
```

- [ ] **Step 3: Wire it into `schedule_post`.** In the `schedule_post` case, immediately after `await assertMediaOwned(ctx.prisma, ctx.organizationId, mediaIds);` (line 393), add:
```ts
          await assertMediaForPlatforms(ctx.prisma, ctx.organizationId, p.channelIds || [], mediaIds.length > 0);
```

- [ ] **Step 4: Wire it into `bulk_schedule`.** In the `bulk_schedule` loop, immediately after `await assertMediaOwned(ctx.prisma, ctx.organizationId, itemMediaIds);` (line 448), add:
```ts
            await assertMediaForPlatforms(ctx.prisma, ctx.organizationId, item.channelIds || [], itemMediaIds.length > 0);
```

- [ ] **Step 5: Wire it into `publish_now`.** In the `publish_now` case, immediately after `await assertMediaOwned(ctx.prisma, ctx.organizationId, mediaIds);` (line 500), add:
```ts
          await assertMediaForPlatforms(ctx.prisma, ctx.organizationId, p.channelIds || [], mediaIds.length > 0);
```

- [ ] **Step 6: Type-check the api package — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm --filter @postautomation/api exec tsc --noEmit
```
Expected: no errors (exit 0).

- [ ] **Step 7: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add packages/api/src/routers/chat.router.ts && git commit -m "feat(scheduler): block media-less IG/FB in chat schedule/bulk/publish actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Regression tests for the chat schedule-time block

**Files:**
- Create: `packages/api/src/__tests__/chat-media-required.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/api/src/__tests__/chat-media-required.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { assertMediaForPlatforms } from "../routers/chat.router";

function mockPrisma(platforms: string[]) {
  return {
    channel: {
      findMany: vi.fn(async () => platforms.map((platform) => ({ platform }))),
    },
  } as any;
}

describe("assertMediaForPlatforms", () => {
  it("throws for a media-less Instagram target (AI off)", async () => {
    const prisma = mockPrisma(["INSTAGRAM"]);
    await expect(
      assertMediaForPlatforms(prisma, "org1", ["chan1"], false),
    ).rejects.toThrow(/Instagram require/i);
  });

  it("throws for a media-less Facebook target (AI off)", async () => {
    const prisma = mockPrisma(["FACEBOOK"]);
    await expect(
      assertMediaForPlatforms(prisma, "org1", ["chan1"], false),
    ).rejects.toThrow(/Facebook require/i);
  });

  it("allows a media-less Instagram target when media IS attached", async () => {
    const prisma = mockPrisma(["INSTAGRAM"]);
    await expect(
      assertMediaForPlatforms(prisma, "org1", ["chan1"], true),
    ).resolves.toBeUndefined();
  });

  it("allows a media-less Twitter target", async () => {
    const prisma = mockPrisma(["TWITTER"]);
    await expect(
      assertMediaForPlatforms(prisma, "org1", ["chan1"], false),
    ).resolves.toBeUndefined();
  });

  it("does not query when no channels are supplied", async () => {
    const prisma = mockPrisma([]);
    await expect(
      assertMediaForPlatforms(prisma, "org1", [], false),
    ).resolves.toBeUndefined();
    expect(prisma.channel.findMany).not.toHaveBeenCalled();
  });

  it("scopes the channel lookup to the org (IDOR defense)", async () => {
    const prisma = mockPrisma(["TWITTER"]);
    await assertMediaForPlatforms(prisma, "org1", ["chan1"], false);
    expect(prisma.channel.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["chan1"] }, organizationId: "org1" },
      select: { platform: true },
    });
  });
});
```

- [ ] **Step 2: Run the test — expect PASS** (the helper exists from Task 3; this test guards it).
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run packages/api/src/__tests__/chat-media-required.test.ts
```
Expected: `Test Files  1 passed`, `Tests  6 passed`. If it FAILS with an import error, Task 3 Step 2 was not applied — fix that first.

- [ ] **Step 3: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add packages/api/src/__tests__/chat-media-required.test.ts && git commit -m "test(scheduler): chat schedule-time media-required block regression

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Worker recovery helpers — `mediaRequiredReason` + `terminalizeStuckClaim`

**Files:**
- Modify: `apps/worker/src/lib/publish-recovery.ts` (append after `shouldReapPublishing`, line 113)
- Test: `apps/worker/src/lib/publish-recovery.test.ts` (append)

- [ ] **Step 1: Write the failing tests.** In `apps/worker/src/lib/publish-recovery.test.ts`, update the import line and append new describe blocks. Change the import line at the top to:
```ts
import { markTargetFailed, shouldReapPublishing, mediaRequiredReason, terminalizeStuckClaim } from "./publish-recovery";
```
Then append at the end of the file:
```ts
describe("mediaRequiredReason", () => {
  it("names Instagram in the reason", () => {
    const msg = mediaRequiredReason("INSTAGRAM");
    expect(msg).toContain("Instagram");
    expect(msg.toLowerCase()).toContain("image");
  });

  it("names Facebook in the reason", () => {
    expect(mediaRequiredReason("FACEBOOK")).toContain("Facebook");
  });

  it("falls back to the raw platform for an unmapped platform", () => {
    expect(mediaRequiredReason("THREADS")).toContain("THREADS");
  });
});

describe("terminalizeStuckClaim", () => {
  it("terminalizes when the claim found nothing on the final attempt", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: true })).toBe(true);
  });

  it("does NOT terminalize on a non-final no-op claim (a later attempt may succeed)", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: false })).toBe(false);
  });

  it("does NOT terminalize when the claim succeeded (count > 0)", () => {
    expect(terminalizeStuckClaim({ claimCount: 1, isFinalAttempt: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (exports missing).**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run apps/worker/src/lib/publish-recovery.test.ts
```
Expected: FAILS — `mediaRequiredReason is not a function` / `terminalizeStuckClaim is not a function`.

- [ ] **Step 3: Implement the helpers.** At the end of `apps/worker/src/lib/publish-recovery.ts` (after `shouldReapPublishing`, line 113), append:
```ts

const MEDIA_REQUIRED_LABEL: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};

/**
 * Human-readable FAILED reason for a post that hit the media-required wall in the
 * worker (no media attached and AI auto-generation didn't produce an image).
 * Used by the worker's `media_required` error branch.
 */
export function mediaRequiredReason(platform: string): string {
  const label = MEDIA_REQUIRED_LABEL[platform] ?? platform;
  return `${label} requires an image or video; none was attached and AI generation is off or unavailable. Attach media (or enable AI image generation) and retry.`;
}

/**
 * Pure decision: should the worker FORCE a stuck PUBLISHING target to FAILED?
 *
 * The atomic claim guard only transitions SCHEDULED/FAILED/DRAFT → PUBLISHING. A
 * BullMQ retry on a target that is ALREADY PUBLISHING gets claimCount === 0 and
 * the worker returns early — but on the FINAL attempt that early return would
 * leave the target orphaned at PUBLISHING forever (the watchdog only reaps after
 * 30 min). So on the final attempt with a no-op claim we must terminalize it now.
 */
export function terminalizeStuckClaim(opts: {
  claimCount: number;
  isFinalAttempt: boolean;
}): boolean {
  return opts.claimCount === 0 && opts.isFinalAttempt;
}
```

- [ ] **Step 4: Run the test — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run apps/worker/src/lib/publish-recovery.test.ts
```
Expected: all existing `shouldReapPublishing`/`markTargetFailed` tests plus the 6 new ones pass.

- [ ] **Step 5: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add apps/worker/src/lib/publish-recovery.ts apps/worker/src/lib/publish-recovery.test.ts && git commit -m "feat(worker): mediaRequiredReason + terminalizeStuckClaim recovery helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Worker — terminalize stuck claim on the final attempt

**Files:**
- Modify: `apps/worker/src/workers/post-publish.worker.ts` (claim guard, lines 220–229)

- [ ] **Step 1: Add the import.** At the top of `apps/worker/src/workers/post-publish.worker.ts`, change the existing recovery import (line 6) from:
```ts
import { markTargetFailed, buildPublishNotifications } from "../lib/publish-recovery";
```
to:
```ts
import { markTargetFailed, buildPublishNotifications, mediaRequiredReason, terminalizeStuckClaim } from "../lib/publish-recovery";
```

- [ ] **Step 2: Replace the silent-return claim guard.** Replace the block at lines 226–229:
```ts
      if (claim.count === 0) {
        console.warn(`[PostPublish] target ${postTargetId} already claimed or published — skipping duplicate job ${job.id}`);
        return;
      }
```
with:
```ts
      if (claim.count === 0) {
        // The claim guard only transitions SCHEDULED/FAILED/DRAFT → PUBLISHING.
        // count===0 means the target is already PUBLISHING/PUBLISHED or gone.
        // On a NON-final attempt we skip (a later attempt or the original job may
        // still finish). On the FINAL attempt a no-op claim means a previous
        // attempt left it orphaned at PUBLISHING — terminalize it now so it can't
        // sit "in progress" forever (the 30-min watchdog is the slow backstop).
        const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts?.attempts ?? 1);
        if (terminalizeStuckClaim({ claimCount: claim.count, isFinalAttempt })) {
          const stuck = await prisma.postTarget.findUnique({
            where: { id: postTargetId },
            select: { status: true, publishedId: true },
          });
          // Only terminalize a target genuinely orphaned at PUBLISHING with no
          // platform id — never clobber a PUBLISHED row or one that has a
          // publishedId (the publishedId short-circuit will mark it PUBLISHED).
          if (stuck && stuck.status === "PUBLISHING" && !stuck.publishedId) {
            await markTargetFailed(
              prisma,
              postTargetId,
              "Publishing did not complete after all retries — please retry.",
            );
            console.warn(`[PostPublish] target ${postTargetId} orphaned at PUBLISHING on final attempt — marked FAILED (job ${job.id})`);
          }
        } else {
          console.warn(`[PostPublish] target ${postTargetId} already claimed or published — skipping duplicate job ${job.id}`);
        }
        return;
      }
```

- [ ] **Step 3: Type-check the worker — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm --filter @postautomation/worker exec tsc --noEmit
```
Expected: no errors (exit 0).

- [ ] **Step 4: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add apps/worker/src/workers/post-publish.worker.ts && git commit -m "fix(worker): terminalize orphaned PUBLISHING target on final claim no-op

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Worker — `media_required` FAILED handler with a human reason

**Files:**
- Modify: `apps/worker/src/workers/post-publish.worker.ts` (validation block 433–437; error branch switch 478–567)

- [ ] **Step 1: Add a `media_required` branch to the publish-error switch.** In the `catch (publishErr: any)` block, insert a new branch immediately before the `else if (errType === "content_too_large")` branch (currently line 540). Insert after the `token_expired` branch's closing `}` (line 539):
```ts
        } else if (errType === "media_required") {
          // Media-required platform (IG/FB) with no usable media. Retrying re-runs
          // the same media-less input and fails identically; the retry's claim
          // guard would then skip it as a duplicate and orphan it at PUBLISHING.
          // Mark FAILED here with a clear human reason so the user knows to attach
          // media or enable AI image generation.
          const reason = mediaRequiredReason(platform);
          await markTargetFailed(prisma, postTargetId, reason);
          throw new UnrecoverableError(reason);
```

- [ ] **Step 2: Classify the pre-publish validation failure as `media_required`.** Replace the validation block at lines 433–437:
```ts
      // Validate content before publishing
      const errors = provider.validateContent({ content: publishContent, mediaUrls, mediaTypes });
      if (errors.length > 0) {
        throw new Error(`Validation failed: ${errors.join(", ")}`);
      }
```
with:
```ts
      // Validate content before publishing
      const errors = provider.validateContent({ content: publishContent, mediaUrls, mediaTypes });
      if (errors.length > 0) {
        // A media-required platform with no media is the common "stuck scheduled
        // post" cause. Terminalize it now with a clear human reason instead of
        // throwing a generic Validation-failed error into the retry loop (which
        // would orphan it at PUBLISHING). UnrecoverableError stops BullMQ retries.
        if (
          mediaUrls.length === 0 &&
          mediaRequiredPlatforms.includes(platform)
        ) {
          const reason = mediaRequiredReason(platform);
          await markTargetFailed(prisma, postTargetId, reason);
          throw new UnrecoverableError(reason);
        }
        throw new Error(`Validation failed: ${errors.join(", ")}`);
      }
```
(Note: `mediaRequiredPlatforms` is already defined at line 385 within the same handler scope and is in scope here; `UnrecoverableError` is already imported at line 1.)

- [ ] **Step 3: Type-check the worker — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm --filter @postautomation/worker exec tsc --noEmit
```
Expected: no errors (exit 0).

- [ ] **Step 4: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add apps/worker/src/workers/post-publish.worker.ts && git commit -m "fix(worker): media_required handler marks target FAILED with human reason

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Worker state-machine regression tests (mock prisma, no Redis)

**Files:**
- Create: `apps/worker/src/workers/__tests__/post-publish-state.test.ts`

- [ ] **Step 1: Write the test.** Create `apps/worker/src/workers/__tests__/post-publish-state.test.ts`. These tests exercise the extracted pure helpers exactly as the worker uses them, plus the `markTargetFailed` write contract against a mock prisma — proving the terminal FAILED behavior without booting BullMQ:
```ts
import { describe, it, expect, vi } from "vitest";
import {
  markTargetFailed,
  mediaRequiredReason,
  terminalizeStuckClaim,
} from "../../lib/publish-recovery";

/** Mirror of the worker's classifyError media_required branch (worker line 199). */
function classifyMediaError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("requires at least one image") || m.includes("media required");
}

describe("media-required publish path", () => {
  it("classifies the Instagram validation error as media_required", () => {
    // The exact string instagram.provider.ts:80 pushes.
    expect(
      classifyMediaError("Instagram requires at least one image or video to publish a post."),
    ).toBe(true);
  });

  it("writes a FAILED target with the human media-required reason", async () => {
    const update = vi.fn(async () => ({}));
    const prisma = { postTarget: { update } } as any;

    await markTargetFailed(prisma, "target-1", mediaRequiredReason("INSTAGRAM"));

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "target-1" });
    expect(arg.data.status).toBe("FAILED");
    expect(arg.data.errorMessage).toContain("Instagram");
    expect(arg.data.errorMessage.toLowerCase()).toContain("image");
  });
});

describe("final-attempt orphan terminalization", () => {
  it("forces FAILED when a double-claim no-op lands on the final attempt", async () => {
    // Simulate the worker claim guard's decision + the resulting DB write.
    const claimCount = 0; // target was already PUBLISHING → updateMany matched nothing
    const isFinalAttempt = true; // job.attemptsMade + 1 >= attempts

    const shouldFail = terminalizeStuckClaim({ claimCount, isFinalAttempt });
    expect(shouldFail).toBe(true);

    const update = vi.fn(async () => ({}));
    const prisma = { postTarget: { update } } as any;
    if (shouldFail) {
      await markTargetFailed(prisma, "target-2", "Publishing did not complete after all retries — please retry.");
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.status).toBe("FAILED");
  });

  it("does NOT force FAILED on a non-final no-op claim", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: false })).toBe(false);
  });

  it("does NOT force FAILED when the claim succeeded", () => {
    expect(terminalizeStuckClaim({ claimCount: 1, isFinalAttempt: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — expect PASS** (helpers exist from Task 5).
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run apps/worker/src/workers/__tests__/post-publish-state.test.ts
```
Expected: `Test Files  1 passed`, `Tests  6 passed`.

- [ ] **Step 3: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add apps/worker/src/workers/__tests__/post-publish-state.test.ts && git commit -m "test(worker): media-required + final-attempt orphan terminalization regression

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Verify the 30-min watchdog still reaps (no `updatedAt` refresh on no-op retries)

**Files:**
- Modify: `apps/worker/src/lib/publish-recovery.test.ts` (append a documentation-grade assertion test)

This task confirms the spec bullet "Verify the 30-min PUBLISHING watchdog reaps (no `updatedAt` refresh on no-op retries)." The auto-healer reaper (`auto-healer.worker.ts:299-326`) and `cron-jobs.ts:445-475` filter on `updatedAt < now-30min`. The claim guard at `post-publish.worker.ts:222` uses `updateMany({ where: { status: { in: ["SCHEDULED","FAILED","DRAFT"] } } })`; when a target is already `PUBLISHING`, that matches **zero rows**, so Prisma writes nothing and the `@updatedAt` column is **not** refreshed — the orphan's `updatedAt` keeps aging and the reaper correctly fires after 30 min. The only writes that touch `updatedAt` (the new terminalize + media_required branches) move the target to `FAILED`, which is terminal and no longer matches the reaper's `status: "PUBLISHING"` filter. We lock this invariant with a test.

- [ ] **Step 1: Append the invariant test.** At the end of `apps/worker/src/lib/publish-recovery.test.ts`, append:
```ts
describe("watchdog reap invariant", () => {
  it("reaps a target orphaned at PUBLISHING whose updatedAt was NOT refreshed by no-op retries", () => {
    // A no-op claim (count===0) writes no row, so @updatedAt is not bumped — the
    // orphan keeps aging and crosses the 30-min threshold.
    const now = new Date("2026-06-13T12:00:00.000Z");
    const orphanedAt = new Date(now.getTime() - 31 * 60 * 1000); // last real write 31 min ago
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt: orphanedAt }, now)).toBe(true);
  });

  it("does NOT reap a target that the worker just terminalized to FAILED", () => {
    const now = new Date("2026-06-13T12:00:00.000Z");
    const justFailed = new Date(now.getTime() - 31 * 60 * 1000);
    // FAILED is terminal — the reaper's status:PUBLISHING filter excludes it.
    expect(shouldReapPublishing({ status: "FAILED", updatedAt: justFailed }, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run apps/worker/src/lib/publish-recovery.test.ts
```
Expected: all `shouldReapPublishing` / `markTargetFailed` / `mediaRequiredReason` / `terminalizeStuckClaim` / watchdog-invariant tests pass.

- [ ] **Step 3: Commit.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git add apps/worker/src/lib/publish-recovery.test.ts && git commit -m "test(worker): lock watchdog reap invariant (no updatedAt refresh on no-op claim)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Full-suite green-check + branch finish

**Files:** none (verification only)

- [ ] **Step 1: Run all touched test files together — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run packages/api/src/lib/__tests__/media-required.test.ts packages/api/src/__tests__/chat-media-required.test.ts apps/worker/src/lib/publish-recovery.test.ts apps/worker/src/workers/__tests__/post-publish-state.test.ts
```
Expected: `Test Files  4 passed`, all tests green.

- [ ] **Step 2: Confirm no security/IDOR regressions — the existing chat IDOR + gating suites still pass.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm exec vitest run packages/api/src/__tests__/chat-channel-ownership.test.ts packages/api/src/__tests__/chat-action-media.test.ts packages/api/src/__tests__/chat-action-gating.test.ts
```
Expected: all pass (the new `assertMediaForPlatforms` runs AFTER `assertChannelsOwned`/`assertMediaOwned`, preserving the org-scoped guards).

- [ ] **Step 3: Type-check both touched packages — expect PASS.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && pnpm --filter @postautomation/api exec tsc --noEmit && pnpm --filter @postautomation/worker exec tsc --noEmit
```
Expected: no errors (exit 0) for both.

- [ ] **Step 4: Review the full diff for the branch.**
```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation && git log --oneline -10 && git diff main --stat
```
Expected: 9 commits across the files listed in `## Files`; no unrelated files changed.
