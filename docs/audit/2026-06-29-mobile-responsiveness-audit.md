# Mobile Responsiveness Audit — PostAutomation Web

**Date:** 2026-06-29
**Method:** Static code analysis (4 parallel passes over every route) **+ live browser verification** at 375 / 390 / 414 px, authenticated as a normal seeded user (`admin@postautomation.app`).
**Scope:** All 25 dashboard routes, Content Studio sub-tabs, auth, admin, legal pages.
**Status:** Audit only — no code changed.

---

## TL;DR

The **shell is solid** — viewport meta is correct, the sidebar collapses to a mobile drawer `<lg`, the padding ladder (`p-4 sm:p-6 lg:p-8`) is right, and **no page scrolls horizontally at the document level**. The defects are **page-level and mechanical**: a handful of tab rows and content panels that don't collapse or scroll on phone width, plus grids/forms that don't restack. These are quick, low-risk Tailwind fixes — not an architectural problem.

Live-browser verification **confirmed 5 real issues and refuted 3 over-stated ones** that static analysis flagged (the dashboard grids and the Analytics table actually render fine on a phone). Trust the "Confirmed" list below over raw static guesses.

---

## Severity legend
- **HIGH** — content is hidden/clipped or the screen scrolls sideways. User loses access to something.
- **MEDIUM** — usable but cramped, squeezed, or ugly. Hurts the experience.
- **LOW** — cosmetic / polish.

---

## CONFIRMED issues (verified in a real mobile browser)

### 🔴 HIGH-1 — Campaigns tab bar hides tabs (user's "half the parts is hidden")
- **File:** `apps/web/app/dashboard/campaigns/page.tsx:378`
- **Code:** `<div className="flex border-b border-border/50">` wrapping 4 tabs (`Campaigns`, `Brand Trackers`, `Content Feed`, `Influencers`), each with `px-4 py-2.5`.
- **Runtime proof:** at 390px the tab row is ~475px wide. The last tab ("Influencers") sits at `right: 475px` — **85px past the screen edge** — and there is **no `overflow-x-auto`** and no `flex-wrap`, so the page's `overflow-hidden` shell clips it with no scrollbar. Tabs are genuinely unreachable.
- **Root cause:** tab row is a plain `flex` with no horizontal scroll or wrap.
- **Direction:** make the row scrollable (`flex overflow-x-auto` + hidden scrollbar) or wrap it.

