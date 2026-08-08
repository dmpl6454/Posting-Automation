# Handoff prompt — ship the FB video-views + Insights accuracy work

Paste everything below the line into a fresh Claude Code session in
`/Users/tabish/Desktop/Dashmani-PostAutomation`.

---

You are picking up finished work that needs to be shipped to production.

## State

Branch **`fix/fb-video-views-and-insights-2026-08-08`** exists **locally only** (never
pushed), 5 commits ahead of `main`, working tree clean:

```
d4418a3 feat(insights): recover Facebook video views for posts we did not publish
2b4340a feat(insights): per-platform view for Channel Performance and Reports
4d444be fix(insights): analytics.engagement ignored the per-capture capability override
6cb8b4a fix(insights): engagement rate rendered an impossible 200%
a300354 fix(insights): FB reel-scrape branch published fabricated zeros
```

Already verified locally: **2,229 tests pass** monorepo-wide (`npx vitest run`),
`tsc --noEmit` clean on social/api/worker/web, and
`SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build` succeeds.

**Full design + rationale: `docs/FB-VIDEO-VIEWS-AND-INSIGHTS-PLAN-2026-08-08.md`.**
Read its **DO NOT** section before changing any code. Do not re-litigate the design —
it was adversarially reviewed and every claim below was live-probed on prod.

## What it does (one line each)

- **Phase 0** — the FB reel-scrape branch declared only 3 of 6 `metricsAvailable` keys, so
  it published a fabricated `0 shares` on every scraped capture.
- **Phase 1** — engagement rate rendered an impossible **200.00%**; now one
  `pooledEngagementRate` for all four granularities, suppressing only
  `interactions > impressions`.
- **Phase 2** — `reportableMetrics()` was called with one argument, so the headline tiles
  ignored the per-capture capability override.
- **Phase 3** — per-platform pill view on Channel Performance + Reports (server-side).
- **Phase 4** — 94% of FB `ExternalPost` rows are video and all stored `impressions = 0`;
  now recovered via `attachments{target}` → reel scraper.

## Your job, in order

### 1. Re-verify locally (do not skip)

```bash
git checkout fix/fb-video-views-and-insights-2026-08-08
pnpm install
pnpm --filter @postautomation/db exec prisma generate
npx vitest run                                    # expect 2229 passed
SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build
```

### 2. Pre-merge deploy safety checks

⚠️ **Merging to `main` IS deploying to prod.** There is no PR CI — `gh pr checks` saying
"no checks" means nothing ran. Before merging:

```bash
ssh posting-automation 'cd /home/deploy/postautomation && git status --short'
```

