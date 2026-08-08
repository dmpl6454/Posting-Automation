# Facebook video views + engagement-rate honesty + per-platform Insights — Implementation Plan

**Branch base:** `main`. Five phases, each independently mergeable and deployable. Merging to `main` *is* deploying to prod — run the pre-merge deploy checks (server tracked-file diff, `bash scripts/deploy.sh` path) before every merge.

---

## Phase ordering and rationale

| # | Phase | Risk | Value | User-visible after merge |
|---|---|---|---|---|
| 0 | Scrape-branch honesty declaration | ~zero (≈20 live captures) | Blocks a 37,766-row fake-zero before it can scale | Almost nothing today; a handful of FB video rows flip fabricated `0 likes/0 shares` → `—` |
| 1 | Engagement-rate anomaly rule + one implementation | low (read-only) | Kills `200%` / `1400%` class permanently, before Phase 2 multiplies the population | `200.00% (1/10)` → `—` with "engagement exceeds views" tooltip; headline tile gains a `—` state; low-base rates gain a disclosure chip |
| 2 | Read-path capability threading (`declaredAvailable` into `analytics.engagement`) | low | Prerequisite for Phase 3 and Phase 4; fixes a live same-page contradiction | FB-only orgs get their Impressions tile + "Total Views" card back when a video capture exists |
| 3 | Per-platform pill view | low (UI + additive server input) | The owner's ask | "All / Facebook / Instagram / …" pills above Channel Performance and Reports; dead columns vanish per view |
| 4 | FB external video-view recovery | **highest** (network, quota, backfill) | 94% of FB external rows gain their only meaningful metric | FB direct posts start showing real views; Impressions column populates across FB channels |

Phase 4 last on purpose: 0–3 make the honesty contract, the rate rule, and the capability plumbing correct *first*, so Phase 4 lands on a read path that cannot turn its data into a lie.

---

# PHASE 0 — Declare every key on the Facebook scrape branch

**Amended per refutation:** the PROVIDER investigation, and both the "gating" and "backfill feasibility" refutations, independently found the same live defect. Fix it *before* anything increases its volume.

### 0.1 `packages/social/src/providers/facebook.provider.ts` — `getVideoAnalytics`, scrape branch

Current (≈`:652-673`):

```ts
if (!viewsUsable) {
  const scraped = await scrapeFacebookReelEngagement(videoId).catch(() => null);
  if (scraped && scraped.views != null && scraped.views > 0) {
    return {
      impressions: scraped.views,
      clicks: 0,
      likes: scraped.likes ?? likes ?? 0,
      shares: scraped.shares ?? 0,          // ← scrapeFacebookReelEngagement ALWAYS returns shares:null
      comments: scraped.comments ?? comments ?? 0,
      ...
      likeKind: "likes",
      metricsAvailable: { reach: false, clicks: false, impressions: true },  // ← likes/comments/shares OMITTED
```

`packages/social-scrapers/src/facebook.ts:243` is `return { ...parseFbReelHtml(html), shares: null };` — unconditional. So `scraped.shares ?? 0` is *always* a fabricated `0`, and it is undeclared, which downstream reads as **available**.

Replace with:

```ts
if (!viewsUsable) {
  const scraped = await scrapeFacebookReelEngagement(videoId, {
    timeoutMs: Number(process.env.FB_SCRAPE_TIMEOUT_MS ?? 6000),
  }).catch(() => null);
  if (scraped && scraped.views != null && scraped.views > 0) {
    // Merge: prefer a value the API produced, else the scraped one. NULL stays
    // NULL — a metric neither source produced must never be stored as 0.
    const mLikes    = likes    ?? scraped.likes    ?? null;
    const mComments = comments ?? scraped.comments ?? null;
    return {
      impressions: scraped.views,
      clicks: 0,
      likes: mLikes ?? 0,
      shares: 0,
      comments: mComments ?? 0,
      reach: 0,
      engagementRate: 0,           // computed downstream; see Phase 1
      source: "scrape",
      likeKind: "reactions",       // parseFbReelHtml counts og:title REACTIONS, not likes
      reachIsDistinct: false,
      metricsAvailable: {
        impressions: true,         // a real number was read from the page
        reach: false,              // Meta deleted it; no source, ever
        clicks: false,             // Video node exposes no click metric
        likes: mLikes !== null,    // scraper's likes are "often null" — declare the truth
        comments: mComments !== null,
        shares: false,             // scrapeFacebookReelEngagement returns shares:null, always
      },
      ...(degraded ? { degraded } : {}),
    };
  }
}
```

**Why each key** (honesty contract, `packages/api/src/lib/platform-metrics.ts` + `gatePostReportRow`):
- `impressions: true` — the only key the scrape actually establishes; this is the per-capture override that keeps real views out of the static-map "—".
- `reach: false` — permanently deleted platform-side (re-verified with `read_insights` granted). An omission would render a fabricated 0.
- `clicks: false` — the Video node has no clicks edge; we never asked.
- `likes` / `comments` — declared from the merged value's nullness. Neither is covered by `requiresExplicitDeclaration`, so an omission would have published a confident 0 (**this is the live bug**).
- `shares: false` — hard-coded because the scraper structurally cannot return shares. `requiresExplicitDeclaration.FACEBOOK` rescues this per-row, but **not in the aggregate** (`effectiveChannelUnavailable`, by design), so an omission poisons the whole channel's Shares column.

`likeKind: "reactions"` matches the feed path (`:582`) and the parser's actual semantics.

### 0.2 Also fix `engagementRate` on this branch

Leave it `0`; Reports and all aggregates recompute. Do **not** compute `(likes+comments)/views` here — it feeds nothing and is the mixed-unit hazard the SQL recompute exists to avoid.

### Tests (Phase 0)

New file `packages/social/src/__tests__/facebook-scrape-declaration.test.ts`:
- `"scrape branch declares ALL SIX metricsAvailable keys"` — assert `Object.keys(...).sort()` equals the six.
- `"a scraper that returns likes:null declares likes:false and never stores a fabricated count"`.
- `"shares is always declared false — the scraper cannot read shares"`.
- `"likeKind is 'reactions' on the scrape branch"`.

Existing tests to update:
- `packages/social/src/__tests__/scraper-fallback.test.ts` — any assertion on the scrape branch's `metricsAvailable` shape or on `likeKind: "likes"`. **Reason it encoded old behavior:** it was written against the 3-key declaration before the omitted-key⇒available rule was understood.

### Rollback / kill switch
No new env. Revert is a single-file revert; no data written by this phase needs undoing (it only *widens* "—").

