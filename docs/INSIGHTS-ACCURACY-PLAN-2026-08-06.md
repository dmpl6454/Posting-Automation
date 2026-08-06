# Insights accuracy: engagement-rate correctness, post-count transparency, non-destructive disconnect

**Date:** 2026-08-06
**Goal (owner):** end-to-end accurate Insights. **Accuracy is uncompromised** — where a number
cannot be made truthful, it must not be shown as a number.

Everything marked **MEASURED** was reconciled against the live production Graph API or prod SQL.

---

## 1. "Bollywood shows 10 posts but Facebook shows 13" — reconciled exactly

**MEASURED** by enumerating the Page's `published_posts` edge and diffing against our
`PostTarget` rows:

| | Bollywood | Contents of bollywood |
|---|---|---|
| Facebook `published_posts` reports | **13** | **12** |
| our DB published targets | **10** | **7** |
| id-matched in both | 8 | 6 |
| only on Facebook | 5 | 6 |
| only in our DB | 2 | 1 |

The arithmetic closes on both sides: `8 + 5 = 13` and `8 + 2 = 10`.

**Neither number is wrong — they count different things.** Facebook counts everything on the
Page. We count only what was published *through PostAutomation*, inside the selected window.
The gap is posts made directly on Facebook (5 and 6 respectively, all on dates where the app
also posted — i.e. the operator posted natively as well).

⚠️ **Caveat on "only in our DB", found while verifying:** these are **video** posts. Video
publishes store a bare Video-node id (e.g. `2285901422221783`) while `published_posts` returns
`{page}_{post}` ids, so they cannot be id-matched at all. One of the two (`2285901422221783`)
is demonstrably still live — the reel scraper returned 57 views for it in the same run. Only
`1748002179986936` is genuinely deleted (`Object with ID does not exist`). So the honest
classification is: ~1 genuinely deleted, ~1 unmatched-by-id-shape.

**Conclusion: this is a labelling problem, not a data problem.** A column headed "Posts" next
to a channel name invites comparison with the Page's own count. Fix = make the column say what
it counts.

---

## 2. 🔴 Engagement rate is producing nonsense — a real accuracy bug

The screenshot shows **`Contents of bollywood — Eng. Rate 1400.00%`**.

**Root cause (MEASURED):** the channel rate sums the **numerator over every post** but the
**denominator only from posts that reported impressions**. On Facebook, the only posts with an
impression figure are *videos* (via `total_video_views` or the reel scraper) — so a channel's
entire reaction count is divided by one video's view count.

| Channel | snapshots | of which impressioned | Σ impressions | Σ engagement | **shown now** | **correct** |
|---|---|---|---|---|---|---|
| Bollywood | 10 | 1 | 57 | 5 | **8.77%** | **7.02%** |
| Contents of bollywood | 7 | 1 | 1 | 14 | **1400.00%** | **200.00%** |
| Group "fb" | — | 2 channels | 58 | 19 | **32.76%** | **~10.34%** |

The correct pooling rule **already exists and is documented** in
[engagement-rate.ts](packages/api/src/lib/engagement-rate.ts) (`computeEngagementRate`: only
rows WITH impressions contribute to *both* sides). `analytics.engagement` uses it.
`perChannelStats` and `groupStats` never did — they compute the rate inline from raw channel
sums. `group-stats.ts` `rateFromRows` pools at *channel* granularity, which inherits the same
inflated numerator one level up.

**⚠️ Even the "correct" 200% is not a number worth printing on its own.** It is arithmetically
right (2 reactions ÷ 1 view) but it describes *one video*, not the channel — and it mixes a
**scraped** view count with **API** reaction counts. So pooling is necessary but not sufficient:
the rate must also disclose how narrow its base is.

---

## 3. 🔴 Disconnect destroys history — and has already destroyed a lot

`PostTarget.channel` is `onDelete: Cascade` and `channel.disconnect` / `bulkDisconnect` do a
hard `delete`. Consequences, **MEASURED on prod**:

- **329 PUBLISHED + 1262 FAILED + 91 DRAFT** posts already have zero targets.
- **1,324,188 Facebook + 2,953 Instagram + 487 Twitter + 70 YouTube orphaned
  `AnalyticsSnapshot` rows** — `AnalyticsSnapshot` has **no FK** to `PostTarget` (bare
  `postTargetId`, indexes only), so nothing ever cleans them up. That engagement history exists
  in the database and is permanently unreachable by any query.
- 111 `channel.disconnected` audit entries landed in one 14-minute window during the owner's
  reconnect session — i.e. some of the "missing history" was destroyed by the reconnect flow
  itself.

Owner has approved both remedies.

---

## 4. Plan

