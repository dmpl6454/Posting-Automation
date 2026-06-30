# Mobile Responsiveness — Round 2 Fixes (Content Studio, Profile, Analytics, RSS)

**Date:** 2026-06-30
**Branch base:** `main` (a new `fix/mobile-responsiveness-round2-2026-06-30` branch off main)
**Scope:** UI/UX only. `apps/web` only — **zero `packages/` changes** (the Repurpose golden-render gate stays untouched). Desktop layout preserved on every fix via `sm:`/grid breakpoints.
**Predecessor:** PR #107 (`docs/audit/2026-06-29-mobile-responsiveness-audit.md`) established the fix vocabulary — `ScrollableTabRow`, `min-w-0`, `flex-col sm:flex-row`, `w-full sm:w-[orig]`, dialog `max-h overflow-y-auto`. This round reuses that vocabulary; it does not invent new patterns.

## Problem

A second mobile-QA pass (screenshots at ~375–414px) surfaced defects PR #107 did not cover — almost all are **horizontal overflow that clips content past the right viewport edge** in tab strips, button rows, and a non-scrolling modal, plus two non-layout UX asks (phone country code, chart axis density) and one redundancy question.

Out of scope (explicit user instruction): **Super Agent** and **Channels** pages.

## Shared root cause (and the architectural decision)

`apps/web/components/ui/tabs.tsx` `TabsList` is the vendored shadcn primitive with base class `inline-flex h-9 …`. `inline-flex` **shrinks to content and ignores `w-full`**, so a `<TabsList className="w-full">` whose `<TabsTrigger>`s use `flex-1` cannot distribute width — the triggers overflow the container. This is the upstream cause of defect 2a (platform tabs) and defect 4 (Repurpose toggle).

There are **9 `TabsList` sites** in `apps/web`, in three intent-groups:

| Intent | Sites | Status |
|--------|-------|--------|
| **grid** (`grid w-full grid-cols-N`) | `content-agent/page.tsx:65`, `:98`; `ImageTab.tsx:422`; `ImageGenerationPanel.tsx:563` | Correct — grid respects `w-full`. No change. |
| **full-width-equal** (`w-full` + `flex-1` triggers) | `RepurposeTab.tsx:1019`; `post-preview-switcher.tsx:97` | **BROKEN** — `inline-flex` ignores `w-full`. Fixed per-site. |
| **content-fit-scrollable** (bare `<TabsList>`) | `monitoring/page.tsx:198`; `BulkTab.tsx:573` | Want to scroll, not stretch. `BulkTab` overflows on mobile; fixed with `ScrollableTabRow`. |

**Decision: do NOT modify the shared `tabs.tsx` base.** A global change to `inline-flex` would risk the 4 grid sites + monitoring and is a higher-blast-radius edit on a vendored primitive. Instead, fix each broken site at its call site (lowest blast radius, matches the cross-check verdict). Two different per-site treatments by intent:
- **full-width-equal → `grid grid-cols-2 w-full`** (RepurposeTab — exactly 2 segments) or **`flex w-full overflow-x-auto` + `shrink-0` triggers** (post-preview-switcher — 5 segments that should scroll, not cram).
- **content-fit-scrollable → wrap in `ScrollableTabRow`** (BulkTab — 3 tabs).

## The fixes

All line numbers are current as of `8082554`/`ae8161b`. Every change keeps desktop identical via `sm:` / grid; none touch `packages/`.

### Module 1 — Content Studio

**1. Mode-selector bars "misalignment"** — `app/dashboard/content-agent/page.tsx:67`
- **Root cause:** NOT a grid/overflow bug. The grid is already `grid w-full grid-cols-2 sm:grid-cols-4` (correct). The mobile render shows *bare icons floating in wide grid cells* because each trigger's label is `<span className="hidden sm:inline">{label}</span>` — labels are hidden below `sm`, so mobile sees icon-only tabs that read as misaligned/empty.
- **Fix:** remove `hidden sm:inline` so the label shows on mobile too. Labels are short (Compose / AI Create / Repurpose / Bulk Create) and fit a 2-col grid at 375px. Keep `text-xs` and `gap-1.5`. Each tab renders icon + label in its cell.
- **Pattern:** mobile-first label visibility. Risk: none (desktop already showed labels; we only add them on mobile).

