# Mobile Responsiveness Round-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 mobile-responsiveness defects + 1 redundancy de-dupe across Content Studio, Profile, Analytics, and RSS — so all four modules are fully mobile-usable at 375–414px with desktop unchanged.

**Architecture:** Pure UI fixes in `apps/web` only (zero `packages/` changes → Repurpose golden-render gate untouched). Each fix reuses an established pattern from PR #107 (`ScrollableTabRow`, `min-w-0`, `flex-col sm:flex-row`, `w-full sm:w-auto`, `grid grid-cols-2`, dialog `max-h`/`overflow-y-auto` + `min-h-0 flex-1`) or a standard Recharts/Radix idiom. Desktop is preserved on every change via `sm:`/grid. The shared `components/ui/tabs.tsx` base is NOT modified — broken `TabsList` sites are fixed per-site by intent.

**Tech Stack:** Next.js (App Router), React, Tailwind, Radix UI (Select, Tabs, Dialog), Recharts, pnpm/Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-30-mobile-responsiveness-round2-design.md`

**Verification model:** These are visual/CSS changes — there is no unit-test harness for them and class-string snapshots would be brittle and miss the *rendered* defect. The "tests" are: (1) the local Next build gate (`SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`, mandatory per the `feedback-verify-next-build-not-just-tsc` memory — SWC rejects syntax `tsc` accepts), and (2) a runtime Playwright pass at 375/390/414px asserting zero horizontal overflow + reachable controls (Task 12). Commit after each fix.

---

## Setup

### Task 0: Branch

- [ ] **Step 1: Create the working branch off main**

```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation
git checkout main
git pull --ff-only
git checkout -b fix/mobile-responsiveness-round2-2026-06-30
```

Expected: on a clean new branch off the latest `main`.

> NOTE: the design spec was committed on `fix/button-feedback-2026-06-30`. Cherry-pick it onto the new branch so the plan/spec travel with the code:
> ```bash
> git checkout fix/button-feedback-2026-06-30 -- docs/superpowers/specs/2026-06-30-mobile-responsiveness-round2-design.md docs/superpowers/plans/2026-06-30-mobile-responsiveness-round2.md
> git add docs/superpowers && git commit -m "docs: carry mobile round-2 spec+plan onto fix branch"
> ```
> (If those two doc files already exist on the branch, skip this.)

---

## Module 1 — Content Studio

### Task 1: Mode-selector tabs — show labels on mobile (Defect 1)

**Files:**
- Modify: `apps/web/app/dashboard/content-agent/page.tsx:67-70`

- [ ] **Step 1: Make the label visible at all widths**

Replace the `<span>` so the label is no longer `sm:`-gated. Current block (lines 66–71):

```tsx
              {tabs.map(({ id, label, icon: Icon }) => (
                <TabsTrigger key={id} value={id} className="gap-1.5 text-xs">
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </TabsTrigger>
              ))}
```

Change to:

```tsx
              {tabs.map(({ id, label, icon: Icon }) => (
                <TabsTrigger key={id} value={id} className="gap-1.5 text-xs">
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{label}</span>
                </TabsTrigger>
              ))}
```

(`shrink-0` on the icon keeps it from squeezing when the label takes width in the 2-col mobile cell. The grid `grid w-full grid-cols-2 sm:grid-cols-4` on line 65 is correct and unchanged.)

- [ ] **Step 2: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/dashboard/content-agent/page.tsx
git commit -m "fix(content-studio): show mode-tab labels on mobile (Defect 1)"
```

---

### Task 2: Compose post-preview platform tabs — scroll instead of clip (Defect 2a)

**Files:**
- Modify: `apps/web/components/previews/post-preview-switcher.tsx:97-102`

- [ ] **Step 1: Make the TabsList a scrollable flex row with non-shrinking triggers**

Current block (lines 96–103):

