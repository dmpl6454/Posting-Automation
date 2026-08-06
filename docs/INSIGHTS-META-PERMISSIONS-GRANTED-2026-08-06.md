# Insights after the Meta insight-permission approval — audit, plan, verification

**Date:** 2026-08-06
**Trigger:** Meta App Review approved the three analytics-read permissions requested on
2026-07-24 — `pages_read_user_content`, `read_insights`, `instagram_manage_insights`
(dashboard: *New requests* = **Approved**; the 8 pre-existing scopes = **Renewed**).

Everything below marked **VERIFIED** was probed live against the production Graph API
from inside `postautomation-worker-1` using real decrypted channel tokens. Nothing here
is inferred from the dashboard alone — the app-role trap (see CLAUDE.md) means an
"it works for admin" test proves nothing about external users.

---

## 1. Ground truth established by live probing

### 1.1 FB post impressions/reach are DELETED — `read_insights` does **not** restore them

Probed every impressions/reach variant individually on a real published FB Page post
using a token that **has `read_insights` granted** (channel `Demo Test`):

| Metric | Result |
|---|---|
| `post_impressions`, `_unique`, `_organic`, `_organic_unique`, `_paid`, `_fan` | ❌ `#100 The value must be a valid insights metric` |
| `post_engaged_users`, `post_negative_feedback`, `post_clicks_unique` | ❌ `#100` |
| `post_reach`, `post_views`, `post_activity`, `post_activity_unique` | ❌ `#100` |
| `post_clicks` | ✅ real row |
| `post_reactions_by_type_total` | ✅ real row (object `{}` when no reactions) |
| `post_reactions_like_total` | ✅ real row |
| `post_video_views`, `_organic`, `_unique`, `post_video_complete_views_organic` | ✅ real rows |
| `post_engagements`, `post_video_avg_time_watched`, `post_video_view_time`, `blue_reels_play_count` | ⚠️ valid NAME but returns **zero data rows** on a photo post |

**Conclusion (VERIFIED, stronger than the 2026-07-23 sweep):** the earlier finding was
correct, and the "maybe #100 was really a permission error" hypothesis is now **refuted** —
the same token that gets `#100` on all nine `post_impressions*` variants gets accepted rows
for `post_clicks`. A missing permission cannot validate one metric name and reject another.

➡️ **FB impressions + reach must stay `—` permanently. Do NOT re-add `post_impressions*`,
`post_engaged_users`, `post_reach`, `post_views` or `post_activity*`.** `read_insights`
restores only the *values* of clicks / video views / reactions.

### 1.2 Missing `read_insights` is a SILENT EMPTY, not an error — the core data bug

| Token | FB feed `/insights?metric=post_clicks,post_video_views,post_reactions_by_type_total` |
|---|---|
| **without** `read_insights` | HTTP **200 OK** + `{"data":[]}` — zero rows, no error |
| **with** `read_insights` | HTTP 200 + **4 rows** with real values |

The FB *video* path fails loudly instead: `/video_insights` → `#200 read_insights permission missing`.

The current provider treats an empty `data` array as "all metrics are zero" and stores
`clicks: 0`, reactions `0` **without** declaring them unavailable. Reports and Channel
Performance therefore render a confident `0` that is indistinguishable from genuine zero
engagement. This is the single most important correctness bug this change fixes.

Reliable discriminator (VERIFIED): `post_clicks` and `post_reactions_by_type_total`
**always** return a row when permitted — even on a zero-engagement post. So
**HTTP 200 with zero rows ⇒ insights not permitted.**

### 1.3 FB fields (`pages_read_user_content`)

| Token | `?fields=reactions.summary(true),comments.summary(true),shares` |
|---|---|
| **without** the scope | ❌ `#10 This endpoint requires the 'pages_read_user_content' permission` |
| **with** the scope | ✅ real summaries — one probed post returned an actual reaction (`type: LIKE`) |

`shares` alone resolves on a basic Page token (the existing isolation fallback is correct).

### 1.4 IG metric sets are per-`media_product_type` and MUTUALLY EXCLUSIVE

Probed individually per product type with `instagram_manage_insights` granted:

| Product type | VERIFIED-valid metrics |
|---|---|
| FEED / CAROUSEL_ALBUM | `reach, saved, shares, views, likes, comments, total_interactions,` **`profile_visits, profile_activity, follows`** |
| REELS | `reach, saved, shares, views, likes, comments, total_interactions,` **`ig_reels_avg_watch_time, ig_reels_video_view_total_time`** |
| STORY | `reach, shares, views, total_interactions, replies, navigation` |

**⚠️ TRAP — the obvious change breaks Reels.** `profile_visits` / `profile_activity` /
`follows` are **NOT supported for REELS**; adding them to a shared metric set makes the
combined REELS call fail entirely (VERIFIED: `ok=false`,
`#100 does not support the profile_visits, profile_activity, follows metric for this
media product type`) — zeroing *every* metric for that Reel. This is the identical
all-or-nothing failure mode PR #148 already fixed once. **Keep the sets strictly
per-product-type; never union them.**

Still invalid, do not re-add: `impressions` (*"no longer supported from v22.0"*), `plays`,
`engagement`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `video_views`.

Real non-zero sample (Reel `17900362803522250`):
`reach=106, views=115, saved=1, total_interactions=1, ig_reels_avg_watch_time=3038ms,
ig_reels_video_view_total_time=328109ms`.

### 1.5 Meta serves **v20.0** for our `v18.0` requests

The `paging` URLs Meta echoes back are `https://graph.facebook.com/v20.0/…` while both
providers pin `apiVersion = "v18.0"`. We are being silently auto-upgraded, which is why an
IG error could cite a v22.0 removal.

**Deliberately NOT changed here.** Bumping the version alters the frozen publish path
("the posting process works — do NOT break it"), and current behavior is correct.
Recorded as a known risk to schedule separately.

### 1.6 Token health — the dominant operational blocker

`debug_token` audit over all **1328** active FB/IG channels:

| | FACEBOOK | INSTAGRAM |
|---|---|---|
| active channels | 966 | 362 |
| token **valid** (firm lower bound) | 142 | 93 |
| of those, holding all 3 new scopes | 136 | 93 |
| channels with ≥1 published post | 10 | 64 |
| **valid token + new scopes + published posts** | **1** | **1** |

Dead-token reasons: `497 ×` *"App_id in the input_token did not match the Viewing App"*
(tokens minted by a different/older Meta app — permanently unusable), `216 ×` session
invalidated (the classic post-config-change invalidation).

> ⚠️ **Self-correction on this sweep:** `302 FB + 77 IG` rows returned `#4 Application
> request limit reached` — that is the *probe* exhausting Meta's app-level quota, not a
> token verdict. Those ~379 are **indeterminate**; "824 dead" is an upper bound and the
> valid counts are a lower bound. The shape of the conclusion is unaffected.

**An App Review approval does not retro-add scopes to already-issued tokens.** Scopes are
granted only at consent time. So the newly-approved permissions reach a channel only when
its owner **reconnects**. Today the app gives the user no way to know this: a dead or
under-scoped token renders as `0` / `—`, identical to genuine zero engagement.

---

## 2. What Insights does today (as-built)

```
analytics-sync.worker
  → provider.getPostAnalytics(tokens, platformPostId)
  → shouldWriteSnapshot()            (dedup: skip if no metric changed; checkpoints always write)
  → AnalyticsSnapshot row            (6 metric cols + engagementRate + metadata JSON)
       metadata = buildSnapshotMetadata(): saved, reachIsDistinct, likeKind,
                                           metricsAvailable, source, windowTag, capturedLate
  → read paths
```

| Read path | UI surface | Honesty gating |
|---|---|---|
| `analytics.postReports` | Reports tab, CSV, emailed report | static map **+ per-snapshot `metricsAvailable`** (`gatePostReportRow`) ✅ |
| `analytics.perChannelStats` | Channel Performance table | **static map only** ❌ |
| `analytics.groupStats` | Group Performance card | **static map only** ❌ |
| `analytics.engagement` / `overview` / `platformBreakdown` | headline cards | raw sums, no gating |

Sync triggers: 6-hourly cron (**excludes FB** for quota), daily long-tail 7–90d (non-FB),
at-age checkpoints 24h/7d/15d/30d (**includes FB**), and manual `triggerSync` ("Sync Now").

---

## 3. Defects to fix