### P1 — Engagement-rate correctness (highest priority: visible nonsense)
- `fetchChannelStatRows`: add impressioned-only aggregates via
  `SUM(...) FILTER (WHERE s.impressions > 0)` — impressions, likes, comments, shares, plus a
  count of impressioned posts.
- `perChannelStats`: compute the rate from those, not from the raw sums.
- `group-stats.ts`: pool from the impressioned-only fields so the group rate stops inheriting
  the inflated numerator.
- **Disclose the base.** Return `engagementRateBasis = { impressionedPosts, totalPosts }` and
  render e.g. `7.02% (1 of 10 posts)`. A rate derived from one post must not read as the
  channel's overall rate.
- Render **"—"**, never `0.00%`, when no post reported impressions.

### P2 — Post-count transparency
- Header becomes **"Posts sent"** with a tooltip, and the footnote explains: counts posts
  published *through PostAutomation* in the selected range; the platform's own total also
  includes posts made directly there and posts outside the range.

### P3 — Non-destructive disconnect (soft delete)
Schema: **`Channel.disconnectedAt DateTime?`** (nullable ⇒ additive, safe for `db push`).

Three states, unambiguous:

| State | `isActive` | `disconnectedAt` | Postable | Channels page | Insights |
|---|---|---|---|---|---|
| Connected | `true` | `null` | ✅ | ✅ | ✅ |
| Paused | `false` | `null` | ❌ | ✅ badge *Paused* | ✅ history |
| Disconnected | `false` | set | ❌ | hidden | ✅ history, badge *Disconnected* |

- `disconnect` / `bulkDisconnect`: set `disconnectedAt`, `isActive = false`, and **clear the
  stored tokens** (a disconnected channel must not retain live credentials). Rows and all
  `PostTarget`s are preserved.
- **Reconnect revives the same row** — the OAuth callback already upserts on
  `(organizationId, platform, platformId)`, so clearing `disconnectedAt` there preserves history
  *and* stops the duplicate-channel proliferation seen today (the same IG account currently
  exists in 6 orgs / repeated rows after disconnect→reconnect).
- **Posting guard:** `post.create` currently filters channels by `organizationId` only — no
  `isActive` check — so a disconnected channel could be targeted with an empty token. Add
  `disconnectedAt: null` to every channel-ownership query that writes targets.
- **Insights inclusion:** the stat aggregate currently `INNER JOIN … c."isActive" = true`, which
  is why disconnecting made history vanish. Include any channel that *has published history in
  the window*, and surface its status per row.
  ⚠️ **Consequence to state plainly:** org totals may *rise*, because real engagement on paused
  and disconnected channels now counts. That is the more accurate figure — a post that was
  published and did earn engagement is a historical fact regardless of the channel's later
  state — but it is a visible change, so it must be called out rather than slipped in.
- Confirm-dialog copy reverts to non-alarming (it is no longer destructive).

### P4 — Orphaned-snapshot cleanup
- Daily cron, batched `DELETE` via a `LIMIT`ed CTE, hard-capped per run so ~1.33M rows drain
  over days without long locks on a 4-core box. Logs how many remain.
- Soft delete stops *channel*-driven orphaning, but post deletion (`bulk.bulkDelete`,
  `post.delete`) still cascades targets, so the cron is a permanent janitor, not a one-off.
- **Deferred:** adding a real FK on `AnalyticsSnapshot.postTargetId`. It is the structural fix
  but needs the table clean first and would take a lock on a 1.3M-row table. Document, schedule
  separately.

### P5 — Verification
1. Unit tests: rate pooling (incl. the 1400% and 200% cases), basis disclosure, soft-delete
   guards, cleanup batching.
2. Real-Postgres e2e for the new `FILTER` aggregates and the history-inclusion join.
3. `pnpm test`, `pnpm type-check`, and the **Next build** (tsc alone is insufficient for web).
4. Live prod re-verify: karan's channels show 7.02% / 200% with an explicit base, and the
   post-count copy matches the reconciliation above.
5. Browser check of Channel Performance + Group Performance.
6. Deploy, then confirm the cleanup cron actually reduces the orphan count (assert output — a
   cron that "runs" and does nothing looks identical to one that works).

---

## 5. Explicitly out of scope
- Showing posts made **directly** on the platform. Insights read the app's own post records;
  ingesting the Page feed would be a new feature and was declared out of scope to Meta in the
  App Review submission (data minimisation).
- Re-associating the 1.33M orphaned snapshots. Their `PostTarget` is gone, so any mapping would
  be invented provenance. They are deleted, not resurrected.
- Backfilling pre-permission zeros. Those captures are correctly marked unavailable and render
  "—"; past 90 days the platform no longer returns fresh figures anyway.