### 🔴 HIGH-2 — Content Studio content panels overflow the right edge
- **File (split layout):** `apps/web/components/content-agent/ComposeTab.tsx:665`
- **Code:** `<div className="grid gap-6 lg:grid-cols-[1fr,400px]">` — the compose + live-preview split.
- **Runtime proof:** the live-preview card (`previews/instagram-preview.tsx`, "Add an image to preview / Preview only") renders **503px wide inside a `rounded-xl … overflow-hidden` card** at a 390px viewport. `<main>` is exactly 390px (no page scroll), so the preview is **clipped** — the "Create with AI" card, Content textarea, and "Create Design" button all run off the right edge (matches the user's first screenshot: "AI will write it for…", "Marvel movie:", "via Claude" are all cut).
- **Root cause:** the preview pane / inner cards keep a desktop min content width on mobile instead of collapsing under the editor.
- **Direction:** the `lg:grid-cols-[1fr,400px]` correctly stacks to 1 column `<lg`, so the bug is an inner element holding a fixed/min width — likely the preview card itself. Make the preview `w-full max-w-full` and ensure no child enforces a min width wider than the column.

### 🟠 HIGH-3 — Content Studio + Image Studio tab bar cramped to 4×78px
- **Files:** `apps/web/app/dashboard/content-agent/page.tsx:65` (`<TabsList className="grid w-full grid-cols-4">`), `apps/web/components/ui/tabs.tsx:16/31`.
- **Runtime proof:** the TabsList renders **4 columns × 78px each in a 311px container** at 375 *and* 414px. Labels are `hidden sm:inline`, so it survives as icon-only — but at 78px the tap targets and icons are tight, and any future label would overflow (`whitespace-nowrap`).
- **Severity note:** borderline HIGH/MEDIUM — usable today (icons only) but fragile.
- **Also affects:** every page that mounts Content Studio tabs (content-agent, posts, calendar render the same shell).

### 🟡 MEDIUM-4 — Team "Invite Member" row squeezes the email input
- **File:** `apps/web/app/dashboard/team/page.tsx:140`
- **Code:** `<div className="flex gap-3">` holding `Input(flex-1)` + `SelectTrigger(w-32)` + `Button`. No `flex-col` at base.
- **Effect:** at 360px the email field is crushed to ~100px → shows only "colle…" (matches the user's Team screenshot). The role select (`w-32` = 128px) and button hog the row.
- **Direction:** `flex flex-col sm:flex-row`, select `w-full sm:w-32`, button `w-full sm:w-auto`.
- **Sibling fixed-width selects** (same fix): `team/page.tsx:150` (`w-32`), `:217` (`w-28`); `approvals/page.tsx:149` (`w-[160px]`); `newsgrid/page.tsx:835` (`w-[140px]`); `admin/orgs/page.tsx:109` (`w-[130px]`); `RepurposeTab.tsx:1582` (`w-36`).

### 🟡 MEDIUM-5 — Image Studio option grid cramped (3×87px)
- **File:** `apps/web/components/content-agent/ImageGenerationPanel.tsx` (grid `grid grid-cols-3 gap-2 sm:grid-cols-5`)
- **Runtime proof:** renders **3 columns × 87px** at mobile width — option tiles too small to read/tap. Several sibling pickers in this file are `grid-cols-2/3/4` with no base collapse (lines ~563, 698, 796, 814, 995, 1078, 1117, 1146).
- **Direction:** add a `grid-cols-1`/`grid-cols-2` base before the `sm:`/`md:` step.

---

## REFUTED by runtime (static analysis over-stated these — do NOT treat as HIGH)

These were flagged by static passes as "HIGH / illegible / cut off," but a real phone browser renders them **correctly**. Lower priority or non-issues:

- **Dashboard landing grids** (`dashboard/page.tsx` stat cards, feature cards, quick-actions) — render **1 card per row, fully legible** at 375px (screenshot verified). The responsive classes work; the missing explicit `grid-cols-1` is harmless because the cards stack anyway. *Polish, not a bug.*
- **Analytics "Channel Performance" table** — already wrapped in `overflow-x-auto` (`analytics/page.tsx:377`). It scrolls horizontally inside its card. The screenshot "cut off" is the table being **swipeable**, not lost. *MEDIUM at most — add a scroll affordance/hint.*
- **Monitoring filter tabs / admin DataTable** — render inside scroll containers; content reachable. Worth a scroll-hint, not a blocker.

> **Lesson for the fix phase:** verify the *rendered* result, not just the class string. "No `overflow-x-auto`" is only a bug if the content actually exceeds the screen at runtime — several flagged grids stack fine on their own.

---

## SYSTEMIC patterns (fix once, helps many pages)

1. **Tab/filter rows without horizontal scroll.** Campaigns (`page.tsx:378`) is the proven offender. Audit every `className="flex border-b…"` tab row and the shared `ui/tabs.tsx` → add `overflow-x-auto` + a hidden-scrollbar utility. *Introducing one `<ScrollableTabs>` wrapper would cover Campaigns, Monitoring filters, and the Content Studio tabs.*
2. **Multi-control rows that don't restack** (`flex gap-x` with input+select+button). Team invite is the proven offender; the same shape recurs in page headers across listening/media/rss/links/monitoring. *Pattern: `flex flex-col gap-3 sm:flex-row sm:items-center`.*
3. **Fixed-width selects** (`w-[Npx]` / `w-28/32/36`). 7 sites listed under MEDIUM-4. *Pattern: `w-full sm:w-[Npx]`.*
4. **Grids missing a mobile base** (`grid sm:grid-cols-N` / `grid-cols-3` with no `grid-cols-1` base). Mostly cosmetic where cards stack anyway, but Image Studio option pickers are genuinely cramped. *Pattern: always lead with `grid-cols-1` or `grid-cols-2`.*

---

## Pages verified CLEAN at mobile width (no overflow/clip/cramp)
`channels`, `analytics`, `monitoring`, `team` (page chrome), `rss`, `links`, `media`, `listening`, `brand-leads`, `approvals`, `super-agent`, `newsgrid`, `settings`, plus the `dashboard` landing.
(Issues on team/links/etc. above are *within-row* cramping, not page overflow.)

---

## Recommended fix order
1. **Campaigns tab scroll** (HIGH-1) — clearest "hidden content" bug, trivial fix.
2. **Content Studio preview overflow** (HIGH-2) — the page the user called out first; highest visibility.
3. **Team invite row + the 7 fixed-width selects** (MEDIUM-4) — one pattern, many sites.
4. **Content/Image Studio cramped grids** (HIGH-3, MEDIUM-5).
5. **Scroll affordances** on Analytics table / Monitoring filters / admin tables (polish).

## Notes for whoever implements
- A `golden-render` test gate exists for Repurpose creatives (`repurpose-render-golden.test.ts`) — responsive class changes in `creative-templates.ts` could trip it; keep render output byte-identical there.
- Verify each fix in a real mobile browser (this audit's method), not just by reading classes — per the refuted list above.
- Dev login note: the seeded `admin@postautomation.app` password did not match the seed's documented `password123` on this local DB; it was reset locally for this audit. (Local dev only.)