```tsx
      <Tabs value={activePlatform} onValueChange={setActivePlatform}>
        <TabsList className="w-full">
          {availablePlatforms.map((p) => (
            <TabsTrigger key={p} value={p} className="flex-1 text-xs">
              {getPlatformLabel(p)}
            </TabsTrigger>
          ))}
        </TabsList>
```

Change to:

```tsx
      <Tabs value={activePlatform} onValueChange={setActivePlatform}>
        <TabsList className="flex w-full justify-start overflow-x-auto">
          {availablePlatforms.map((p) => (
            <TabsTrigger key={p} value={p} className="shrink-0 text-xs">
              {getPlatformLabel(p)}
            </TabsTrigger>
          ))}
        </TabsList>
```

Why: `flex` overrides the base `inline-flex` (which ignores `w-full`); `overflow-x-auto` lets the 5 platform tabs scroll horizontally so YouTube is reachable instead of clipped; `shrink-0` stops triggers from being crushed; `justify-start` so they pack from the left when scrolling. Desktop with ≤4 platforms still fits with no scrollbar.

- [ ] **Step 2: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/previews/post-preview-switcher.tsx
git commit -m "fix(content-studio): scroll platform-preview tabs so YouTube is reachable on mobile (Defect 2a)"
```

---

### Task 3: Compose action buttons — stack on mobile (Defect 2b)

**Files:**
- Modify: `apps/web/components/content-agent/ComposeTab.tsx:1221` (the action row `<div>`) and the three `<Button>` opening tags within it (`Save as Draft`, `Schedule`, `Publish Now`).

- [ ] **Step 1: Stack the action row on mobile, restore the row on desktop**

Change the row container at line 1221:

```tsx
          <div className="flex justify-end gap-3 pb-8">
```

to:

```tsx
          <div className="flex flex-col gap-3 pb-8 sm:flex-row sm:justify-end">
