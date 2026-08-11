# Facebook impressions/reach recovery — `post_media_view` implementation plan + backfill

**Status: Deploy 1 IMPLEMENTED, flag OFF, not yet deployed.** Supersedes the "FB
impressions/reach are permanently gone" conclusion in CLAUDE.md and in
`docs/INSIGHTS-META-PERMISSIONS-GRANTED-2026-08-06.md`.

| Item | State |
|---|---|
| §3.2 two-rung ladder + §2 lifetime selection | ✅ `packages/social/src/utils/fb-insight-metrics.ts` + provider |
| §3.3 MAX-preferring merge, §3.4 scraper demotion (early return) | ✅ |
| §3.5 `CAPS.FACEBOOK.unavailable` untouched | ✅ verified byte-identical |
| §3.6 `SUM(reach)` relabelled + `impressionedPosts` DISTINCT fix | ✅ |
| P0-1 listing must not stamp insights health | ✅ verdict moved to the metrics pass |
| P1-3 `emailReport` capability-filtered columns | ✅ |
| §4 backfill floor `EXTERNAL_RECAPTURE_BEFORE` + non-video-first ordering | ✅ |
| Kill switch plumbed in `docker-compose.prod.yml` | ✅ fail-closed, defaults `false` |
| §3.7 engagement-rate `rate_impossible` measurement (Deploy 0) | ✅ **RUN — 0 of 120 would be suppressed** (see below) |
| P1-6 FB excluded from periodic crons | ⏳ accepted/documented, not changed |
| P2-7 `chat.router` second aggregate | ⏳ follow-up PR |
| P2-8 run the `LIVE_E2E` availability SQL suite | ⏳ checklist gate before enabling |
| P2-10 pass `pageId` on the feed insights call | ⏳ not done |

Verification: **2,268 tests pass** (39 new), `tsc` clean on social/api/worker, web build green.

**Every fact below was live-probed against the production Graph API** from inside
`postautomation-worker-1` with real decrypted Page tokens on 2026-08-11. Design reviewed by a
13-agent workflow: 6 design dimensions, each adversarially refuted, plus a completeness critic.
All six were refuted at major/fatal severity — the refutations confirmed the core shape and
caught six specific unsafe implementation details, all folded in below.

---

## 0. The correction this plan rests on