**2a. Post-preview platform tabs clipped (YouTube off-screen)** — `components/previews/post-preview-switcher.tsx:97`
- **Root cause:** `<TabsList className="w-full">` (inline-flex, ignores `w-full`) with 5 `flex-1` triggers → triggers overflow, last tab (YouTube) clipped past the right edge.
- **Fix:** `<TabsList className="flex w-full overflow-x-auto">` and change each `<TabsTrigger className="flex-1 text-xs">` to `className="shrink-0 text-xs"`. With a variable number of platforms (1–8), forcing equal `flex-1` cramming is wrong; a horizontally-scrollable strip (same principle as `ScrollableTabRow`) lets all platforms be reached. `flex` overrides the base `inline-flex`.
- **Pattern:** `flex overflow-x-auto` (ScrollableTabRow principle). Risk: low — desktop with ≤4 platforms still fits without a scrollbar; `overflow-x-auto` only shows a scrollbar when needed (and `scrollbar-hide` is *not* applied here so the affordance is visible — acceptable; if undesired we add `scrollbar-hide`).

**2b. Action buttons clipped (Save as Draft cut off)** — `components/content-agent/ComposeTab.tsx:1221`
- **Root cause:** `<div className="flex justify-end gap-3 pb-8">` holds 3 variable-width buttons (Save as Draft / Schedule / Publish Now) with no wrap/stack; `justify-end` right-aligns so the leftmost (longest) button clips on the left at ~390px.
- **Fix:** `<div className="flex flex-col gap-3 pb-8 sm:flex-row sm:justify-end">` and add `className="w-full sm:w-auto"` to each of the 3 `<Button>`s. Mobile: full-width stacked buttons; desktop: unchanged right-aligned row. Mirrors the `DialogFooter` idiom (`ui/dialog.tsx:72`).
- **Pattern:** `flex-col sm:flex-row` stacking + `w-full sm:w-auto`. Risk: low.

**3. Calendar header legend + nav clipped (Draft / Today off-screen)** — `components/content-agent/CalendarTab.tsx:52–54`
- **Root cause:** `CardHeader` row is `flex items-center justify-between` with the month-title on the left and a single `flex items-center gap-3` group on the right that packs BOTH the status legend (Filter icon + 5 buttons ≈205px) AND the month-nav (prev / next / Today ≈100px) into one non-wrapping line ≈305px+ — overflows the ~238px available at 375px, so the title scrolls off-left and Draft/`<`/Today clip off-right.
- **Fix:** restructure the header to stack on mobile. Change the outer wrapper to `flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`, and let the controls group wrap: the right-side group becomes `flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3`, with the legend group given `flex-wrap` so its 5 buttons wrap to a second line on the narrowest phones rather than clip. Desktop (`sm:`) is byte-identical to today.
- **Pattern:** `flex-col sm:flex-row` stacking + `flex-wrap` (reuses `ui/calendar.tsx` months idiom). Risk: low — internal button groups unchanged; only the row→column responsive behavior is added.

**4. Repurpose From URL / From Text toggle misaligned** — `components/content-agent/RepurposeTab.tsx:1019`
- **Root cause:** identical `inline-flex`-ignores-`w-full` issue as 2a, but here exactly 2 segments → they render content-width and look uneven instead of two equal halves.
- **Fix:** `<TabsList className="grid w-full grid-cols-2">` (drop nothing else; triggers keep `flex-1 gap-2` which is harmless inside a grid cell — or simplify to just `gap-2`). `grid grid-cols-2` makes two exactly-equal halves that respect `w-full` at every width. Matches the grid TabsList sites already in the codebase.
- **Pattern:** `grid grid-cols-2 w-full` equal-split (same as `ImageTab:422`). Risk: none — grid is a superset; desktop renders identical equal halves.

**5a. Bulk "Schedule Selected" button outside the card** — `components/content-agent/BulkTab.tsx:137`
- **Root cause:** `<div className="flex items-end gap-4">` keeps the full-width DateTimePicker (`flex-1`) and the "Schedule Selected (N)" button side-by-side at all widths; the button's text pushes it past the card's right edge at ~414px.
- **Fix:** `<div className="flex flex-col gap-4 sm:flex-row sm:items-end">` and give the button `className="w-full sm:w-auto"`. Mobile: picker on top, full-width button below; desktop: unchanged side-by-side bottom-aligned.
- **Pattern:** `flex-col sm:flex-row` stacking + `w-full sm:w-auto`. Risk: low.

