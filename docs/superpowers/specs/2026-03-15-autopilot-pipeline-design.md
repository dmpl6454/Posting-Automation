# Autopilot Pipeline — Design Spec

**Date:** 2026-03-15
**Status:** Approved

## Overview

End-to-end automation pipeline for managing 200+ social media pages (Instagram + Facebook + mixed platforms) around trending internet content. The system automatically discovers trending news, selects what to post, generates unique content per account, and schedules/publishes — with a hybrid auto/manual review gate for sensitive content.

## Architecture: Event-Driven Pipeline

5-stage pipeline connected via BullMQ queues, fitting the existing worker architecture.

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  DISCOVER    │───▶│   SCORE &    │───▶│   GENERATE   │───▶│   REVIEW     │───▶│  SCHEDULE &  │
│  Trending    │    │   MATCH      │    │   Content     │    │   Gate       │    │  PUBLISH     │
│  Content     │    │   to Accounts│    │   Per Account │    │   Auto/Human │    │              │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
     ↑                                                                               │
     │                    ┌──────────────┐                                            │
     └────────────────────│  ANALYTICS   │◀───────────────────────────────────────────┘
                          │  Feedback    │
                          └──────────────┘
```

### New BullMQ Queues

- `TREND_DISCOVER` — fetch from sources (Google News, NewsAPI, Reddit, Twitter/X trends)
- `TREND_SCORE` — score relevance, match to account groups, deduplicate
- `CONTENT_GENERATE` — AI content creation (text + image via Gemini)
- `CONTENT_REVIEW` — human review queue for sensitive/high-risk content
- `AUTOPILOT_SCHEDULE` — smart timing + queue for publish

### New Cron Job

- `autopilot-pipeline` — runs every 15-30 minutes, kicks off the discovery stage

Publishing, token refresh, and analytics use existing workers unchanged.

---

## Stage 1: Trending Content Discovery

### Sources & Fetch Strategy

| Source | Method | Frequency | What it gets |
|--------|--------|-----------|-------------|
| Google News RSS | RSS fetch (existing) | Every 15 min | Headlines by topic + region |
| NewsAPI.org | REST API | Every 15 min | Articles with full text, images, source credibility |
| Reddit | Reddit API (hot/rising) | Every 30 min | Viral content per subreddit (mapped to niches) |
| Twitter/X Trends | X API v2 | Every 15 min | Trending topics + hashtags by region |
| Custom RSS feeds | RSS fetch (existing) | Per feed interval | Niche-specific blog/publication content |

### Data Model — `TrendingItem`

New Prisma model:

```prisma
model TrendingItem {
  id                String   @id @default(cuid())
  organizationId    String
  sourceType        String   // GOOGLE_NEWS, NEWSAPI, REDDIT, TWITTER, RSS
  sourceId          String   // dedupe key — URL hash or external ID
  title             String
  summary           String?
  fullText          String?
  imageUrl          String?
  sourceUrl         String
  sourceName        String   // e.g., "Reuters", "r/technology"
  topics            String[] // extracted topics: ["tech", "ai", "startup"]
  region            String   // IN, US, UK, GLOBAL
  publishedAt       DateTime
  trendScore        Float    @default(0) // 0-100, calculated in scoring stage
  matchedAccountIds String[]
  status            String   @default("NEW") // NEW, SCORED, GENERATING, GENERATED, POSTED, EXPIRED, REJECTED
  sensitivity       String   @default("LOW") // LOW, MEDIUM, HIGH
  expiresAt         DateTime // trending items expire after 24-48h
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])

  @@unique([sourceId, organizationId])
  @@index([status, organizationId])
  @@index([expiresAt])
}
```

### Deduplication

Hash of normalized title + source URL. If a story appears across multiple sources, keep the richest version (most text, best image) and merge topic tags.

### Topic Extraction

Lightweight keyword matching first (fast), LLM classification only for ambiguous items. Reuses the existing smart router pattern.

---

## Stage 2: Scoring, Matching & Content Selection

### Scoring Formula (0-100)

```
trendScore = (recency × 0.3) + (sourceCredibility × 0.2) + (viralSignal × 0.2) + (nicheRelevance × 0.3)
```

| Factor | Calculation |
|--------|-------------|
| **Recency** | Decays over time — 100 if <1h old, 50 at 6h, 10 at 24h, 0 at 48h |
| **Source Credibility** | Static score per source (Reuters=95, random blog=30). Configurable lookup table |
| **Viral Signal** | Reddit upvotes, Twitter mention count, or cross-source appearance count |
| **Niche Relevance** | Topic overlap with account's niche + LLM scoring for edge cases |

### Account Matching

Each account/account group has a niche profile (existing `Agent.niche` + `Agent.topics[]`). The matcher:

1. Filters trending items by `trendScore >= threshold` (configurable per account, default 40)
2. Matches item topics against account topics — needs at least 1 topic overlap
3. Ranks matches by niche relevance score
4. Caps at account's `postsPerDay` limit — only top N items get through
5. Checks daily post count — skips accounts that already hit their quota

### Sensitivity Detection

Gemini Flash classifier scans title + summary:

- Political content → `HIGH`
- Death/violence/disaster → `HIGH`
- Opinion/controversy → `MEDIUM`
- Everything else → `LOW`

`LOW` → auto-pipeline. `MEDIUM`/`HIGH` → review queue.

### Output

For each match, a `ContentJob` is queued:
```json
{ "trendingItemId": "...", "accountId": "...", "sensitivity": "LOW", "trendScore": 75, "nicheAngle": "tech" }
```

---

## Stage 3: Content Generation

**Single format for all platforms: Static news post image (via Gemini) + Caption + Hashtags**

### Per ContentJob

1. **Generate caption** — AI writes unique take on the story from the account's niche/tone angle. Uses smart router for provider selection. Includes a hook/opinion line, not just a restatement of the headline.

2. **Generate hashtags** — existing `hashtag-suggestion.chain`, platform-aware (more on Instagram, fewer on Facebook).

3. **Generate news post image** — Gemini image generation with:
   - **Reference image** from the account's saved style reference (stored in media library)
   - **Prompt**: "Generate a news post image in the exact same visual style as the reference. Headline: [trending item title]. Keep the same layout, colors, fonts, and design language."
   - Output: 1080x1080 for Instagram, 1200x675 for Facebook/others

4. **Create platform variants** — same style but different dimensions + caption adjusted for platform char limits.

5. **Create Post + PostTarget records** with generated image + caption.

### New Field on Agent Model

- `referenceImageUrl` — URL to the page's style reference image (from media library)

### Unique Spin Per Account

Different caption angle (each account's tone/niche/custom prompt produces a different written take) + different visual template (each page has its own reference image style).

### Concurrency

10 parallel generation workers. Each job takes ~5-10 seconds (AI text + image). 200 accounts × configurable posts/day = easily handled.

---

## Stage 4: Review Gate

Posts flow into two paths based on sensitivity:

| Sensitivity | Action | Destination |
|-------------|--------|-------------|
| `LOW` | Auto-approve | Straight to scheduling queue |
| `MEDIUM` | Human review | Review queue in dashboard |
| `HIGH` | Human review | Review queue, flagged as priority with reason |

### Review Dashboard (`/autopilot/review`)

- Cards showing: image preview, caption, target account, sensitivity badge, score
- Actions: Approve, Reject, Edit caption & re-approve
- Bulk approve/reject for batch processing
- Filter by sensitivity level, account group
- Auto-reject if not reviewed within the item's expiry window (24-48h)

---

## Stage 5: Auto-Scheduling & Publishing

Once approved (or auto-approved):

1. **Check account's daily quota** — if already at `postsPerDay` limit, skip
2. **Pick time slot** — distribute posts evenly across the day per account
   - If `postsPerDay = 3` → slots at roughly 9am, 1pm, 6pm (account's timezone)
   - If a slot already has a post, push to next available gap (minimum 2h between posts)
3. **Rate limiting** — max 50 posts published per minute across all accounts to avoid Meta API throttling
4. **Stagger same story** — when the same trending story goes to 30 accounts, posts are staggered over 1-2 hours
5. **Create publish job** — uses existing `POST_PUBLISH` queue with delay until scheduled time

Actual publishing uses the existing `post-publish.worker.ts` unchanged.

---

## Dashboard & Monitoring

### New Pages

**1. Autopilot Overview** (`/autopilot`)
- Pipeline health: items discovered → scored → generated → published (last 24h)
- Live queue depths per stage
- Today's stats: posts generated, published, pending review, failed
- Top trending stories currently in pipeline

**2. Trending Feed** (`/autopilot/trending`)
- Live feed of discovered trending items with scores
- Filter by topic, source, region, status
- Manual override: force-add a story to specific accounts or reject a story

**3. Review Queue** (`/autopilot/review`)
- Described in Stage 4 above

**4. Account Groups** (`/autopilot/accounts`)
- Create/manage niche groups (e.g., "Tech Pages", "Sports Pages")
- Assign accounts to groups
- Per-group settings: topics, posting frequency, trend score threshold, auto/manual review preference
- Upload reference image per account

**5. Pipeline Logs** (`/autopilot/logs`)
- Timeline view of pipeline runs
- Error tracking per stage
- Per-account posting history

### New Prisma Model — `AccountGroup`

```prisma
model AccountGroup {
  id                    String   @id @default(cuid())
  organizationId        String
  name                  String   // "Tech Pages", "Sports Pages"
  topics                String[]
  trendScoreThreshold   Float    @default(40)
  autoApprove           Boolean  @default(false) // override sensitivity for this group
  postsPerDay           Int      @default(3)
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])
  agents       Agent[]

  @@index([organizationId])
}
```

---

## Schema Changes Summary

1. **New model: `TrendingItem`** — stores discovered trending content with scores and status
2. **New model: `AccountGroup`** — groups accounts by niche with shared settings
3. **Agent model additions:**
   - `referenceImageUrl String?` — style reference image for Gemini generation
   - `accountGroupId String?` — relation to AccountGroup
4. **New queues:** `TREND_DISCOVER`, `TREND_SCORE`, `CONTENT_GENERATE`, `CONTENT_REVIEW`, `AUTOPILOT_SCHEDULE`
5. **New workers:** `trend-discover.worker.ts`, `trend-score.worker.ts`, `content-generate.worker.ts`, `autopilot-schedule.worker.ts`
6. **New cron:** `autopilot-pipeline` every 15-30 minutes

---

## External API Keys Required

- **NewsAPI.org** — `NEWSAPI_KEY`
- **Reddit API** — `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
- **X/Twitter API v2** — `TWITTER_BEARER_TOKEN` (for trends, not posting)
- **Gemini** — already configured (`GEMINI_API_KEY`)

---

## Error Handling

- Each stage retries independently (BullMQ built-in retry with exponential backoff)
- Failed items don't block the pipeline — they're logged and skipped
- Expired trending items are auto-cleaned after 48h
- If Gemini image generation fails, fall back to existing `generateNewsCardImage()` HTML template
- If all content sources fail, existing agent-based posting continues as normal (this is additive, not replacing)