```

- [ ] **Step 2: Make each of the three buttons full-width on mobile**

Add `className="w-full sm:w-auto"` to each of the three `<Button>`s in that row.

a) The **Save as Draft** button currently opens as:

```tsx
            <Button
              variant="outline"
              onClick={async () => {
```

Change to:

```tsx
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={async () => {
```

b) The **Schedule** button currently opens as:

```tsx
            <Button
              variant="secondary"
              onClick={() => handleSubmit(false)}
```

Change to:

```tsx
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={() => handleSubmit(false)}
```

c) The **Publish Now** button currently opens as:

```tsx
            <Button
              onClick={() => handleSubmit(true)}
              disabled={!content || selectedChannels.length === 0 || createPost.isPending || isUploading || !!youtubeBlockReason}
```

Change to:

```tsx
            <Button
              className="w-full sm:w-auto"
              onClick={() => handleSubmit(true)}
              disabled={!content || selectedChannels.length === 0 || createPost.isPending || isUploading || !!youtubeBlockReason}
```

- [ ] **Step 3: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/content-agent/ComposeTab.tsx
git commit -m "fix(content-studio): stack compose action buttons on mobile so Save-as-Draft is fully visible (Defect 2b)"
```

---

### Task 4: Calendar header — stack legend + nav, wrap the legend (Defect 3)

**Files:**
- Modify: `apps/web/components/content-agent/CalendarTab.tsx:51-55` (the header rows).

- [ ] **Step 1: Make the title/controls row stack on mobile, and let the controls group + legend wrap**

Current block (lines 51–56):

```tsx
          <div className="flex items-center justify-between">
            <CardTitle>{format(currentDate, "MMMM yyyy")}</CardTitle>
            <div className="flex items-center gap-3">
              {/* Status filter */}
              <div className="flex items-center gap-1">
                <Filter className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
```

Change the two wrapper `<div>`s (outer row + controls group). Replace:

```tsx
          <div className="flex items-center justify-between">
            <CardTitle>{format(currentDate, "MMMM yyyy")}</CardTitle>
            <div className="flex items-center gap-3">
              {/* Status filter */}
              <div className="flex items-center gap-1">
```

with:

```tsx
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>{format(currentDate, "MMMM yyyy")}</CardTitle>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              {/* Status filter */}
              <div className="flex flex-wrap items-center gap-1">
```

Why: outer row stacks the month title above the controls on mobile (`flex-col` → `sm:flex-row`); the controls group stacks the legend above the nav on mobile; the legend itself gets `flex-wrap` so its Filter-icon + 5 status buttons wrap to a second line at 375px rather than clip. The month-navigation `<div className="flex items-center gap-1">` (Today / prev / next) is left unchanged — it's narrow enough to stay on one line. Desktop (`sm:`) is byte-identical to today.

- [ ] **Step 2: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/content-agent/CalendarTab.tsx
git commit -m "fix(content-studio): stack+wrap calendar header so Draft/Today are not clipped on mobile (Defect 3)"
```

---

### Task 5: Repurpose From URL / From Text toggle — equal halves (Defect 4)

**Files:**
- Modify: `apps/web/components/content-agent/RepurposeTab.tsx:1019`

- [ ] **Step 1: Use a 2-col grid for the two segments**

Current (line 1019):

```tsx
            <TabsList className="w-full">
```

Change to:

```tsx
            <TabsList className="grid w-full grid-cols-2">
```

Why: `grid grid-cols-2` makes two exactly-equal halves that honor `w-full` at every width (grid respects width; the base `inline-flex` did not). The two `<TabsTrigger className="flex-1 gap-2">` children are unchanged — `flex-1` is inert inside a grid cell and harmless. Matches `ImageTab.tsx:422`.

- [ ] **Step 2: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/content-agent/RepurposeTab.tsx
git commit -m "fix(content-studio): align Repurpose From-URL/From-Text toggle as equal halves (Defect 4)"
```

---

### Task 6: Bulk schedule row + CSV sub-tabs (Defects 5a, 5b)

**Files:**
- Modify: `apps/web/components/content-agent/BulkTab.tsx:13` (import), `:137` (schedule row), `:146` (Schedule-Selected button), `:573-586` (sub-tabs TabsList).

- [ ] **Step 1: Import ScrollableTabRow**

Current line 13:

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
```

Add a new import directly after it:

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";
import { ScrollableTabRow } from "~/components/ui/scrollable-tab-row";
```

- [ ] **Step 2: Stack the schedule control row on mobile (Defect 5a)**

Current (line 137):

```tsx
        <div className="flex items-end gap-4">
```

Change to:

```tsx
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
```

- [ ] **Step 3: Make the Schedule-Selected button full-width on mobile (Defect 5a)**

The button currently opens as (line ~146):

```tsx
          <Button
            onClick={handleSchedule}
            disabled={selectedIds.size === 0 || !scheduledAt || bulkSchedule.isPending}
          >
```

Change to:

```tsx
          <Button
            className="w-full sm:w-auto"
            onClick={handleSchedule}
            disabled={selectedIds.size === 0 || !scheduledAt || bulkSchedule.isPending}
          >
```

- [ ] **Step 4: Wrap the CSV sub-tabs in ScrollableTabRow (Defect 5b)**

Current block (lines 572–586):

```tsx
      <Tabs defaultValue="schedule" className="space-y-4">
        <TabsList>
          <TabsTrigger value="schedule">
            <Calendar className="mr-2 h-4 w-4" />
            Bulk Schedule
          </TabsTrigger>
          <TabsTrigger value="import">
            <Upload className="mr-2 h-4 w-4" />
            CSV Import
          </TabsTrigger>
          <TabsTrigger value="export">
            <Download className="mr-2 h-4 w-4" />
            CSV Export
          </TabsTrigger>
        </TabsList>
```

Change to:

```tsx
      <Tabs defaultValue="schedule" className="space-y-4">
        <ScrollableTabRow>
          <TabsList>
            <TabsTrigger value="schedule" className="shrink-0">
              <Calendar className="mr-2 h-4 w-4" />
              Bulk Schedule
            </TabsTrigger>
            <TabsTrigger value="import" className="shrink-0">
              <Upload className="mr-2 h-4 w-4" />
              CSV Import
            </TabsTrigger>
            <TabsTrigger value="export" className="shrink-0">
              <Download className="mr-2 h-4 w-4" />
              CSV Export
            </TabsTrigger>
          </TabsList>
        </ScrollableTabRow>
```

Why: `ScrollableTabRow` (the PR #107 primitive: `flex overflow-x-auto whitespace-nowrap scrollbar-hide`) lets the 3 icon+text tabs scroll instead of clip; `shrink-0` keeps each tab intact. Desktop still fits inline.

- [ ] **Step 5: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/content-agent/BulkTab.tsx
git commit -m "fix(content-studio): stack bulk schedule row + scroll CSV sub-tabs on mobile (Defects 5a/5b)"
```

---

### Task 7: De-dupe New Post / Create Post (Defect 9)

**Files:**
- Modify: `apps/web/components/content-agent/PostsTab.tsx:57-60`

- [ ] **Step 1: Hide the header "New Post" button while the list is empty**

Current block (lines 49–61):

```tsx
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">All Posts</h2>
          <p className="text-sm text-muted-foreground">
            Manage and schedule your social media posts
          </p>
        </div>
        <Button onClick={() => onSwitchTab?.("compose")}>
          <Plus className="mr-2 h-4 w-4" />
          New Post
        </Button>
      </div>
```

Change the `<Button>` to a guarded render keyed off the SAME condition the empty-state card uses (`data?.posts.length === 0`, at line 91):

```tsx
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">All Posts</h2>
          <p className="text-sm text-muted-foreground">
            Manage and schedule your social media posts
          </p>
        </div>
        {!(data && data.posts.length === 0) && (
          <Button onClick={() => onSwitchTab?.("compose")}>
            <Plus className="mr-2 h-4 w-4" />
            New Post
          </Button>
        )}
      </div>
```

Why: while loading (`data === undefined`) the button shows; when posts exist it shows; ONLY when the list has loaded and is empty (the moment the centered "Create Post" empty-state card renders) is the header button hidden — so the empty view shows exactly one CTA. The empty-state "Create Post" button (lines 101–104) is unchanged.

- [ ] **Step 2: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/content-agent/PostsTab.tsx
git commit -m "fix(content-studio): hide header New Post button on empty list to remove duplicate CTA (Defect 9)"
```

---

## Module 2 — Profile

### Task 8: Phone number — country-code Select + local number input (Defect 6)

**Files:**
- Modify: `apps/web/app/dashboard/settings/page.tsx` — add Select import (~line 13), add state (~line 120), add a derived `fullPhone` and rewrite the add-phone input block (~lines 419–433), update the `addPhone` and `verifyPhone` submit calls.

This is the one task with logic. The backend `addPhone`/`verifyPhone` mutations are UNCHANGED — they still receive a single concatenated string. We construct that string from a country-code `<Select>` + a local-number `<Input>`.

- [ ] **Step 1: Import the Select primitive**

After the dialog import block (the line ending `} from "~/components/ui/dialog";` at line 21), add:

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
```

- [ ] **Step 2: Add country-code + local-phone state and a country-code list**

Find the phone state (line 120):

```tsx
  const [newPhone, setNewPhone] = useState("");
```

Replace that single line with:

```tsx
  const [countryCode, setCountryCode] = useState("+91");
  const [localPhone, setLocalPhone] = useState("");
  // Full E.164-ish number submitted to the backend (country code + digits only).
  const newPhone = countryCode + localPhone.replace(/\D/g, "");
```

(`newPhone` is now a derived `const`, not state — every existing reference to `newPhone` keeps working, including the `verifyPhone.mutate({ phone: newPhone, otp })` callsite at line ~397, because by the time the user verifies, `countryCode`/`localPhone` still hold the same values they entered. The `setNewPhone` setter is removed; it had exactly one caller, the input below, which we replace.)

Add this country-code constant near the top of the file, just after the imports (above the component, e.g. right after the last import line):

```tsx
const COUNTRY_CODES = [
  { code: "+91", label: "+91 India" },
  { code: "+1", label: "+1 US/Canada" },
  { code: "+44", label: "+44 UK" },
  { code: "+61", label: "+61 Australia" },
  { code: "+971", label: "+971 UAE" },
  { code: "+65", label: "+65 Singapore" },
  { code: "+49", label: "+49 Germany" },
  { code: "+33", label: "+33 France" },
  { code: "+880", label: "+880 Bangladesh" },
  { code: "+92", label: "+92 Pakistan" },
];
```

- [ ] **Step 3: Replace the free-text phone input block with Select + Input**

Current block (lines 419–434, inside the "Add / change phone form"):

```tsx
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="newPhone">
                      {userAny?.phone ? "Change Number" : "Mobile Number"}
                    </Label>
                    <Input
                      id="newPhone"
                      type="tel"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="+91 98765 43210"
                    />
                    <p className="text-xs text-muted-foreground">
                      Include country code (e.g. +91 for India, +1 for USA)
                    </p>
                  </div>
```

Change to:

```tsx
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="newPhone">
                      {userAny?.phone ? "Change Number" : "Mobile Number"}
                    </Label>
                    <div className="flex gap-2">
                      <Select value={countryCode} onValueChange={setCountryCode}>
                        <SelectTrigger className="w-[120px] shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {COUNTRY_CODES.map((c) => (
                            <SelectItem key={c.code} value={c.code}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        id="newPhone"
                        type="tel"
                        inputMode="tel"
                        className="min-w-0 flex-1"
                        value={localPhone}
                        onChange={(e) => setLocalPhone(e.target.value)}
                        placeholder="98765 43210"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Select your country code, then enter your number.
                    </p>
                  </div>
```

- [ ] **Step 4: Update the add-phone submit guard to use the local number**

The "Send Verification OTP" button currently opens as (line ~436):

```tsx
                    <Button
                      size="sm"
                      onClick={() => addPhone.mutate({ phone: newPhone })}
                      disabled={addPhone.isPending || !newPhone}
                    >
```

Change the `disabled` guard so it checks the local number is non-empty (the derived `newPhone` is never empty because it always has `countryCode`):

```tsx
                    <Button
                      size="sm"
                      onClick={() => addPhone.mutate({ phone: newPhone })}
                      disabled={addPhone.isPending || !localPhone.trim()}
                    >
```

(The `verifyPhone.mutate({ phone: newPhone, otp: phoneOtp })` callsite needs NO change — `newPhone` is the same derived value.)

- [ ] **Step 5: Build gate + type-check**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
pnpm --filter @postautomation/web exec tsc --noEmit
```

Expected: both exit 0. (Watch for "Cannot find name 'setNewPhone'" — if it appears, there is a second `setNewPhone` caller that must be migrated to `setLocalPhone`; grep `setNewPhone` in the file and fix it.)

- [ ] **Step 6: Verify no stray setNewPhone references remain**

```bash
grep -n "setNewPhone" apps/web/app/dashboard/settings/page.tsx
```

Expected: no output (all migrated). If any line prints, replace that `setNewPhone(x)` with logic that sets `countryCode`/`localPhone` appropriately (most likely it's a reset like `setNewPhone("")` → change to `setLocalPhone("")`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/dashboard/settings/page.tsx
git commit -m "feat(profile): country-code Select + number input for mobile number (Defect 6)"
```

---

## Module 3 — Analytics

### Task 9: Posts Over Time chart — stop X-axis label overlap (Defect 7)

**Files:**
- Modify: `apps/web/app/dashboard/analytics/page.tsx:231-236` (the `<XAxis>`).

- [ ] **Step 1: Add minTickGap + tickMargin to the XAxis**

Current block (lines 231–236):

```tsx
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval={Math.ceil(chartData.length / 10) - 1}
                  className="text-muted-foreground"
                />
```

Change to:

```tsx
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                  minTickGap={24}
                  tickMargin={8}
                  className="text-muted-foreground"
                />
```

Why: `minTickGap={24}` tells Recharts to skip ticks that would render closer than 24px apart, so labels never collide at any container width; `interval="preserveStartEnd"` lets Recharts auto-thin the ticks (driven by `minTickGap`) while always keeping the first and last date — this replaces the fixed `Math.ceil(chartData.length / 10) - 1` interval that emitted a constant ~10 ticks regardless of width (the overlap cause). `tickMargin={8}` adds breathing room below the axis. No rotation (`angle`) and no margin change — desktop stays clean.

- [ ] **Step 2: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/dashboard/analytics/page.tsx
git commit -m "fix(analytics): prevent Posts-Over-Time x-axis label overlap via minTickGap (Defect 7)"
```

---

## Module 4 — RSS Feeds

### Task 10: Add-Feed modal — scrollable body, pinned footer (Defect 8)

**Files:**
- Modify: `apps/web/app/dashboard/rss/page.tsx:132` (DialogContent) and `:139` (form body wrapper).

- [ ] **Step 1: Make DialogContent a height-capped flex column**

Current (line 132):

```tsx
          <DialogContent className="sm:max-w-[500px]">
```

Change to:

```tsx
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[500px]">
```

- [ ] **Step 2: Make ONLY the form body scroll**

Current (line 139):

```tsx
            <div className="space-y-4 py-4">
```

Change to:

```tsx
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
```

Why: `DialogContent` becomes a flex column with an 85vh ceiling and clipped overflow; the form body becomes the only scroll region (`min-h-0 flex-1 overflow-y-auto` — `min-h-0` is load-bearing so the flex child can shrink below its content height and actually scroll). `DialogHeader` and `DialogFooter` are flex siblings that stay pinned, so Cancel / Add Feed are always reachable even with Auto-Post expanded. Mirrors `components/media-picker-dialog.tsx:53` + `:143`.

- [ ] **Step 3: Build gate**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/dashboard/rss/page.tsx
git commit -m "fix(rss): make Add-Feed dialog body scroll so Cancel/Add Feed stay reachable on mobile (Defect 8)"
```

---

## Verification

### Task 11: Full type-check + build of the web app

- [ ] **Step 1: Type-check the whole web workspace**

```bash
pnpm --filter @postautomation/web exec tsc --noEmit
```

Expected: exit 0, no errors.

- [ ] **Step 2: Production build**

```bash
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

Expected: exit 0, build completes.

### Task 12: Runtime mobile-width verification (Playwright)

> This is the real test of the fixes — it verifies the *rendered* output, the failure mode class-strings can't catch. Run the dev server, log in (local seeded admin), and assert at 375/390/414px. If the local DB admin password is unknown, reset it as documented in the `project-mobile-responsiveness-2026-06-30` memory (`docker exec dashmani-postautomation-postgres-1 psql -U postautomation postautomation` → bcrypt reset), or use the CSRF + credentials-callback login path noted there.

- [ ] **Step 1: Start infra + dev server**

```bash
docker compose up -d                 # Postgres 5433 / Redis 6380 / MinIO 9000-9001
pnpm --filter @postautomation/web dev # http://localhost:3000
```

(If the page is blank / all routes 404, kill stacked turbo-dev servers first per the `project-postautomation-dev-emfile` memory: `pkill -f turbo` then retry.)

- [ ] **Step 2: For each width in {375, 390, 414}, drive each fixed screen and assert no horizontal overflow**

Use the Playwright MCP browser tools. For each route below, set viewport to the width, navigate, and run this overflow assertion in the page (must return `[]`):

```js
[...document.querySelectorAll('*')]
  .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
  .map(el => el.tagName + '.' + (el.className?.toString().slice(0,40)))
```

Routes + the specific control to confirm visible & clickable:
- `/dashboard/content-agent` (Compose tab): mode tabs show **labels**; Post Preview platform strip — **YouTube** tab reachable (scroll if needed); action row — **Save as Draft** fully visible (stacked on mobile).
- `/dashboard/content-agent?view=calendar` (or the Calendar sub-view): **Draft** legend item and **Today** button fully visible.
- `/dashboard/content-agent?tab=repurpose`: **From URL** and **From Text** segments are equal halves, flush.
- `/dashboard/content-agent?tab=bulk`: **Schedule Selected** button inside the card (stacked); **CSV Export** tab reachable.
- `/dashboard/settings` (Profile): country-code **Select** opens; choosing `+1` then typing digits — confirm the add-phone button enables.
- `/dashboard/analytics`: Posts Over Time x-axis labels do **not** overlap (count rendered tick texts; they should be spaced).
- `/dashboard/rss`: open **Add Feed**, toggle **Auto-Post** on, scroll the dialog body — **Cancel** and **Add Feed** buttons reachable.
- `/dashboard/content-agent` (Posts/Recent view) with an empty list (filter to a status with no posts): exactly **one** CTA visible (no header "New Post" beside the empty card).

- [ ] **Step 3: Desktop regression spot-check at 1280px**

Navigate the same routes at 1280px and confirm each layout is visually unchanged from `main` (tabs inline, buttons in a right-aligned row, calendar header on one line, phone row with select+input inline, chart full tick set).

- [ ] **Step 4: Record results**

Note pass/fail per screen per width. If any screen still overflows, fix that task's classes and re-run Step 2 for that screen before proceeding.

### Task 13: PR

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin fix/mobile-responsiveness-round2-2026-06-30
gh pr create --base main --title "fix(ui): mobile responsiveness round 2 — Content Studio, Profile, Analytics, RSS" --body "$(cat <<'EOF'
## Summary
Round-2 mobile-responsiveness fixes for the 4 modules flagged in QA (Content Studio, Profile, Analytics, RSS). UI/UX only — zero `packages/` changes, desktop preserved via `sm:`/grid.

Spec: docs/superpowers/specs/2026-06-30-mobile-responsiveness-round2-design.md
Plan: docs/superpowers/plans/2026-06-30-mobile-responsiveness-round2.md

## Fixes
- Content Studio mode tabs: show labels on mobile (was icon-only → looked misaligned)
- Compose: platform-preview tabs scroll (YouTube reachable); action buttons stack on mobile
- Calendar header: legend + nav stack/wrap (Draft/Today no longer clipped)
- Repurpose From-URL/From-Text toggle: equal halves
- Bulk: schedule row stacks; CSV sub-tabs scroll
- Posts: hide header "New Post" while list empty (removes duplicate CTA on empty state)
- Profile: country-code Select + number input (backend contract unchanged)
- Analytics: x-axis `minTickGap` stops date-label overlap (no rotation; desktop unchanged)
- RSS Add-Feed dialog: scrollable body + pinned footer (Cancel/Add Feed reachable with Auto-Post on)

## Verification
- `tsc --noEmit` + `pnpm --filter @postautomation/web build` green
- Runtime Playwright pass at 375/390/414px: zero horizontal overflow, all flagged controls reachable
- Desktop spot-check at 1280px: unchanged

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR opened against `main`.

---

## Notes for the implementer

- **Order independence:** Tasks 1–10 are independent files (except Task 6 touches one file in two places); they can be done in any order. Do Task 0 first, Tasks 11–13 last.
- **The golden-render gate** (`packages/ai/.../repurpose-render-golden.test.ts`) is NOT affected — no `packages/` file changes. Do not run `-u` on any snapshot.
- **Do not modify** `components/ui/tabs.tsx` or `components/ui/dialog.tsx` base primitives — all fixes are at call sites.
- **Every `sm:` breakpoint is the desktop preserver** — if a build/runtime check shows desktop changed, you dropped or mis-ordered a `sm:` class.
