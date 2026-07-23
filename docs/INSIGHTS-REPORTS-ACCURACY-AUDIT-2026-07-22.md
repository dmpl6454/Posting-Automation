# Insights + Reports Data-Accuracy Audit — 2026-07-22

## ✅ DEFINITIVE ADMIN-vs-EXTERNAL TEST — 2026-07-23 (the authoritative answer; supersedes all earlier claims)

Tested the SAME FB API calls with BOTH an admin token (`tabish@dashmani.com` / Page "ENT News") and a **genuinely external** token (`karankumar1166dt@gmail.com` / Page "Bollywood", reconnected 11:29) — the natural experiment that removes the app-role bias.

**RESULT — external FB user, per-call (live):**
| FB read (what our code uses) | Admin | External | Permission needed for external |
|---|---|---|---|
| `reactions.summary` (→ our "likes") | 200 | **🔴 400** | **`pages_read_user_content`** — NOT requested, NOT held |
| `comments.summary` (→ our "comments") | 200 | **🔴 400** | **`pages_read_user_content`** — NOT requested, NOT held |
| `shares` | 200 | ✅ 200 | (page token) |
| `likes.summary` | 200 | 🔴 400 | `pages_read_engagement` (held) — but code uses `reactions.summary`, not this |
| insights `post_clicks` / `post_reactions_by_type_total` / `post_reactions_like_total` / `post_engagements` / `post_video_views` | 200 | ✅ **200** | works on current perms |
| `/comments` + `/likes` EDGES | 200 | 🔴 400 | `pages_read_user_content` |
| page `fan_count`/`followers_count` | 200 | ✅ 200 | (page token) |

**THE KEY FINDING (my prior "reactions/comments work on pages_read_engagement" was WRONG):** our code reads reactions+comments via the **post-FIELDS API** (`reactions.summary`, `comments.summary`), which requires **`pages_read_user_content`** — a permission we NEVER requested and don't hold. **So for EVERY external FB user, reactions ("likes") and comments return 400 → those columns are EMPTY.** Only `shares` + the insights metrics work. The admin sees data only because app-role bypasses App Review.

**Why tabish's Insights show 0 in the screenshot:** the tested admin posts genuinely have 0 engagement (reactions=0, comments=0), AND FB impressions/reach are deleted-by-Meta. So 0 is partly real-zero, partly unavailable — not a permission failure for the ADMIN. For EXTERNAL users it would additionally 400.

**Two fix paths for FB engagement on external users:**
- **(A) No new permission:** switch reactions from the fields API to the **INSIGHTS edge** (`post_reactions_by_type_total` / `post_reactions_like_total`, both 200 on external tokens). But **comments have no insights equivalent** → comments would stay empty without `pages_read_user_content`.
- **(B) Request `pages_read_user_content` (App Review):** keeps the fields API, restores reactions+comments+likes for external users. This is the real gap.

---

## ⚠️ LIVE API VERIFICATION UPDATE — 2026-07-23 (corrects earlier claims)

After the admin-privileged reconnect, I tested the **real Graph API with the decrypted prod Page token** (via `prisma.channel.findFirstOrThrow` — the same read path the worker uses; note a `postTarget→channel` RELATION read returns still-ENCRYPTED tokens, only direct `channel.find*` decrypts). Findings that **revise the plan**:

1. **🔴 FB `post_impressions` AND `post_impressions_unique` are REJECTED as `#100 "must be a valid insights metric"`** on the live API (resolves at v20.0) — on both a zero-activity post AND a post with real reactions. **These metrics are DEPRECATED.** So the Phase-1.1 fix (reach = `post_impressions_unique`) and the original `post_impressions` BOTH request non-existent metrics → **FB impressions/reach are permanently 0 regardless of `read_insights`.** The FB metric names MUST be updated to the current v20+ set. Metrics that DO return 200 on the Page token: `post_clicks`, `post_reactions_by_type_total`, `post_reactions_like_total`, `post_video_views`, `blue_reels_play_count` (all returned `undefined`/empty on the tested posts — low/zero activity, but the metric NAMES are valid). Post FIELDS (`shares`, `comments.summary`, `reactions.summary`) return **200 with real data** on `pages_read_engagement` — these are the reliable FB signals TODAY.
2. **FB token is a PAGE token** (`/me` = the Page id; no `/me/permissions` edge). `post_clicks` etc. return `data:[]` not an error — so the insights EDGE is reachable on the Page token; the issue is purely metric-NAME validity + whether values populate.
3. **IG media `18108667694116164` (a 2026-07-17 post) fails even for BASIC fields** (`like_count`) with `#100 subcode 33 "does not exist / missing permissions"` — this specific media isn't loadable by the freshly-reconnected token (likely a different IG account than the reconnect authorized, OR the reconnect didn't grant `instagram_manage_insights`). NOT a clean signal either way — needs a media id known to belong to the reconnected IG account to disambiguate.