Must be **empty**. A `modified:` on any tracked file blocks *every* future deploy
(CLAUDE.md quirk #9). If dirty, stop and reconcile before going further.

### 3. Open the PR

```bash
git push -u origin fix/fb-video-views-and-insights-2026-08-08
gh pr create --base main --title "fix(insights): FB video views, engagement-rate honesty, per-platform view"
```

Body: summarize the five phases, link the plan doc, and state plainly that
`EXTERNAL_VIEW_SCRAPE_ENABLED` ships **`false`** and is flipped only after the canary.

### 4. Set the kill switch BEFORE merging

```bash
ssh posting-automation 'cd /home/deploy/postautomation && grep -q EXTERNAL_VIEW_SCRAPE_ENABLED .env.prod \
  || echo "EXTERNAL_VIEW_SCRAPE_ENABLED=false" >> .env.prod'
```

The code default is ON (fail-open by design). Shipping with it `false` means the merge
changes **no** scraping behavior — only the honesty fixes go live, which is the low-risk
half.

### 5. Merge and deploy

Merge the PR. Then confirm the deploy actually ran and the **migrate container rebuilt**:

```bash
ssh posting-automation 'docker inspect postautomation-migrate:latest --format="{{.Created}}"; \
                        docker inspect postautomation-web:latest --format="{{.Created}}"'
```

Both timestamps must be from this deploy. ⚠️ **Prod applies schema via
`prisma db push --skip-generate` from the migrate container — NOT `migrate deploy`.** The
`packages/db/prisma/migrations/20260808120000_external_post_video_id/` file is
documentation only and will never execute; the three new columns
(`resolvedVideoId`, `videoResolvedAt`, `isReel`) arrive from `schema.prisma`. If the
migrate image is stale it runs an old schema and can propose dropping live tables
(quirk #2) — if you see that, stop.

Verify the columns landed:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='ExternalPost'
  AND column_name IN ('resolvedVideoId','videoResolvedAt','isReel');
-- expect 3 rows
```

### 6. Verify the honesty fixes (scraping still OFF)

Browser, as `tabish@dashmani.com` → `/dashboard/analytics`:

- **"Contents of bollywood"** must show **`—`** for Eng. Rate (tooltip: *"More interactions
  than recorded views…"*), **not** `200.00%`.
- **"Bollywood"** must still show **`7.02% (1/13)`** — if this went to `—`, the
  minimum-base rule is wrong; revert Phase 1 and report.
- Platform pills appear above Channel Performance. Clicking **Facebook** drops the Reach
  column; **Instagram** drops Clicks. **Facebook Impressions must NOT disappear.**

### 7. Canary the scraper (the only risky part)

```bash
ssh posting-automation 'cd /home/deploy/postautomation && \
  sed -i "s/EXTERNAL_VIEW_SCRAPE_ENABLED=false/EXTERNAL_VIEW_SCRAPE_ENABLED=true/" .env.prod && \
  echo "EXTERNAL_SCRAPE_PER_RUN=5" >> .env.prod && \
  docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps worker'
```

Wait **one full 2-hour cycle**, then check:

```bash
ssh posting-automation 'docker logs postautomation-worker-1 --since 3h \
  | grep -E "ExternalSync|scrape misses" | tail -40'
```

```sql
-- THE headline number. Before: 0 of 38,067. After the canary: a small non-zero.
SELECT count(*) FILTER (WHERE ("metricsAvailable"->>'impressions')='true') AS declared_true,
       count(*) FILTER (WHERE impressions > 0)                            AS nonzero
FROM "ExternalPost" WHERE platform='FACEBOOK' AND "mediaType"='video';

-- HONESTY GUARDS — both must stay 0.
SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND impressions=0 AND ("metricsAvailable"->>'impressions')='true';

SELECT count(*) FROM "ExternalPost"
WHERE platform='FACEBOOK' AND ("metricsAvailable"->>'impressions')='true'
  AND ("metricsAvailable"->>'shares') IS NULL;

-- Feed metrics must NOT regress. Prod baseline 2026-08-08:
--   clicks_gt0=22419  shares_gt0=8714  comments_gt0=7522  likes_gt0=21057
SELECT count(*) FILTER (WHERE clicks>0)   clicks_gt0,
       count(*) FILTER (WHERE shares>0)   shares_gt0,
       count(*) FILTER (WHERE comments>0) comments_gt0,
       count(*) FILTER (WHERE likes>0)    likes_gt0
FROM "ExternalPost" WHERE platform='FACEBOOK' AND "mediaType"='video';
```

Also confirm FB **publishing** did not slow down in that window (the Graph usage cache is
module-global and shared with the publish path).

**Only if all guards hold**, raise to `EXTERNAL_SCRAPE_PER_RUN=40` and recreate the worker.
Full backfill then takes ~32–40h, newest posts first.

### 8. Rollback (cheapest first)

1. `EXTERNAL_VIEW_SCRAPE_ENABLED=false` + recreate worker (~10s). Stops all scraping;
   everything else keeps working.
2. `EXTERNAL_SYNC_ENABLED=false` — stops external ingestion entirely.
3. `git revert` the phase. The three columns are nullable and additive — **leave them**;
   dropping a column is riskier than an unread one. No data repair is needed: a stored
   `impressions: true` was true when written.

## Hard rules

- **Do NOT modify `FacebookProvider.getPostAnalytics`.** It runs inside the publish job.
  `packages/social/src/__tests__/facebook-external-video-analytics.test.ts` locks this with
  a strict fetch mock — if it fails, the change is wrong, not the test.
- **Do NOT edit `CAPS.FACEBOOK.unavailable`** to "fix" impressions. That is PR #148.
  Capability widens only through per-capture `metricsAvailable`.
- **Do NOT return a `metricsAvailable` object with fewer than all six keys** from any
  Facebook path — an omitted key reads as AVAILABLE downstream.
- **Do NOT apply `requiresExplicitDeclaration` inside `effectiveChannelUnavailable`** —
  per-row rule only; on the aggregate it blanks whole channels (prod incident 2026-08-07).
- **Do NOT re-add any `post_impressions*` metric name** — one invalid name 400s the whole
  call. Verified deleted even *with* `read_insights` granted.
- The owner's standing constraint: **"the posting process works — do NOT break it."**

If a guard query returns a bad number, stop and report it rather than pressing on.
