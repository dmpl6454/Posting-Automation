# Insights Data-Accuracy Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every EXISTING Insights/Reports column show real, correctly-labeled, non-redundant data for every platform — fixing the live-confirmed Meta insights failures, the aggregation bugs, and the root-cause 7-slot data model.

**SCOPE GUARDRAILS (owner decision 2026-07-22):**
- **Build NO new feature/screen.** No "Account Growth / Top Movers" UI, no new pages. Only fix what is **broken or redundant** in the existing Insights + Reports.
- **Reuse `@dashmani/social-scrapers` INSIDE this repo** (vendor it as a workspace package `packages/social-scrapers`) as a resilient FALLBACK data source for the live-broken owned-post engagement. Nothing is built in or run from the other app.
- **We WILL also get the Meta permissions.** So the design is belt-and-suspenders: official API is the primary/clean path (once App Review approves the scopes); the scraper is the immediate fallback that works with no approval and covers FB reels + un-stubs Snapchat. Fallback chain: **official API → (null/permission-fail) scraper → (both miss) honest `—`.**

**Architecture:** Six phases, each shippable on its own. Phase 1 restores Meta insights via official API (scope + metric fixes). **Phase 1.5 vendors `social-scrapers` and wires it as the fallback** so IG/FB/Snapchat data flows NOW without waiting on App Review. Phase 2 extends `SocialAnalytics`/`AnalyticsSnapshot` with the dimensions the 7-slot interface discards (native reach vs impressions, saved, likeKind, per-platform capability metadata) — the root-cause fix. Phase 3 fixes the aggregation math in `analytics.router.ts`. Phase 4 makes the UI honest (per-platform labels, — vs 0, hide-redundant-reach). Phase 5 adds the sync-efficiency guard. Phases 3–5 depend on Phase 2's schema; Phases 1 + 1.5 are independent and highest-urgency.

**Tech Stack:** TypeScript (strict), Prisma + Postgres, BullMQ worker, tRPC, Next.js, Vitest. Package manager pnpm@9.15.0. Meta Graph API v18.0 (FB) / IG Graph API. `@dashmani/social-scrapers` (dependency-free, fail-open, `EngagementResult = {views,likes,comments,shares,caption,walled}`, `scrapeEngagement` supports facebook+snapchat only). Test runner: `pnpm --filter <pkg> test`.

**Source of truth:** [docs/INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md](../../INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md) (30 findings + NEW-1..6 + per-platform matrix + live prod evidence §6.3).

**Ground truth from prod (2026-07-22, live-verified):** IG snapshots have impressions/reach/shares=0 in 100% of rows (likes/comments real); FB impressions/reach/clicks=0 across all 1.32M rows. Meta insights are effectively non-functional in production. `instagram_manage_insights` and `read_insights` appear NOWHERE in the codebase.