4. **⚠️ IG INSIGHTS require `instagram_manage_insights` for EXTERNAL users — the admin test does NOT generalize (CORRECTED).** Tested `GET /{ig-media}/insights?metric=reach` → **HTTP 200, `reach: 2619`** — BUT that account (`madaboutmarketingg`, org `sds`) is owned by the OPERATOR `sudhanshu@dashmani.com` (`isSuperAdmin`), i.e. app-role. **Meta's v25 docs (Instagram Media Insights → Reading → Requirements) require `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement` on the Facebook-Login path.** App-role users get every REQUESTED scope at Standard Access with NO App Review (that's why it worked); external users get only Advanced-Access-APPROVED scopes. `instagram_manage_insights` is now REQUESTED but NOT approved → **external users' IG insights will FAIL until App Review grants it.** So IG DOES need the `instagram_manage_insights` submission. (The truly-external verification — a random user's token — is still the only 100% proof; the docs + app-role model make this near-certain.)

5. **🔴 FB has NO impression/reach metric AT ALL anymore (live-enumerated).** Swept all plausible metric names against the live API. The ONLY valid Page-post `/insights` metrics now are: **`post_clicks`, `post_reactions_like_total`, `post_reactions_by_type_total`, `post_engagements`, `post_video_views`, `post_video_views_organic`**. EVERY `post_impressions*` variant (organic/paid/unique/fan) AND `post_engaged_users` (the old reach proxy) are **INVALID** — Meta removed them from the Page-post insights edge. **FB impressions and reach are simply not obtainable via post insights, at any permission level.** The realistic FB signals today = reactions/comments/shares (post FIELDS, `pages_read_engagement`, already working) + `post_clicks` + `post_video_views` (insights). `read_insights` is likely still needed for the `post_clicks`/`post_video_views` insight edge to return VALUES (they returned 200-but-empty on low-activity posts) — but it CANNOT resurrect the removed impression/reach metrics.

**Net correction to the plan (re-corrected 2026-07-23 after the app-role trap):**
- **IG: DOES need `instagram_manage_insights` (App Review) for external users.** Meta's docs require it on the Facebook-Login path; the admin test only worked because app-role users bypass App Review. The code fix (request `views` not `impressions`) is shipped + correct, but external users won't get insight VALUES until the scope is Advanced-Access-approved. Until then, external IG insights render `—`.
- **FB: NOT a permission problem for impressions/reach — those metrics were DELETED by Meta.** The code stops requesting `post_impressions*` (they 400 the whole call) and uses only the valid metric set (shipped, `c6995fb`). FB impressions/reach render **`—` permanently** — Meta doesn't expose them for Page posts anymore. `read_insights` only helps `post_clicks`/`post_video_views` VALUES.
- **So "only two permissions remain?" — closer to YES than my mid-turn correction:** IG needs `instagram_manage_insights` (App Review) for external-user insights; FB `read_insights` is optional (clicks/video-views values only, never impressions/reach). Both are worth submitting; neither restores FB impressions/reach.
- **⚠️ ANY "it works" test on an operator/admin account is inconclusive for external users** — app-role users get all requested scopes free. Only a truly-external account's token proves external behavior.

See §8 for the revised code fix.

---


**Scope:** Every column on the Insights page (posts, impressions, reach, likes, comments, shares, clicks, engagement rate) traced end-to-end — provider `getPostAnalytics` → `AnalyticsSnapshot` (write) → `analytics.router.ts` (read/aggregate) → `analytics/page.tsx` + `ReportsTab.tsx` (render) — plus a full correctness + redundancy audit of the Reports tab.

**Method:** 39-agent adversarial workflow (4 ground maps → 8 per-column lineage tracers → 3-skeptic majority verification per candidate → Reports analysis with its own verify pass) **cross-checked against an independent manual code trace**. 33 candidates → **30 confirmed** (3 refuted by ≥2/3 skeptics). No conformity bias: the widely-assumed "engagement rate is 100× off from mixed units" hypothesis was **investigated and REJECTED** (see §0).

---

## §0. The false positive we did NOT report (anti-conformity-bias)

`AnalyticsSnapshot.engagementRate` **is** stored in three incompatible units by platform:
- **0–1 fraction:** YouTube, Instagram, Facebook, LinkedIn, Reddit (Reddit divides by `ups+downs`, not impressions)
- **0–100 percent:** Threads, Pinterest, DevTo
- **hardcoded 0:** Twitter (free tier)

**BUT no Insights or Reports surface ever reads this stored column.** Every engagement-rate shown to a user is **recomputed from raw counts** as `(likes+comments+shares)/impressions*100`:
- Org-wide `engagement` proc — SQL `analytics.router.ts:315-318`
- `perChannelStats` — JS `analytics.router.ts:547-548`
- `groupStats` — `group-stats.ts:81-85` (`rateFromSums`)
- Reports `fetchPostReportRows` — SQL `analytics.router.ts:164-169`