**5b. Bulk CSV sub-tabs overflow (Bulk Schedule / CSV Import / CSV Export)** — `components/content-agent/BulkTab.tsx:573`
- **Root cause:** bare `<TabsList>` (inline-flex content-fit) with 3 icon+text triggers exceeds ~414px; no scroll wrapper → clips.
- **Fix:** wrap the `<TabsList>` in `<ScrollableTabRow>` (import from `~/components/ui/scrollable-tab-row`) and add `shrink-0` to each `<TabsTrigger>` so they don't compress. `TabsTrigger` already has `whitespace-nowrap` from the base. Follows the exact pattern already used in campaigns/autopilot/brand-leads.
- **Pattern:** `ScrollableTabRow` (existing primitive). Risk: low — desktop still fits inline (no scrollbar shown).

**9. "New Post" / "Create Post" redundancy** — `components/content-agent/PostsTab.tsx:58–61` (header) & `:101–104` (empty-state)
- **Finding:** functionally these are a persistent-header-action + empty-state-CTA pair (both call `onSwitchTab("compose")`). They appear **simultaneously only when the post list is empty** — which is the visual redundancy the user flagged in the screenshot. Once any post exists, the empty card (and its "Create Post") disappears and only the header "New Post" remains.
- **Decision (user):** de-dupe the empty state by **hiding the header "New Post" button while the list is empty**, so the empty state shows exactly one CTA (the centered "Create Post"), and the header button reappears once posts exist.
- **Fix:** gate the header "New Post" `<Button>` (`PostsTab.tsx:57–60`) on the inverse of the empty-state condition. The empty card renders when `data?.posts.length === 0` (`:91`). So wrap the header button: `{!(data && data.posts.length === 0) && (<Button onClick={…}>…New Post</Button>)}`. This keeps the button visible during loading (skeleton, `data` still `undefined`) and whenever posts exist, and hides it *only* when the empty card is shown — guaranteeing exactly one CTA on screen at all times. The empty-state "Create Post" (`:101–104`) is unchanged. No layout/overflow change.
- **Risk:** low — a single conditional render keyed off the *same* `data.posts.length === 0` source the empty-state branch uses, so the two are never both shown and never both hidden.

### Module 2 — Profile (`app/dashboard/settings/page.tsx`)