### Verification (prod)
```sql
-- BEFORE: scrape captures with an omitted shares/likes key
SELECT count(*) FROM "AnalyticsSnapshot"
WHERE metadata->>'source' = 'scrape'
  AND (metadata->'metricsAvailable'->>'shares') IS NULL;
-- AFTER (allow one analytics-sync cycle, ~6h): this count must stop growing.
SELECT date_trunc('day',"snapshotAt") d, count(*) FILTER (WHERE metadata->'metricsAvailable'->>'shares' IS NULL) omitted,
       count(*) total
FROM "AnalyticsSnapshot" WHERE metadata->>'source'='scrape' AND "snapshotAt" > now()-interval '7 days'
GROUP BY 1 ORDER BY 1;
-- expect: omitted = 0 for days after deploy.
```

---

# PHASE 1 — Engagement rate: one implementation, an impossibility gate, a disclosed low base

**Amended per refutation.** The proposed "suppress below a minimum denominator" was REFUTED on four grounds that the plan now honors:
1. Suppression at the headline tile is *less* honest — that tile has no `null` path and renders `0.00%`.
2. `—` already means "unavailable / not synced"; overloading it with "measured but withheld" makes the existing tooltip false.
3. Prod-verified reel views are 54/452/17/7/75 — a min of 100 blanks 3 of 5 legitimately.
4. A threshold does not fix `>100%`, which is a *population mismatch*, unbounded at any denominator.

So the rule is **two-tier, and only the impossible tier suppresses**:

```
HARD  (render "—", reason = "rate_impossible"):   interactions > impressions
SOFT  (render the number + a "low base" chip):    0 < impressions < MIN_CONFIDENT_RATE_IMPRESSIONS
NONE  (render the number):                        impressions >= threshold
"—"   (reason = "no_basis"):                      impressionedPosts === 0 or impressions === 0
```

**`MIN_CONFIDENT_RATE_IMPRESSIONS = 50`.** Concrete justification: the prod-verified truths that must keep rendering are denominator **57** (Bollywood 7.02%) and **58** (group 10.34%) — locked in `engagement-rate-pooling.test.ts`. 50 is the largest round number below 57. It never suppresses; it only decorates. Reel denominators 17 and 7 get the chip and keep their number.

### 1.1 `packages/api/src/lib/engagement-rate.ts` — resurrect as the ONE implementation

It currently has **zero production callers** (only its own test imports it). Keep `computeEngagementRate` byte-identical (its test is a pinned prod truth) and add:

```ts
export const MIN_CONFIDENT_RATE_IMPRESSIONS = 50;

export type RateVerdict = {
  /** 0–100 percent, or null when it must render "—". */
  rate: number | null;
  /** Why it is null / decorated. */
  reason?: "no_basis" | "rate_impossible";
  /** true when 0 < impressions < MIN_CONFIDENT_RATE_IMPRESSIONS. Rate is STILL returned. */
  lowBase: boolean;
  impressions: number;
  interactions: number;
  impressionedPosts: number;
};

export function pooledEngagementRate(p: {
  impressions: number; interactions: number; impressionedPosts: number;
}): RateVerdict {
  const base = { impressions: p.impressions, interactions: p.interactions,
                 impressionedPosts: p.impressionedPosts, lowBase: false };
  if (p.impressionedPosts <= 0 || p.impressions <= 0)
    return { ...base, rate: null, reason: "no_basis" };
  if (p.interactions > p.impressions)
    // Definitionally impossible: numerator and denominator are drawn from the SAME
    // FILTER (WHERE impressions > 0) rows, so this can only mean the two sides came
    // from different metric SOURCES (FB reactions from the insights edge vs. views
    // from video_insights/the scraper). Printing it is worse than withholding it.
    return { ...base, rate: null, reason: "rate_impossible" };
  return { ...base, rate: (p.interactions / p.impressions) * 100,
           lowBase: p.impressions < MIN_CONFIDENT_RATE_IMPRESSIONS };
}
```

### 1.2 EVERY call site that must apply it (five — four live, one SQL)

| # | File:function | Change |
|---|---|---|
| 1 | `packages/api/src/routers/analytics.router.ts` → `perChannelStats` (≈`:881-884`) | Replace the inline `impDen > 0 ? (impNum/impDen)*100 : 0` with `pooledEngagementRate({...})`. Return `engagementRate: v.rate` (**now `number \| null`**), keep `engagementRateBasis`, add `engagementRateFlags: { lowBase: v.lowBase, reason: v.reason ?? null }`. |
| 2 | `packages/api/src/lib/group-stats.ts` → `rateFromRows` (`:159-175`) | Keep it accumulating **every** member row (a group of twelve 50-impression channels is a legitimate 600-impression base — do NOT exclude sub-threshold members), then return `pooledEngagementRate(...)`. `GroupStatRow.engagementRate` becomes `number \| null` + the same flags. |
| 3 | `packages/api/src/routers/analytics.router.ts` → `analytics.engagement` (`:637-645`) | **The 🔴 site.** Widen `engagementRate` to `number \| null`, and add the `engagementRateBasis` + flags this procedure currently does not emit at all. Update the OpenAPI schema in `packages/api/src/openapi/generate-spec.ts` (`≈:484-489`) in the SAME commit — it is a published endpoint. |
| 4 | `packages/api/src/routers/analytics.router.ts` → `gatePostReportRow` (`:371-372`) | Per-row: after the existing `gatedImpressions === null` gate, add the impossibility gate — `if (gatedImpressions !== null && (likes+comments+shares) > gatedImpressions) engagementRate = null`. Uses the *gated* values so a "—" metric can't drive it. |
| 5 | `packages/api/src/routers/analytics.router.ts` → `fetchPostReportRows` SQL, **both** arms (`:432-437` external, `:469-474` app) | Third arm on the `CASE`: a captured snapshot with `impressions = 0` currently emits a hard `0`. `0/0` is undefined, not zero. Change `WHEN s."snapshotAt" IS NOT NULL THEN 0` → `WHEN s."snapshotAt" IS NOT NULL AND s.impressions > 0 THEN 0 ELSE NULL`, and the mirror for `ep."metricsSyncedAt"`. |

### 1.3 UI

`apps/web/app/dashboard/analytics/page.tsx`:
- `:780` and `:919` currently call `.toFixed(2)` on a non-null type. Guard both: `row.engagementRate === null ? "—" : row.engagementRate.toFixed(2) + "%"`.
- Tooltip must be **reason-specific**, not the existing `unavailable` copy:
  - `no_basis` → today's text ("No post on this channel reported an impression/view count…").
  - `rate_impossible` → *"More interactions than recorded views — Facebook reports reactions and video views from different sources, so a rate can't be computed."*
- `lowBase: true` → render the number plus a muted chip `· low base` with title `Based on ${impressions} impressions across ${impressionedPosts} of ${totalPosts} posts.`
- `:530-540` headline tile: add the `null → "—"` branch (it currently does `(engagement?.engagementRate ?? 0).toFixed(2)`).

`apps/web/components/analytics/ReportsTab.tsx:469` already renders `null → "—"`. `apps/web/lib/csv.ts:28` and `packages/api/src/lib/report-csv.ts:32` do `String(v ?? "")` → empty cell, never `0`. No change needed; confirm with tests.