The only readers of the stored value are the two snapshot-**writer** workers (`post-publish.worker.ts:844`, `analytics-sync.worker.ts:66`). **Verdict: the historical 100×-off bug is already neutralized by recomputation.** The mixed unit is a latent trap only if someone ever SUMs or displays `AnalyticsSnapshot.engagementRate` directly — see finding INFO-1.

---

## §1. Confirmed Insights findings (30)

Severity: 8 High · 15 Medium · 6 Low · 1 Info.

### HIGH

| # | Column / Surface | Location | Defect |
|---|---|---|---|
| H1 | posts / overview cards | `analytics.router.ts:224` | **`published` > `totalTargets` is displayable.** `published` (L229-238) counts PUBLISHED targets incl. the `publishedAt IS NULL` OR-branch; `totalTargets` (L214-224) sums `p.targets.length` over a query that **requires** `publishedAt` in range (NULL excluded) and counts ALL target statuses. During any mixed-outcome / lagged publish (`Post.publishedAt` set only when all targets terminalize), the card renders e.g. "5 across 0 targets" — numerator exceeds its stated denominator. |
| H2 | posts / overview cards | `analytics.router.ts:398` | `overview.published` and `platformBreakdown` are documented as sharing one population but use slightly different predicates → the "Published Targets" headline and the pie total can disagree. |
| H3 | reach / channel table | `analytics.router.ts:314` | **`Reach` SUMs semantically incompatible values** across platforms: unique reach (IG), engaged-users (FB), and views-aliased-to-reach (YT/Threads/X/Pinterest/DevTo/Reddit) are added into one number. |
| H4 | reach / channel table | `facebook.provider.ts:394` | FB reach = `post_engaged_users` (users who *acted*), **not** unique reach — structurally smaller than impressions and a different metric than every other platform's "reach". |
| H5 | reach / overview card | `page.tsx:170` | "Total Reach" org card inherits every H3/H4 cross-platform mismatch in a single headline number. |
| H6 | clicks / engagement tile | `page.tsx:178` | **Clicks is structurally always-0 for 7/10 platforms** (YT, X, Threads, IG, DevTo, Reddit hardcode `clicks:0`; real only for LinkedIn-org, FB, Pinterest). The org Clicks tile is near-universally an undercount presented as real. |
| H7 | engagementRate / engagement tile | `analytics.router.ts:316` | **Ratio-of-sums pooling.** `SUM(likes+comments+shares)/SUM(impressions)`: a LinkedIn *member* post (`impressions=0`, likes>0) or Reddit (`view_count=0`, ups>0) adds to the numerator with **no matching denominator**. Example: IG target (1000 impr, 20 likes = true 2%) + LinkedIn member (0 impr, 80 likes) → renders **10%** (5× inflated). *Unanimous 3/3 confirm.* |
| H8 | engagementRate / group table | `group-stats.ts:83` | Same zero-impression numerator-pooling flaw in `rateFromSums` for the Group Performance table. |

### MEDIUM (15)

| # | Column / Surface | Location | Defect |
|---|---|---|---|
| M1 | engagementRate / engagement tile | `analytics.router.ts:273` | Org-wide rate has **no `isActive` filter**; `perChannelStats`/`groupStats` INNER JOIN `isActive=true`. A disconnected channel's snapshots still feed the headline rate but vanish from the table → headline and breakdown can't be reconciled. |
| M2 | likes / channel table | `facebook.provider.ts:391` | FB "Likes" actually stores **total reactions** (love/haha/wow/sad/angry) — mislabeled. |
| M3 | likes / channel table | `pinterest.provider.ts:171` | Pinterest "Likes" stores **Pin saves** — a different engagement type. |
| M4 | likes / channel table | `reddit.provider.ts:208` | Reddit "Likes" stores **upvotes** (`post.ups`) — Reddit has no "like". |
| M5 | likes / engagement tile | `page.tsx:175` | The org "Likes" tile SUMS real-likes + FB-reactions + Pinterest-saves + Reddit-upvotes into one apples-to-oranges number. |
| M6 | impressions / engagement tile | `analytics.router.ts:309` | "Impressions" pools true impressions with views-aliased-to-impressions (YT/Threads/DevTo/IG-Reels/FB-video). |
| M7 | impressions / channel table | `analytics.router.ts:543` | Platforms that never populate impressions (X free tier, LinkedIn member posts) show a hard `0`, indistinguishable from a real zero. |
| M8 | reach / channel table | `youtube.provider.ts:284` | **`reach` == `impressions`** for YT/Threads/X/Pinterest/Reddit/DevTo → Impressions and Reach columns show **identical numbers** — a redundant column. |
| M9 | reach / channel table | `facebook.provider.ts:445` | FB **video** posts hardcode `reach=0` → COALESCE'd to 0, so a real-reach video shows 0 reach. |
| M10 | reach / reports table | `ReportsTab.tsx:361` | Reports "Reach" renders raw per-platform reach with no normalization (same semantic mix as H3). |
| M11 | shares / channel table | `youtube.provider.ts:282` | YT "Shares" = `favoriteCount`, which the YouTube Data API has returned as **0 for all videos** since favorites were deprecated. |
| M12 | shares / channel table | `pinterest.provider.ts:172` | Structurally-0 shares for platforms that don't report it (Pinterest, DevTo, IG non-Reel, FB video, YT) shown as real 0. |
| M13 | shares / channel table | `analytics.router.ts:57` | **NULL-vs-0 divergence:** a channel with NO snapshot shows Shares `0` (COALESCE) in Insights but `—` in Reports — the two tabs disagree on the same channel. |
| M14 | clicks / channel table | `page.tsx:505` | Channel "Clicks" `0` is indistinguishable between a captured-zero-click snapshot and a channel whose platform never reports clicks. |
| M15 | clicks / engagement tile | `analytics.router.ts:310` | The Clicks sum mixes 3 incompatible platform definitions of "click" (FB post_clicks, Pinterest pin+outbound clicks, LinkedIn org clicks). |

