# Mobile Responsiveness Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the confirmed mobile-responsiveness defects in the PostAutomation web app and stop the three recurring patterns (clipped tab rows, non-restacking control rows, fixed-width selects) class-wide via small shared primitives.

**Architecture:** Introduce two tiny client primitives — `ScrollableTabRow` (a horizontally-scrollable tab strip with a hidden scrollbar) and a documented `responsive-row` class pattern — then route every offending site through them. Independently fix the CSS-Grid `min-width:auto` overflow that clips Content Studio, and add a `grid-cols-1` base to cramped option grids. Every change is additive Tailwind / one small component; no data, API, or behavior changes.

**Tech Stack:** Next.js (App Router) + Tailwind CSS + shadcn/ui (`components/ui/*`), `cn()` from `~/lib/utils`. Verified locally with Playwright at 375/390/414px.

**Verification model:** The USER tests each increment in a real mobile browser. Therefore every task ends with a **TEST RECIPE** (URL + width + what to look for), not an automated assertion. Land work in small commits so the user can verify one slice at a time.

**Source of truth:** Audit at `docs/audit/2026-06-29-mobile-responsiveness-audit.md`. The HIGH-2 fix below was empirically validated: injecting `min-w-0` on the Content Studio grid items collapsed the runaway track from **504px → 326px** at a 390px viewport (overflow count 53 → 0).

---

## Ground rules for the implementer

1. **Verify the RENDERED result, not the class string.** The audit's live pass refuted 3 static "HIGH" findings (dashboard grids, Analytics table) that actually render fine. Do not "fix" things that already work. Only the items in this plan are confirmed.
2. **Do NOT touch `packages/ai/src/tools/creative-templates.ts` or any Repurpose *render* output.** A golden-render gate (`packages/ai/src/__tests__/repurpose-render-golden.test.ts`) snapshots that. This plan only touches `apps/web` UI chrome — none of it should alter creative renders. If `pnpm --filter @postautomation/ai test` is affected, you've edited the wrong file.
3. **`min-w-0` is the canonical fix for grid/flex children that won't shrink.** A grid/flex item defaults to `min-width:auto`, so a long descendant inflates the track past the viewport. Adding `min-w-0` lets it collapse. Prefer this over hard-coding widths.
4. **Commit after each task.** Branch off `main` first (see Task 0).
5. **Local dev:** infra is via `docker compose up -d` (Postgres 5433 / Redis 6380 / MinIO). Run the web app alone with `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web dev`. Seeded login for testing: `admin@postautomation.app` (password was reset locally to `Audit#2026` during the audit; reset again if needed).
6. After all web edits, before declaring done, run the **Next build gate** (per repo memory: SWC rejects syntax tsc accepts):
   `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` → expect exit 0.

---

## Task 0: Branch

**Step 1:** Create a working branch off `main`.
```bash
git checkout main && git pull
git checkout -b fix/mobile-responsiveness-2026-06-29
```
**Step 2:** Confirm clean working tree (`git status`).

---

## Task 1: Add the `ScrollableTabRow` primitive (build first, validate on one page)

**Why first:** It's the dependency for Tasks 2–4. Build it, prove it on Campaigns, then fan out.

**Files:**
- Create: `apps/web/components/ui/scrollable-tab-row.tsx`
- Verify util exists: `apps/web/lib/utils.ts` exports `cn`

**Step 1: Create the component.** Hidden-scrollbar horizontal strip; children are the existing tab buttons unchanged.
```tsx
// apps/web/components/ui/scrollable-tab-row.tsx
"use client";

import { cn } from "~/lib/utils";

/**
 * Horizontal, swipe-scrollable row for tab/segment strips so extra tabs are
 * reachable on narrow screens instead of being clipped by an overflow-hidden
 * ancestor. Scrollbar is visually hidden (utility added in globals.css).
 * Drop-in: replace the offending `<div className="flex border-b ...">` wrapper.
 */
export function ScrollableTabRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex overflow-x-auto whitespace-nowrap scrollbar-hide -mb-px",
        className,
      )}
      role="tablist"
    >
      {children}
    </div>
  );
}
```