Also close the emailed-CSV inconsistency: `analytics.router.ts:1255-1272` hardcodes all metric columns while the browser export filters by `reportableMetrics`. Build both header and row from **one** filtered list.

### Tests (Phase 1)

New `packages/api/src/__tests__/engagement-rate-verdict.test.ts`:

| case | den | num | posts | expect |
|---|---|---|---|---|
| no impressioned posts | 0 | 5 | 0 | `rate: null, reason: "no_basis"` |
| prod 200% row | 1 | 2 | 1 | `rate: null, reason: "rate_impossible"` |
| prod Bollywood | 57 | 4 | 1 | `rate ≈ 7.02, lowBase: false` |
| prod group | 58 | 6 | 2 | `rate ≈ 10.34, lowBase: false` |
| small real reel | 17 | 2 | 1 | `rate ≈ 11.76, lowBase: true` (**never null**) |
| real zero on a good base | 500 | 0 | 5 | `rate: 0` |
| threshold guard | — | — | — | `expect(MIN_CONFIDENT_RATE_IMPRESSIONS).toBeLessThanOrEqual(57)` with a comment naming the prod row |
| never NaN/Infinity | — | — | — | property assertion |

Plus a wiring `describe`: `perChannelStats` row with `impressionedImpressions:1 / interactions:2` ⇒ `engagementRate: null` **but `engagementRateBasis {1,10}` still present**; `sumChannelRowsIntoGroups` same rows ⇒ `null`, not 200; `gatePostReportRow({impressions: 1, likes: 2, engagementRate: 200})` ⇒ `null`.

New `apps/web/lib/metric-cell.test.ts` additions (file exists): `engagementRateCell(null) → "—"`, `engagementRateCell(0, {impressionedPosts: 5}) → "0.00%"`.

Existing tests to update:
- `packages/api/src/__tests__/engagement-rate-pooling.test.ts:54-60` — asserts `computeEngagementRate(posts) === 200`. **Keep it verbatim** (`computeEngagementRate` is unchanged and stays a pure ratio); add a sibling assertion that `pooledEngagementRate` on the same fixture returns `null / "rate_impossible"`. This is deliberate: the pinned prod truth stays pinned, and the new rule gets its own gate.
- `packages/api/src/__tests__/group-metric-availability.test.ts:70-89` — asserts a rate is present with `impressionedPosts: 1`. Update only if its fixture is impossible (`num > den`); add a comment naming the reason.
- `packages/api/src/__tests__/insights-availability-sql.e2e.test.ts:301-304` — asserts a numeric rate from `impressionedPosts === 1`. **Reason it encoded old behavior:** written before the impossibility rule existed. Adjust the seeded numbers so `num <= den`, and add a second case seeding `num > den` that asserts `null`.
- `packages/api/src/__tests__/report-metric-gate.test.ts` — any case pairing `impressions: 0` with a numeric `engagementRate` (the SQL now emits NULL there).

### Rollback
Pure read path. `git revert` the commit; no data written. No env switch needed (and none should be added — a flag on an honesty rule invites shipping the dishonest branch).

### Verification (prod)
```sql
-- Channels that were rendering an impossible rate. Should be the ONLY rows now "—".
WITH r AS (
  SELECT c.id, c.name, c.platform,
         SUM(ep.impressions) FILTER (WHERE ep.impressions>0) den,
         SUM(ep.likes+ep.comments+ep.shares) FILTER (WHERE ep.impressions>0) num
  FROM "ExternalPost" ep JOIN "Channel" c ON c.id=ep."channelId"
  WHERE ep."postTargetId" IS NULL AND ep."publishedAt" > now()-interval '30 days'
  GROUP BY 1,2,3)
SELECT *, round(num::numeric/NULLIF(den,0)*100,2) rate FROM r WHERE num > den ORDER BY den;
```
Browser: "Contents of bollywood" must show **`—`** with the "more interactions than recorded views" tooltip, not `200.00%`. Bollywood must still show **`7.02% (1/10)`**.

---

# PHASE 2 — Thread per-capture capability into `analytics.engagement`