### LOW (6)

| # | Location | Defect |
|---|---|---|
| L1 | `analytics.router.ts:51` | Impressions column mixes true impressions and "views" without labeling. |
| L2 | `analytics.router.ts:56` | No-snapshot channel shows hard `0` Comments (vs `—` in Reports). |
| L3 | `pinterest.provider.ts:173` | Pinterest always reports comments `0` (never requested) → shown as real 0. |
| L4 | `reddit.provider.ts:209` | Reddit "shares" = `crossposts.length` from one API page (a small, capped, non-share proxy). |
| L5 | `analytics.router.ts:320` | **Engagement-tile clicks (and all metrics) can double-count** a target when two snapshots share the identical `MAX(snapshotAt)` — the `engagement` proc joins on the timestamp value; `perChannelStats` uses `LATERAL … LIMIT 1`. No unique constraint on `(postTargetId, snapshotAt)`. |
| L6 | (channel table) | Twitter free-tier all-zero rows presented alongside real data with no "unavailable" distinction. |

### INFO

| # | Location | Note |
|---|---|---|
| INFO-1 | `schema.prisma:421` | `AnalyticsSnapshot.engagementRate` stored in 3 incompatible units. Harmless today (never read for display — §0) but a landmine if any future code SUMs/averages/displays the stored column directly. Recommend normalizing at write time (store percent everywhere) or dropping the column. |

---

## §2. Reports tab — correctness (3 confirmed, all minor)

The user's suspicion that Reports contains inaccuracies is **partially validated but the issues are minor** (info/low), not gross errors:

1. **INFO — IG Reels Eng.% understates** (`analytics.router.ts:165`): recompute uses `(likes+comments+shares)/impressions`, but IG folds `saved`/`total_interactions` into the provider's own rate, which the report never surfaces as a column. Internally consistent with Insights, but not IG's platform-defined engagement.
2. **INFO — truncation marker off-by-one** (`ReportsTab.tsx:131`): `exportRows.length === EXPORT_LIMIT` labels a file `-truncated` when there are *exactly* 1000 rows (complete). Same for the "capped at 500" footer at exactly 500. Cosmetic honesty edge.
3. **LOW — CSV formula-injection guard misses leading whitespace** (`csv.ts:13` + `report-csv.ts:17`): `/^[=+\-@\t\r]/` tests the raw string, so `' =HYPERLINK(...)'` (leading space) slips through unescaped. Excel treats it as a formula in some locales. **Fix in BOTH** duplicated serializers (they intentionally don't share code).

**Positive confirmations (working correctly):** at_age mode row-selector (`publishedAt <= boundary`) now correctly aligns with the `windowTag` checkpoint filter (the historical "structurally empty at_age" bug is fixed); NULL-vs-0 is correctly distinguished in Reports (`snapshotAt IS NOT NULL → 0` else `—`); UTC handling is consistent; org-scoping (IDOR) intact.

---

## §3. Reports vs Insights — redundancy verdict

**COMPLEMENTARY — NOT redundant. Recommendation: KEEP the current two-tab architecture.**

They are **two altitudes over one dataset**, answering different questions:

**Unique to Reports (would be lost by removal — no substitute anywhere):**
- Per-post × per-channel rows (one row per PostTarget) — Insights only rolls up to channel/group SUMs
- CSV export (formula-injection-guarded, BOM, `-truncated` marker, 1000-row cap) — Insights has **no export**
- Emailed CSV to arbitrary address (rate-limited 5/h, audit-logged) — Insights has **no email path**
- 24h/7d/15d/30d **publish-age** windows — Insights uses a calendar date-range picker (different model)
- **at_age** mode (metrics pinned to checkpoint snapshots via `windowTag`) — no Insights view reads `windowTag`
- Per-row "Captured (UTC)" timestamp + >24h **stale hint** — Insights has only an org-wide banner
- Clickable per-post link + per-row external platform-URL link — Insights tables have no post-level links

**Unique to Insights:** platform pie, posts-over-time bar chart, org/channel/group roll-up cards, Sync Now, calendar date-range picker.

**Shared:** only the `AnalyticsSnapshot` data source, the recomputed engagement-rate formula, org-scoping, PUBLISHED filter, UTC convention, and the same-page tab switch.

**If consolidation is ever forced** (not recommended): render the Insights roll-ups, then append the ReportsTab table + toolbar (window/mode toggles, Export, Email) as a final "Post Reports" Card — keeping **both** data sources (they use different row populations that must not be collapsed) and preserving the CSV guard, `-truncated` marker, and emailReport rate-limit/audit verbatim. **Net: the shipped two-tab layout already is the right answer.**

---

## §4. Recommended fixes (priority order)

1. **H7/H8 (engagement rate inflation)** — either compute the rate per-target then average, or exclude `impressions=0` targets from both numerator and denominator so orphan engagement can't inflate the pooled rate.
2. **H1/H2/M1 (population mismatches)** — align `totalTargets`, `published`, `platformBreakdown`, and the `engagement` proc on ONE population (target-level, `isActive=true`, consistent publishedAt/updatedAt predicate). Clamp the sub-label so `published ≤ totalTargets`.
3. **M2–M5 (mislabeled likes)** — rename the column to "Reactions/Likes" or normalize per platform; at minimum add a tooltip that FB=reactions, Pinterest=saves, Reddit=upvotes. Same for the org Likes tile.
4. **H3/H4/H5/M8/M9 (reach redundancy + semantics)** — either drop the Reach column for platforms where `reach==impressions`, or label it per-platform; fix FB video `reach=0`.
5. **H6/M14/M15 (clicks)** — hide/gray the Clicks column for platforms that never report it; distinguish "unavailable" from a real 0.
6. **M13/L2 (NULL-vs-0)** — make Insights and Reports agree: show `—` for no-snapshot channels in Insights too.
7. **L5 (double-count on tie)** — add a `@@unique([postTargetId, snapshotAt])` or switch the `engagement` proc to `DISTINCT ON`/`LATERAL LIMIT 1` like the per-channel path.
8. **Reports §2.3 (CSV guard)** — trim leading whitespace before the formula-prefix test, in both `csv.ts` and `report-csv.ts`.
9. **INFO-1** — normalize stored `engagementRate` to one unit at write time (defense-in-depth).

### §4.1 Data-source strategy (owner decision 2026-07-22)

The live-broken Meta data (IG/FB reach/impressions = 0) will be fixed **two ways in parallel** — belt-and-suspenders:
- **Official API (primary/clean):** add `instagram_manage_insights` + `read_insights` scopes, fix FB reach metric (`post_impressions_unique`), IG `impressions`→`views`. Needs Meta App Review re-approval (multi-day) + users reconnect. **Owner confirmed: "we will also get the permissions."**
- **Scraper fallback (immediate, no approval):** reuse the existing production-hardened `@dashmani/social-scrapers` (`~/Desktop/social-scrapers`) — **vendored INTO this repo** as `@postautomation/social-scrapers` (owner: build/run nothing in the other app; implement here). Fail-open, dependency-free. Provides a fallback for **FB reel engagement** + **un-stubs Snapchat spotlight engagement**. Fallback chain per provider: **official API → (null/permission-fail) scraper → (both miss) honest `—`**.
- **⚠️ IG coverage gap:** `social-scrapers`' `scrapeEngagement` supports **facebook + snapchat only** — its IG path is follower-only. So **IG owned-post reach/impressions has NO scraper fallback** and is fixed ONLY by the official-API scope. Until the scope lands, IG reach/impressions render honest `—`, never a fake 0.
- **No new features built** (owner guardrail): the "Account Growth / Top Movers" follower screen is NOT in this repo and will NOT be built. This work fixes only the existing broken/redundant Insights + Reports columns.
- Full plan: [docs/superpowers/plans/2026-07-22-insights-accuracy-fix.md](superpowers/plans/2026-07-22-insights-accuracy-fix.md).

---

## §5. Root cause — why the inaccuracies exist (added 2026-07-22, round 2)

### §5.1 The architectural root cause: a 7-slot lowest-common-denominator interface

Every provider must map its native platform metrics into a **fixed 7-field shape** — `SocialAnalytics` ([packages/social/src/abstract/social.types.ts:16](packages/social/src/abstract/social.types.ts#L16)): `impressions, clicks, likes, shares, comments, reach, engagementRate`. `AnalyticsSnapshot` ([schema.prisma:421](packages/db/prisma/schema.prisma#L421)) mirrors exactly these 7 (+ `metadata Json`). **This single design choice is the source of nearly every §1 finding:**

- **Mislabeling (M2–M5):** platforms whose native "engagement" isn't a "like" are forced into the `likes` slot — FB→*reactions*, Pinterest→*saves*, Reddit→*upvotes*.
- **Duplication (M8, H3):** platforms with no distinct "reach" metric reuse `impressions`/`views` for the `reach` slot (`reach: views`).
- **Discarded metrics:** native metrics with **no slot** are fetched and thrown away — IG `saved` and `total_interactions` are fetched for Reels then folded into `engagementRate` and never stored ([instagram.provider.ts:324](packages/social/src/providers/instagram.provider.ts#L324)); FB requests `post_reactions_like_total` but **never uses it** ([facebook.provider.ts:356](packages/social/src/providers/facebook.provider.ts#L356)).
- **Always-0 (H6, M11–M15):** slots a platform can't fill are hardcoded `0` (`clicks: 0` on YT/X/Threads/IG/DevTo/Reddit; `shares: 0` on Pinterest/DevTo/FB-video), rendered identically to a real zero.

**NEW-1 (High) — 9 platforms return `null` → NO snapshot, all-zero rows.** `getPostAnalytics` is unimplemented (inherits base `return null`, [social.abstract.ts:34](packages/social/src/abstract/social.abstract.ts#L34)) for **bluesky, discord, mastodon, medium, slack, telegram, tiktok, wordpress**, and **snapchat** (stubbed, allowlist-pending). Channels on these platforms **never get an AnalyticsSnapshot**, so in the Channel Performance table they render a full row of `0`s (COALESCE'd) — indistinguishable from a channel that has real zero engagement or one that simply hasn't synced. The UI gives no "analytics not supported for this platform" signal.

### §5.2 Silent-failure amplifier

`analytics-sync.worker.ts` (L58-72) `?? 0`-coalesces **every** field into the snapshot, and each provider's insights call does `metrics.X || 0` on failure ([facebook.provider.ts:384](packages/social/src/providers/facebook.provider.ts#L384), [instagram.provider.ts:301](packages/social/src/providers/instagram.provider.ts#L301)). A **partial permission or API failure logs a `console.warn` and stores `0`** — so a metric we lack permission for, or a Meta API deprecation, shows up as a real-looking zero with no user-visible signal. This is why a permissions gap (§6) would be *invisible* on the dashboard.

### §6. Meta insights — permission utilisation *(pending doc-grounded workflow — updated below)*

**Code facts established:**
- Approved LIVE scopes ([channel.router.ts:487/494](packages/api/src/routers/channel.router.ts#L487)): **FB** = `pages_show_list, pages_manage_posts, pages_read_engagement`; **IG** = `pages_show_list, pages_read_engagement, instagram_basic, instagram_content_publish, business_management`. **Neither includes `read_insights` (FB) nor `instagram_manage_insights` (IG).**
- **FB `reach` uses the WRONG metric (candidate NEW-2, High):** [facebook.provider.ts:394](packages/social/src/providers/facebook.provider.ts#L394) sets `reach: post_engaged_users` — that is *people who engaged* (clicked/reacted/commented), **not** reach. True FB Page-post unique reach is `post_impressions_unique`. This isn't a semantic mix (H4 undersold it) — it's a categorically wrong metric: engaged-users ⊆ reach, always smaller, often by 10–100×.
- FB requests `post_reactions_like_total` but uses `reactions.summary.total_count` instead → the "likes" number is **all reactions**, and the field that would give *true likes* is fetched and ignored.
- IG correctly branches by `media_product_type` and fetches `saved`/`shares`/`plays`/`reach` — but `saved` is **discarded** (no slot).

### §6.1 Meta permission verdict (doc-grounded, authoritative)

**🔴 NEW-3 (CRITICAL) — Instagram insights are almost certainly BROKEN in production (permission-failure zeros masquerading as real data).** Per Meta's **Media Insights Requirements table (updated 2026-06-18)**, the Instagram-API-with-Facebook-Login path we use ([instagram.provider.ts:28](packages/social/src/providers/instagram.provider.ts#L28), IG resolved via `me/accounts → instagram_business_account`) requires **`instagram_basic` + `instagram_manage_insights` + `pages_read_engagement`** to read `GET /{ig-media}/insights`. **We have `instagram_basic` + `pages_read_engagement` but NOT `instagram_manage_insights`** ([channel.router.ts:494](packages/api/src/routers/channel.router.ts#L494)). Consequence, traced in code: `readInsights()` ([instagram.provider.ts:296](packages/social/src/providers/instagram.provider.ts#L296)) hits the insights endpoint → Meta returns a permission error → `res.ok=false` → warns, returns `false`; the reach-only retry ([:318](packages/social/src/providers/instagram.provider.ts#L318)) fails identically → `metrics{}` stays empty → **impressions, reach, shares, engagement all resolve to `0`** ([:323-333](packages/social/src/providers/instagram.provider.ts#L323)). Meanwhile `like_count`/`comments_count` (read from media **fields** on `instagram_basic`, [:272-282](packages/social/src/providers/instagram.provider.ts#L272)) **do** succeed — which is exactly why IG analytics *looks* partly alive while every reach/impressions/shares value is really a permission-failure zero. **Fix: add `instagram_manage_insights` to the INSTAGRAM scopes and re-submit for App Review** (all IG users must then reconnect for fresh tokens).

**🔴 NEW-4 (High, time-bomb) — IG `impressions` metric deprecated.** Even with the scope, Graph API v22 (changelog 2025-01-21) **deprecated `impressions` on media insights**: requests after 2025-04-21 for media created on/after 2024-07-02 **return an error**. The FEED/STORY branches request `impressions` ([instagram.provider.ts:288-292](packages/social/src/providers/instagram.provider.ts#L288)) → must switch to **`views`**. So IG FEED/CAROUSEL insights would fail on this ground too, independently of the scope gap.

**🟠 NEW-2 (High, confirmed) — FB `reach` uses the wrong metric.** [facebook.provider.ts:394](packages/social/src/providers/facebook.provider.ts#L394) maps `reach = post_engaged_users`, which Meta documents as *"people who clicked anywhere in your post"* — an **engagement count, not reach**. True unique reach is **`post_impressions_unique`** (available under our existing `pages_read_engagement` on `apiVersion v18.0` — not deprecated on our version), simply never requested. FB reach is systematically understated (engaged-users ⊆ reach). **Fix: add `post_impressions_unique` to the metric string, map `reach = metrics.post_impressions_unique`.**

**🟡 NEW-5 (Medium) — FB post-insights is permission-fragile.** Meta's `/{post}/insights` Requirements table lists **both `read_insights` and `pages_read_engagement`**. We have only `pages_read_engagement`. In practice Meta serves post insights to a Page admin on `pages_read_engagement` alone (ANALYZE task derives from admin assignment), which is why **FB analytics work today** — but if Meta ever enforces the documented `read_insights` requirement or the token lacks the ANALYZE task, `/{post}/insights` 403s and the worker silently writes `0` for impressions/clicks/reach. Recommend adding `read_insights` (low review risk) or accepting the documented fragility knowingly.

**Verdict on "are we using our Meta insights permissions":** **FB = partially** (works for admin'd Pages but uses the wrong reach metric, discards `post_reactions_like_total`, and is permission-fragile). **IG = NO** (the required `instagram_manage_insights` scope is missing, so IG reach/impressions/shares are permission-failure zeros; only like/comment counts — which ride on `instagram_basic` — are real).

### §6.3 ✅ CONFIRMED AGAINST LIVE PRODUCTION DATA (2026-07-22)

Ran read-only aggregates on the prod `AnalyticsSnapshot` table (`ssh posting-automation → docker exec postautomation-postgres-1 psql`). The inferences above are **confirmed by real data — this is not theoretical**:

| Platform | snapshots | impressions>0 | reach>0 | likes>0 | comments>0 | shares>0 | clicks>0 |
|---|---|---|---|---|---|---|---|
| **FACEBOOK** | 1,324,516 | **0** | **0** | 25,297 | — | 189 | **0** |
| **INSTAGRAM** | 2,978 | **0** | **0** | 2,211 | 827 | **0** | 0 |
| TWITTER | 2,777 | 2,129 | 2,129 | 285 | 216 | 3 | 0 |
| YOUTUBE | 307 | 186 | 186 | 69 | — | — | 0 |

- **NEW-3 CONFIRMED (IG):** across ALL 2,978 IG snapshots — and the last-14-days subset (301 snaps, 2026-07-17→22) — **impressions/reach/shares are 0 in 100% of rows**, while likes>0 in 74% and comments>0 in 28%. Exactly the permission-failure signature: the `instagram_basic` media-fields call (likes/comments) works; the `/insights` call (impressions/reach/shares) fails and is swallowed to 0. **Every Instagram reach/impressions/shares number ever shown on the dashboard is a fake zero.**
- **NEW-5 UPGRADED Medium → 🔴 CRITICAL (FB):** impressions/reach/clicks are **0 across ALL 1.32M FB rows**, and the last-14-days sample (4 snaps) is all-zero including likes. FB's `/{post}/insights` call is **already failing in production** — the "usually works for admins" caveat is empirically false here. Only `reactions.summary`/`shares` (the second, `pages_read_engagement` call) intermittently populate. So **FB impressions, reach, and clicks are also fake zeros today.**
- **NEW-6 (Medium, efficiency/cost — NOT in original audit):** FB has **28,126 distinct targets → 1,324,516 snapshots = 47.1 snapshots/target.** The table is bloated ~47× with dead all-zero FB rows (long-tail daily sync + at-age checkpoints + retries each writing a zero-row). This inflates the `AnalyticsSnapshot` table, slows the LATERAL latest-snapshot joins, and wastes Graph API calls on a call that returns nothing usable. Worth a dedupe/skip-if-unchanged guard once the insights calls are fixed.

**Bottom line:** Meta (both FB and IG) insights are effectively **non-functional in production right now** — likes/comments are real, but impressions/reach/clicks/shares are permission-failure zeros on 100% of Meta rows. This is the highest-priority fix and it is **live-verified**, not inferred.

### §6.2 Meta metrics available under approved scopes but discarded/unused
- **FB `post_impressions_unique`** (true reach) — never requested (NEW-2).
- **FB `post_clicks_by_type`** — per-type click breakdown, unused.
- **FB video:** `post_video_views_unique` (reach proxy), video shares/comments — `getVideoAnalytics` hardcodes reach/shares/clicks to 0 instead ([facebook.provider.ts:436-447](packages/social/src/providers/facebook.provider.ts#L436)).
- **FB `post_reactions_like_total`** — requested ([:356](packages/social/src/providers/facebook.provider.ts#L356)) but discarded (true like-only count; code stores all-reactions instead).
- **IG `saved`, `total_interactions`** — fetched for Reels ([:290](packages/social/src/providers/instagram.provider.ts#L290)) then discarded (no slot; folded into engagementRate).
- **IG `views`** (post-2024 impressions replacement), `follows`, `ig_reels_avg_watch_time`, `profile_activity` (BIO_LINK_CLICKED etc. — closest IG has to "clicks") — never requested.

---

## §7. How data is represented per platform (complete matrix)

Legend: **ACCURATE** = correct native metric · **DUP** = duplicate of Impressions column · **MISLABELED** = a different metric shown under this header · **0** = structurally always zero · **null** = no snapshot ever written.

| Platform | Impressions | Reach | Likes | Comments | Shares | Clicks | Eng.Rate unit |
|---|---|---|---|---|---|---|---|
| **YouTube** | viewCount (views, not impressions) | **DUP** of impressions | likeCount ✓ | commentCount ✓ | favoriteCount (**~always 0**, deprecated) | **0** | fraction 0–1 |
| **LinkedIn** | impressionCount ✓ (org posts; member=**0**) | uniqueImpressionsCount ✓ (org; member **0**) | likesSummary ✓ | commentsSummary ✓ | shareCount ✓ (org) | clickCount ✓ (org only) | fraction 0–1 |
| **Facebook (feed/photo)** | post_impressions ✓ | **MISLABELED** (post_engaged_users) | reactions total ✓ (all reactions, not just likes) | comments.summary ✓ | shares.count ✓ | post_clicks ✓ | fraction 0–1 |
| **Facebook (video)** | total_video_impressions/views | **0** (hardcoded) | likes.summary ✓ | comments.summary ✓ | **0** (hardcoded) | **0** (hardcoded) | fraction 0–1 |
| **Instagram (all)** | 🔴 **0** (perm-fail; +`impressions` deprecated) | 🔴 **0** (perm-fail; native reach when working) | like_count ✓ (real — rides on `instagram_basic`) | comments_count ✓ (real) | 🔴 **0** (perm-fail; Reels-only when working) | **0** (IG has no click metric — correct) | fraction 0–1 |
| **Threads** | views | **DUP** of impressions | likes ✓ | replies ✓ | reposts+quotes ✓ | **0** | **percent** ×100 |
| **Twitter/X** | impression_count ✓ (0 on free tier) | **DUP** of impressions | like_count ✓ (0 free) | reply_count ✓ | retweet_count ✓ | **0** | **hardcoded 0** |
| **Pinterest** | IMPRESSION (30d sum) ✓ | **DUP** of impressions | **MISLABELED** (SAVE count) | **0** (never requested) | **0** (hardcoded) | PIN_CLICK+OUTBOUND ✓ | **percent** ×100 |
| **Reddit** | view_count ✓ | **DUP** of impressions | **MISLABELED** (upvotes `ups`) | num_comments ✓ | crossposts.length (page-capped proxy) | **0** | fraction (÷ ups+downs, **different denominator**) |
| **DevTo** | page_views_count ✓ | **DUP** of impressions | positive_reactions ✓ | comments_count ✓ | **0** (hardcoded) | **0** | **percent** ×100 |
| **Snapchat** | **null** (stub, allowlist-pending) | null | null | null | null | null | null |
| **Bluesky, Discord, Mastodon, Medium, Slack, Telegram, TikTok, WordPress** | **null** — no `getPostAnalytics` override; base returns null → **NO snapshot ever written** → all-zero rows in the table | null | null | null | null | null | null |

**Takeaways for the fix plan:**
- **Reach** is genuinely accurate on only **LinkedIn** (and IG once the scope is fixed). It's a duplicate of Impressions on 6 platforms, mislabeled/zeroed on FB, and null on 9.
- **Likes** is mislabeled on Pinterest (saves), Reddit (upvotes), and semantically loose on FB (all reactions).
- **Clicks** is real on only LinkedIn-org/FB/Pinterest; zero everywhere else.
- **9 of ~19 platform paths write no analytics at all** yet render zero-rows indistinguishable from real zeros.
- The single biggest *live* data-integrity issue is **NEW-3 (IG insights permission failure)** — it silently zeros the reach/impressions/shares of every Instagram post, and IG is a primary channel.