**6. Phone number — manual country code → selector + number**
- **Root cause:** a single free-text `tel` `<Input>` (`:424`) forces the user to type `+91`/`+1` inline; placeholder `+91 98765 43210` + helper "Include country code…" is error-prone ("unknown number"). Not an overflow bug — a control-swap UX fix.
- **Fix (user's chosen approach — in-house Select, no new dependency):**
  - New state near the existing phone state (`:120`): `const [countryCode, setCountryCode] = useState("+91"); const [localPhone, setLocalPhone] = useState("");` (keep or remove `newPhone`; see submit below).
  - Replace the single `<Input id="newPhone" …>` block with a `<div className="flex gap-2">` row containing:
    - a `<Select value={countryCode} onValueChange={setCountryCode}>` with `<SelectTrigger className="w-[110px] shrink-0">` and a short curated list of common codes: `+91 (IN)`, `+1 (US)`, `+44 (UK)`, `+61 (AU)`, `+971 (AE)`, `+65 (SG)`, `+49 (DE)`, `+33 (FR)`, `+880 (BD)`, `+92 (PK)`. (Each `SelectItem value` is the bare dial code e.g. `"+91"`; label shows code + country.)
    - a `<Input id="newPhone" type="tel" inputMode="tel" className="min-w-0 flex-1" value={localPhone} onChange={…} placeholder="98765 43210">` for the **local** number only.
  - Submit (`addPhone.mutate`): `phone: countryCode + localPhone.replace(/\D/g, "")` (strip spaces/dashes from the local part; the code already carries the `+`). **Backend contract is unchanged** — `addPhone`/`verifyPhone` still receive one E.164-ish concatenated string; the `verifyPhone.mutate({ phone: newPhone, … })` callers must use the same concatenated value, so compute `const fullPhone = countryCode + localPhone.replace(/\D/g, "")` once and pass it to both `addPhone` and `verifyPhone` (replace the two `newPhone` references). Disabled-state guard becomes `!localPhone`.
  - Imports: add `Select, SelectContent, SelectItem, SelectTrigger, SelectValue` from `~/components/ui/select` (primitive confirmed to exist + export).
  - Helper text → "Select your country code, then enter your number."
- **Pattern:** Radix `Select` (already a dependency) + `flex gap-2` with `shrink-0` select + `min-w-0 flex-1` input (so the row never overflows on mobile). Risk: low — verify both `addPhone` and `verifyPhone` send the same concatenated string; backend untouched.

### Module 3 — Analytics (`app/dashboard/analytics/page.tsx`)

**7. "Posts Over Time" X-axis date labels overlap (inspect/narrow view)**
- **Root cause:** `<XAxis dataKey="label" tick={{ fontSize: 11 }} interval={Math.ceil(chartData.length / 10) - 1} …>` (`:231`) renders unrotated 11px labels with no minimum gap; at narrow widths the fixed `interval` still emits ~10 ticks that physically collide.
- **Fix:** add `minTickGap={24}` and `tickMargin={8}` to the `<XAxis>`. `minTickGap` makes Recharts **drop** colliding ticks responsively at *any* container width — clean at 375px and at full desktop — with no rotation.
- **Deliberately NOT doing** `angle={-45}` + `height`/`bottom` margin (the audit's alternative): the user said the chart "looks fine in the mobile" and the overlap shows in the narrow inspect view; rotating labels would *regress the wide desktop view* (rotated labels waste vertical space) to fix a narrow case. `minTickGap` fixes both without that trade-off and without a margin change.
- **Pattern:** Recharts `minTickGap` (standard density mitigation). Risk: low/cosmetic — slightly fewer ticks at narrow widths (intended); desktop tick set is preserved or denser.

### Module 4 — RSS Feeds (`app/dashboard/rss/page.tsx`)

**8. Add-Feed modal won't scroll → Cancel / Add Feed unreachable when Auto-Post is on**
- **Root cause:** `<DialogContent className="sm:max-w-[500px]">` (`:132`) is the default shadcn `DialogContent` — a CSS **grid** with no height cap. Enabling Auto-Post reveals the AI Prompt textarea + a target-channels list, growing the body taller than a phone viewport. With no `max-h` + scroll region, the footer (`Cancel` / `Add Feed`, `:234`) is pushed below the fold and is unreachable.
- **Fix (mirror `components/media-picker-dialog.tsx:53` + `:143`):**
  - `<DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[500px]">` — make the content a flex column with an 85vh ceiling and clipped overflow.
  - Change the form body wrapper (`<div className="space-y-4 py-4">`, `:139`) to `<div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">` — only the body scrolls; `DialogHeader` and `DialogFooter` stay pinned. `min-h-0` is load-bearing (a flex child won't shrink below content height without it, so the scroll never engages).
- **Pattern:** internal-scrollable-dialog (`flex max-h-[Xvh] flex-col overflow-hidden` + `min-h-0 flex-1 overflow-y-auto`). Risk: low — `DialogFooter`'s own `flex-col-reverse sm:flex-row` is untouched; tall desktop dialogs also benefit; no other dialog affected (scoped to this one `DialogContent`).

## What is explicitly NOT changing

- No `packages/` files (Repurpose golden-render gate untouched).
- `components/ui/tabs.tsx` base primitive — unchanged (per-site fixes only).
- `components/ui/dialog.tsx` base — unchanged (per-site `DialogContent` className only).
- Desktop layout on every screen — preserved via `sm:`/grid.
- Super Agent and Channels pages — out of scope.
- Any backend / tRPC / mutation contract — the phone fix keeps the same submitted string.

## Verification

1. **Local build gate (mandatory, per `feedback-verify-next-build-not-just-tsc`):** `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` must exit 0 (SWC catches syntax `tsc` accepts). Run `pnpm --filter @postautomation/web exec tsc --noEmit` as well.
2. **Runtime mobile pass (the real test — verify *rendered* output, not class strings):** drive each fixed screen with Playwright at **375 / 390 / 414px** and assert:
   - No element exceeds `document.documentElement.clientWidth` (zero horizontal overflow).
   - Each previously-clipped control is fully visible and clickable: platform tabs (incl. YouTube), Save-as-Draft button, calendar Draft/Today, Repurpose toggle halves equal, Bulk Schedule-Selected button, RSS Cancel + Add Feed reachable after toggling Auto-Post on.
   - Phone: country `Select` opens, picking `+1` then typing a number submits the concatenated value.
   - Mode tabs show labels on mobile; empty Posts view shows exactly one CTA.
3. **Desktop regression spot-check** at ≥1024px on the same screens — layouts unchanged.

## Rollout

Single PR off `main` → `fix/mobile-responsiveness-round2-2026-06-30`. CI/CD is deploy-only (no build/test gate per `project-e2e-audit-2026-06-19`), so the local build gate + runtime pass ARE the pre-flight. Merge to `main` auto-deploys to Linode.
