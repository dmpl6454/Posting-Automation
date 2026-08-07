# External-posts Insights — LIVE-PROBED ground truth (2026-08-06)

Every fact below was obtained by running probes against the **production** Graph API from
inside `postautomation-worker-1` with real decrypted tokens. Where this document and any
reasoning disagree, **this document wins** — the codebase's standing lesson is that
reasoning about Meta's API is unreliable and only live calls settle it.

Probe scripts: session scratchpad `probe-external.ts`, `probe2.ts`, `probe3.ts`, `probe4.ts`.

---

## 1. ✅ We CAN read insights for posts we did NOT publish

This is the premise the entire feature rests on, and it is confirmed.

```
[A] insights on a FOREIGN post 1196604146874966_122114442585390760
    GET /{post-id}/insights?metric=post_clicks,post_video_views,post_reactions_by_type_total
    → HTTP 200, rows=4   (post_clicks=0, post_reactions_by_type_total={}, post_video_views=0)
    GET /{post-id}?fields=shares,comments.summary(true),reactions.summary(true)
    → HTTP 200   shares=ABSENT comments=0 reactions=0
```

A Page access token reads insights for **any** post on that Page, regardless of who
authored it. No new permission is required beyond the approved set.

⚠️ `shares=ABSENT` on a zero-share post — Graph **omits** the key rather than returning 0.
The provider already treats `?? 0` on an OK response as a real zero; that is correct.

## 2. ✅ Listing a Page's own posts works, with `since` honored and cursor paging

```
GET /{page-id}/published_posts
    ?fields=id,created_time,message,status_type,attachments{media_type,type},permalink_url
    &since=<unix>&limit=25
→ HTTP 200, paging.cursors present
  id=1196604146874966_122114466033390760 created=2026-08-06T08:58:16+0000 status_type=added_photos att=photo/photo
  id=1196604146874966_122114459559390760 created=2026-08-06T08:36:38+0000 status_type=added_photos att=album/album
```

- `since` **is** honored (epoch seconds).
- Ids are the composite `{pageId}_{postId}` form.
- `published_posts` returns posts **published by the Page** — including ones made directly
  on Facebook. Measured on the `Bollywood` Page: 7 posts since Aug 1, of which **6 were
  ours and 1 was not**. `/feed` also responds but additionally admits visitor content, so
  `published_posts` is the correct edge.

## 3. ✅ The FB video dedup problem is SOLVED

Long-standing hazard (CLAUDE.md): video publishes store a **bare Video-node id** while
`published_posts` returns `{page}_{post}`, so videos "could never be id-matched".

```
GET /{page-id}/videos?fields=id,post_id
  video 2285901422221783 -> post_id=122111714397390760
  video 1015462917761398 -> post_id=122105710155390760
GET /{bare-video-id}?fields=id,post_id
  2285901422221783 -> post_id=122111714397390760
```

**`post_id` is the second half of the composite id.** So:

```
dedupKey = `${pageId}_${post_id}`
  2285901422221783 → 1196604146874966_122111714397390760
```

which matches `published_posts` exactly. A bare Video-node id resolves in **one** extra
call, and only for the small minority of targets stored that way.

Consistency check: the other bare id, `1748002179986936`, returns
`400 … does not exist` — that is the video CLAUDE.md already records as genuinely deleted.
The probe independently reproduced a known fact, which is good evidence the method is sound.

## 4. 🔴 Reachability — the real constraint (NOT rate limits)

**Authoritative figure — unbiased random sample of 30 distinct FB Pages (probe7), using
the exact ranking + failover the design will use:**

```
reachable : 7/30 = 23%      →  ~95 of 409 FB Pages
INSTAGRAM : 0/12 = 0%       →  effectively zero today
```

Every dead token returns `code 190 / subcode 460` — *"session invalidated because the user
changed their password or Facebook has changed the session"*. This is the same
token-staleness already documented after the App Review approval; it is **not** fixable in
code. Only a user reconnect restores it.