**Scraper reality check (from social-scrapers README — accept these):** scrapers depend on live HTML/JSON shapes and need occasional re-probing; IG/FB rate-limit datacenter IPs hard, so the fallback fetch should route through a residential proxy (inject via `ScraperOptions.fetchImpl`) or accept a low hit-rate from the Linode IP; `scrapeEngagement` only yields FB-reel + Snapchat-spotlight engagement (IG/YT/X post engagement stays on the official API — the scraper's IG/YT/X paths are follower-only, which this Insights scope does not use).

---

## Phase 0: Setup

- [ ] **Step 0.1: Create the working branch**

```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation
git checkout main && git pull origin main
git checkout -b fix/insights-accuracy-2026-07-22
```

- [ ] **Step 0.2: Confirm the test baseline is green**

Run: `pnpm --filter @postautomation/social test && pnpm --filter @postautomation/api test`
Expected: PASS (existing suites green before we change anything).

---

## Phase 1: Restore Meta insights (LIVE-CONFIRMED broken — highest urgency)

Fixes NEW-2 (FB wrong reach metric), NEW-3 (IG missing scope), NEW-4 (IG impressions deprecated), NEW-5 (FB read_insights). This phase makes Meta impressions/reach/shares real. **The IG scope change requires Meta App Review re-approval + users reconnecting — code lands now, data flows once approved.**

### Task 1.1: FB — use the correct reach metric (`post_impressions_unique`)

**Files:**
- Modify: `packages/social/src/providers/facebook.provider.ts:355-395`
- Test: `packages/social/src/__tests__/facebook-analytics.test.ts` (create)

- [ ] **Step 1.1.1: Write the failing test**

```typescript
// packages/social/src/__tests__/facebook-analytics.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";

describe("FacebookProvider.getPostAnalytics reach metric", () => {
  const provider = new FacebookProvider();
  afterEach(() => vi.restoreAllMocks());

  it("maps reach to post_impressions_unique, NOT post_engaged_users", async () => {
    const insights = {
      data: [
        { name: "post_impressions", values: [{ value: 1000 }] },
        { name: "post_impressions_unique", values: [{ value: 600 }] },
        { name: "post_clicks", values: [{ value: 40 }] },
        { name: "post_engaged_users", values: [{ value: 90 }] },
      ],
    };
    const fields = { shares: { count: 5 }, comments: { summary: { total_count: 8 } }, reactions: { summary: { total_count: 20 } } };
    vi.spyOn(provider as any, "graphFetch").mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("/insights") ? insights : fields),
    }));

    const result = await provider.getPostAnalytics({ accessToken: "t" } as any, "123_456");
    expect(result?.reach).toBe(600); // post_impressions_unique, not 90 (engaged_users)
    expect(result?.impressions).toBe(1000);
  });
});
```

- [ ] **Step 1.1.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/facebook-analytics.test.ts`
Expected: FAIL — `reach` is 90 (post_engaged_users), not 600.

- [ ] **Step 1.1.3: Fix the metric string + mapping**

In `facebook.provider.ts` `getPostAnalytics`, change the insights metric list to request `post_impressions_unique` and map `reach` from it. Drop the unused `post_reactions_like_total`:

```typescript
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=post_impressions,post_impressions_unique,post_clicks,post_engaged_users&access_token=${tokens.accessToken}`
    );
    // ... after building `metrics` and fetching `postData` (shares/comments/reactions) ...
    const impressions = metrics.post_impressions || 0;
    const totalEngagement = reactions + shares + comments;
    const engagementRate = impressions > 0 ? totalEngagement / impressions : 0;

    return {
      impressions,
      clicks: metrics.post_clicks || 0,
      likes: reactions,
      shares,
      comments,
      // TRUE unique reach. post_engaged_users (previous value) = people who
      // CLICKED anywhere in the post — an engagement count, not reach.
      reach: metrics.post_impressions_unique || 0,
      engagementRate,
    };
```

- [ ] **Step 1.1.4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/facebook-analytics.test.ts`
Expected: PASS.

- [ ] **Step 1.1.5: Commit**

```bash
git add packages/social/src/providers/facebook.provider.ts packages/social/src/__tests__/facebook-analytics.test.ts
git commit -m "fix(analytics): FB reach uses post_impressions_unique not post_engaged_users

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: IG — request `views` (impressions deprecated) + surface `saved`

**Files:**
- Modify: `packages/social/src/providers/instagram.provider.ts:285-334`
- Test: `packages/social/src/__tests__/instagram-analytics.test.ts` (create)

- [ ] **Step 1.2.1: Write the failing test**

```typescript
// packages/social/src/__tests__/instagram-analytics.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";

describe("InstagramProvider.getPostAnalytics metric set", () => {
  const provider = new InstagramProvider();
  afterEach(() => vi.restoreAllMocks());

  it("requests 'views' (not deprecated 'impressions') for FEED media", async () => {
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      calls.push(String(url));
      if (String(url).includes("media_product_type")) {
        return { ok: true, json: async () => ({ like_count: 10, comments_count: 2, media_product_type: "FEED" }) } as any;
      }
      return { ok: true, json: async () => ({ data: [
        { name: "views", values: [{ value: 500 }] },
        { name: "reach", values: [{ value: 300 }] },
      ] }) } as any;
    }) as any;

    const result = await provider.getPostAnalytics({ accessToken: "t" } as any, "ig_1");
    const insightsCall = calls.find((c) => c.includes("/insights"));
    expect(insightsCall).toContain("views");
    expect(insightsCall).not.toContain("impressions"); // deprecated Jan 2025
    expect(result?.impressions).toBe(500); // views ride on impressions slot
    expect(result?.reach).toBe(300);
  });
});
```

- [ ] **Step 1.2.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/instagram-analytics.test.ts`
Expected: FAIL — the FEED metric string still contains `impressions`.

- [ ] **Step 1.2.3: Update the metric sets + views mapping**

In `instagram.provider.ts` `getPostAnalytics`, replace the metric-set selection and the impressions derivation. FEED/CAROUSEL and STORY use `views` (the post-2024 replacement for `impressions`):

```typescript
    const metricSet =
      productType === "REELS"
        ? "views,reach,saved,shares,total_interactions,likes,comments"
        : productType === "STORY"
          ? "views,reach,replies"
          : "views,reach"; // FEED/CAROUSEL: 'impressions' deprecated (Graph v22, 2025-01-21) → use 'views'
    // ...
    // Reel plays/views ride on the impressions slot (same "views ride on
    // impressions" convention as YouTube/Threads).
    const impressions = metrics.views ?? metrics.impressions ?? metrics.plays ?? 0;
    const totalEngagement = metrics.total_interactions ?? metrics.engagement ?? likes + comments;
    const engagementRate = impressions > 0 ? totalEngagement / impressions : 0;
    // metrics.saved is now available for the schema-backed `saved` column (Phase 2).
```

Keep the `readInsights(metricSet)` → `readInsights("reach")` fallback exactly as-is.

- [ ] **Step 1.2.4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/instagram-analytics.test.ts`
Expected: PASS.

- [ ] **Step 1.2.5: Commit**

```bash
git add packages/social/src/providers/instagram.provider.ts packages/social/src/__tests__/instagram-analytics.test.ts
git commit -m "fix(analytics): IG requests 'views' not deprecated 'impressions'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Add the missing Meta insights scopes

**Files:**
- Modify: `packages/api/src/routers/channel.router.ts:487` (FACEBOOK), `:494` (INSTAGRAM)
- Test: `packages/api/src/__tests__/meta-scopes.test.ts` (create)

- [ ] **Step 1.3.1: Write the failing test**

```typescript
// packages/api/src/__tests__/meta-scopes.test.ts
import { describe, it, expect } from "vitest";
import { getDefaultScopesForTest as getDefaultScopes } from "../routers/channel.router";

describe("Meta insights scopes", () => {
  it("INSTAGRAM includes instagram_manage_insights (required for media insights)", () => {
    expect(getDefaultScopes("INSTAGRAM")).toContain("instagram_manage_insights");
  });
  it("FACEBOOK includes read_insights (documented requirement for post insights)", () => {
    expect(getDefaultScopes("FACEBOOK")).toContain("read_insights");
  });
});
```

> NOTE: `getDefaultScopes` is currently a private function. Export a test alias at the bottom of `channel.router.ts`: `export const getDefaultScopesForTest = getDefaultScopes;` (or make the existing symbol exported). Do this in Step 1.3.3.

- [ ] **Step 1.3.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/meta-scopes.test.ts`
Expected: FAIL — scopes missing (and possibly an import error until the export is added).

- [ ] **Step 1.3.3: Add the scopes + test export**

In `channel.router.ts`:

```typescript
    FACEBOOK: ["public_profile", "pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights"],
    // ...
    INSTAGRAM: ["public_profile", "pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish", "business_management", "instagram_manage_insights"],
```

And at the bottom of the file: `export const getDefaultScopesForTest = getDefaultScopes;`

- [ ] **Step 1.3.4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/meta-scopes.test.ts`
Expected: PASS.

- [ ] **Step 1.3.5: Commit**

```bash
git add packages/api/src/routers/channel.router.ts packages/api/src/__tests__/meta-scopes.test.ts
git commit -m "fix(analytics): add instagram_manage_insights + read_insights Meta scopes

Required per Meta Media Insights + Page post insights requirements tables.
IG media insights (reach/impressions/shares) fail without instagram_manage_insights.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.4: External process — Meta App Review resubmission (NON-CODE, tracked)

- [ ] **Step 1.4.1: Submit App Review for the two new scopes.** In Meta App Dashboard → App Review → Permissions and Features, request Advanced Access for `instagram_manage_insights` and `read_insights`. Reuse the existing approved screencast (`MetaNewSubmission_final.mp4`) — the flows are unchanged; add reviewer notes: "reading own-Page/own-IG-Business media insights (impressions/reach/saved) for the connected user's analytics dashboard." See CLAUDE.md "Facebook / Instagram (Meta) specifics" for the submission mechanics.
- [ ] **Step 1.4.2: After approval, existing FB/IG channels must reconnect** (scope change invalidates tokens — the standard Meta quirk). Add an in-app banner on the Channels page prompting reconnect for FB/IG (or rely on the existing token-invalidation error surfacing). Verify with one real IG post: after reconnect, `AnalyticsSnapshot` reach/impressions become non-zero.
- [ ] **Step 1.4.3: Verify on prod** with the same query used in the audit:
```sql
SELECT platform, SUM(CASE WHEN reach>0 THEN 1 ELSE 0 END) reach_gt0, COUNT(*)
FROM "AnalyticsSnapshot" WHERE platform IN ('FACEBOOK','INSTAGRAM')
AND "snapshotAt" > now() - interval '2 days' GROUP BY platform;
```
Expected after approval + reconnect: `reach_gt0 > 0`.

---

## Phase 1.5: Vendor `social-scrapers` + wire the resilient fallback

Makes IG/FB/Snapchat owned-post engagement flow **immediately** (no App Review wait) by falling back to the existing, production-hardened `@dashmani/social-scrapers` when the official API returns null/permission-fail. Reused inside this repo as a workspace package.

### Task 1.5.1: Vendor social-scrapers as a workspace package

**Files:**
- Create: `packages/social-scrapers/` (copy `~/Desktop/social-scrapers/{src,package.json,tsconfig.json,README.md}`)
- Modify: `pnpm-workspace.yaml` (already globs `packages/*` — verify), root `package.json` if needed

- [ ] **Step 1.5.1.1: Copy the library into the monorepo**

```bash
cd /Users/tabish/Desktop/Dashmani-PostAutomation
mkdir -p packages/social-scrapers
cp -R ~/Desktop/social-scrapers/src packages/social-scrapers/src
cp ~/Desktop/social-scrapers/{package.json,tsconfig.json,README.md} packages/social-scrapers/
```

- [ ] **Step 1.5.1.2: Rename the package to the workspace convention**

Edit `packages/social-scrapers/package.json`: change `"name": "@dashmani/social-scrapers"` → `"name": "@postautomation/social-scrapers"`. Align the `tsconfig.json` `extends` to `../../tsconfig.base.json` if the repo convention requires it (check a sibling package's tsconfig first).

- [ ] **Step 1.5.1.3: Add it as a dependency of the social package + worker**

In `packages/social/package.json` and `apps/worker/package.json`, add `"@postautomation/social-scrapers": "workspace:*"` to `dependencies`. Then:

```bash
pnpm install
```

- [ ] **Step 1.5.1.4: Verify it builds + typechecks in-repo**

Run: `pnpm --filter @postautomation/social-scrapers build && pnpm --filter @postautomation/social-scrapers typecheck`
Expected: exit 0, `dist/` emitted.

- [ ] **Step 1.5.1.5: Commit**

```bash
git add packages/social-scrapers pnpm-workspace.yaml packages/social/package.json apps/worker/package.json pnpm-lock.yaml
git commit -m "chore(analytics): vendor social-scrapers as @postautomation/social-scrapers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.5.2: FB — fall back to reel-engagement scrape when the API misses

**Files:**
- Modify: `packages/social/src/providers/facebook.provider.ts` (getPostAnalytics + getVideoAnalytics)
- Test: `packages/social/src/__tests__/facebook-analytics-fallback.test.ts` (create)

- [ ] **Step 1.5.2.1: Write the failing test** — when the API insights call yields impressions=0 AND `scrapeFacebookReelEngagement` returns real views/likes, the provider returns the SCRAPED numbers (mapped views→impressions), not the API zeros. reach/clicks stay null→0 (scraper doesn't provide them) with `metricsAvailable.reach=false`.

```typescript
// packages/social/src/__tests__/facebook-analytics-fallback.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";
import * as scrapers from "@postautomation/social-scrapers";

describe("FacebookProvider scraper fallback", () => {
  const provider = new FacebookProvider();
  afterEach(() => vi.restoreAllMocks());

  it("uses scraped reel engagement when the API returns all-zero insights", async () => {
    // API insights → empty (permission-fail signature), fields → zeros
    vi.spyOn(provider as any, "graphFetch").mockImplementation(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.spyOn(scrapers, "scrapeFacebookReelEngagement").mockResolvedValue({
      views: 5000, likes: 120, comments: 8, shares: null, caption: null,
    } as any);
    const result = await provider.getPostAnalytics({ accessToken: "t" } as any, "9999999999"); // bare video id
    expect(result?.impressions).toBe(5000); // scraped views → impressions
    expect(result?.likes).toBe(120);
    expect(result?.source).toBe("scrape"); // provenance flag (see Phase 2)
  });
});
```

- [ ] **Step 1.5.2.2: Run to verify it fails.**
Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/facebook-analytics-fallback.test.ts`
Expected: FAIL — no fallback yet.

- [ ] **Step 1.5.2.3: Add the fallback in `getVideoAnalytics` (and the feed path where applicable).** After computing the API result, if `impressions === 0` (the permission-failure signature), try the scraper:

```typescript
import { scrapeFacebookReelEngagement } from "@postautomation/social-scrapers";
// ... inside getVideoAnalytics, after building the API-based result:
    if (impressions === 0) {
      const scraped = await scrapeFacebookReelEngagement(videoId);
      if (scraped && scraped.views != null) {
        return {
          impressions: scraped.views,
          clicks: 0,
          likes: scraped.likes ?? likes,
          shares: scraped.shares ?? 0,
          comments: scraped.comments ?? comments,
          reach: 0,
          engagementRate: scraped.views > 0
            ? ((scraped.likes ?? 0) + (scraped.comments ?? 0)) / scraped.views : 0,
          source: "scrape",                                   // Phase 2 provenance
          metricsAvailable: { reach: false, clicks: false },  // scraper gives neither
          reachIsDistinct: false,
        };
      }
    }
    // else return the API result with source: "api"
```

- [ ] **Step 1.5.2.4: Run to verify it passes.**

- [ ] **Step 1.5.2.5: Commit**

```bash
git add packages/social/src/providers/facebook.provider.ts packages/social/src/__tests__/facebook-analytics-fallback.test.ts
git commit -m "feat(analytics): FB falls back to reel-engagement scrape when API insights miss

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 1.5.3: Un-stub Snapchat analytics via the spotlight scraper

**Files:**
- Modify: `packages/social/src/providers/snapchat.provider.ts` (implement `getPostAnalytics` — currently inherits base null)
- Test: `packages/social/src/__tests__/snapchat-analytics.test.ts` (create)

- [ ] **Step 1.5.3.1: Write the failing test** — `getPostAnalytics` returns scraped spotlight views/comments/shares (likes null → 0 with `metricsAvailable.likes=false`, since Snapchat exposes no like metric).

- [ ] **Step 1.5.3.2: Run to verify it fails** (base returns null).

- [ ] **Step 1.5.3.3: Implement it:**

```typescript
import { scrapeSnapchatSpotlightEngagement } from "@postautomation/social-scrapers";
async getPostAnalytics(_tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
  const e = await scrapeSnapchatSpotlightEngagement(platformPostId);
  if (!e || e.views == null) return null; // fail-open — no fabricated data
  const impressions = e.views;
  return {
    impressions, clicks: 0,
    likes: 0, shares: e.shares ?? 0, comments: e.comments ?? 0,
    reach: impressions,
    engagementRate: impressions > 0 ? ((e.comments ?? 0) + (e.shares ?? 0)) / impressions : 0,
    source: "scrape",
    likeKind: "likes",
    metricsAvailable: { likes: false, clicks: false, reach: false }, // SC has no like metric
    reachIsDistinct: false,
  };
}
```

- [ ] **Step 1.5.3.4: Run to verify it passes.**

- [ ] **Step 1.5.3.5: Commit**

```bash
git add packages/social/src/providers/snapchat.provider.ts packages/social/src/__tests__/snapchat-analytics.test.ts
git commit -m "feat(analytics): Snapchat analytics via spotlight-engagement scraper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **IG note:** `scrapeEngagement` does NOT provide IG per-post engagement (the scraper's IG path is follower-only). So IG owned-post reach/impressions is fixed ONLY by the official-API scope add (Phase 1.3 + App Review). There is no scraper fallback for IG post engagement — this is a real coverage limit; until the scope lands, IG reach/impressions render honest `—` (Phase 4.2.3), not a fake 0. Document this in the audit doc.

> **Proxy note:** the scraper fetches from the worker's IP. FB/Snapchat spotlight pages are more tolerant than IG, but if hit-rate is low from the Linode datacenter IP, inject a residential-proxy fetch via `ScraperOptions.fetchImpl` at the call sites (a single shared `scraperOptions` in the worker). Add `SCRAPER_PROXY_URL` env, optional — absent ⇒ direct fetch.

---

## Phase 2: Extend the data model (root-cause fix)

Fixes the 7-slot-interface root cause (§5.1). Adds the dimensions the interface currently discards so reach/likes/saved are correct and non-redundant. **Additive, backward-compatible** — new columns default such that existing reads are byte-identical until Phase 3/4 consume them.

### Task 2.1: Extend `SocialAnalytics` + `AnalyticsSnapshot` with the missing dimensions

**Files:**
- Modify: `packages/social/src/abstract/social.types.ts:16-24`
- Modify: `packages/db/prisma/schema.prisma:421` (model AnalyticsSnapshot)
- Test: `packages/social/src/__tests__/social-analytics-shape.test.ts` (create)

- [ ] **Step 2.1.1: Write the failing test for the new interface shape**

```typescript
// packages/social/src/__tests__/social-analytics-shape.test.ts
import { describe, it, expect } from "vitest";
import type { SocialAnalytics } from "../abstract/social.types";

describe("SocialAnalytics extended shape", () => {
  it("carries native-metric metadata so columns can be labeled/deduped", () => {
    const a: SocialAnalytics = {
      impressions: 100, clicks: 0, likes: 10, shares: 2, comments: 1, reach: 60, engagementRate: 0.13,
      // new optional fields:
      saved: 4,
      reachIsDistinct: true,      // false when reach == impressions (dedup signal)
      likeKind: "likes",           // 'likes' | 'reactions' | 'saves' | 'upvotes'
      metricsAvailable: { impressions: true, reach: true, clicks: false, shares: true },
    };
    expect(a.saved).toBe(4);
    expect(a.reachIsDistinct).toBe(true);
    expect(a.likeKind).toBe("likes");
    expect(a.metricsAvailable?.clicks).toBe(false);
  });
});
```

- [ ] **Step 2.1.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/social-analytics-shape.test.ts`
Expected: FAIL — TS error, fields don't exist on the interface.

- [ ] **Step 2.1.3: Extend the interface (all new fields OPTIONAL for back-compat)**

```typescript
// packages/social/src/abstract/social.types.ts
export type LikeKind = "likes" | "reactions" | "saves" | "upvotes";
export type AnalyticsSource = "api" | "scrape";

export interface SocialAnalytics {
  impressions: number;
  clicks: number;
  likes: number;
  shares: number;
  comments: number;
  reach: number;
  engagementRate: number;
  // ── extended (optional; providers fill what they truly have) ──
  /** Saves/bookmarks (IG saved, Pinterest save) — a distinct action, not a like. */
  saved?: number;
  /** true only when `reach` is a genuinely distinct metric from `impressions`.
   *  false ⇒ reach was aliased from impressions/views (UI hides the Reach cell). */
  reachIsDistinct?: boolean;
  /** What the `likes` slot actually holds, for honest labeling. */
  likeKind?: LikeKind;
  /** Which of the 7 slots this platform can populate at all (false ⇒ render "—", not 0). */
  metricsAvailable?: Partial<Record<"impressions" | "reach" | "likes" | "comments" | "shares" | "clicks", boolean>>;
  /** Where this row came from: official API or the scraper fallback (Phase 1.5). */
  source?: AnalyticsSource;
}
```

- [ ] **Step 2.1.4: Extend the Prisma model (store the new fields in `metadata` JSON — no column migration risk)**

We store the extended fields inside the existing `metadata Json?` rather than new columns, to avoid a wide migration on the 1.3M-row table and keep the LATERAL joins unchanged. Confirm `metadata Json?` exists on `AnalyticsSnapshot` (schema.prisma:~432 — it does). No schema change needed for storage; the worker will write `metadata.saved`, `metadata.reachIsDistinct`, `metadata.likeKind`, `metadata.metricsAvailable` alongside the existing `windowTag`.

> Decision: JSON metadata (not new typed columns) because (a) no migration on a 1.3M-row table, (b) these are display-hints, not aggregated numerics, (c) `saved` is the only new numeric and it's low-traffic. If `saved` ever needs SUM aggregation, promote it to a real `Int @default(0)` column in a later migration.

- [ ] **Step 2.1.5: Run test to verify it passes**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/social-analytics-shape.test.ts`
Expected: PASS.

- [ ] **Step 2.1.6: Commit**

```bash
git add packages/social/src/abstract/social.types.ts packages/social/src/__tests__/social-analytics-shape.test.ts
git commit -m "feat(analytics): extend SocialAnalytics with saved/reachIsDistinct/likeKind/metricsAvailable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Set the honest metadata in every provider

**Files:**
- Modify: all 10 analytics providers in `packages/social/src/providers/*.provider.ts`
- Test: `packages/social/src/__tests__/provider-metric-honesty.test.ts` (create)

- [ ] **Step 2.2.1: Write the failing test (table-driven, one assertion per platform)**

```typescript
// packages/social/src/__tests__/provider-metric-honesty.test.ts
import { describe, it, expect } from "vitest";
// Uses each provider's returned metadata. Mock the fetches per provider and assert:
//  - Pinterest.likeKind === "saves"; Reddit.likeKind === "upvotes"; Facebook.likeKind === "reactions"; YouTube.likeKind === "likes"
//  - YouTube/Threads/Twitter/Pinterest/Reddit/DevTo: reachIsDistinct === false (reach aliased from impressions)
//  - LinkedIn (org): reachIsDistinct === true
//  - Instagram: saved is set from metrics.saved for REELS
// (Full mock scaffolding mirrors facebook-analytics.test.ts / instagram-analytics.test.ts.)
import { PinterestProvider } from "../providers/pinterest.provider";
import { RedditProvider } from "../providers/reddit.provider";

describe("provider metric honesty metadata", () => {
  it("Pinterest labels its likes slot as 'saves' and reach as non-distinct", async () => {
    const p = new PinterestProvider();
    // mock sumMetric-backing fetch → IMPRESSION=100, SAVE=8, PIN_CLICK=3
    // (mirror the fetch shape pinterest.provider expects)
    // ...
    const r = await p.getPostAnalytics({ accessToken: "t" } as any, "pin_1");
    expect(r?.likeKind).toBe("saves");
    expect(r?.reachIsDistinct).toBe(false);
  });
});
```

> The worker (Step 2.2.3) and UI (Phase 4) are the real consumers; this test locks the per-provider labels. Fill the mock bodies to match each provider's fetch shape (see the existing facebook/instagram analytics tests for the pattern).

- [ ] **Step 2.2.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/provider-metric-honesty.test.ts`
Expected: FAIL — providers don't return the metadata yet.

- [ ] **Step 2.2.3: Add the metadata to each provider's return.** Exact per-provider values (append to each `return {...}`):

| Provider | `likeKind` | `reachIsDistinct` | `saved` | `metricsAvailable` (false slots) |
|---|---|---|---|---|
| youtube | `"likes"` | `false` | — | `{clicks:false, shares:false}` (favoriteCount ~always 0) |
| linkedin | `"likes"` | `true` (org) / `false` (member) | — | member: `{impressions:false,reach:false,shares:false,clicks:false}` |
| facebook (feed) | `"reactions"` | `true` | — | `{}` (all real) |
| facebook (video) | `"likes"` | `false` | — | `{reach:false, shares:false, clicks:false}` |
| instagram | `"likes"` | `true` | `metrics.saved` | `{clicks:false}` |
| threads | `"likes"` | `false` | — | `{clicks:false}` |
| twitter | `"likes"` | `false` | — | `{clicks:false, reach:false}` (free-tier all 0) |
| pinterest | `"saves"` | `false` | `saves` | `{comments:false, shares:false}` |
| reddit | `"upvotes"` | `false` | — | `{clicks:false}` |
| devto | `"likes"` | `false` | — | `{clicks:false, shares:false}` |

Example (Pinterest, `pinterest.provider.ts` return):
```typescript
    return {
      impressions, clicks, likes: saves, shares: 0, comments: 0, reach: impressions,
      engagementRate: impressions > 0 ? ((clicks + saves) / impressions) * 100 : 0,
      saved: saves,
      likeKind: "saves",
      reachIsDistinct: false,
      metricsAvailable: { comments: false, shares: false },
    };
```

- [ ] **Step 2.2.4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/social exec vitest run src/__tests__/provider-metric-honesty.test.ts`
Expected: PASS.

- [ ] **Step 2.2.5: Commit**

```bash
git add packages/social/src/providers packages/social/src/__tests__/provider-metric-honesty.test.ts
git commit -m "feat(analytics): providers declare likeKind/reachIsDistinct/saved/metricsAvailable

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Worker persists the new metadata

**Files:**
- Modify: `apps/worker/src/workers/analytics-sync.worker.ts:56-72`
- Modify: `apps/worker/src/workers/post-publish.worker.ts:834-846`
- Test: `apps/worker/src/__tests__/analytics-sync-metadata.test.ts` (create)

- [ ] **Step 2.3.1: Write the failing test**

```typescript
// apps/worker/src/__tests__/analytics-sync-metadata.test.ts
// Assert the snapshot metadata merges the new fields alongside windowTag.
import { describe, it, expect } from "vitest";
import { buildSnapshotMetadata } from "../workers/analytics-sync.worker";

describe("buildSnapshotMetadata", () => {
  it("merges provider metric metadata with windowTag", () => {
    const md = buildSnapshotMetadata(
      { saved: 4, reachIsDistinct: false, likeKind: "saves", metricsAvailable: { clicks: false } } as any,
      "7d",
      false
    );
    expect(md).toMatchObject({ windowTag: "7d", saved: 4, reachIsDistinct: false, likeKind: "saves" });
    expect(md.metricsAvailable).toEqual({ clicks: false });
  });
  it("returns undefined-safe object when no windowTag and no extra metadata", () => {
    const md = buildSnapshotMetadata({} as any, undefined, false);
    expect(md).toBeUndefined(); // byte-identical to legacy no-metadata path
  });
});
```

- [ ] **Step 2.3.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/worker exec vitest run src/__tests__/analytics-sync-metadata.test.ts`
Expected: FAIL — `buildSnapshotMetadata` not exported/defined.

- [ ] **Step 2.3.3: Extract + implement `buildSnapshotMetadata`, use it in both workers**

Add to `analytics-sync.worker.ts` (exported) and reuse in `post-publish.worker.ts`:

```typescript
export function buildSnapshotMetadata(
  a: { saved?: number; reachIsDistinct?: boolean; likeKind?: string; metricsAvailable?: Record<string, boolean>; source?: string },
  windowTag: string | undefined,
  capturedLate: boolean
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (a.saved != null) extra.saved = a.saved;
  if (a.reachIsDistinct != null) extra.reachIsDistinct = a.reachIsDistinct;
  if (a.likeKind != null) extra.likeKind = a.likeKind;
  if (a.metricsAvailable != null) extra.metricsAvailable = a.metricsAvailable;
  if (a.source != null) extra.source = a.source;   // 'api' | 'scrape' provenance
  if (windowTag) extra.windowTag = windowTag;
  if (capturedLate) extra.capturedLate = true;
  return Object.keys(extra).length > 0 ? extra : undefined;
}
```

Then in the `analyticsSnapshot.create` data, replace the inline `metadata` ternary with:
```typescript
          ...(buildSnapshotMetadata(analytics as any, windowTag, capturedLate)
            ? { metadata: buildSnapshotMetadata(analytics as any, windowTag, capturedLate) }
            : {}),
```
(Compute once into a `const md` to avoid double-calling.)

- [ ] **Step 2.3.4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/worker exec vitest run src/__tests__/analytics-sync-metadata.test.ts`
Expected: PASS.

- [ ] **Step 2.3.5: Commit**

```bash
git add apps/worker/src/workers/analytics-sync.worker.ts apps/worker/src/workers/post-publish.worker.ts apps/worker/src/__tests__/analytics-sync-metadata.test.ts
git commit -m "feat(analytics): persist metric-honesty metadata on snapshots

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3: Fix the aggregation math (analytics.router.ts)

Fixes H1/H2 (population mismatch), H7/H8 (engagement-rate pooling inflation), M1/M24 (isActive population), L5 (double-count on tie). Depends only on the router — no schema needed.

### Task 3.1: Fix engagement-rate inflation — exclude zero-impression targets from the pool

**Files:**
- Modify: `packages/api/src/routers/analytics.router.ts:315-318` (engagement proc), `:547-548` (perChannelStats), `packages/api/src/lib/group-stats.ts:81-85`
- Test: `packages/api/src/__tests__/engagement-rate-pooling.test.ts` (create)

- [ ] **Step 3.1.1: Write the failing test**

```typescript
// packages/api/src/__tests__/engagement-rate-pooling.test.ts
import { describe, it, expect } from "vitest";
import { computeEngagementRate } from "../lib/engagement-rate";

describe("computeEngagementRate", () => {
  it("does not let a zero-impression target inflate the pooled rate", () => {
    // IG: 1000 impr, 20 eng (true 2%). LinkedIn member: 0 impr, 80 eng.
    // Bad (current): (20+80)/(1000+0)*100 = 10%. Correct: exclude the 0-impr row → 2%.
    const rows = [
      { impressions: 1000, likes: 20, comments: 0, shares: 0 },
      { impressions: 0, likes: 80, comments: 0, shares: 0 },
    ];
    expect(computeEngagementRate(rows)).toBeCloseTo(2.0, 3);
  });
  it("returns 0 when no impressions anywhere", () => {
    expect(computeEngagementRate([{ impressions: 0, likes: 5, comments: 0, shares: 0 }])).toBe(0);
  });
});
```

- [ ] **Step 3.1.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/engagement-rate-pooling.test.ts`
Expected: FAIL — `engagement-rate.ts` doesn't exist.

- [ ] **Step 3.1.3: Create the shared helper**

```typescript
// packages/api/src/lib/engagement-rate.ts
/** Pool only rows that HAVE impressions, so engagement from a zero-impression
 *  target (LinkedIn member post, Reddit with view_count 0) can't inflate the
 *  rate over a denominator it didn't contribute to. Returns a 0–100 percent. */
export function computeEngagementRate(
  rows: Array<{ impressions: number; likes: number; comments: number; shares: number }>
): number {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.impressions > 0) {
      num += r.likes + r.comments + r.shares;
      den += r.impressions;
    }
  }
  return den > 0 ? (num / den) * 100 : 0;
}
```

- [ ] **Step 3.1.4: Wire it into the three call sites.**
  - `engagement` proc: change the SQL to `SUM(a.likes+a.comments+a.shares) FILTER (WHERE a.impressions > 0)` over `SUM(a.impressions) FILTER (WHERE a.impressions > 0)` — or drop the SQL rate and compute in JS from per-row results. Simplest: add `FILTER (WHERE a.impressions > 0)` to both the numerator SUM and denominator SUM in the `engagementRate` CASE at `:315-318`.
  - `perChannelStats:547-548`: the per-channel row already has summed impressions; guard is already `impressions > 0 ? ... : 0`. Add a code comment that per-channel pooling is acceptable (a single channel is one platform, so no cross-platform 0-impression contamination) — **no change needed**, but document why.
  - `group-stats.ts:81-85` `rateFromSums`: same guard; groups CAN mix platforms, so switch it to use `computeEngagementRate` over the group's per-channel rows instead of pre-summed totals. This requires `sumChannelRowsIntoGroups` to keep per-channel rows for the rate calc.

Concrete SQL edit for `engagement` proc:
```sql
          CASE WHEN SUM(a.impressions) FILTER (WHERE a.impressions > 0) > 0
            THEN CAST(SUM(a.likes + a.comments + a.shares) FILTER (WHERE a.impressions > 0) AS FLOAT)
                 / SUM(a.impressions) FILTER (WHERE a.impressions > 0) * 100
            ELSE 0
          END as "engagementRate"
```

- [ ] **Step 3.1.5: Run test + existing analytics tests to verify pass**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/engagement-rate-pooling.test.ts src/__tests__/group-stats.test.ts`
Expected: PASS (update `group-stats.test.ts` expectations if the group rate changes for mixed-impression fixtures).

- [ ] **Step 3.1.6: Commit**

```bash
git add packages/api/src/lib/engagement-rate.ts packages/api/src/routers/analytics.router.ts packages/api/src/lib/group-stats.ts packages/api/src/__tests__/engagement-rate-pooling.test.ts
git commit -m "fix(analytics): engagement rate excludes zero-impression targets from pool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Reconcile the overview `published` / `totalTargets` populations

**Files:**
- Modify: `packages/api/src/routers/analytics.router.ts:203-260` (overview proc)
- Test: `packages/api/src/__tests__/overview-population.test.ts` (create)

- [ ] **Step 3.2.1: Write the failing test**

```typescript
// packages/api/src/__tests__/overview-population.test.ts
// Real-Postgres createCaller test (mirror the existing analytics e2e).
// Setup: one post, publishedAt=NULL, status=PUBLISHING, with 2 PUBLISHED targets
// whose updatedAt is in-range. Assert overview.published <= overview.totalTargets.
import { describe, it, expect } from "vitest";
// ... test harness that builds the caller against a test DB ...

describe("overview population consistency", () => {
  it("never reports published > totalTargets", async () => {
    // arrange the mixed-outcome post described above
    // const overview = await caller.analytics.overview({});
    // expect(overview.published).toBeLessThanOrEqual(overview.totalTargets);
  });
});
```

> Use the same real-Postgres `createCaller` harness as the existing `group-stats.test.ts` / analytics e2e (per CLAUDE.md §"Admin gate + ... Insights groupStats"). Fill in the arrange block with direct `prisma.post.create` + `postTarget.create`.

- [ ] **Step 3.2.2: Run test to verify it fails**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/overview-population.test.ts`
Expected: FAIL — `published` (2) > `totalTargets` (0) for the mixed-outcome post.

- [ ] **Step 3.2.3: Compute `totalTargets` from the SAME population as `published`.** Replace the `totalTargets = sum of p.targets.length over the publishedAt-in-range posts query` with a target-level count that matches `published`'s predicate (PUBLISHED targets with `publishedAt in range OR (publishedAt NULL AND updatedAt in range)`), counting all statuses for the denominator but over the same post set:

```typescript
      // totalTargets must be the SAME population as `published` (target-level,
      // including the NULL-publishedAt OR-branch) so published <= totalTargets always.
      const totalTargets = await ctx.prisma.postTarget.count({
        where: {
          post: {
            organizationId: ctx.organizationId,
            OR: [
              { publishedAt: { gte: from, lte: to } },
              { publishedAt: null, updatedAt: { gte: from, lte: to } },
            ],
          },
        },
      });
```

- [ ] **Step 3.2.4: Run test to verify it passes**

Run: `pnpm --filter @postautomation/api exec vitest run src/__tests__/overview-population.test.ts`
Expected: PASS.

- [ ] **Step 3.2.5: Commit**

```bash
git add packages/api/src/routers/analytics.router.ts packages/api/src/__tests__/overview-population.test.ts
git commit -m "fix(analytics): overview totalTargets shares published's population (no published>total)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: Add `isActive` filter to the engagement proc (reconcile with the channel table)

**Files:**
- Modify: `packages/api/src/routers/analytics.router.ts:273-282` (engagement proc target query)
- Test: extend `packages/api/src/__tests__/engagement-rate-pooling.test.ts` or a new e2e

- [ ] **Step 3.3.1: Write the failing test** (real-Postgres): a disconnected (`isActive=false`) channel's snapshots must NOT count toward `engagement`, so the headline rate matches the channel-table population.

- [ ] **Step 3.3.2: Run to verify it fails** (disconnected channel's engagement still counted).

- [ ] **Step 3.3.3: Add the channel filter** to the engagement proc's `postTarget.findMany` where-clause:
```typescript
        where: {
          post: { organizationId: ctx.organizationId, publishedAt: { gte: from, lte: to } },
          status: "PUBLISHED",
          channel: { isActive: true },
        },
```

- [ ] **Step 3.3.4: Run to verify it passes.**

- [ ] **Step 3.3.5: Commit**
```bash
git commit -am "fix(analytics): engagement proc counts active channels only (matches channel table)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3.4: Prevent double-count on tied `snapshotAt`

**Files:**
- Modify: `packages/api/src/routers/analytics.router.ts:320-325` (engagement proc join)
- Test: `packages/api/src/__tests__/snapshot-tie-dedup.test.ts` (create)

- [ ] **Step 3.4.1: Write the failing test** — two snapshots for one target with identical `snapshotAt`; assert the metric is counted once, not summed.

- [ ] **Step 3.4.2: Run to verify it fails** (value doubled).

- [ ] **Step 3.4.3: Switch the engagement proc to `DISTINCT ON` (one row per target), matching the per-channel LATERAL LIMIT 1:**
```sql
        FROM (
          SELECT DISTINCT ON (s."postTargetId") s.*
          FROM "AnalyticsSnapshot" s
          WHERE s."postTargetId" = ANY($1::text[])
          ORDER BY s."postTargetId", s."snapshotAt" DESC, s.id DESC
        ) a
```
(Then `SUM` over `a` as before — `id DESC` breaks the tie deterministically.)

- [ ] **Step 3.4.4: Run to verify it passes.**

- [ ] **Step 3.4.5: Commit**
```bash
git commit -am "fix(analytics): engagement proc dedups tied-timestamp snapshots (DISTINCT ON)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4: Make the UI honest (labels, — vs 0, hide redundant reach)

Fixes M2–M5 (mislabeled likes), M8/H3 (redundant reach), M13/L2 (NULL-vs-0), H6/M14 (always-0 clicks), NEW-1 (null-provider platforms). Consumes Phase 2's metadata. UI-only.

### Task 4.1: Router surfaces the per-row honesty metadata

**Files:**
- Modify: `packages/api/src/routers/analytics.router.ts` — `perChannelStats`, `groupStats`, `postReports` output shapes to include `likeKind`, `reachIsDistinct`, `metricsAvailable`, `hasSnapshot` (derived from the latest snapshot's `metadata`).
- Test: extend the analytics e2e.

- [ ] **Step 4.1.1: Write the failing test** — `perChannelStats` rows include `likeKind`/`reachIsDistinct`/`hasSnapshot` read from the latest snapshot metadata.
- [ ] **Step 4.1.2: Run to verify it fails.**
- [ ] **Step 4.1.3: Read the latest snapshot's `metadata` in `fetchChannelStatRows`** (add `s.metadata` to the LATERAL select) and thread `likeKind`/`reachIsDistinct`/`metricsAvailable` + a `hasSnapshot boolean` (`s.snapshotAt IS NOT NULL`) into the returned rows. Default `likeKind='likes'`, `reachIsDistinct=true`, `hasSnapshot=false` when metadata absent (legacy rows).
- [ ] **Step 4.1.4: Run to verify it passes.**
- [ ] **Step 4.1.5: Commit.**

### Task 4.2: Channel + Group tables render honest labels

**Files:**
- Modify: `apps/web/app/dashboard/analytics/page.tsx:460-516` (channel table), `:575-613` (group table)
- Test: none (presentational) — verify via `pnpm --filter @postautomation/web build` + manual/Playwright.

- [ ] **Step 4.2.1: Likes header + cell tooltip.** Where the row's `likeKind !== "likes"`, render the cell with a tooltip: `saves` → "Saves (Pinterest has no likes)", `upvotes` → "Upvotes (Reddit)", `reactions` → "All reactions (Facebook)". Keep the header "Likes" but add an ⓘ explaining mixed sources, OR render a small platform-aware sublabel.
- [ ] **Step 4.2.2: Reach cell — hide when not distinct.** When `reachIsDistinct === false`, render `—` with tooltip "This platform reports views, not a separate reach" instead of duplicating the impressions number.
- [ ] **Step 4.2.3: — vs 0.** When `hasSnapshot === false`, render every metric cell as `—` (not `0`) with a row-level "Not synced yet / analytics not available for this platform" hint. When `metricsAvailable[col] === false`, render that specific cell `—` with "Not available on {platform}".
- [ ] **Step 4.2.4: Clicks column.** When `metricsAvailable.clicks === false` for the row, render `—`.
- [ ] **Step 4.2.5: Build check.** Run `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` → exit 0 (per the `feedback-verify-next-build-not-just-tsc` memory).
- [ ] **Step 4.2.6: Commit.**

### Task 4.3: Reports table honest labels (same treatment)

**Files:**
- Modify: `apps/web/components/analytics/ReportsTab.tsx:306-394` (per-row cells)
- [ ] **Step 4.3.1: Apply the same likeKind tooltip, reachIsDistinct `—`, metricsAvailable `—` treatment to the Reports table cells** (it already distinguishes captured-0 from no-snapshot `—` for eng-rate; extend to reach/clicks/likes labeling).
- [ ] **Step 4.3.2: Build check + commit.**

### Task 4.4: Reports correctness fixes (audit §2)

**Files:**
- Modify: `apps/web/lib/csv.ts:13-23`, `packages/api/src/lib/report-csv.ts:17-27` (formula-injection guard)
- Modify: `apps/web/components/analytics/ReportsTab.tsx:131,397` (truncation markers)
- Test: `apps/web/lib/csv.test.ts` (extend)

- [ ] **Step 4.4.1: Write the failing test for the whitespace-formula bypass**

```typescript
// apps/web/lib/csv.test.ts (add)
import { describe, it, expect } from "vitest";
import { toCsv } from "./csv";
it("neutralizes a formula that starts with leading whitespace", () => {
  const csv = toCsv([["h"]], [[" =HYPERLINK(\"http://evil\")"]]);
  // the cell must be prefixed with ' after the guard (not left executable)
  expect(csv).toMatch(/"'? ?=HYPERLINK/); // guard applied despite leading space
  expect(csv).not.toMatch(/,\s+=HYPERLINK/); // NOT an unescaped leading-space formula
});
```

- [ ] **Step 4.4.2: Run to verify it fails.**
Run: `pnpm --filter @postautomation/web exec vitest run lib/csv.test.ts`
Expected: FAIL — `' =HYPERLINK'` passes through unescaped.

- [ ] **Step 4.4.3: Trim leading whitespace before the formula-prefix test** in BOTH serializers (they intentionally don't share code — fix twice):

```typescript
// csv.ts and report-csv.ts esc()/escaping fn — test the TRIMMED string:
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
function needsGuard(s: string): boolean {
  return FORMULA_PREFIX.test(s.replace(/^[\s ]+/, "")); // strip leading ws/nbsp first
}
// prefix ' when needsGuard(cell) is true
```

- [ ] **Step 4.4.4: Fix the truncation-marker off-by-one** — `ReportsTab.tsx:131` change `=== EXPORT_LIMIT` to `>= EXPORT_LIMIT` semantics is wrong (it can't exceed); instead fetch `EXPORT_LIMIT + 1` and mark truncated only when `length > EXPORT_LIMIT`, slicing back to the limit. Same for the `>= 500` footer at `:397` and `emailReport`'s `rows.length >= input.limit` (analytics.router.ts:790): fetch limit+1, truncated when `> limit`.

- [ ] **Step 4.4.5: Run tests + build to verify pass.**
Run: `pnpm --filter @postautomation/web exec vitest run lib/csv.test.ts && SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: PASS, build exit 0.

- [ ] **Step 4.4.6: Commit**

```bash
git add apps/web/lib/csv.ts packages/api/src/lib/report-csv.ts apps/web/components/analytics/ReportsTab.tsx apps/web/lib/csv.test.ts
git commit -m "fix(reports): CSV guard trims leading whitespace + truncation marker off-by-one

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> NOTE on IG-Reels Eng.% understatement (audit §2.1, info): once Phase 2 stores `saved`, the Reports Eng.% can optionally add saved to the numerator for Reels. Deferred — it's an info-level definitional nuance, not a bug. Leave the recompute as `(likes+comments+shares)/impressions` for cross-platform consistency.

---

## Phase 5: Sync efficiency (NEW-6 — FB 47× snapshot bloat)

### Task 5.1: Skip writing a snapshot when metrics are unchanged from the latest

**Files:**
- Modify: `apps/worker/src/workers/analytics-sync.worker.ts:56` (before `create`)
- Test: `apps/worker/src/__tests__/analytics-sync-dedup.test.ts` (create)

- [ ] **Step 5.1.1: Write the failing test** — given a latest snapshot identical to the freshly-fetched metrics AND no `windowTag`, `getPostAnalytics` result should NOT create a new row.
- [ ] **Step 5.1.2: Run to verify it fails.**
- [ ] **Step 5.1.3: Add an "unchanged skip" guard** (only for non-checkpoint cron jobs — checkpoint/`windowTag` jobs must always write): fetch the latest snapshot for the target; if all 6 numeric metrics equal the new values and `!windowTag`, return without creating. This directly stops the 47×-per-target zero-row accumulation.
- [ ] **Step 5.1.4: Run to verify it passes.**
- [ ] **Step 5.1.5: Commit.**

- [ ] **Step 5.2 (optional, ops): one-time prod cleanup** of historical all-zero FB duplicate snapshots (keep the latest per target per day). Write as a standalone script `scripts/dedupe-analytics-snapshots.ts`, dry-run first, run via `docker exec`. NOT part of the app deploy.

---

## Final verification (whole plan)

- [ ] **F.1: Full test suites green**
Run: `pnpm --filter @postautomation/social test && pnpm --filter @postautomation/api test && pnpm --filter @postautomation/worker test`
Expected: all PASS, including the pre-existing security/IDOR/golden suites named in CLAUDE.md §Testing.

- [ ] **F.2: Web build green**
Run: `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`
Expected: exit 0.

- [ ] **F.3: Root type-check**
Run: `pnpm type-check`
Expected: exit 0.

- [ ] **F.4: Update the audit doc** — mark each finding in `docs/INSIGHTS-REPORTS-ACCURACY-AUDIT-2026-07-22.md` as FIXED with the commit hash, and note the Meta App Review status (pending/approved).

- [ ] **F.5: Open the PR** with a body summarizing: Meta insights restored (scope + metrics), root-cause metadata model, aggregation fixes, UI honesty, sync dedup. Flag the manual step (Meta App Review + user reconnect) as a release gate for the IG/FB data to actually flow.

---

## Spec-coverage self-check

- Every §1 High/Medium finding maps to a task: H1/H2→3.2, H3/H4/H5/M8/M9→1.1+4.2.2, H6/M14/M15→4.2.4, H7/H8→3.1, M1/M24→3.3, M2–M5→2.2+4.2.1, M13/L2→4.2.3, L5→3.4.
- Every NEW finding: NEW-1→4.2.3, NEW-2→1.1, NEW-3→1.2+1.3+1.4 (API) **+ 1.5.3 note (no IG scraper — honest — until scope)**, NEW-4→1.2, NEW-5→1.3+1.4, NEW-6→5.1.
- **Live-broken data restored two ways:** official API (Phase 1, needs App Review) + scraper fallback (Phase 1.5, works now) for FB reels + Snapchat. IG post engagement = API-only (Phase 1.5.3 note documents the scraper coverage gap).
- **Scraper reuse (owner decision):** vendored as `@postautomation/social-scrapers` in Phase 1.5.1; used as fallback only (Phase 1.5.2/1.5.3); provenance stored via `source` field (Phase 2.1/2.3) so the UI can show "scraped" data honestly if desired.
- **No new features:** every task modifies an EXISTING surface (providers, analytics.router, analytics/page.tsx, ReportsTab, workers). No new pages/screens. ✓ matches owner guardrail.
- Reports correctness (§2 of audit — CSV whitespace guard, truncation off-by-one, IG-Reels eng%): Task 4.4 (whitespace-trim guard in both `csv.ts` + `report-csv.ts`; limit+1 truncation detection; IG-Reels saved deferred as info).
- Reports redundancy: no task — audit verdict is KEEP-SEPARATE (no change).
- **Meta permissions:** Phase 1.3 (code) + Phase 1.4 (App Review resubmission) — owner confirmed "we will also get the permissions." The scraper fallback means data flows even before approval; the scope makes IG's official path work and removes the FB permission fragility.