| # | Severity | Defect |
|---|---|---|
| **P0** | 🔴 | **Token/scope health is invisible.** Only 1 FB + 1 IG channel can serve insights at all; the rest need a reconnect and the UI never says so. Zeros are indistinguishable from dead tokens. |
| **P1** | 🔴 | **FB silent-empty stored as real zeros** (§1.2). `metricsAvailable` omits `clicks`, so the gate treats it as available and prints `0`. |
| **P2** | 🟠 | **IG partial success marks everything available.** `hasInsights = metrics.reach != null \|\| impressions > 0` — if the product-type set fails and only the `reach` retry succeeds, impressions/shares are declared available while never returned. |
| **P3** | 🟠 | **Newly-unlocked IG metrics unused**: `profile_visits`, `profile_activity`, `follows` (FEED/CAROUSEL); `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time` (REELS). |
| **P4** | 🟠 | **Aggregates ignore per-snapshot metadata.** `perChannelStats`/`groupStats` use the static map only ⇒ real FB **video** views (`total_video_views` → impressions slot) render `—` in Channel Performance while Reports shows them. Half-fixed PR #148 regression. |
| **P5** | 🟡 | **FB video path returns `null` when the fields call fails**, discarding successfully-fetched `video_insights`; and the reel-scraper fires on a *legitimate* 0 views instead of on unavailability. |
| **P6** | 🟡 | FB feed `engagementRate` hardcoded `0`. Honest (no impressions ⇒ no rate) but undocumented. |

### Explicitly NOT defects — do not "fix"
- FB impressions/reach `—` (§1.1, platform-level deletion).
- IG `clicks` always `—` (IG has no click metric).
- `post_engagements` returning no rows (valid name, no data — don't depend on it).
- Reports `Eng.%` being `—` for FB (recomputed as `÷ impressions`, which is unavailable).

---

## 4. Plan

### Module A — Providers (`packages/social`)
- **A1** FB feed: treat *HTTP 200 + zero rows* as **insights unavailable** → declare
  `metricsAvailable.clicks = false` and do not trust insights-derived reactions.
  Keep the request set to the verified-valid three.
- **A2** FB fields: classify `#10` / `#200` as a permission failure and declare
  `comments`/`likes` availability accordingly (keep the best-effort, never-fatal shape).
- **A3** FB video: never return `null` when only the *fields* call fails; scrape only when
  insights were **unavailable** (permission error / zero rows), not on a legitimate 0;
  declare `impressions` availability honestly per capture.
- **A4** IG: per-product-type metric sets including the new metrics (never unioned);
  derive `metricsAvailable` from **actual per-metric presence**; carry Reels watch-time.

### Module B — Honesty plumbing (`packages/api`, `apps/worker`)
- **B1** Extend `SocialAnalytics` + `buildSnapshotMetadata` with the new optional fields.
- **B2** `fetchChannelStatRows`: aggregate declared availability per metric alongside the sums.
- **B3** `perChannelStats` / `groupStats`: merge declared availability with the static map,
  using the same precedence as `gatePostReportRow`.

### Module C — Channel insights health (the P0 fix)
Derive health from the Graph calls the pipeline **already makes** — no new external quota,
no new cron, and coverage exactly where insights matter (channels with published posts):
- providers report a structured degradation reason;
- the sync worker persists it to `Channel.metadata.insightsHealth`;
- a tRPC read exposes it (pure DB read — no N+1 over 900 channels).

### Module D — UI
- Insights banner: "N channels need reconnecting to restore Insights" → Channels page.
- Channel Performance: per-row *Reconnect* affordance; `—` semantics preserved.
- Surface the newly-available IG data (saves / Reels watch time).

### Module E — Verification
1. Unit tests for all pure logic (metric-set selection, availability derivation, gating).
2. `pnpm test`, `pnpm type-check`, and the **Next build** (per the standing rule that
   `tsc` alone is insufficient for `apps/web`).
3. Live provider run in the prod worker against the two golden channels **and** the real
   Reel with non-zero data (`reach=106, views=115, saved=1`).
4. Real analytics-sync run → dump `AnalyticsSnapshot` rows + metadata via SQL.
5. tRPC `createCaller` against real Postgres → confirm the UI-facing shape.
6. Browser check of the Insights page.

---

## 5. Operational follow-up (owner action, not code)

The code changes make Insights *correct*; they cannot conjure scopes onto issued tokens.
To actually populate FB/IG insights at scale, channel owners must **reconnect** once.
Module C is what makes that need visible and actionable in-product.