⚠️ Two earlier probes gave 29% and 95%; both were biased samples. See the sampling-bias
table in §6c — **23% is the number to size against.**

## 5. 📈 Volume — the invisible data is LARGE

Reachable pages are far more active than the ones we publish through:

```
ENT News        25+ posts since Aug 1   (hit the limit=25 cap)
Bollywood Paps  25+
Just Bollywood  25+
Pap Talk        19
Bollywood        7   (a page we DO publish through)
Demo Test        2
Asthetic         2
```

**Authoritative sizing (unbiased probe7 sample):**

```
mean posts since Aug 1, per REACHABLE page : 17.7
pages with ≥1 post, of those reachable     : 6/7
                                     ⇒ backfill ≈ 95 × 17.7 ≈ 1,700 posts
                                     ⇒ growth   ≈ 3.5 posts/page/day × 95 ≈ 330/day
```

Compare: pages we publish through average **3.7** posts. Reachable pages average **17.7** —
roughly **5× more activity than Insights can currently see**.

This is the gap the owner is asking to close, and it is much larger than the app-published
volume — which is exactly why the current Insights view looks so sparse.

## 6. ✅ Rate limits are PER-PAGE (Business Use Case), not one global pool

```
x-business-use-case-usage:
  {"1196604146874966":[{"type":"pages","call_count":1,"total_cputime":1,
                        "total_time":1,"estimated_time_to_regain_access":0}]}
```

Keyed by **page id**; `call_count` is a **percentage** of that page's quota. So each of the
~117 reachable Pages carries its own budget, and per-page spend is what matters.

⚠️ Do not confuse this with the app-level `#4 Application request limit reached` that a
1328-channel `debug_token` sweep once tripped — that was one global endpoint hammered in a
tight loop. Per-page BUC gives far more headroom, but the app-level ceiling still exists,
so global concurrency must stay bounded.

**Budget arithmetic for a cold backfill (authoritative numbers):**

```
probe       409 pages × 1 liveness/list call          ≈   409 calls   (314 fail fast on 190/460)
list         95 reachable × ~1–2 paginated calls      ≈   140 calls
metrics   1,700 posts × 2 calls (insights + fields)   ≈ 3,400 calls
video map   small minority × 1                        ≈   <50 calls
                                                   total ≈ 4,000 calls
concentrated on 95 live page budgets                  ≈    38 calls/page
```

38 calls against a per-page quota is negligible (the sample showed `call_count: 1`, i.e. 1%
of budget, after a real listing call). **Meta is not the binding constraint — our 4-core box
is.** So: bounded global concurrency and a steady drip, never burst parallelism.

Steady state is far cheaper: ~330 new posts/day ≈ 660 metric calls/day, plus re-syncing
recent posts on a decaying cadence.

## 6b. ✅ Foreign posts return REAL engagement — the value proof

Four active Pages we have **never published through**, 4 posts each, all `media_type=video`:

```
ENT News         clicks=1,14,4,14   views=0,0,8,32   reactions=3,4,1,6  comments=0,1,0,0  shares=1
Bollywood Paps   clicks=0,0,0,0     views=0          reactions=2,1,1,1
Just Bollywood   clicks=0,0,12,3    views=0          reactions=0,0,5,2  shares=1
Pap Talk         clicks=0,0,8,3     views=0          reactions=0,0,0,2  comments=1,1,1,1
```

- Every call returned `ins_rows=4` ⇒ `read_insights` is live on these tokens.
- **14 of 16 posts carry real engagement.** `post_video_views` populates for video posts
  (8, 32), which is exactly the one impression-like metric FB still reports.
- `shares` is **ABSENT** on most posts (Graph omits it at zero) — the `?? 0` on an OK
  response is right, and the new explicit `shares` availability flag stays accurate.

## 6c. ⚠️ Token health varies BETWEEN channel rows for the SAME Page