**Step 2: Add the `scrollbar-hide` utility** to `apps/web/app/globals.css` (append near the bottom, inside the file's existing `@layer utilities` if present, else add one):
```css
@layer utilities {
  .scrollbar-hide {
    -ms-overflow-style: none;      /* IE/Edge */
    scrollbar-width: none;          /* Firefox */
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;                  /* Chrome/Safari */
  }
}
```
(If `globals.css` already has an `@layer utilities { ... }` block, add the two rules inside it instead of opening a second block.)

**Step 3: TEST RECIPE (after Task 2 wires the first consumer).** No standalone test — validated via Campaigns in Task 2.

**Step 4: Commit.**
```bash
git add apps/web/components/ui/scrollable-tab-row.tsx apps/web/app/globals.css
git commit -m "feat(ui): add ScrollableTabRow primitive + scrollbar-hide utility"
```

---

## Task 2: Fix Campaigns tab bar (HIGH-1) — first consumer of the primitive

**Files:**
- Modify: `apps/web/app/dashboard/campaigns/page.tsx:378`

**Step 1: Replace the tab-row wrapper.** Change the plain flex to the primitive; leave the `tabs.map(...)` buttons exactly as-is. Add `shrink-0` to each tab button so they don't compress instead of scrolling.

Current (line 378):
```tsx
<div className="flex border-b border-border/50">
  {tabs.map((tab) => (
    <button
      key={tab.key}
      onClick={() => setActiveTab(tab.key)}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
```
Change to:
```tsx
<ScrollableTabRow className="border-b border-border/50">
  {tabs.map((tab) => (
    <button
      key={tab.key}
      onClick={() => setActiveTab(tab.key)}
      className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
```
And close the wrapper: change the matching `</div>` (line ~395) to `</ScrollableTabRow>`.

**Step 2:** Add the import at the top of the file:
```tsx
import { ScrollableTabRow } from "~/components/ui/scrollable-tab-row";
```

**Step 3: TEST RECIPE.**
- Run web app, log in, open `http://localhost:3000/dashboard/campaigns` at **390px** width.
- **Expect:** all 4 tabs (Campaigns, Brand Trackers, Content Feed, Influencers) reachable by swiping the strip; no tab clipped with no way to reach it; the active underline still tracks.
- Before this fix the last tab sat 85px off-screen with no scrollbar.

**Step 4: Commit.**
```bash
git add apps/web/app/dashboard/campaigns/page.tsx
git commit -m "fix(campaigns): make tab bar horizontally scrollable on mobile (HIGH-1)"
```

---

## Task 3: Fix autopilot tab bar (systemic — same pattern)

**Files:**
- Modify: `apps/web/app/dashboard/autopilot/layout.tsx:33`

**Step 1:** This row has 7 tabs (Overview, Agents, Trending, Review Queue, Posts, Account Groups, Pipeline Logs) — `className="flex gap-1 border-b"`. Wrap with `ScrollableTabRow` and add `shrink-0` to each tab item. Keep `gap-1`.
```tsx
<ScrollableTabRow className="gap-1 border-b">
  {/* ...each tab link gets shrink-0 added to its className... */}
</ScrollableTabRow>
```
Add the import.

**Step 2: TEST RECIPE.** `/dashboard/autopilot` at 390px → all 7 tabs reachable by swipe, none clipped.

**Step 3: Commit.**
```bash
git add apps/web/app/dashboard/autopilot/layout.tsx
git commit -m "fix(autopilot): scrollable tab bar on mobile"
```

---

## Task 4: Fix brand-leads tab bar (systemic — same pattern)

**Files:**
- Modify: `apps/web/app/dashboard/brand-leads/page.tsx:588`

**Step 1:** `className="flex border-b border-border/50"`, tabs via `.map` with counts (already `whitespace-nowrap` on buttons). Wrap with `ScrollableTabRow`, add `shrink-0` to each button. Add import.

**Step 2: TEST RECIPE.** `/dashboard/brand-leads` at 390px → all tabs reachable by swipe.

**Step 3: Commit.**
```bash
git add apps/web/app/dashboard/brand-leads/page.tsx
git commit -m "fix(brand-leads): scrollable tab bar on mobile"
```

---

## Task 5: Fix Content Studio horizontal overflow (HIGH-2) — empirically validated

**Files:**
- Modify: `apps/web/components/content-agent/ComposeTab.tsx:665` (+ the two column children at 667 and the right/preview column)

**Root cause:** the grid `grid gap-6 lg:grid-cols-[1fr,400px]` has items with default `min-width:auto`; a descendant's intrinsic width inflates the (implicit, `<lg`) single column to ~504px on a 390px screen → cards clipped by the page shell. **Validated fix:** `min-w-0` on the grid and its column children collapses the track to viewport (504→326px, overflow 53→0).

**Step 1:** Add `min-w-0` to the grid container and BOTH column wrappers.
- Line 665: `<div className="grid gap-6 lg:grid-cols-[1fr,400px]">` → add `min-w-0`:
  `<div className="grid min-w-0 gap-6 lg:grid-cols-[1fr,400px]">`
- Line 667 (left/editor column): `<div className="space-y-6">` → `<div className="min-w-0 space-y-6">`
- The right/preview column wrapper (find the sibling `<div>` after the left column closes, holding the `<InstagramPreview/>` / preview switcher) → add `min-w-0` to it too.

**Step 2:** Guard inner flex rows that hold long content. The "Create with AI" Input row at line 704 (`<div className="flex gap-2">` with `Input(flex-1)` + Button) is fine because Input has `flex-1`, but confirm the row's parent `CardContent`/column carries `min-w-0` from Step 1. If any inner `flex` row still overflows in the test, add `min-w-0` to that row.

**Step 3: TEST RECIPE.**
- `/dashboard/content-agent` at **390px**.
- **Expect:** the "Create with AI" card, the Content textarea, the "Create Design" button, and the AI Image Generation card all fit within the screen — no text cut off at the right edge ("…will write it for", "Marvel movie:", "via Claude" should be fully visible or wrap, not clipped). No horizontal scroll on `<main>`.
- Also check the same component renders on `/dashboard/posts` and `/dashboard/calendar` (they mount Content Studio) — should be clean there too.

**Step 4: Commit.**
```bash
git add apps/web/components/content-agent/ComposeTab.tsx
git commit -m "fix(content-studio): collapse runaway grid track on mobile via min-w-0 (HIGH-2)"
```

---

## Task 6: Fix Content Studio + Image Studio cramped tab/option grids (HIGH-3, MEDIUM-5)

**Files:**
- Modify: `apps/web/app/dashboard/content-agent/page.tsx:65` and `:98`
- Modify: `apps/web/components/content-agent/ImageGenerationPanel.tsx:563` (+ the option grids at ~698, 796, 814, 995, 1078, 1117, 1146)
- Modify: `apps/web/components/content-agent/ImageTab.tsx:422`

**Step 1 (tab grids):** Give the `TabsList` grids a responsive column count so 4 tabs aren't crushed to 78px.
- `content-agent/page.tsx:65`: `grid w-full grid-cols-4` → `grid w-full grid-cols-2 sm:grid-cols-4`
  (2×2 on phone reads far better than 4×78px; labels are `hidden sm:inline` so icons stack 2-up.)
- `ImageGenerationPanel.tsx:563`: `grid w-full grid-cols-3` → `grid w-full grid-cols-1 sm:grid-cols-3` (or `grid-cols-3` is acceptable if each is ≥110px after fix — verify in test).

**Step 2 (option grids):** For each option-tile grid that currently leads with `grid-cols-3`/`grid-cols-4`/`grid-cols-5` and no mobile base, prepend a base of `grid-cols-2` (so tiles are ≥~165px on phone). Example — the Image Studio `grid grid-cols-3 gap-2 sm:grid-cols-5` → `grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5`. Apply the same `grid-cols-2` base to the sibling pickers in `ImageGenerationPanel.tsx` listed above and `ImageTab.tsx:422` (`grid-cols-2` is already fine at 2 — leave 2-col ones unless tiles are unreadable).

**Step 3: TEST RECIPE.**
- `/dashboard/content-agent` at 375px → the 4 main tabs render 2×2 (readable), not 4 cramped icons.
- `/dashboard/image-studio` at 375px → option tiles are tappable/readable (≥2 per row, not 3×87px).

**Step 4: Commit.**
```bash
git add apps/web/app/dashboard/content-agent/page.tsx apps/web/components/content-agent/ImageGenerationPanel.tsx apps/web/components/content-agent/ImageTab.tsx
git commit -m "fix(content-studio,image-studio): responsive tab/option grids on mobile (HIGH-3, MED-5)"
```

---

## Task 7: Fix the Team invite row + restack the multi-control rows (MEDIUM-4, systemic Pattern B)

**Files:**
- Modify: `apps/web/app/dashboard/team/page.tsx:140`
- Modify: `apps/web/app/dashboard/newsgrid/page.tsx:363, :827`
- Modify: `apps/web/app/dashboard/channels/page.tsx:795`
- Modify: `apps/web/components/content-agent/RepurposeTab.tsx:1033, :1684`

**Pattern (apply to each):** the row `<div className="flex gap-N ...">` holding [Input + Select + Button] (or Input + Button) → make it `flex flex-col gap-... sm:flex-row` so it stacks on phone; give the Button `w-full sm:w-auto` and any Select `w-full sm:w-[orig]` (Task 8 covers the select widths).

**Step 1 — Team invite (the proven one), team/page.tsx:140:**
```tsx
// before
<div className="flex gap-3">
  <Input ... className="flex-1" />
  <SelectTrigger className="w-32"> ... </SelectTrigger>
  <Button> <Plus className="mr-2 h-4 w-4" /> Invite </Button>
</div>
// after
<div className="flex flex-col gap-3 sm:flex-row">
  <Input ... className="flex-1" />
  <SelectTrigger className="w-full sm:w-32"> ... </SelectTrigger>
  <Button className="w-full sm:w-auto"> <Plus className="mr-2 h-4 w-4" /> Invite </Button>
</div>
```

**Step 2 — apply the same `flex-col … sm:flex-row` (and `w-full sm:w-auto` on trailing buttons) to:** newsgrid:363 (Input+Button search), newsgrid:827 (Input+Select platform filter), channels:795 (Input+Button), RepurposeTab:1033 (Input+Button), RepurposeTab:1684 (Input+Button). For rows that are *just* Input+Button and already comfortable side-by-side at 375px, prefer keeping them inline but ensure the Input has `flex-1 min-w-0` so it never collapses to "colle…"; only stack if the test shows crowding. Use judgement per the TEST RECIPE.

**Step 3: TEST RECIPE.**
- `/dashboard/team` at 360–375px → email field shows a full address (not "colle…"); role select + Invite button sit on their own full-width rows below.
- `/dashboard/newsgrid`, `/dashboard/channels` at 375px → search/filter rows don't crush the input.

**Step 4: Commit.**
```bash
git add apps/web/app/dashboard/team/page.tsx apps/web/app/dashboard/newsgrid/page.tsx apps/web/app/dashboard/channels/page.tsx apps/web/components/content-agent/RepurposeTab.tsx
git commit -m "fix(team,newsgrid,channels,repurpose): restack control rows on mobile (MED-4, Pattern B)"
```

---

## Task 8: Fix fixed-width selects (systemic Pattern C)

**Files & exact edits** (change `w-[orig]` → `w-full sm:w-[orig]`; the ones already carrying `sm:` are correct — leave them):
- `apps/web/app/dashboard/team/page.tsx:150` — `w-32` → `w-full sm:w-32`
- `apps/web/app/dashboard/team/page.tsx:217` — `w-28 h-8 text-xs` → `w-full sm:w-28 h-8 text-xs`
- `apps/web/app/dashboard/newsgrid/page.tsx:835` — `h-8 w-[140px] text-xs` → `h-8 w-full sm:w-[140px] text-xs`
- `apps/web/app/dashboard/brand-leads/page.tsx:608` — `w-40 h-8 text-xs` → `w-full sm:w-40 h-8 text-xs`
- `apps/web/app/admin/orgs/page.tsx:109` — `h-8 w-[130px]` → `h-8 w-full sm:w-[130px]`
- `apps/web/components/content-agent/RepurposeTab.tsx:1582` — `w-36` → `w-full sm:w-36`

**Leave as-is (already responsive):** `approvals/page.tsx:149`, `admin/posts/page.tsx:156, :170`.

**Step 1:** Make the 6 edits above.

**Step 2: TEST RECIPE.** `/dashboard/team`, `/dashboard/newsgrid`, `/dashboard/brand-leads` at 375px → these selects span full width when stacked, no fixed-width overflow.

**Step 3: Commit.**
```bash
git add apps/web/app/dashboard/team/page.tsx apps/web/app/dashboard/newsgrid/page.tsx apps/web/app/dashboard/brand-leads/page.tsx apps/web/app/admin/orgs/page.tsx apps/web/components/content-agent/RepurposeTab.tsx
git commit -m "fix(selects): full-width-on-mobile for fixed-width selects (Pattern C)"
```

---

## Task 9: Build gate + final mobile sweep

**Step 1: Build gate.**
```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```
Expect exit 0. (SWC catches syntax tsc would pass — required before merge.)

**Step 2: Sanity — AI package render gate untouched.**
```bash
pnpm --filter @postautomation/ai test
```
Expect green / unchanged (this plan should not affect it; if it changed, you edited the wrong file).

**Step 3: USER mobile sweep (handoff).** Hand the user this checklist to verify at 375–414px, logged in:
- [ ] Campaigns — all tabs swipeable, none lost
- [ ] Autopilot — all 7 tabs swipeable
- [ ] Brand Leads — tabs swipeable
- [ ] Content Studio (`/dashboard/content-agent`, also `/posts`, `/calendar`) — no right-edge clipping; tabs 2×2
- [ ] Image Studio — option tiles readable
- [ ] Team — invite row stacks; email shows full address
- [ ] Newsgrid / Channels — filter/search rows don't crush inputs
- [ ] Spot-check: dashboard landing, analytics, monitoring still look correct (these were already fine — confirm no regression)

**Step 4:** Open PR off `fix/mobile-responsiveness-2026-06-29` once the user confirms.

---

## Out of scope (deliberately, per audit)
- Dashboard landing grids, Analytics table, Monitoring filters, admin DataTable — **render fine at runtime**; only candidates for optional scroll-hints later, not bugs.
- Legal/auth page headers — cosmetic; not included.
- Automated overflow test in CI — user opted to test manually; CI is deploy-only anyway (no test gate) per CLAUDE.md.

## Decision log
- **Systemic + confirmed, shared primitives, user-tests** (user choices, 2026-06-29).
- **`ScrollableTabRow` over `flex-wrap`:** wrapping tabs to 2 rows shifts content vertically and looks broken with an active underline; a swipe strip matches the platform convention and keeps one row.
- **`min-w-0` over width hacks for HIGH-2:** empirically collapses the track (504→326px) with zero behavioral change; targets the actual CSS-grid `min-width:auto` cause.
- **`grid-cols-2` base (not `grid-cols-1`) for option tiles:** 1-per-row makes pickers very tall; 2-up is readable and compact on phone.