**Meta RENAMED per-post impressions and reach. It did not delete the capability.** From
[Meta's own deprecated-metrics page](https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics):

```
post_impressions_unique*  (Alternative: post_total_media_view_unique)
page_impressions_unique*  (Alternative: page_total_media_view_unique)
```

The earlier conclusion ("deleted platform-wide, no permission restores them") was reached by
probing whether the **old** names work. They don't. But a probe can only answer *"does name X
work?"* — it cannot discover a name nobody guessed. The `#100 "must be a valid insights metric"`
error was itself saying *this is a naming problem*, which should have prompted "then what IS the
name?" That is the method lesson; it belongs in the record.

### 🔑 No App Review, no reconnect, no consent change

`debug_token` on the exact Page token that returned `post_media_view=144`:

```
business_management, email, instagram_basic, instagram_content_publish,
instagram_manage_comments, instagram_manage_insights, pages_manage_posts,
pages_read_engagement, pages_read_user_content, pages_show_list,
public_profile, read_insights
```

Every scope is **already approved**. `read_insights` covers the new metrics — same edge, new
names. **This is a pure code change.**

Why that is proof and not inference: a missing scope on this edge is a **silent HTTP 200 with
`{"data":[]}`**, never `#100`. A permission gap cannot validate one metric name and reject
another in the same request. On one token, in the same second, `post_media_view` returns 144
while `post_impressions` returns `#100`.

---

## 1. The exact metric namespace (36 names × 5 mediaTypes, one probe per name)

### ✅ VALID — real values on **all five** media types

| Metric | photo | album | status | video | link | Maps to |
|---|---|---|---|---|---|---|
| **`post_media_view`** | 14 | 144 | 3 | 276 | 58 | **impressions** |
| **`post_total_media_view_unique`** | 3 | 106 | 1 | 255 | 36 | **reach** |
| `post_clicks` | 0 | 3 | 0 | 5 | 2 | clicks *(in use)* |
| `post_reactions_by_type_total` | ✅ | ✅ | ✅ | ✅ | ✅ | reactions *(in use)* |
| `post_reactions_like_total` | 2 | 1 | 0 | 1 | 1 | likes only |
| `post_clicks_by_type` | ✅ | ✅ | ✅ | ✅ | ✅ | click breakdown |
| `post_video_views` (+`_unique`/`_organic`/`_paid`) | 0 | 0 | 0 | 163 | 0 | video views |
| `post_video_view_time`, `post_video_avg_time_watched` | — | — | — | ✅ | — | video only |

Impressions ≥ reach holds in **every** pair (ratios 1.08×–4.7×) — consistent with genuine
impressions/reach semantics, not a mislabelled counter.

### ❌ DEAD (`#100`) on every media type — the naming is asymmetric and unguessable

`post_impressions`, `post_impressions_unique`, `post_impressions_organic`,
`post_impressions_paid`, `post_impressions_fan`, `post_reach`, `post_engaged_users`,
`post_clicks_unique`, `post_negative_feedback`(+`_unique`), `post_views`, `post_views_unique`,
**`post_total_media_view`** (no `_unique`), **`post_media_view_unique`**, `post_media_views`,
`post_total_media_views`, `post_organic_media_view`, `post_paid_media_view`,
`post_media_view_organic`, `post_media_view_paid`, `post_media_view_time`,
`post_total_media_view_time`

⚠️ `post_engagements` returns **EMPTY200** (silent empty) — unusable, do not add it.

⚠️ Note the asymmetry: `post_media_view` is valid but `post_media_view_unique` is dead;
`post_total_media_view_unique` is valid but `post_total_media_view` is dead. **Neither name can
be derived from the other.** Every new name must be probed individually.

### Reels validated at scale (the population that matters)

`mediaType='video'` does not distinguish reels, and reels are the entire 52,076-row population.
Probed 25 rows with `isReel = true`:

```
post_media_view present      : 25/25
post_total_media_view_unique : 25/25
media_view > 0               : 25/25   (==0: 0)
impressions < reach anomalies: 0
dead tokens skipped          : 24 (~49%, the known coverage ceiling)
```

### 🔴 The new metrics exist ONLY on the POST node

| Call | Result |
|---|---|
| `/{composite}/insights?metric=post_media_view` | **OK: 276, 128** |
| `/{video-id}/insights?metric=post_media_view` | `#100` |
| `/{video-id}/video_insights?metric=post_media_view` | `#1` |
| `/{video-id}/video_insights?metric=total_video_impressions` | **EMPTY200** |
| `/{video-id}/video_insights?metric=total_video_views` | **EMPTY200** |

This is why reels looked unrecoverable: the code was asking the **Video** node, which reports
nothing for reels. The composite post node had the answer all along.

**Consequence for the publish path:** `getPostAnalytics` routes bare video ids (no `_`) to
`getVideoAnalytics` → Video node → nothing. Reaching the new metrics for app-published videos
requires `resolveVideoPostId` first (already exists, shipped in PR #165). See §3.4.

---

## 2. 🔴🔴 THE FAKE-ZERO TRAP — read this before writing any code

**The combined 5-metric call succeeds** (HTTP 200) — adding names to the existing comma list
costs **zero extra round-trips**. But it returns **7 rows for 5 metrics**:

```
name=post_clicks                    period=lifetime  v0=3
name=post_video_views               period=lifetime  v0=0
name=post_reactions_by_type_total   period=lifetime  v0={"like":1}
name=post_media_view                period=lifetime  v0=144     <-- real
name=post_total_media_view_unique   period=lifetime  v0=106     <-- real
name=post_video_views               period=day       v0=0       <-- DUPLICATE
name=post_total_media_view_unique   period=day       v0=0       <-- DUPLICATE, stale end_time
```

Meta returns **both `lifetime` and `day`** period rows for `post_total_media_view_unique` (and
for `post_video_views`). The `day` row holds **0** with a stale `end_time`, and it comes **after**
the lifetime row.

The existing parse loop at
[facebook.provider.ts:531-538](../packages/social/src/providers/facebook.provider.ts#L531-L538)
is **last-wins with no period filter**:

```ts
for (const metric of rows) {
  const v = metric.values?.[0]?.value;
  metrics[metric.name] = /* ... */ v || 0;   // LAST WINS
}
```

So a naive widening stores **`reach = 0`** while declaring it available — a fabricated zero, the
exact honesty violation this whole subsystem exists to prevent. My own first probe fell into it
and reported `unique=0` before I noticed the duplicate.

**It is latent today only because** `impressions: 0` / `reach: 0` are hardcoded at
[:587](../packages/social/src/providers/facebook.provider.ts#L587) and the equally-duplicated
`post_video_views` is parsed and then discarded.

> **MANDATORY:** every read must select `period === "lifetime"`, falling back to the first row
> only when no lifetime row exists. `post_media_view` happens to be lifetime-only today; do not
> rely on that — Meta added a `day` variant to its sibling without notice.

---

## 3. Implementation

### 3.1 The freeze permits this — verified against the lock, not the comment

[facebook.provider.ts:492-495](../packages/social/src/providers/facebook.provider.ts#L492) says
*"network shape is FROZEN — do not add calls here."* The test that **enforces** it
([facebook-external-video-analytics.test.ts:53-71](../packages/social/src/__tests__/facebook-external-video-analytics.test.ts#L53))
asserts `seen).toHaveLength(2)` plus the absence of a third URL. **It asserts round-trip count and
never inspects the metric list.** There is exactly one `graphFetch` in the insights branch
([:520-522](../packages/social/src/providers/facebook.provider.ts#L520)).

So the freeze means **round-trips, not query strings** — widening the comma list does not violate
it. But the freeze's *purpose* is engaged, because `?metric=` is all-or-nothing.

**What a `#100` on the widened call would cost** (traced, not assumed): `graphFetch` returns the
non-ok Response and recurses only on 429/403 codes 4/32/368, so `#100` never throws →
`rows=[]` → `insightsUsable=false` → `clicks: 0` + `clicks:false` ⇒ renders `—`. Reactions
survive **only** via the separate fields call, which needs `pages_read_user_content` — so on
tokens predating that approval, **likes are lost too**. And `diagnoseMetaError` returns
`undefined` for `#100` by design, so `deriveInsightsHealth` yields `"ok"`: **the loss would be
silent and permanent across 28,229 FB targets.** Publishing itself is never at risk — step 4b
runs after `status:"PUBLISHED"` is committed, inside a warn-only catch.

That asymmetry is why the ladder is mandatory, not optional.

### 3.2 Two-rung, failure-only ladder in `getFeedPostAnalytics`

Modelled on the Instagram precedent
([instagram.provider.ts:463-504](../packages/social/src/providers/instagram.provider.ts#L463)).

```
RUNG 1 (preferred): post_clicks,post_video_views,post_reactions_by_type_total,
                    post_media_view,post_total_media_view_unique
RUNG 2 (base):      post_clicks,post_video_views,post_reactions_by_type_total   <-- byte-identical to today
```

**Append the new names at the end.** That keeps
[facebook-video.test.ts:116](../packages/social/src/__tests__/facebook-video.test.ts#L116)'s
`toContain("…/insights?metric=post_clicks,post_video_views,post_reactions_by_type_total")`
passing as a prefix, and keeps the strict mock's `/\/insights\?metric=post_clicks/` route
matching, so `seen` stays at 2 and the golden lock passes unedited.

Rules — each one closes a defect the refutations found:

1. **Descend ONLY on a metric-NAME error.** Never on a 200-with-zero-rows: that is the
   missing-scope sentinel and a shorter list cannot fix a token.
2. **🔴 Narrow the `#100` classifier.** `#100` is *also* returned in this codebase for
   object-not-found (a deleted video, [:456](../packages/social/src/providers/facebook.provider.ts#L456))
   and nonexisting-field. Require **all three**: `code === 100` **AND**
   `error_subcode !== 33` **AND** a name-error message signature
   (`/valid insights metric|does not support the .* metric|nonexisting field/i`).
   Treating every `#100` as a bad name would make a deleted post trigger an endless pointless
   descent.
3. **Derive `metricsAvailable` per metric NAME** from a `present: Set<string>` built off the
   returned `metric.name`s — never one boolean for the whole call (that bug was fixed 2026-08-06).
4. **All six keys always** (`impressions, reach, clicks, likes, comments, shares`). An omitted
   key reads as AVAILABLE downstream.
5. **`period === "lifetime"` selection** (§2).
6. **Process-lifetime "dead rung" memo** so a persistent `#100` costs one extra call once, not
   once per row.
7. **Kill switch `FB_MEDIA_VIEW_METRICS_ENABLED`** (default **false**; see §6 — the compose
   allowlist trap means it must also be named in `docker-compose.prod.yml`).
8. **🔴 Add a loud, distinct log line on any descent.** Because `#100 → no degradation → "ok"`,
   the log is the *only* detection channel for a future Meta rename. This is the single largest
   residual risk in the plan.

### 3.3 `getExternalPostAnalytics` — MAX-preferring merge, never a clobber

The current merge at
[:729-736](../packages/social/src/providers/facebook.provider.ts#L729) is
`impressions: views ?? 0` with `impressions: views !== null`, which **overwrites the feed value
unconditionally** and can declare a 0 as available.

Measured reality settles the direction: the scraper was undercounting by up to **13×** — one reel
stored **6,421** where the API reports **83,582 impressions / 55,376 reach / 38,609 video views**.

```ts
// Prefer the LARGER of the two when both are positive; fall back to whichever exists.
// Never let an API 0 beat a recovered scraped value, and never fabricate availability.
const candidates = [apiViews, scrapedViews].filter((v) => v !== null && v > 0);
const best = candidates.length ? Math.max(...candidates) : (apiViews ?? scrapedViews);
// impressions: best ?? feed.impressions
// metricsAvailable.impressions: best !== null || feed.metricsAvailable.impressions === true
```

### 3.4 Scraper: KEEP, demote to last rung

Not redundant, for two verified reasons:

- **It measures a different quantity.** `post_media_view` (276) ≠ `post_video_views` (163). The
  scraper's value was being written into the `impressions` slot when it is really a view count.
- **It is the only token-free recovery path**, and that is test-locked:
  [facebook-external-video-analytics.test.ts:230-261](../packages/social/src/__tests__/facebook-external-video-analytics.test.ts#L230)
  proves that when both Graph calls fail `190/460`, the scrape still yields
  `impressions: true`. Given ~49% dead tokens, that path carries real coverage.

**Demote it:** fire only when the API produced no positive view figure for that post.

1. **🔴 Predicate on a POSITIVE COUNT, not a declaration.** Use `(feed.impressions ?? 0) > 0`,
   **not** `feed.metricsAvailable.impressions === true`. Presence of a `post_media_view` row is
   not evidence of a usable number.
2. **🔴 Make the skip an EARLY `return feed;`** before the videoId block at
   [:668-686](../packages/social/src/providers/facebook.provider.ts#L668). A fall-through hits the
   merge at :730/:736 and clobbers the good value back to a declared-unavailable 0.
3. Keep `EXTERNAL_VIEW_SCRAPE_ENABLED`. Do not delete it.
4. Gate the second, currently un-budgeted scrape call site in `getVideoAnalytics` (which runs
   inside the publish job) behind an opt defaulting **off**.

### 3.5 🔴 Do NOT touch `CAPS.FACEBOOK.unavailable` — unanimous

`platform-metrics.ts` keeps `FACEBOOK: { …, unavailable: ["impressions","reach"] }`
**byte-identical**. Capability widens **only** via per-capture `metricsAvailable`. Verified
precedence: `gatePostReportRow` short-circuits on `key in declared` (analytics.router.ts:339)
before the static map at :364; `effectiveChannelUnavailable` returns available on
`declared === true` (platform-metrics.ts:191) before the legacy branch at :210.

Dropping the CAPS entries would fabricate a `0` for every legacy metadata-less capture. This is
exactly PR #148's mistake.

`requiresExplicitDeclaration` stays `{FACEBOOK:["shares"]}` and stays **out of**
`effectiveChannelUnavailable` (prod incident 2026-08-07 blanked whole channels).

Also correct a now-false comment: the file says impressions/reach are "deleted by Meta
(permanent)". They are renamed. Leaving that comment invites someone to re-derive the wrong
conclusion.

### 3.6 🔴 `SUM(reach)` across posts is NOT reach

`post_total_media_view_unique` is unique **per post** (3 / 106 / 1 / 255 / 36). Summing it across
a channel's posts counts the same person once per post they saw.
[analytics.router.ts:189](../packages/api/src/routers/analytics.router.ts#L189)
(`COALESCE(SUM(reach),0)`) feeds the **"Total Reach"** card
([analytics/page.tsx:238](../apps/web/app/dashboard/analytics/page.tsx#L238)).

Facebook is the first platform where this becomes a large, confidently-wrong number. Options, in
preference order:

1. Relabel the card/column to **"Reach (sum of per-post reach)"** with a footnote — cheapest,
   honest.
2. Report reach only at per-post granularity and drop the channel/org aggregate.
3. Build a real page-level path using `page_total_media_view_unique`. **The repo has no
   page-level insights code at all** — zero hits for any `/insights?metric=page…` call. That is
   a separate feature, not part of this change.

**Do not ship the new reach value into an unlabelled `SUM` card.** Pick 1 or 2 in this PR.

Related minor, same query: `impressionedPosts` is `COUNT(*) FILTER(…)` (:198) while `posts` is
`COUNT(DISTINCT post_key)` (:186), so the newly-visible `(n/m)` basis chip can print a numerator
above its denominator when one post has two snapshots. Fix both to `COUNT(DISTINCT …)`.

### 3.7 Engagement rate — quantify before enabling

Feed posts gain a real denominator, so they enter the pooling in
[engagement-rate.ts](../packages/api/src/lib/engagement-rate.ts). Two consequences:

- Channels currently showing `—` will show a real rate; `(1/N)` basis chips appear.
- **The `rate_impossible` rule may start firing legitimately.** A photo with
  `post_media_view = 14` and 20 reactions is real, not impossible — reactions can exceed
  impressions when a post is shared onward. With `impressions` as low as 3–14 on photos and
  statuses, this is not hypothetical.

**✅ MEASURED 2026-08-11 (n=120 live prod posts) — the risk is nil:**

```
impressions == 0             : 0    (renders "—", no rate either way)
low base (0 < impr < 50)     : 50   (renders WITH a low-base chip, NOT suppressed)
interactions > impressions   : 0    => 0.0% would be suppressed
by mediaType                 : video 0/112, album 0/8
```

No remedy needed; `rate_impossible` stays as-is. The reason it fired before and cannot now: the
`200%`/`1400%` incidents divided a numerator and denominator drawn from **different sources**
(reactions from the insights edge over one video's view count). Both sides now come from the same
post's own metrics, and `post_media_view` is by construction ≥ any single interaction count. The
50 low-base rows render *with* a disclosure chip rather than being hidden — the honest middle
ground, not suppression.

⚠️ The sample is video-heavy (112/120) because that is the population. Re-check after the
non-video-first backfill ordering has measured a few thousand photo/album/status rows.

---

## 4. Backfill strategy

### The population, measured

| Bucket | Rows | Note |
|---|---|---|
| FB `ExternalPost` total | **55,617** | **all** published 2026-08-01 or later (product floor) |
| `mediaType=video` | 52,076 | 52,014 are reels |
| album / photo / status / link | 2,644 / 868 / 21 / 8 | have **nothing** today |
| declaring `reach: true` | **0** | aggregate correctly stays `—` until re-measured |
| declaring `impressions: true` | 7,117 | all video, all `metricsSource=scrape` |
| **`source=api` with `impressions=0`** | **29,833** | ← the bucket Deploy 1 moves |
| never measured (`metricsSyncedAt IS NULL`) | 15,126 | picked up by the normal sweep |
| Live (non-orphan) FB `AnalyticsSnapshot` | **612 rows / 42 targets** | app-published side is tiny |
| Orphan snapshots | 1,324,190 | the janitor's population, unrelated |

Two facts make this cheap: **every row is inside one month** (no deep-history problem), and the
metrics pass **already makes this exact call** — adding names costs **zero extra Graph calls**.

### The mechanism: no new job, no new column

Drive it entirely through the existing external-sync metrics pass:

- Add one env-gated **recapture floor** to `needsMetrics` in
  [external-post-sync.worker.ts:107-114](../apps/worker/src/workers/external-post-sync.worker.ts#L107):
  `EXTERNAL_RECAPTURE_BEFORE=<ISO timestamp>` — a row whose `metricsSyncedAt` predates the floor
  is eligible again. **`metricsSyncedAt` is the self-clearing progress marker** — no new column,
  no new state to reconcile, and the sweep converges monotonically.
- Ordering: prefer **non-video first** (2,672 rows that have *nothing* today, and they are cheap),
  then `source=api, impressions=0` (29,833), then the scraped 7,081 (which already show a number).
- Unset the floor when the sweep is clean; it is idempotent and re-runnable.
- **App-published side needs no backfill job**: 42 live targets, and
  `availabilityChanged` ([snapshot-dedup.ts:57-67](../apps/worker/src/lib/snapshot-dedup.ts#L57))
  forces a corrective snapshot when the capability claim changes even with identical numbers. A
  single one-shot FB analytics-sync enqueue over those 42 targets is enough if you want it
  immediate.

### 🔴 The rollback asymmetry — state it plainly

`AnalyticsSnapshot` is append-only, so a flag flip converges there. **`ExternalPost` metrics are
an in-place `updateMany`** ([:383-397](../apps/worker/src/workers/external-post-sync.worker.ts#L383))
with no history column:

- The 7,117 scraper-recovered values are **overwritten** the first time the new path writes.
  Flipping the flag does **not** restore them.
- The write bumps `metricsSyncedAt`, and `needsMetrics` then defers by age (6h / 24h / 7d), so
  post-rollback convergence for older rows is up to **a week**, not one sweep.

Mitigation: the MAX-preferring merge (§3.3) means the stored number can only go **up**, so an
overwrite is an improvement, not a loss (measured: 6,421 → 83,582). Accept and document, or add
a `metricsPrevious` jsonb if the exact prior values must be recoverable.

### Throughput

`EXTERNAL_METRICS_PER_RUN=150`, 4 shards, 2h cron. Metrics cost 2 Graph calls/post and this
change adds **none**. Zero true rate-limit errors were observed across 3,067 sync runs, so Meta
is not the constraint — the 4-core box is. Do not raise concurrency as part of this work.

---

## 5. Gaps found by the completeness critic — fix or explicitly accept

| # | Gap | Location | Action |
|---|---|---|---|
| **P0-1** | A successful **listing** stamps `insightsHealth: ok`, but `/published_posts` needs none of the insight scopes — so a channel that cannot read insights is marked healthy every 2h, clearing the reconnect banner this plan's coverage depends on. `healthVerdictChanged` also returns false for a repeated identical verdict, so `checkedAt` never refreshes. | [external-post-sync.worker.ts:167-169](../apps/worker/src/workers/external-post-sync.worker.ts#L167) · [channel-insights-health.ts:79-91](../apps/worker/src/lib/channel-insights-health.ts#L79) | **Fix in this PR.** Listing success must not produce a positive insights verdict. |
| **P0-2** | No test proves the health verdict survives a rung descent. Dangerous combo: rung 1 `#100` + rung 2 `200 {"data":[]}` — if rung 1's diagnosis wins, a genuinely under-scoped token reads as a name problem. And total exhaustion returns `no_data`, which `deriveInsightsHealth` maps to **"ok"**. | [facebook.provider.ts:540-545](../packages/social/src/providers/facebook.provider.ts#L540) · [meta-insight-diagnosis.ts:105-107](../packages/social/src/utils/meta-insight-diagnosis.ts#L105) | **Fix + test in this PR.** Assert `degraded.reason === "missing_scope"`, `missingScopes === ["read_insights"]`. |
| **P1-3** | `analytics.emailReport` **hardcodes** all 15 CSV columns incl. `"Views/Impressions"`, `"Reach"` — unlike `ReportsTab`, which filters through `reportableMetrics`. Same procedure family, two answers. | [analytics.router.ts:1421-1456](../packages/api/src/routers/analytics.router.ts#L1421) | Fix in this PR — build header+rows from one filtered list so indexes cannot drift. |
| **P1-4** | Rollback asymmetry (in-place `updateMany`). | §4 above | Documented; mitigated by MAX merge. |
| **P1-5** | Concern that Deploy 1 delivers little because the deferral guard runs before any Graph call. | [:344-350](../apps/worker/src/workers/external-post-sync.worker.ts#L344) | **Resolved by measurement:** 29,833 `api/impressions=0` + 15,126 unmeasured = 44,959 rows in scope. |
| **P1-6** | FB is excluded from **both** periodic analytics crons, so an app-published FB post's t≈0 publish snapshot ("0 views, available") stands for up to 24h. | [cron-jobs.ts:249](../apps/worker/src/scheduler/cron-jobs.ts#L249), [:308](../apps/worker/src/scheduler/cron-jobs.ts#L308) | Decide explicitly: suppress availability at step 4b for very young captures, **or** accept and document. Self-corrects at the 24h checkpoint. |
| **P2-7** | `chat.router.ts get_analytics` is a **second, ungated** aggregate — no `metricsAvailable` gate, no `ExternalPost` union, no date window, `MAX()` instead of `DISTINCT ON`. CLAUDE.md claims it agrees with the dashboard; it already doesn't, and will diverge materially once FB impressions become real. | [chat.router.ts:979-1009](../packages/api/src/routers/chat.router.ts#L979) | Follow-up PR. Note it in CLAUDE.md now so the claim stops being asserted. |
| **P2-8** | The only suite covering the availability SQL is `describe.skipIf(!LIVE_E2E)` — never runs in a normal test pass. | [insights-availability-sql.e2e.test.ts:178](../packages/api/src/__tests__/insights-availability-sql.e2e.test.ts#L178) | **Make running it a checklist gate** — it is the only executable proof the aggregate half works. |
| **P2-9** | `SUM(reach)` is not reach. | §3.6 | Fix in this PR (relabel or drop the aggregate). |
| **P2-10** | `getFeedPostAnalytics`'s insights call passes **no `pageId`**, so its per-page quota is untracked — unlike :671/:702. | [facebook.provider.ts:520](../packages/social/src/providers/facebook.provider.ts#L520) | Pass `pageId` where available; low risk, real observability win. |

---

## 6. Sequencing

**Deploy 0 — measurement only, no code.**
Run the `interactions > post_media_view` count for §3.7. If material, decide the
`rate_impossible` remedy before enabling anything.

**Deploy 1 — provider + honesty, flag OFF.**
Ladder (§3.2), lifetime selection (§2), MAX merge (§3.3), scraper demotion (§3.4), P0-1, P0-2,
P2-9/§3.6, P1-3, P2-10, comment corrections. Ships inert behind
`FB_MEDIA_VIEW_METRICS_ENABLED=false`.

> ⚠️ **The flag must be named in `docker-compose.prod.yml`'s worker `environment:` map, not just
> written into `.env.prod`.** That file uses an explicit allowlist, not `env_file:` — an
> unplumbed key arrives as an **empty string**, and a fail-open `!== "false"` check then reads it
> as ENABLED. This exact trap shipped the FB scraper live for ~1h on 2026-08-08 (PR #166).
> Default the compose value to the **safe** side.

**Deploy 2 — enable on a canary.** Flip the flag; watch a handful of channels; verify the guard
queries in §7 including the new reach guards.

**Deploy 3 — backfill.** Set `EXTERNAL_RECAPTURE_BEFORE`, non-video first. Unset when clean.

---

## 7. Guard queries (extend the existing set)

```sql
-- Existing guards must stay 0.
SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND impressions=0 AND ("metricsAvailable"->>'impressions')='true';
SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND ("metricsAvailable"->>'impressions')='true'
  AND ("metricsAvailable"->>'shares') IS NULL;

-- NEW: the duplicate-period trap. reach declared available but 0 => the lifetime
-- selection is broken and the `day` row won. MUST be 0.
SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND reach=0 AND ("metricsAvailable"->>'reach')='true';

-- NEW: impressions must never be below reach.
SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND reach>0 AND impressions>0 AND impressions<reach;

-- NEW: the MAX merge must never lower a previously-recovered value.
-- Snapshot `impressions` per id before Deploy 3 and diff after; expect no decreases.

-- Progress. Before: impressions>0 = 7117 (video only), reach>0 = 0.
SELECT COALESCE("mediaType",'(null)') t, count(*),
       count(*) FILTER (WHERE impressions>0) impr_gt0,
       count(*) FILTER (WHERE reach>0)       reach_gt0
FROM "ExternalPost" WHERE platform='FACEBOOK' GROUP BY 1 ORDER BY 2 DESC;

-- Feed metrics must NOT regress (2026-08-11 baseline):
--   clicks 26762 · shares 10458 · comments 8943 · likes 25951
```

---

## 8. Hard rules

- **Do NOT edit `CAPS.FACEBOOK.unavailable`** (§3.5). That was PR #148.
- **Do NOT apply `requiresExplicitDeclaration` inside `effectiveChannelUnavailable`** — per-row
  only (prod incident 2026-08-07).
- **Do NOT return fewer than all six `metricsAvailable` keys.**
- **Do NOT add a round-trip to `getFeedPostAnalytics`'s happy path** — the ladder's second call
  fires only on a name error.
- **Do NOT descend a rung on a 200-with-zero-rows** — that is the missing-scope sentinel.
- **Do NOT treat every `#100` as a bad metric name** — require subcode ≠ 33 and the message
  signature.
- **Do NOT read a metric without selecting `period === "lifetime"`.**
- **Do NOT re-add any `post_impressions*` / `post_views` name** — one invalid name 400s the whole
  call.
- **Do NOT retire the reel scraper** — it is the only token-free path, test-locked, and ~49% of
  tokens are dead.
- Owner's standing constraint: **"the posting process works — do NOT break it."**

---

## 9. Probe scripts

Reusable, read-only, run via
`docker cp <f> postautomation-worker-1:/app/apps/worker/ && docker exec … tsx apps/worker/<f>`:
`probe-media-view.ts` (name discovery), `probe-sweep.ts` (36×5 matrix), `probe-combined.ts`
(all-or-nothing safety), `probe-dupes.ts` (**the period trap**), `probe-videonode.ts`
(post vs Video node), `probe-perms.ts` (`debug_token` scopes), `probe-reels-scale.ts`
(25-reel validation + population split). Session scratchpad:
`/private/tmp/claude-501/-Users-tabish-Desktop-Dashmani-PostAutomation/0e614fad-1071-4798-b7cd-d5c798e69c6b/scratchpad/`.