`Just Bollywood` appeared twice in one probe: once **alive**, once **dead**. The same
`platformId` has several `Channel` rows (one per org, sometimes several per org), each with
its own stored token, connected at different times.

**Design consequence:** when collapsing 1339 rows → 524 accounts, do **not** pick an
arbitrary row. Order candidate rows by likely health (no `needs_reconnect` verdict, newest
`dataAccessExpiresAt`, newest `updatedAt`) and **fail over to a sibling row** when a token
returns `190/460`. This converts a large slice of "unreachable" accounts into reachable
ones for free, with no user action — worth real coverage.

**Measured — the failover pool is large (pure DB, no quota):**

| | distinct accounts | with >1 row | mean rows | max | rows w/ DIFFERENT tokens | mean connect spread |
|---|---|---|---|---|---|---|
| FACEBOOK | 409 | **375 (92%)** | 2.38 | 6 | **375 (100%)** | 134.5 d |
| INSTAGRAM | 115 | **76 (66%)** | 3.17 | 6 | **76 (100%)** | 137.3 d |

Every multi-row account holds **genuinely distinct tokens**, connected a mean of ~134 days
apart.

### ⚠️ CORRECTION — failover helps far less than that structure suggests

I initially predicted failover would roughly double coverage, by assuming sibling tokens
fail **independently** (`1 − 0.71^2.38 ≈ 56%`). **That assumption is empirically false.**

Measured on an unbiased 30-Page sample (probe7):

```
reachable on FIRST ranked token : 7/30 = 23%
reachable WITH sibling failover : 7/30 = 23%   ← failover added ZERO
```

**Why:** `190/460` is *"the session has been invalidated because the user changed their
password or Facebook has changed the session"* — a **user-level** event. Sibling rows for
one Page usually trace back to the same connecting user, so all of that user's tokens die
together. Independence does not hold.

Failover is still worth implementing (probe6 found one Page of 20 where the top-ranked
token was dead and a sibling worked — the same-Page-different-user case), but budget it as
a **~0–5% edge case, not a coverage strategy**. The only real fix for the other 77% is a
user reconnect.

### Sampling bias — why three probes disagreed

| probe | population sampled | alive |
|---|---|---|
| probe4 | Pages with **no** publish history | 29% |
| probe6 | Pages with the **most** channel rows (4–6) | 95% |
| **probe7** | **unbiased random across all 409** | **23%** |

Only probe7 is a valid basis for sizing. probe6's 95% reflects that heavily-connected Pages
are actively managed and recently reconnected — a real effect, but not the population rate.

## 6d. 🔒 Do NOT synthesize Post/PostTarget rows for external posts

Verified by reading the pipeline, not assumed:

- The publish cron ([cron-jobs.ts:776](../apps/worker/src/scheduler/cron-jobs.ts#L776))
  selects `Post.status = "SCHEDULED"` with `targets: { where: { status: "SCHEDULED" } }`.
  A synthetic row written as `PUBLISHED` would not be published — so that specific risk is
  containable.
- **But the blast radius is much wider than the publisher.** Synthetic `Post` rows would
  also flow into: Content Studio's post list and calendar, the Phase-3 archive
  (`post.archive`), `bulk.bulkDelete`/`csvExport`, the activity feed, the stuck-post
  watchdog ([cron-jobs.ts:864](../apps/worker/src/scheduler/cron-jobs.ts#L864)), and — most
  seriously — **`enforcePlanLimit("postsPerMonth")` quota counting**. A user would burn
  their monthly quota on posts they made directly on Facebook.

⇒ **External posts belong in their own model**, joined to `Channel`, and unioned only in
the Insights read paths. The publish path stays untouched, honoring the owner's standing
"the posting process works — do NOT break it".

## 6e. Where a new cron fits

Existing cadence in `apps/worker/src/scheduler/cron-jobs.ts`:
`scheduleAnalyticsSync` 6h · `scheduleLongTailAnalyticsSync` daily ·
`scheduleMetaDataAccessBackfill` daily (token-deduped, hard-capped 40 calls/run) ·
`scheduleTokenRefreshes` 30m · `scheduleAvatarCache` daily · `scheduleBrandContentSync` 4h.

A new external-post sync must not double-spend quota with `scheduleAnalyticsSync`, and must
respect the `CRON_LEADER` gate (only one cron leader may run).

## 6f. Do duplicate connections multiply API calls? (measured — NO)

A recurring and reasonable worry: "if users A and B both connect the same account, do we
call Meta twice?"

**Same-org duplication is structurally impossible.** `Channel` is
`@@unique([organizationId, platform, platformId])`, so a second user connecting the same
Page in the same workspace UPSERTS the existing row. Proven by measurement — the channel
count and the distinct (org, account) pair count are IDENTICAL:

| | channel rows | distinct (org, platformId) pairs | distinct accounts | rows/account |
|---|---|---|---|---|
| FACEBOOK | 975 | **975** | 409 | 2.38 |
| INSTAGRAM | 364 | **364** | 115 | 3.17 |

If same-org duplication were possible, rows would EXCEED the pair count. They are equal.
**All duplication is cross-ORG** — the same Page connected from several workspaces, which
is legitimate.

**And cross-org duplication costs nothing**, because ingestion is keyed on
`platform:platformId`: 1339 rows → **524 Graph calls, not 1339** (a 61% reduction). Results
are then fanned out to every channel row as cheap DB writes.

Fan-out distribution (accounts by number of orgs sharing them):

```
FACEBOOK  1 org: 34   2: 269   3: 36   4: 57   5: 11   6: 2
INSTAGRAM 1 org: 39   2: 9     3: 13   4: 13   5: 30   6: 11
```

### ⚠️ Deleting users/orgs barely reduces the API budget

Because the cost is already per-account, removing an org only helps for accounts that org
holds EXCLUSIVELY. Measured:

| org removed | distinct accounts before | after | **saved** |
|---|---|---|---|
| sds (496 channels) | 524 | 471 | **53** |
| Digital Sukoon (383 channels) | 524 | 516 | **8** |
| DASHMANI (180 channels) | 524 | 522 | **2** |
| Tabish's Workspace (121) | 524 | 523 | **1** |
| nikhil's Workspace (120) | 524 | 524 | **0** |

Deleting a 120-channel workspace saves **zero** calls — every one of its accounts is
connected elsewhere too. Overlap per org:

| org | accounts | shared with other orgs | exclusive |
|---|---|---|---|
| sds | 496 | 443 | 53 |
| Digital Sukoon | 383 | 375 | 8 |
| DASHMANI | 180 | 178 | 2 |
| Tabish's Workspace | 121 | 120 | 1 |
| nikhil's Workspace | 120 | 120 | 0 |

⇒ Deleting users is a UI-clutter decision, **not** an API-cost decision. The dedup already
did that work.

## 7. Consequences for the design

1. **FB-first is the honest reality**, but IG ingestion must still be built — it is dead
   only because of tokens and will start working the moment owners reconnect. Building
   FB-only would force a rewrite.
2. **Dedup key is `{pageId}_{postId}`**, with a one-call `post_id` resolution for bare
   Video-node ids. IG media ids are bare and match `publishedId` directly.
3. **Ingestion must be background-only**, keyed on **distinct `platformId`** (524 accounts,
   not 1339 channel rows) and fanned out to every org holding that account at read time.
4. **The UI must be honest about coverage**: with ~71% of Pages and ~100% of IG accounts
   unreachable, a silent partial view would be the very "confident wrong number" this
   codebase keeps fighting. Reconnect state must be visible.
5. **Rate limiting should be per-page aware**, reading `x-business-use-case-usage` rather
   than assuming a single global pool.
