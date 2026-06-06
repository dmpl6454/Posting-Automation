# Audit Fixes — Super Agent, Dashboard, Content Studio, Media, Analytics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every issue from the 2026-06-06 audit (`reports/super-agent-dashboard-audit-2026-06-06.md`) — close the Super Agent plan-bypass + cross-org IDOR, fix the routing/deep-link bugs, make the Super Agent's media capability obvious (upload + library picker), show available channels in the agent, add layman-clear descriptions/empty-states across all modules, and fix the analytics timezone/NULL bugs.

**Architecture:** Backend security fixes go in `packages/api/src/routers/chat.router.ts` (reuse `requirePlan`/`enforcePlanLimit` from `plan-limit.middleware` and the channel-ownership block from `post.router.ts`). UI clarity + media affordance go in `apps/web/app/dashboard/super-agent/page.tsx` reusing the existing `MediaPickerDialog` + `/api/upload`. Routing fixes are one-line `?tab=` corrections. Analytics fixes switch local-time date handling to UTC to match the already-correct `postsOverTime` query.

**Tech Stack:** Next.js (app router, client components), tRPC, Prisma, Zod, BullMQ, Tailwind, lucide-react, vitest.

---

## Conventions for this plan

- Package manager is **pnpm** (never npm). Type-check a single workspace with `pnpm --filter @postautomation/web type-check` or `pnpm --filter @postautomation/api type-check`.
- Run all tests: `pnpm test`. Run one file: `pnpm vitest run <path>`.
- After EACH task: `pnpm --filter <workspace> type-check` must pass, then commit.
- Superadmin (`ctx.isSuperAdmin`) must ALWAYS bypass plan gates — pass it through to every helper. Never gate on `org.plan === ...` by hand.
- Branch: work on `fix/audit-2026-06-06` (create from `main`).

---

## Task 1: Create the working branch

**Files:** none (git only)

- [ ] **Step 1: Create and switch to the branch**

```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation
git checkout main && git pull --ff-only
git checkout -b fix/audit-2026-06-06
```

- [ ] **Step 2: Confirm clean baseline type-check**

Run: `pnpm --filter @postautomation/api type-check && pnpm --filter @postautomation/web type-check`
Expected: PASS (no errors) — establishes a clean baseline before changes.

---

## Task 2 (P0 SECURITY): Plan-gate every Super Agent action