**Amended per refutation:** the per-platform-split claim was REFUTED specifically because `analytics.engagement` drops the `declaredAvailable` argument. Fixing it is a prerequisite for Phase 3 and it repairs a live same-page contradiction (Channel Performance shows real FB video impressions while the tile above says the org can't report impressions).

### 2.1 `packages/api/src/routers/analytics.router.ts` → `analytics.engagement` (`:617-620`)

```ts
const orgChannels = await ctx.prisma.channel.findMany({ ... });
const reportable = reportableMetrics(orgChannels.map((c) => c.platform as string));
```
→
```ts
// ⚠️ The second argument is load-bearing. Without it this evaluates the STATIC map
// only, so an FB-only org loses its Impressions tile while the Channel Performance
// table one card below renders real video views — the PR #148 contradiction, one
// level up. `statRows` is already in scope (fetched at :611) and carries the
// BOOL_OR'd per-capture declarations.
const reportable = reportableMetrics(
  orgChannels.map((c) => c.platform as string),
  statRows.map((r) => r.declaredAvailable)
);
```

### Tests
New `packages/api/src/__tests__/engagement-reportable-override.test.ts`:
- `"analytics.engagement threads declaredAvailable into reportableMetrics"` — a FB-only org with one capture declaring `impressions: true` must return `reportableMetrics` containing `impressions`. **Must be at the PROCEDURE level**, not on the pure function: `insights-data-access-expiry.test.ts:140-143` already covers the pure function and did not catch that the only production caller drops the argument.
- `"an FB-only org with no video captures still drops impressions"` (no regression to the honest default).

Existing tests: none should break. `platform-metrics.test.ts:31-42` (static map keeps FB `unavailable: ["impressions","reach"]`) must stay green — **this phase must not touch `CAPS`.**

### Rollback
Single-line revert.

### Verification (prod)
Browser, as an org with a Facebook channel that has a video capture: the **Impressions** engagement tile and the **Total Views** stat card must appear, and must agree with the Impressions column in Channel Performance below. Before this phase they disagree.

---

# PHASE 3 — Per-platform Insights view

### 3.1 Server: additive optional `platform` input

`packages/api/src/routers/analytics.router.ts`:

- `fetchChannelStatRows(prisma, organizationId, from, to, platform?)` — add one predicate to **both** CTE arms: `AND ($4::text IS NULL OR c.platform::text = $4)` / `c2.platform::text = $4`. Parameter appended; org scoping unchanged.
- `analytics.engagement`, `analytics.perChannelStats`, `analytics.groupStats` — accept `platform: z.string().optional()`. **`groupStats` accepts it and IGNORES it**: a `ChannelGroup` may span platforms, so "Facebook groups" is undefined. Document that in a comment.
- `analytics.postReports` + `emailReport` — add `platform: z.string().optional()`, threaded into `fetchPostReportRows` as `AND c.platform::text = $n` on **both** union arms. **Server-side is mandatory here, not optional:** `postReports` is capped at `limit: 500`; a client-side filter would hide a platform whose rows all sit past row 500 — a cap that changes a displayed value, which this codebase classifies as a bug.
- Both `postReports` and `perChannelStats` additionally return **`platformsInWindow: string[]`** computed from an **unfiltered** query, or the pill row deletes its own siblings the moment a platform is chosen. Cheapest source: `SELECT DISTINCT c.platform` over the same window, org-scoped.
- `reportableMetrics` in `postReports` (`:1215-1218`) is already computed from the returned rows, so it narrows automatically. `analytics.engagement`'s now does too (Phase 2).

All procedures stay **`orgProcedure`** — `app-role-gating.test.ts` locks Insights as USER-readable.

### 3.2 UI: pill row

`apps/web/app/dashboard/analytics/page.tsx`.

**Primitive:** reuse `apps/web/lib/channel-platform-filter.ts` — `platformCounts()` (count-desc, alphabetical tie-break, so pills never reorder mid-render). Copy the *visual* idiom verbatim from `apps/web/app/dashboard/channels/page.tsx:1134-1177`: `flex flex-wrap items-center gap-1.5`, an "All · N" pill then one pill per platform with `<PlatformIcon>` (`~/components/icons/platform-icons`), `aria-pressed`, click-active-to-clear.

**Do NOT use `ScrollableTabRow`** — it is `overflow-x-auto` and would hide pills behind a swipe; there is no clipping ancestor here and the set is 2–6 pills.

**Divergence from `filterByPlatform`'s documented contract:** its docstring says an unknown platform yields an empty list (correct for a *picker*, where showing everything would select unintended channels). In an analytics table an unexplained empty result is worse — so if the URL/state platform is not in `platformsInWindow`, **fall back to All** and clear the state.

**URL param:** `?tab=insights&platform=FACEBOOK`. Read it in the existing `InsightsTabDeepLink` child (`page.tsx:956-978`) — the one place `useSearchParams` is already Suspense-boundaried, so static generation is unaffected.
- ⚠️ Its effect deps are `[searchParams, onTab]`. `onPlatform` **must** be a `useState` setter or a `useCallback`-stable fn. An inline arrow re-runs the effect every render — the ActivityPanel SSE-storm dep-identity bug class.
- Read-only by default (matches today's contract; zero refetch risk). If write-back is added, always re-emit `tab` too: `router.replace(\`?tab=${tab}&platform=${p}\`, { scroll: false })`.
- Validate against `platformsInWindow` before applying. Never interpolate the raw param.

**CLS / empty-state guards (all mandatory):**
1. `postReports.useQuery` gains `placeholderData: (prev) => prev` — a new `platform` in the key is a new query, and without it the table collapses to skeleton bars on every pill click. `perChannelStats`/`engagement` get it too.
2. Reserve the pill row's height (`min-h-[28px]` container that exists during loading) and keep it mounted-but-empty for single-platform orgs, so the table never gets pushed down after load.
3. If the selected platform disappears from `platformsInWindow` after a date-range change, reset to `null`.
4. A filtered-empty result must **never** route into the `page.tsx:811-826` "No active channels found / Connect a channel" empty state — that would be flatly false. Render a filter-specific empty state naming the platform, with a "Show all" action. Same for `ReportsTab.tsx:349-353`.
5. `noEngagementYet` (`page.tsx:293-297`) must keep computing over the **unfiltered** `channelStats`, or picking a quiet platform flashes the "connected but nothing synced" banner on a healthy org.
6. Scope the "—" footnote (`page.tsx:797-809`) to the active platform, or it becomes noise.

### 3.3 Which columns disappear — by derivation only

**Amended per refutation: never write a per-platform column list.** The removals fall out of the existing capability functions once the row set narrows:

| view | dropped | mechanism |
|---|---|---|
| Facebook | **Reach** | `CAPS.FACEBOOK.unavailable` includes `reach`; measured 0 nonzero / 0 declared, ever |
| Instagram | **Clicks** | `CAPS.INSTAGRAM.unavailable = ["clicks"]`; 0 nonzero / 0 declared across 40,656 rows |
| YouTube-only | Reach, Clicks, Shares | `CAPS.YOUTUBE` |
| Twitter-only | Reach, Clicks | `CAPS.TWITTER` |

**FACEBOOK Impressions must NEVER be in such a list.** It is live (video views) and Phase 4 makes it much more so. It survives only because `effectiveChannelUnavailable:191` returns available when any capture declared it. A `HIDDEN_PER_PLATFORM: { FACEBOOK: ["reach","impressions"] }` map would re-commit PR #148 *exactly as the gap is being filled*.

`channelColumns` (`page.tsx:249-253`) and `groupColumns` (`:260-264`) keep their existing `.some()` expressions — only the input array narrows. `likeHeader` (`:274-276`) then relabels "Likes"→"Reactions" on a Facebook view for free. The Eng. Rate column gate (`:673`, `:748`, `:861`) becomes per-platform for free.

### Tests (Phase 3)
New `apps/web/lib/insights-platform-view.test.ts`:
- `"columnsForPlatform('FACEBOOK', declared with impressions:true) keeps Impressions"`.
- `"columnsForPlatform('FACEBOOK') always drops Reach"`, `"('INSTAGRAM') always drops Clicks"`.
- Property: `"the ALL view's column set is the union of every platform view's — switching tabs can never hide a number ALL showed"`.
- `"an unknown platform param falls back to All, not to an empty table"`.

New `packages/api/src/__tests__/analytics-platform-filter.test.ts`:
- `"postReports platform input narrows rows AND recomputes reportableMetrics from the narrowed set"`.
- `"platformsInWindow is computed UNFILTERED so pills survive a selection"`.
- `"groupStats ignores platform"` (documented, deliberate).
- `"platform is never interpolated — org scoping stays in the WHERE"`.

Real-Postgres addition to `packages/api/src/__tests__/insights-availability-sql.e2e.test.ts`: seed FB+IG rows, assert the platform predicate narrows both CTE arms and that `impressioned*` sums narrow with them. **A mocked Prisma cannot cover this** — `fetchChannelStatRows` is `$queryRawUnsafe`; a mock never parses the SQL, so a broken predicate or a UNION column-order mismatch "passes".

### Rollback
UI + additive optional inputs. Revert the commit; old clients that never send `platform` are unaffected by the server half, so the server can stay if only the UI needs reverting.

### Verification (prod)
Browser: on an org with FB+IG, "All" shows Reach (IG populates it) with "—" on FB rows; clicking **Facebook** drops the Reach column entirely and relabels Likes→Reactions; clicking **Instagram** drops Clicks. Deep-link `?tab=insights&platform=INSTAGRAM` reproduces it. `?platform=NOPE` shows All.

---

# PHASE 4 — Facebook external video-view recovery

## 4.0 Architecture, amended per two refutations

Both refutations of "add it to `getPostAnalytics`" are honored in full:

1. **`FacebookProvider.getPostAnalytics` is NOT modified.** App-published FB posts are frequently **composite**-id (`:965` `platformPostId: feedData.id`; `:912`/`:930` `data.post_id || data.id`), and `post-publish.worker.ts:833` calls `getPostAnalytics` **inside the publish job**. Any edit to the composite branch executes in the frozen publish path.
2. **It is a MERGE, never a path swap.** Prod already holds, on `mediaType='video'` FB `ExternalPost` rows: 22,419 with clicks>0, 8,714 shares>0, 7,522 comments>0, 21,057 likes>0 — all from the composite/feed branch. Routing them to `getVideoAnalytics` (which declares `clicks:false, shares:false`) would trade an impressions gap for a clicks/shares/comments gap at 37k-row scale.
3. **Zero extra Graph calls in the common case.** Video id comes from the *existing* listing call's field expansion; reels skip `video_insights` entirely (GT #6: 0 view rows on 36/36 reels probed). This directly answers the app-quota refutation — the shared `usageCache.app` that the uncapped publish path reads does not grow for reels.

### 4.1 `packages/social/src/providers/facebook.provider.ts` — pure refactor first (separate commit)

Extract the composite body (`:470-589`) into `private async getFeedPostAnalytics(tokens, compositeId): Promise<SocialAnalytics | null>` and make `getPostAnalytics` read:

```ts
async getPostAnalytics(tokens, platformPostId) {
  if (!platformPostId.includes("_")) return this.getVideoAnalytics(tokens, platformPostId);
  return this.getFeedPostAnalytics(tokens, platformPostId);
}
```
Byte-identical behavior. Lock it (§4.8).

### 4.2 Listing: resolve the video id for free

`listRecentPosts` (`:385-387`), change the field expansion:

```
?fields=id,created_time,message,status_type,permalink_url,attachments{media_type}
→
?fields=id,created_time,message,status_type,permalink_url,attachments{media_type,target{id,url}}
```

⚠️ **Probe this live on the `published_posts` edge before merging** — GT #5 measured `attachments{media_type,target}` on the *single-post node*, not on the edge. If the edge refuses the nested expansion, fall back to §4.4's per-post resolve (and reduce `EXTERNAL_SCRAPE_PER_RUN` accordingly). Never use `object_id` (deprecated, `#12`).

`packages/social/src/abstract/social.types.ts` → `ExternalPostSummary`, add:
```ts
  /** FB: the Video/Reel node id behind a video attachment (attachments.target.id). */
  videoId?: string;
  /** FB: true when the attachment target URL is a /reel/ permalink. */
  isReel?: boolean;
```
Populate in the `posts.push(...)` block (`:405-417`) from `row.attachments?.data?.[0]?.target?.id` / `.target?.url?.includes("/reel/")`.

**mediaType demotion fix** — `apps/worker/src/workers/external-post-sync.worker.ts:265` currently writes `mediaType: summary.mediaType ?? null` on every pass, so one attachment-less listing nulls a known video. Change the `update` branch to:
```ts
...(summary.mediaType ? { mediaType: summary.mediaType } : {}),
...(summary.productType ? { productType: summary.productType } : {}),
```

### 4.3 A total, normalizing video predicate — NOT `=== "video"`

**Amended per refutation:** `mediaType` holds a union of two Meta vocabularies (`attachments.media_type` ∪ `status_type`, per the author's own comment at `:411` naming `added_photos`/`added_video`), IG stores it UPPERCASE (`VIDEO`/`REELS`), and prod holds 16 rows as `mobile_status_update`.

New pure module `packages/social/src/utils/fb-video-like.ts`:

```ts
const VIDEO_LIKE = new Set(["video","video_inline","video_autoplay","added_video","video_direct_response"]);

/** Total predicate. UNKNOWN ⇒ true: a wasted resolve is one cheap lookup on data we
 *  already have; a skipped one is a permanent "—". FALSE only for values we KNOW
 *  cannot carry a view count. */
export function isFacebookVideoLike(input: {
  mediaType?: string | null; permalink?: string | null; videoId?: string | null;
}): boolean {
  if (input.videoId) return true;                    // listing resolved a video node
  const t = String(input.mediaType ?? "").toLowerCase();
  if (VIDEO_LIKE.has(t)) return true;
  if (/\/reel\/|\/videos\/|\/watch/i.test(input.permalink ?? "")) return true;
  if (["photo","added_photos","album","link","shared_story","note","status","mobile_status_update"].includes(t))
    return false;
  return t === "" ? false : true;                    // unknown non-empty label ⇒ attempt
}
```

`external-post-sync.worker.ts:278` `due` select must add `mediaType: true, permalink: true, resolvedVideoId: true, postTargetId: true` (`productType` is already selected and unread for FB — leave it).

### 4.4 New provider method — external-only, merge-shaped

```ts
/**
 * Analytics for a FB post we did NOT publish (composite id from /published_posts).
 *
 * Deliberately a SEPARATE method from getPostAnalytics: that one is called INSIDE
 * the publish job (post-publish.worker.ts step 4b) and by analytics-sync, and its
 * network shape is frozen. This one is called ONLY by external-post-sync.
 *
 * It is a MERGE, never a re-route. The feed capture (clicks/reactions/comments/
 * shares) is ALWAYS taken; a view count is then merged into `impressions` only.
 */
async getExternalPostAnalytics(
  tokens: OAuthTokens,
  compositeId: string,
  opts: { pageId: string; videoId?: string | null; isReel?: boolean; allowScrape?: boolean }
): Promise<SocialAnalytics | null>
```

Body:
1. `const feed = await this.getFeedPostAnalytics(tokens, compositeId);` — if `null`, return `null` (unchanged semantics: worker `continue`s, `metricsSyncedAt` stays NULL ⇒ "—").
2. `let videoId = opts.videoId ?? null;` If absent **and** `isFacebookVideoLike(...)`, one fallback resolve:
   `GET /{compositeId}?fields=attachments{media_type,target{id,url}}` with **`{ retries: 1, maxSleepMs: 5_000, timeoutMs: 15_000 }`** (the `CONNECT_GRAPH_OPTS` shape at `:72-76`) and **`pageId` as the 3rd `graphFetch` arg** so `x-page-usage` is tracked. A failed resolve is non-fatal.
   Do **not** add `pageId` to the three existing analytics calls at `:490/:528/:542` — that would change throttling for existing captures.
3. `if (!videoId) return feed;` — byte-identical to today for non-video posts.
4. **Non-reel video only:** `video_insights?metric=total_video_impressions,total_video_views`. Skipped for reels (GT #6 — 0/36). `viewsUsable = ok && rows.length > 0`.
5. **Reel, or step 4 produced nothing, and `opts.allowScrape`:** `scrapeFacebookReelEngagement(videoId, { timeoutMs: 6000 })` under the global semaphore (§4.6).
6. Merge and return.

```ts
const views: number | null =
  viewsUsable ? (metrics.total_video_impressions || metrics.total_video_views || 0)
  : (scraped?.views ?? null);

return {
  ...feed,                                  // clicks / likes / comments / shares PRESERVED
  impressions: views ?? 0,
  source: scrapedUsed ? "scrape" : feed.source,
  metricsAvailable: {
    ...feed.metricsAvailable,               // all six keys, already explicit from getFeedPostAnalytics
    impressions: views !== null,            // ONLY key this path may change
  },
  ...(worstDegradation(feed.degraded, videoDegraded) ? { degraded: ... } : {}),
};
```

**The exact `metricsAvailable` a merged external video capture declares, and why:**

| key | value | justification |
|---|---|---|
| `impressions` | `views !== null` | the only key this path establishes. `true` is the per-capture override that lifts the static-map "—". A scrape miss ⇒ `false` ⇒ "—", **never** a fake 0 (the column is NOT NULL and stores 0). |
| `reach` | inherited `false` | Meta deleted it; no source exists. |
| `clicks` | inherited `insightsUsable` | from the feed insights edge; a silent HTTP-200-empty ⇒ `false`. |
| `likes` | inherited `reactions !== null` | fields edge or insights reaction fallback. |
| `comments` | inherited `comments !== null` | fields edge only; needs `pages_read_user_content`. |
| `shares` | inherited `shares !== null` | **must stay explicit** — Graph omits the field at genuine zero, and `requiresExplicitDeclaration.FACEBOOK` only rescues it per-row, not in the aggregate. |

**`degraded` must be preserved from the feed capture** — otherwise a video-dominated FB channel produces "clean" captures that clear a legitimate `needs_reconnect` verdict after the TTL in `channel-insights-health.ts:104`, re-opening the 2026-08-06 health flap.

### 4.5 Persistence — two nullable columns, no jsonb overload

`packages/db/prisma/schema.prisma` → `model ExternalPost`, add:

```prisma
  /// FB Video/Reel node id behind a video attachment. Resolved from the LISTING
  /// call's attachments{target{id}} expansion (free) or, rarely, one extra node read.
  resolvedVideoId  String?
  /// Negative cache. Set on every resolve ATTEMPT, including one that found nothing —
  /// without it, every pass re-pays the lookup for every non-video post forever.
  videoResolvedAt  DateTime?
```

`productType` was rejected as a stash (documented IG-only; overloading a typed column reads as corruption). `degraded` was rejected (overwritten on every metric write, `worker:306`). `metricsAvailable` was rejected (contaminating the one structure the honesty contract depends on). No `metadata Json?` needed.

Additive nullable columns are safe under the migrate container's `db push` — but **rebuild the migrate container** (deploy quirk #2).

### 4.6 Budgets, throttles, breaker — the cost refutation answered

All in `apps/worker/src/workers/external-post-sync.worker.ts`:

```ts
const SCRAPE_PER_RUN     = Number(process.env.EXTERNAL_SCRAPE_PER_RUN ?? 40);
const SCRAPE_CONCURRENCY = Number(process.env.FB_VIEW_SCRAPE_CONCURRENCY ?? 2);
const USAGE_CEILING      = Number(process.env.EXTERNAL_SYNC_USAGE_CEILING ?? 60);
const SCRAPE_ENABLED     = process.env.EXTERNAL_VIEW_SCRAPE_ENABLED !== "false";
const WALLED_BREAKER     = Number(process.env.EXTERNAL_SCRAPE_WALLED_BREAKER ?? 8);
```

1. **Process-wide scrape semaphore** — `createSemaphore(SCRAPE_CONCURRENCY)` at module scope (the `@postautomation/ai` helper, as `video-overlay.ts:30` uses it). Raising `EXTERNAL_SYNC_CONCURRENCY` must not multiply concurrent 1–2 MB HTML fetches, and `analytics-sync.worker.ts` can scrape through the same provider simultaneously.
2. **Explicit `timeoutMs: 6000`** — `ScraperOptions.timeoutMs` defaults to **12,000** (`packages/social-scrapers/src/shared.ts:32-33`) and the current call site passes nothing. At 12s × 150 posts a walled IP turns one account job into 30 minutes against a 2h cadence.
3. **Per-run walled breaker** — after `WALLED_BREAKER` consecutive misses, stop scraping for the remainder of the job (log it). A blocked IP must not cost full price for zero data, and must not burn the IP the *working* bare-id path (`facebook.provider.ts:653`) depends on.
4. **Scrape budget is separate from `METRICS_PER_RUN` and it must NOT set `metricsSyncedAt` alone.** Order the loop so a post either gets its full capture (feed + view attempt) or is left entirely unmeasured. Concretely: run the feed capture for up to `METRICS_PER_RUN` posts as today; for video-like rows, only attempt the view merge while the scrape budget remains; **once the scrape budget is exhausted, stop processing video-like rows for this run** (leave them `metricsSyncedAt = NULL`). Otherwise a post gets feed metrics, is marked synced, and its views are hidden for a **week** by `needsMetrics`.
5. **Yield the shared Graph quota to publishing.** Before each post, if `provider.currentMaxUsage?.() >= USAGE_CEILING`, break out of the metrics loop and return early (log `usage_ceiling`). Export a tiny `currentMaxUsage()` accessor over `getMaxUsage()` in `facebook.provider.ts`. This is the honest answer to "a module-global `usageCache` couples external sync to the publish path": we cannot un-share Meta's app-wide budget, but external sync can **stand down first** rather than push the uncapped publish path into `throttleIfNeeded`'s 60s band.
6. **Skip `postTargetId != null` rows for the scrape budget** — read paths union only `postTargetId IS NULL`, so scraping app-published rows is pure waste.
7. **Kill switch `EXTERNAL_VIEW_SCRAPE_ENABLED`**, checked *before* the semaphore. Code default ON (`!== "false"`, matching `EXTERNAL_SYNC_ENABLED`), because the failure mode is fail-open — a blocked IP degrades to exactly today's behavior, never to a wrong number. **But ship it set to `false` in `.env.prod` and flip it after the canary (§4.7).**

### 4.7 Backfill strategy for the 37,766 rows

**It rides the normal cron. No one-off script.**

- **Why:** `needsMetrics` (`worker:84-91`) already re-measures never-synced rows at highest priority, `metricsSyncedAt` *is* the resume cursor (crash-safe, idempotent, survives deploys), and the sharded cron already has the kill switch, the shard hash, and the concurrency lane. A parallel script would duplicate all of that and bypass the semaphore and the usage ceiling.
- **Throttle:** `EXTERNAL_SCRAPE_PER_RUN=40` × 24 reachable accounts/shard × 4 shards ≈ 3,840 scrapes/8h sweep ≈ 480/h. At ~2.5s and concurrency 2 that is ~17% of a slot-hour. Graph cost added ≈ **0** for reels (listing expansion is free, `video_insights` skipped).
- **Drain:** ~15,859 distinct reachable video posts (37,766 rows ÷ 2.38 FB fanout) ÷ 3,840 per sweep ≈ **4–5 sweeps ≈ 32–40h**. Deliberately slow. The post *count* is already complete and truthful; only the numbers fill in, newest-first.
- **Resumable:** kill the worker at any point; the next run picks up every row still `metricsSyncedAt IS NULL` or stale per `needsMetrics`. `resolvedVideoId`/`videoResolvedAt` mean a resolve is never repeated.
- **Kill switch:** `EXTERNAL_VIEW_SCRAPE_ENABLED=false` stops the expensive half while listing (post counts) keeps working. `EXTERNAL_SYNC_ENABLED=false` stops everything.
- **Canary — mandatory before the fleet:** deploy with `EXTERNAL_VIEW_SCRAPE_ENABLED=false`. Then set `EXTERNAL_SCRAPE_PER_RUN=5` + `EXTERNAL_VIEW_SCRAPE_ENABLED=true` for **one** 2h cycle. Check: (a) `x-app-usage` max observed in worker logs, (b) publish-job durations for FB in the same window, (c) the walled-miss ratio, (d) the SQL in §4.9. Only then raise to 40.

### 4.8 Tests (Phase 4)

New `packages/social/src/__tests__/facebook-external-video-analytics.test.ts`:
- 🔴 `"BARE-id analytics make exactly two calls, in order"` — snapshot the URL sequence for `getPostAnalytics(tokens, "123456789012345")`; assert it equals `[/video_insights?metric=total_video_impressions,total_video_views, /{id}?fields=likes.summary(true),comments.summary(true)]`. **The assertion is the absence of a third call** — golden-gate discipline applied to network shape.
- 🔴 `"a COMPOSITE id through getPostAnalytics makes exactly the two feed calls"` — no attachments resolve, no scrape. This is the publish-path lock.
- `"getExternalPostAnalytics PRESERVES feed clicks/shares/comments/likes when merging views"` — feed returns clicks 42/shares 7/comments 3; scrape returns views 54; assert all four survive and only `impressions` changed.
- `"resolves the video id from attachments{...target}, never object_id"`.
- `"a reel SKIPS video_insights entirely"` — assert no `/video_insights` URL.
- `"a scrape miss leaves impressions declared FALSE and stored 0"`.
- `"the merged capture declares all six metricsAvailable keys"`.
- `"feed degradation is preserved through the merge"` (health-flap guard).

⚠️ These tests must use a **strict** fetch mock. `facebook-video.test.ts:96-112` and `facebook-insights-metrics.test.ts:38-70` use a catch-all default branch that silently answers any unmatched URL with the fields body and asserts only `urls[0]` — an inserted call ships uncovered. Add a strict harness (`unmatched URL ⇒ throw`) for the new file, and use it for the two byte-identity tests above.

New `packages/social/src/__tests__/fb-video-like.test.ts` — table over every value present in prod (`video`, `video_inline`, `photo`, `album`, `mobile_status_update`, `added_video`, `added_photos`, `null`, `""`, uppercase `VIDEO`) plus the permalink signals, plus `videoId` short-circuit.

New `apps/worker/src/__tests__/external-video-budget.test.ts`:
- `"scrape budget selects newest-first and leaves the rest metricsSyncedAt NULL"` — encodes *a cap that defers is a budget; a cap that changes a displayed value is a bug*.
- `"a post is never marked metricsSyncedAt when its view attempt was skipped for budget"`.
- `"rows with postTargetId != null never consume scrape budget"`.
- `"the walled breaker stops scraping after N consecutive misses"`.
- `"the usage ceiling ends the run early rather than pushing app usage higher"`.
- `"a listing without attachments does not null an existing mediaType"`.

Existing tests to update / must stay green:
- `packages/social/src/__tests__/facebook-insights-metrics.test.ts:111-131` — asserts a composite FEED id yields `impressions:false, reach:false` and the URL never contains `post_impressions`. **Must stay green with ZERO edits.** That is the cheapest proof the design is correct: if it breaks, the resolve/scrape is firing on id shape rather than on an explicit caller opt-in.
- `packages/api/src/__tests__/platform-metrics.test.ts:31-42` — the FACEBOOK static map must keep `unavailable: ["impressions","reach"]`. Anyone "fixing" the gap by editing `CAPS` fails here; the test wins.
- `packages/api/src/__tests__/shares-visibility.test.ts:122-172` — `requiresExplicitDeclaration` must stay **out** of `effectiveChannelUnavailable`. Tempting to add `impressions` to it now that FB impressions arrive via a third call path; adding it to the **aggregate** blanks whole channels. Per-row only, and only with evidence.
- `packages/social/src/__tests__/facebook-video.test.ts` / `scraper-fallback.test.ts` — bare-id byte-identity anchors; unchanged.
- Real-Postgres `packages/api/src/__tests__/external-posts-insights.e2e.test.ts` — add: after seeding FB external video rows with `metricsAvailable.impressions:true`, assert channel-level `availImpressions` flips TRUE **and** `availShares`/`availClicks` do not drop. (`LIVE_E2E=1` + `DATABASE_URL` + `TOKEN_ENCRYPTION_KEY`.)

### 4.9 Verification (prod)

```sql
-- 1. Resolution coverage (should climb toward ~94% of FB rows)
SELECT count(*) FILTER (WHERE "resolvedVideoId" IS NOT NULL) resolved,
       count(*) FILTER (WHERE "videoResolvedAt" IS NOT NULL) attempted,
       count(*) total
FROM "ExternalPost" WHERE platform='FACEBOOK' AND "mediaType"='video';

-- 2. THE headline number: FB external video rows that now declare impressions.
--    BEFORE: 0 of 37,766.  AFTER one full sweep: expect thousands (bounded by the
--    23% reachable-Page ceiling ⇒ target roughly 8,000–9,000).
SELECT count(*) FILTER (WHERE ("metricsAvailable"->>'impressions')='true') declared_true,
       count(*) FILTER (WHERE impressions > 0)                            nonzero,
       count(*)                                                           total
FROM "ExternalPost" WHERE platform='FACEBOOK' AND "mediaType"='video';

-- 3. HONESTY GUARD — must stay 0. A row with a view count must never have lost
--    its feed metrics to the merge.
SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND ("metricsAvailable"->>'impressions')='true'
  AND ("metricsAvailable"->>'shares') IS NULL;

-- 4. HONESTY GUARD — must stay 0. A scrape miss must never store a confident 0.
SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND impressions=0
  AND ("metricsAvailable"->>'impressions')='true';

-- 5. Feed metrics did NOT regress (compare to the pre-deploy snapshot of these four)
SELECT count(*) FILTER (WHERE clicks>0)   clicks_gt0,
       count(*) FILTER (WHERE shares>0)   shares_gt0,
       count(*) FILTER (WHERE comments>0) comments_gt0,
       count(*) FILTER (WHERE likes>0)    likes_gt0
FROM "ExternalPost" WHERE platform='FACEBOOK' AND "mediaType"='video';
-- prod baseline 2026-08-08: 22419 / 8714 / 7522 / 21057. These must NOT fall.

-- 6. Impossible rates did not appear en masse (Phase 1 catches them, but a spike
--    means views and reactions are being drawn from mismatched populations)
WITH r AS (SELECT c.id, SUM(ep.impressions) FILTER (WHERE ep.impressions>0) den,
                  SUM(ep.likes+ep.comments+ep.shares) FILTER (WHERE ep.impressions>0) num
           FROM "ExternalPost" ep JOIN "Channel" c ON c.id=ep."channelId"
           WHERE ep."postTargetId" IS NULL GROUP BY 1)
SELECT count(*) FROM r WHERE num > den;
```

Worker log probes:
```bash
ssh posting-automation 'docker logs postautomation-worker-1 --since 3h | grep -E "ExternalSync|walled|usage_ceiling" | tail -60'
# expect: measured>0, no sustained walled runs, no usage_ceiling on a healthy cycle
```
Browser: a Facebook channel with direct reels now shows numbers in the Impressions column of Channel Performance **and** in Reports for the same posts (they must agree — that agreement is what `effectiveChannelUnavailable` + `gatePostReportRow` guarantee).

### 4.10 Rollback

Ordered, cheapest first:
1. `EXTERNAL_VIEW_SCRAPE_ENABLED=false` in `.env.prod` + `docker compose … up -d --no-deps worker`. Stops all scraping; listing and feed metrics continue. **~10 seconds.**
2. `EXTERNAL_SYNC_ENABLED=false` — stops external ingestion entirely.
3. `git revert` the phase. The two new columns are nullable and additive; leave them (dropping a column is riskier than an unread column). Already-written rows keep their honest `metricsAvailable`, so no data repair is needed — a stored `impressions: true` remains true.

There is **no** data-corruption rollback scenario by construction: the merge only ever sets `impressions` and its declaration, and a miss declares `false` ⇒ "—".

---

# DO NOT

**Publish path / provider**
1. **Do NOT modify `FacebookProvider.getPostAnalytics`'s network shape.** It runs inside the publish job (`post-publish.worker.ts:833`) and app-published FB posts are frequently composite-id. Add methods; never edit the shared body beyond the byte-identical `getFeedPostAnalytics` extraction.
2. **Do NOT route composite-id video posts to `getVideoAnalytics`.** It declares `clicks:false, shares:false` and would erase 22,419 clicks / 8,714 shares / 7,522 comments already captured.
3. **Do NOT pass `GraphFetchOpts` to the publish-path calls** (`:264`, `:816`, `:856`, `:883`, `:948`) or add `pageId` to the existing analytics calls at `:490/:528/:542`. Their defaults are deliberate.
4. **Do NOT scrape at t+0 in the publish job.** A video published seconds ago has zero views; the existing `:652` fallback should be gated off for a fresh publish while you are in the file.
5. **Do NOT re-add any `post_impressions*`, `post_engaged_users`, `post_reach`, `post_views`, or `post_activity*` metric name.** One invalid name 400s the whole call. Verified deleted *with* `read_insights` granted.

**Honesty contract**
6. **Do NOT return a `metricsAvailable` object with fewer than all six keys** from any Facebook path. An omitted key reads as AVAILABLE.
7. **Do NOT store `x ?? 0` for a metric you could not read.** Store the 0 the column requires *and* declare the key `false`.
8. **Do NOT add `impressions` (or anything else) to `requiresExplicitDeclaration` without evidence of a genuinely separate call path**, and **never** apply `requiresExplicitDeclaration` inside `effectiveChannelUnavailable` — it is a per-row rule; on the aggregate it blanks whole channels (prod incident, 2026-08-07).
9. **Do NOT edit `CAPS.FACEBOOK.unavailable`** to "fix" the impressions gap. That is PR #148. Widening happens through per-capture `metricsAvailable` only.
10. **Do NOT drop the `degraded` field when merging captures.** A "clean" video capture clears a legitimate `needs_reconnect` verdict after the TTL — the 2026-08-06 health flap.
11. **Do NOT write a per-platform hardcoded column list.** Column removal must fall out of `reportableMetrics` / `effectiveChannelUnavailable`.

**Rate**
12. **Do NOT suppress a measured rate for being small.** Below `MIN_CONFIDENT_RATE_IMPRESSIONS` it gets a chip, not a `—`. Only `interactions > impressions` (and a zero base) suppress.
13. **Do NOT reuse the existing `—` tooltip for a suppressed rate.** "We could not read it" and "we read it and it is impossible" are different facts.
14. **Do NOT reimplement the rate anywhere.** Five call sites, one `pooledEngagementRate`.
15. **Do NOT exclude sub-threshold member channels from a group's pool.** Aggregate first, judge the summed denominator.

**Scheduling / cost**
16. **Do NOT put a timestamp in a BullMQ jobId** and keep every custom jobId at **exactly three colon segments**.
17. **Do NOT add a cap that changes a displayed value.** `EXTERNAL_LIST_PAGE_HARD_STOP` is a runaway guard; `EXTERNAL_SCRAPE_PER_RUN` is only safe because an unscraped post keeps `metricsSyncedAt = NULL` and renders "—".
18. **Do NOT mark `metricsSyncedAt` when the view attempt was skipped for budget** — `needsMetrics` would hide the post for a week.
19. **Do NOT call `scrapeFacebookReelEngagement` without `timeoutMs`** (the default is 12,000ms) or outside the semaphore + breaker.
20. **Do NOT run two cron leaders** (`CRON_LEADER`), and remember `nginx.conf`/migrate-container rebuild quirks on deploy.

**General**
21. **Do NOT chase a permission for FB impressions/reach, IG clicks, or YouTube shares.** All three are API-surface absences, not scope gates — re-verified with `read_insights`/`instagram_manage_insights` **granted**. A missing permission cannot validate `post_clicks` and reject `post_impressions` on the same token.
22. **Do NOT trust a mocked Prisma for anything touching `fetchChannelStatRows` / `fetchPostReportRows` SQL.** Use the `LIVE_E2E=1` suites.
23. **Delete the untracked `packages/social/src/providers/youtube 2.provider.ts`** (its `:241` still maps the permanently-zero `favoriteCount` into the shares slot — a stale copy of a fixed bug, waiting for someone to grep into it). Same for `CLAUDE 2.md` and `packages/super-text/tsconfig 2.json`.