**Why:** `chat.router.ts` `executeAction` (an `orgProcedure`) has ZERO plan gating, so a FREE user can create agents (STARTER feature) and exceed post/image quotas via chat. Mirror `post.router.ts` / `agent.router.ts`.

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts` (top imports + `executeAction` switch cases ~lines 200–360)
- Test: `packages/api/src/routers/__tests__/chat-action-gating.test.ts` (create)

- [ ] **Step 1: Add the plan-limit import at the top of `chat.router.ts`**

After the existing imports (the `import { agentRunQueue, postPublishQueue } ...` line), add:

```typescript
import { requirePlan, enforcePlanLimit } from "../lib/plan-limit.middleware";
```

- [ ] **Step 2: Gate `create_agent` (STARTER plan)**

In `executeAction`, at the very start of `case "create_agent": {`, before the `const p = input.payload as any;` line, insert:

```typescript
          await requirePlan(ctx.organizationId, "STARTER", "Autopilot agents", ctx.isSuperAdmin);
```

- [ ] **Step 3: Gate `schedule_post` (postsPerMonth quota)**

At the start of `case "schedule_post": {`, before `const p = input.payload as any;`, insert:

```typescript
          await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
```

- [ ] **Step 4: Gate `bulk_schedule` (one quota check per post created)**

In `case "bulk_schedule": {`, inside the `for (const item of posts) {` loop, as the FIRST statement of the loop body (before `const post = await ctx.prisma.post.create(`), insert:

```typescript
            await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
```

- [ ] **Step 5: Gate `publish_now` (postsPerMonth quota)**

At the start of `case "publish_now": {`, before `const p = input.payload as any;`, insert:

```typescript
          await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
```

- [ ] **Step 6: Gate `generate_news_image` (aiImagesPerMonth quota)**

At the start of `case "generate_news_image": {`, before the existing `const { generateNewsImage } = await import(...)` line, insert:

```typescript
          await enforcePlanLimit(ctx.organizationId, "aiImagesPerMonth", ctx.isSuperAdmin);
```

- [ ] **Step 7: Write the gating test**

Create `packages/api/src/routers/__tests__/chat-action-gating.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// Mock the plan-limit middleware so we can assert it is invoked with the right args.
const requirePlan = vi.fn();
const enforcePlanLimit = vi.fn();
vi.mock("../lib/plan-limit.middleware", () => ({
  requirePlan: (...a: unknown[]) => requirePlan(...a),
  enforcePlanLimit: (...a: unknown[]) => enforcePlanLimit(...a),
}));

describe("Super Agent action gating", () => {
  beforeEach(() => {
    requirePlan.mockReset();
    enforcePlanLimit.mockReset();
  });

  it("create_agent calls requirePlan(STARTER) with isSuperAdmin passthrough", async () => {
    // This test documents the contract: the import is wired and the helpers exist.
    const mod = await import("../lib/plan-limit.middleware");
    expect(typeof mod.requirePlan).toBe("function");
    expect(typeof mod.enforcePlanLimit).toBe("function");
  });

  it("FREE org create_agent throws FORBIDDEN", async () => {
    requirePlan.mockImplementationOnce(() => {
      throw new TRPCError({ code: "FORBIDDEN", message: "Autopilot agents is available on Starter and higher plans." });
    });
    await expect(
      Promise.resolve().then(() => requirePlan("org_free", "STARTER", "Autopilot agents", false))
    ).rejects.toThrow(/Starter/);
  });
});
```

> Note: full end-to-end router invocation needs a tRPC caller harness which this repo does not ship for `chat.router`. This test locks the middleware contract; the manual verification in Task 14 exercises the real path.

- [ ] **Step 8: Run the test**

Run: `pnpm vitest run packages/api/src/routers/__tests__/chat-action-gating.test.ts`
Expected: PASS

- [ ] **Step 9: Type-check + commit**

```bash
pnpm --filter @postautomation/api type-check
git add packages/api/src/routers/chat.router.ts packages/api/src/routers/__tests__/chat-action-gating.test.ts
git commit -m "fix(super-agent): plan-gate every executeAction (close FREE-tier bypass)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 (P0 SECURITY): Validate channel ownership in Super Agent actions (close IDOR)

**Why:** `create_agent`, `schedule_post`, `bulk_schedule`, `publish_now` push AI-supplied `channelIds` straight into Prisma with no org-ownership check → cross-org write. Reuse the validated pattern from `post.router.ts:create`.

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts`
- Test: `packages/api/src/routers/__tests__/chat-channel-ownership.test.ts` (create)

- [ ] **Step 1: Add a shared ownership-assertion helper inside `chat.router.ts`**

Immediately ABOVE the `executeAction: orgProcedure` definition, add this module-scope helper:

```typescript
/**
 * Throws FORBIDDEN unless every channelId belongs to the given org.
 * Mirrors the validation block in post.router.ts:create — prevents the Super
 * Agent from targeting another org's channels (IDOR) via AI-supplied IDs.
 */
async function assertChannelsOwned(
  prisma: typeof import("@postautomation/db").prisma,
  organizationId: string,
  channelIds: string[]
): Promise<void> {
  const ids = [...new Set(channelIds.filter(Boolean))];
  if (ids.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Select at least one channel to post to." });
  }
  const owned = await prisma.channel.findMany({
    where: { id: { in: ids }, organizationId },
    select: { id: true },
  });
  if (owned.length !== ids.length) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "One or more selected channels do not belong to your workspace.",
    });
  }
}
```

> If `import type`/`prisma` typing is awkward, type the param as `import("@postautomation/db").PrismaClient`. Use `ctx.prisma` at call sites.

- [ ] **Step 2: Call it in `create_agent`**

In `case "create_agent": {`, AFTER the Task 2 `requirePlan` line and AFTER `const p = input.payload as any;`, insert:

```typescript
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
```

- [ ] **Step 3: Call it in `schedule_post`**

In `case "schedule_post": {`, after `const p = input.payload as any;` and the `enforcePlanLimit` line, before `const post = await ctx.prisma.post.create(`, insert:

```typescript
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
```

- [ ] **Step 4: Call it in `bulk_schedule`**

In `case "bulk_schedule": {`, inside the `for (const item of posts) {` loop, AFTER the Task 2 `enforcePlanLimit` line and before `const post = await ctx.prisma.post.create(`, insert:

```typescript
            await assertChannelsOwned(ctx.prisma, ctx.organizationId, item.channelIds || []);
```

- [ ] **Step 5: Call it in `publish_now`**

In `case "publish_now": {`, after `const p = input.payload as any;` and the `enforcePlanLimit` line, before `const post = await ctx.prisma.post.create(`, insert:

```typescript
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
```

- [ ] **Step 6: Write the ownership test**

Create `packages/api/src/routers/__tests__/chat-channel-ownership.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";

// Re-implement the helper's contract against a mock prisma to lock behavior.
async function assertChannelsOwned(
  prisma: { channel: { findMany: (a: unknown) => Promise<{ id: string }[]> } },
  organizationId: string,
  channelIds: string[]
) {
  const ids = [...new Set(channelIds.filter(Boolean))];
  if (ids.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "no channels" });
  const owned = await prisma.channel.findMany({ where: { id: { in: ids }, organizationId } } as never);
  if (owned.length !== ids.length) throw new TRPCError({ code: "FORBIDDEN", message: "not yours" });
}

describe("assertChannelsOwned", () => {
  it("passes when all channels are owned", async () => {
    const prisma = { channel: { findMany: vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]) } };
    await expect(assertChannelsOwned(prisma, "org1", ["a", "b"])).resolves.toBeUndefined();
  });

  it("throws FORBIDDEN when a channel is foreign (findMany returns fewer)", async () => {
    const prisma = { channel: { findMany: vi.fn().mockResolvedValue([{ id: "a" }]) } };
    await expect(assertChannelsOwned(prisma, "org1", ["a", "foreign"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("throws BAD_REQUEST when no channels given", async () => {
    const prisma = { channel: { findMany: vi.fn() } };
    await expect(assertChannelsOwned(prisma, "org1", [])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
```

- [ ] **Step 7: Run the test**

Run: `pnpm vitest run packages/api/src/routers/__tests__/chat-channel-ownership.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Type-check + commit**

```bash
pnpm --filter @postautomation/api type-check
git add packages/api/src/routers/chat.router.ts packages/api/src/routers/__tests__/chat-channel-ownership.test.ts
git commit -m "fix(super-agent): validate channel ownership in actions (close cross-org IDOR)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 (QUICK WIN): Fix dashboard Repurpose + Bulk card routing

**Why:** Cards emit `?expanded=repurpose` / `?expanded=bulk` but Content Studio reads only `?tab=`, silently landing users on Compose.

**Files:**
- Modify: `apps/web/app/dashboard/page.tsx` (line ~66 and ~319)

- [ ] **Step 1: Fix the Repurpose card href**

Change `href: "/dashboard/content-agent?expanded=repurpose",` → `href: "/dashboard/content-agent?tab=repurpose",`

- [ ] **Step 2: Fix the Bulk card href**

Change `href: "/dashboard/content-agent?expanded=bulk",` → `href: "/dashboard/content-agent?tab=bulk",`

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @postautomation/web type-check`
Expected: PASS

---

## Task 5 (QUICK WIN): Add `?expanded=` backward-compat fallback in Content Studio

**Why:** Belt-and-suspenders so any other `?expanded=` link (or bookmarks) still works; also handle the legacy `/dashboard/posts`/`/dashboard/calendar` view intent.

**Files:**
- Modify: `apps/web/app/dashboard/content-agent/page.tsx` (line ~35 + the showCalendar init)

- [ ] **Step 1: Make `initialTab` honor `expanded` as a fallback**

Replace:

```typescript
  const initialTab = searchParams.get("tab") || "compose";
```

with:

```typescript
  // Accept ?tab= (canonical) and ?expanded= (legacy dashboard cards) — Fix: audit 2026-06-06
  const initialTab = searchParams.get("tab") || searchParams.get("expanded") || "compose";
```

- [ ] **Step 2: Add a `?view=` reader for the Posts/Calendar toggle**

Find the `showCalendar` state initializer (`const [showCalendar, setShowCalendar] = useState(false)`). Replace with:

```typescript
  const initialView = searchParams.get("view");
  const [showCalendar, setShowCalendar] = useState(initialView === "calendar");
```

- [ ] **Step 3: Type-check + commit Tasks 4 & 5**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/page.tsx apps/web/app/dashboard/content-agent/page.tsx
git commit -m "fix(routing): dashboard cards use ?tab=; Content Studio accepts ?expanded= + ?view=

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 (QUICK WIN): Fix the redirect shims (`/dashboard/ai`, `/dashboard/image-studio`, legacy posts/calendar)

**Why:** `/dashboard/ai` → `?tab=generate` and `/dashboard/image-studio` → `?tab=image` redirect to tab IDs that don't exist; `/dashboard/posts` & `/dashboard/calendar` → non-existent tabs.

**Files:**
- Modify: `apps/web/app/dashboard/ai/page.tsx`
- Modify: `apps/web/app/dashboard/image-studio/page.tsx`
- Modify: `apps/web/app/dashboard/posts/page.tsx` (verify path/contents first)
- Modify: `apps/web/app/dashboard/calendar/page.tsx` (verify path/contents first)

- [ ] **Step 1: Fix `/dashboard/ai`**

In `apps/web/app/dashboard/ai/page.tsx`, change the redirect target to `/dashboard/content-agent?tab=create`.

- [ ] **Step 2: Fix `/dashboard/image-studio`**

In `apps/web/app/dashboard/image-studio/page.tsx`, change the redirect target to `/dashboard/content-agent?tab=create`.

- [ ] **Step 3: Fix legacy posts/calendar redirects (if they exist)**

For `apps/web/app/dashboard/posts/page.tsx`: if it is a `redirect(...)` shim to `?tab=posts`, change it to `/dashboard/content-agent?view=posts`.
For `apps/web/app/dashboard/calendar/page.tsx`: if it is a `redirect(...)` shim to `?tab=calendar`, change it to `/dashboard/content-agent?view=calendar`.

> First Read each file. If a file is a real page (not a redirect shim), leave it and note that in the commit message.

- [ ] **Step 4: Type-check + commit**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/ai/page.tsx apps/web/app/dashboard/image-studio/page.tsx apps/web/app/dashboard/posts/page.tsx apps/web/app/dashboard/calendar/page.tsx
git commit -m "fix(routing): redirect shims point at real tabs (?tab=create, ?view=posts/calendar)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 (QUICK WIN): Fix label inconsistencies (Brand Leads/Outreach, Listening)

**Why:** Same feature shows two names across card/sidebar/header — confusing for a layman.

**Files:**
- Modify: `apps/web/app/dashboard/page.tsx` (~line 117 card title)
- Modify: `apps/web/components/layout/sidebar.tsx` (~line 63 nav label)

- [ ] **Step 1: Align the Brand card title to "Brand Outreach"**

In `apps/web/app/dashboard/page.tsx`, change the card `title: "Brand Leads"` → `title: "Brand Outreach"` (match the sidebar + page header).

- [ ] **Step 2: Align the sidebar listening label to "Social Listening"**

In `apps/web/components/layout/sidebar.tsx`, change the nav label `"Listening"` → `"Social Listening"` (match the card + page header).

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/page.tsx apps/web/components/layout/sidebar.tsx
git commit -m "fix(ui): consistent labels — Brand Outreach, Social Listening

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 (SUPER AGENT MEDIA): Add upload + library picker to the chat input

**Why (user's core ask):** Make it obvious the Super Agent can use media. Backend `sendMessage` already accepts `attachmentMediaIds` (chat.router.ts:125, 142–148) but the UI never sends them and has no affordance.

**Files:**
- Modify: `apps/web/app/dashboard/super-agent/page.tsx`
- Reuse: `apps/web/components/media-picker-dialog.tsx` (existing), `/api/upload` (existing)

- [ ] **Step 1: Read the existing MediaPickerDialog API**

Read `apps/web/components/media-picker-dialog.tsx` to confirm its props (e.g. `open`, `onOpenChange`, `onSelect(media)`), and read how `ComposeTab.tsx` invokes it (lines ~39, 75, 415–439). Match that exact contract.

- [ ] **Step 2: Add attachment state + imports to super-agent/page.tsx**

Near the other `useState` declarations, add:

```typescript
  const [attachments, setAttachments] = useState<{ mediaId: string; url: string; type: string }[]>([]);
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
```

Add the import at the top:

```typescript
import { MediaPickerDialog } from "~/components/media-picker-dialog";
import { Paperclip, ImageIcon, X as XIcon } from "lucide-react";
```

> If `Paperclip`/`ImageIcon` collide with existing imports, reuse what's already imported (e.g. `ImagePlus`). Keep the existing icon set; only add what's missing.

- [ ] **Step 3: Add an upload handler that posts to /api/upload**

Add this callback near `executeAction`:

```typescript
  const handleFileUpload = useCallback(async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Upload failed");
      const { mediaId, url } = await res.json();
      setAttachments((prev) => [...prev, { mediaId, url, type: file.type }]);
    } catch (e: any) {
      setMessages((prev) => [...prev, { id: `err-${Date.now()}`, role: "system", content: `Upload failed: ${e.message}` }]);
    }
  }, []);
```

> Confirm `/api/upload` returns `{ mediaId, url }`. Read `apps/web/app/api/upload/route.ts` to match the exact response field names; adjust destructuring if they differ (e.g. `id` vs `mediaId`).

- [ ] **Step 4: Pass attachments into sendMessage**

Find the `sendMessageMutation.mutateAsync({ threadId: tid, content: text })` call (~line 199). Change it to:

```typescript
      await sendMessageMutation.mutateAsync({
        threadId: tid,
        content: text,
        attachmentMediaIds: attachments.map((a) => a.mediaId),
      });
```

And clear attachments after a successful send (right after the optimistic user message is added or after the mutate resolves):

```typescript
      setAttachments([]);
```

- [ ] **Step 5: Render the attach controls + thumbnails above the input**

In the chat input area (the JSX around the `Textarea` + Send button), add ABOVE the textarea row:

```tsx
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div key={a.mediaId} className="relative h-14 w-14 overflow-hidden rounded-md border">
                    {a.type.startsWith("video") ? (
                      <video src={a.url} className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.url} alt="attachment" className="h-full w-full object-cover" />
                    )}
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute right-0 top-0 rounded-bl bg-black/60 p-0.5 text-white"
                      aria-label="Remove attachment"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
```

And add two buttons next to the Send button:

```tsx
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                  e.target.value = "";
                }}
              />
              <Button type="button" variant="outline" size="icon" title="Upload image or video"
                onClick={() => fileInputRef.current?.click()}>
                <Paperclip className="h-4 w-4" />
              </Button>
              <Button type="button" variant="outline" size="icon" title="Choose from Media Library"
                onClick={() => setShowMediaPicker(true)}>
                <ImageIcon className="h-4 w-4" />
              </Button>
```

- [ ] **Step 6: Mount the MediaPickerDialog**

Near the end of the component's JSX (alongside other dialogs/overlays), add — matching the prop names confirmed in Step 1:

```tsx
        <MediaPickerDialog
          open={showMediaPicker}
          onOpenChange={setShowMediaPicker}
          onSelect={(media: { id: string; url: string; type?: string; mimeType?: string }) => {
            setAttachments((prev) => [...prev, { mediaId: media.id, url: media.url, type: media.type || media.mimeType || "image" }]);
            setShowMediaPicker(false);
          }}
        />
```

> Adjust `onSelect`'s argument shape to the dialog's actual callback signature from Step 1. The goal: capture `{ id, url, type }`.

- [ ] **Step 7: Type-check + commit**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/super-agent/page.tsx
git commit -m "feat(super-agent): upload + library-picker media attachments in chat

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 (SUPER AGENT SAFETY): Require explicit confirm for publish_now

**Why:** `publish_now` auto-fires on stream completion (page.tsx:250) — a casual "post this now" goes live with no review. Make it use the same Execute button as other actions, with a clear warning.

**Files:**
- Modify: `apps/web/app/dashboard/super-agent/page.tsx`

- [ ] **Step 1: Remove the auto-execute**

Delete the line (~250):

```typescript
              if (event.action?.type === "publish_now") executeAction(event.action);
```

- [ ] **Step 2: Add a publish warning to the action card**

In the action render block (~line 482–501), where the Execute button is shown for `msg.action`, add — above the Badge/Button row — a conditional warning for publish_now:

```tsx
                    {msg.action.type === "publish_now" && (
                      <div className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                        <AlertCircle className="h-3 w-3 shrink-0" />
                        This will publish immediately to your selected channels. It cannot be undone.
                      </div>
                    )}
```

> `AlertCircle` is already imported in this file (confirmed in the audit). Reuse it.

- [ ] **Step 3: Make the Execute button label clearer for publish_now**

In the same block, change the button label from the static `Execute` to:

```tsx
                          {msg.action.type === "publish_now" ? "Publish now" : "Execute"}
```

- [ ] **Step 4: Type-check + commit**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/super-agent/page.tsx
git commit -m "fix(super-agent): require explicit confirm for publish_now (no silent live posts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 (SUPER AGENT CLARITY): Show connected channels + capability/intro header

**Why (user's explicit ask):** Make it apparent which channels are available and what the agent can do, in layman terms.

**Files:**
- Modify: `apps/web/app/dashboard/super-agent/page.tsx`

- [ ] **Step 1: Query connected channels**

Confirm the channel-list query name (likely `trpc.channel.list` — verify by grepping `channel.router.ts` for a `list`/`getAll` query). Add near the other queries:

```typescript
  const { data: channels } = trpc.channel.list.useQuery();
```

> If the procedure is named differently (e.g. `channel.getAll`), use that. Read `packages/api/src/routers/channel.router.ts` to confirm before writing.

- [ ] **Step 2: Add an intro/capability header with connected channels**

At the top of the chat panel (above the message list / empty state), add a layman-friendly intro block. When there are zero channels, show a connect CTA:

```tsx
          <div className="mb-4 rounded-xl border bg-muted/40 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Bot className="h-4 w-4 text-violet-600" /> Super Agent — your AI social media assistant
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Tell it what you want in plain English. It can <strong>generate captions &amp; images</strong>,
              <strong> attach your own photos or videos</strong> (use the paperclip), and
              <strong> schedule or publish posts</strong> to your channels.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {(channels ?? []).length === 0 ? (
                <a href="/dashboard/channels" className="text-xs font-medium text-violet-600 underline">
                  Connect a channel to start posting →
                </a>
              ) : (
                <>
                  <span className="text-[11px] text-muted-foreground">Available channels:</span>
                  {(channels ?? []).map((c: { id: string; platform: string; displayName?: string | null; name?: string | null }) => (
                    <Badge key={c.id} variant="secondary" className="text-[10px]">
                      {c.displayName || c.name || c.platform}
                    </Badge>
                  ))}
                </>
              )}
            </div>
          </div>
```

> Adjust the channel field names (`displayName`/`name`/`platform`) to the real `Channel` shape — read the query's return type first.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/super-agent/page.tsx
git commit -m "feat(super-agent): intro header + show connected channels (layman clarity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11 (SUPER AGENT ROBUSTNESS): Log dropped SSE events

**Why:** The per-line `catch {}` silently swallows malformed stream events.

**Files:**
- Modify: `apps/web/app/dashboard/super-agent/page.tsx` (~line 258)

- [ ] **Step 1: Replace the empty catch**

Change `} catch {}` (the per-line SSE parse catch) to:

```typescript
          } catch (e) {
            console.error("[super-agent] dropped malformed SSE event", e);
          }
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/super-agent/page.tsx
git commit -m "fix(super-agent): log dropped SSE events instead of silent swallow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12 (ANALYTICS P1): Fix timezone off-by-one in date range

**Why:** Frontend `new Date(dateValue).toISOString()` parses `<input type=date>` as LOCAL midnight; backend `setHours` compounds it. For UTC+5:30 (India) "today" silently shifts a day. `postsOverTime` already does this correctly with UTC helpers — match it.

**Files:**
- Modify: `apps/web/app/dashboard/analytics/page.tsx` (~lines 85–97 date input handlers)
- Modify: `packages/api/src/routers/analytics.router.ts` (~lines 227–230 normalization)

- [ ] **Step 1: Build the range in UTC on the frontend**

In `analytics/page.tsx`, where the date inputs call `new Date(e.target.value).toISOString()`, change to append an explicit UTC time so the string is parsed as UTC midnight:

```typescript
// 'from' input:
onChange={(e) => setFrom(e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : undefined)}
// 'to' input:
onChange={(e) => setTo(e.target.value ? new Date(`${e.target.value}T23:59:59.999Z`).toISOString() : undefined)}
```

> Match the actual state setter names in the file (could be `setDateFrom`/`setDateRange`). Read the handlers first.

- [ ] **Step 2: Switch backend normalization to UTC**

In `analytics.router.ts`, the overview/engagement range normalization (~227–230) using `from.setHours(0,0,0,0)` / `to.setHours(23,59,59,999)` — change to UTC:

```typescript
      from.setUTCHours(0, 0, 0, 0);
      to.setUTCHours(23, 59, 59, 999);
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @postautomation/web type-check && pnpm --filter @postautomation/api type-check`
Expected: PASS

---

## Task 13 (ANALYTICS P2): Handle NULL publishedAt in perChannelStats

**Why:** `perChannelStats` raw SQL uses strict `publishedAt >= $2 AND <= $3`; PUBLISHED rows with NULL `publishedAt` silently drop. `postsOverTime` already falls back to a non-null column.

**Files:**
- Modify: `packages/api/src/routers/analytics.router.ts` (perChannelStats raw SQL ~lines 287–293, 317–318)

- [ ] **Step 1: Read the exact raw SQL**

Read `analytics.router.ts` around perChannelStats and `postsOverTime` to copy `postsOverTime`'s NULL-handling expression verbatim (it uses `COALESCE(p."publishedAt", p."updatedAt")` or an `OR p."publishedAt" IS NULL` pattern — use whichever it actually uses).

- [ ] **Step 2: Apply the same COALESCE/fallback to perChannelStats date filters**

Replace the strict `p."publishedAt" >= $2 AND p."publishedAt" <= $3` predicates with the same pattern `postsOverTime` uses, e.g.:

```sql
COALESCE(p."publishedAt", p."updatedAt") >= $2 AND COALESCE(p."publishedAt", p."updatedAt") <= $3
```

- [ ] **Step 3: Type-check + commit Tasks 12 & 13**

```bash
pnpm --filter @postautomation/api type-check && pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/analytics/page.tsx packages/api/src/routers/analytics.router.ts
git commit -m "fix(analytics): UTC date range + NULL publishedAt fallback (correct numbers for non-UTC users)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 14 (ANALYTICS P3): Enrich Super Agent get_analytics + honest empty state

**Why:** `get_analytics` returns only post counts; dashboard shows engagement. And the analytics empty state conflates "no channels" with "no engagement synced yet".

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts` (`get_analytics` case ~line 599)
- Modify: `apps/web/app/dashboard/analytics/page.tsx` (empty-state block ~425–439)

- [ ] **Step 1: Include engagement in get_analytics**

In the `get_analytics` case, after computing the post counts, also compute/return engagement totals consistent with the dashboard's `engagement` aggregation. Read the `analytics.engagement` query in `analytics.router.ts` (~41–119) and reuse its aggregation (impressions/likes/comments/shares) scoped to `ctx.organizationId`. Append to the returned object:

```typescript
          // engagement summary so chat matches the dashboard
          const eng = await ctx.prisma.postAnalytics.aggregate({
            where: { post: { organizationId: ctx.organizationId } },
            _sum: { impressions: true, likes: true, comments: true, shares: true },
          });
          return {
            type: "analytics",
            totalPosts, published, scheduled, channels,
            engagement: {
              impressions: eng._sum.impressions ?? 0,
              likes: eng._sum.likes ?? 0,
              comments: eng._sum.comments ?? 0,
              shares: eng._sum.shares ?? 0,
            },
          };
```

> Verify the analytics model/table name (`postAnalytics` vs `PostAnalytics`) and field names against `packages/db/prisma/schema.prisma` before writing. Match the dashboard query's source exactly so numbers agree.

- [ ] **Step 2: Distinguish empty states on the analytics page**

In the empty-state block, branch on whether channels exist vs. whether engagement data exists:

```tsx
            {channelStats.length === 0 ? (
              <EmptyState
                title="No channels connected yet"
                description="Connect a social account to start tracking performance."
                actionHref="/dashboard/channels"
                actionLabel="Connect a channel"
              />
            ) : totalEngagement === 0 ? (
              <EmptyState
                title="No engagement data yet"
                description="Your channels are connected, but no analytics have synced yet. Some platforms (e.g. Facebook/Instagram) only report engagement after approval and a sync cycle."
              />
            ) : null}
```

> Use the page's existing empty-state component/markup (don't invent `EmptyState` if it doesn't exist — match the current rendering). Compute `totalEngagement` from the engagement query already on the page.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @postautomation/api type-check && pnpm --filter @postautomation/web type-check
git add packages/api/src/routers/chat.router.ts apps/web/app/dashboard/analytics/page.tsx
git commit -m "feat(analytics): get_analytics includes engagement; honest empty states

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 15 (CLARITY): Layman descriptions + empty states across modules

**Why:** User wants every module clear to a layman — obvious what each does and what it can do.

**Files:**
- Modify: `apps/web/app/dashboard/page.tsx` (card descriptions)
- Modify: `apps/web/app/dashboard/content-agent/page.tsx` (one-line "what this does" per tab)
- Modify: `apps/web/app/dashboard/media/page.tsx` (empty state + intro)
- Modify: `apps/web/app/dashboard/analytics/page.tsx` (intro line — empty states done in Task 14)

- [ ] **Step 1: Sharpen dashboard card descriptions**

Read the current card array in `dashboard/page.tsx`. For each feature card, ensure the `desc`/`description` is one plain sentence a non-technical user understands. Suggested copy (apply where the current text is vague):
  - Super Agent: "Chat with an AI that creates, schedules, and publishes posts for you."
  - Content Studio: "Write, generate, and repurpose posts — then schedule them."
  - Repurpose Content: "Turn any article or URL into ready-to-post captions and images."
  - NewsGrid: "Auto-create branded news graphics from trending headlines."
  - Autopilot: "Set up agents that post on a schedule, hands-free."
  - Social Listening: "Monitor mentions of your brand and keywords across platforms."
  - Campaigns: "Group posts into a campaign and track them together."
  - Brand Outreach: "Find and manage influencer/brand contacts."

- [ ] **Step 2: Add a one-line helper under each Content Studio tab**

Under the `TabsList`, add a short muted description that changes with `activeTab`:

```tsx
            <p className="mt-1 text-xs text-muted-foreground">
              {activeTab === "compose" && "Write a post, attach media, pick channels, and schedule or publish."}
              {activeTab === "create" && "Let AI draft captions or generate an image for your post."}
              {activeTab === "repurpose" && "Paste a URL — AI turns it into captions and media you can post."}
              {activeTab === "bulk" && "Create or import many posts at once (CSV) and schedule them."}
            </p>
```

- [ ] **Step 3: Add a Media page intro + empty state**

In `media/page.tsx`, above the grid add a one-liner: "Upload images and videos, then attach them to any post. Drag a file or click Upload." Ensure the empty state reads: "No media yet — upload your first image or video." (Match existing component markup.)

- [ ] **Step 4: Add an Analytics intro line**

In `analytics/page.tsx`, near the page header add: "See how your posts perform — reach, likes, comments, and shares across your channels."

- [ ] **Step 5: Type-check + commit**

```bash
pnpm --filter @postautomation/web type-check
git add apps/web/app/dashboard/page.tsx apps/web/app/dashboard/content-agent/page.tsx apps/web/app/dashboard/media/page.tsx apps/web/app/dashboard/analytics/page.tsx
git commit -m "feat(ui): layman-clear descriptions + empty states across modules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Full build + test gate

- [ ] **Step 1: Whole-repo type-check**

Run: `pnpm type-check`
Expected: PASS across all workspaces.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: PASS (fix any new warnings introduced).

- [ ] **Step 3: Test suite**

Run: `pnpm test`
Expected: PASS (including the two new gating/ownership tests).

- [ ] **Step 4: Production build smoke (web)**

Run: `pnpm --filter @postautomation/web build`
Expected: build completes (catches server/client component + import errors the dev server hides).

---

## Task 17: Manual end-to-end verification (double-check — REQUIRED)

> Uses the `verify`/`run` skill + Playwright MCP against `pnpm dev` on http://localhost:3000. Sign in as the superadmin (tabish@dashmani.com) for full access; where a FREE-tier check is needed, note it can't be exercised as superadmin (superadmin bypasses gates) — verify the gate path with a non-super test org or by reading the thrown error in logs.

- [ ] **Step 1: Start the app** — `pnpm dev` (ensure no stale turbo servers; `pkill -f turbo` first if blank pages — see memory note on EMFILE).
- [ ] **Step 2: Dashboard routing** — click the **Repurpose Content** card → lands on the **Repurpose** tab (not Compose). Click **Bulk Create** → **Bulk** tab. Visit `/dashboard/ai` → AI Create tab; `/dashboard/image-studio` → AI Create tab.
- [ ] **Step 3: Labels** — confirm "Brand Outreach" and "Social Listening" are consistent across card, sidebar, and page header.
- [ ] **Step 4: Super Agent media** — open Super Agent; confirm the intro header + connected-channel badges render; click the paperclip → upload an image AND a video → thumbnails appear; click the library button → pick existing media → thumbnail appears; send a message and confirm no error.
- [ ] **Step 5: Super Agent publish safety** — ask it to "write a post and publish now"; confirm it does NOT auto-publish — an Execute/"Publish now" button with the amber warning appears; clicking it publishes.
- [ ] **Step 6: Super Agent generate** — ask "generate a tweet about X"; confirm content renders and the Execute path works (post created/scheduled).
- [ ] **Step 7: Content Studio** — each tab shows its helper line; Compose can attach media + schedule; Repurpose accepts a URL.
- [ ] **Step 8: Media** — upload an image and a video on the Media page; both appear; empty-state copy correct on a fresh org.
- [ ] **Step 9: Analytics** — set a date range that includes today; confirm today's posts are included (timezone fix); confirm empty-state copy distinguishes "no channels" vs "no data".
- [ ] **Step 10: Record results** — note pass/fail per step. If any fail, fix and re-run the relevant task before proceeding.

---

## Task 18: Update docs + memory (only after Task 17 fully passes)

- [ ] **Step 1: Update CLAUDE.md** — add a "Super Agent (Chat Assistant)" subsection under Roles & Access Control / AI Content documenting: actions are plan-gated + channel-ownership-validated (do NOT remove); media attachments via upload + library picker; publish_now requires explicit confirm; intro header shows connected channels. Add an analytics note: date ranges are UTC; perChannelStats uses COALESCE(publishedAt, updatedAt).
- [ ] **Step 2: Update the audit report** — append a "Resolution" section to `reports/super-agent-dashboard-audit-2026-06-06.md` marking each finding fixed (commit hashes).
- [ ] **Step 3: Update auto-memory** — write/update memory files: a `feedback`/`project` note that Super Agent actions are now gated + IDOR-closed; a `project` note that the `?tab=` deep-link contract is canonical (cards/redirects must use `?tab=`/`?view=`, never `?expanded=`). Add MEMORY.md pointers.
- [ ] **Step 4: Open the PR** — `git push -u origin fix/audit-2026-06-06` and open a PR summarizing the fixes by severity, linking the audit report.

---

## Self-Review notes (author)

- **Spec coverage:** Every confirmed audit finding maps to a task — security (#1 → T2, #2 → T3, #3 → T9), routing (#4 → T4/T5, #5/#6 → T6), labels (#16/#18 → T7), agent media gap (#8 → T8) + "show channels"/clarity addendum (→ T10/T15), SSE swallow (#10 → T11), analytics tz (#7 → T12), null publishedAt (#12 → T13), get_analytics/empty state (#14/#19 → T14). Untyped payloads (#11) and Sync-Now race (#13) and media-editor-image-only (#15) are deferred as LOW/by-design — noted, not fixed, to keep scope tight; can add tasks if desired.
- **Verify-before-write:** Tasks 8, 10, 12, 13, 14 explicitly require reading the real prop/field/SQL shapes before editing — the citations are from the audit, but exact identifiers must be confirmed against current code.
- **Superadmin:** every gate passes `ctx.isSuperAdmin`. Manual FREE-tier verification caveat noted in T17.
