# Autopilot Pipeline — Design Spec

**Date:** 2026-03-15
**Status:** Approved

## Overview

End-to-end automation pipeline for managing 200+ social media pages (Instagram + Facebook + mixed platforms) around trending internet content. The system automatically discovers trending news, selects what to post, generates unique content per account, and schedules/publishes — with a hybrid auto/manual review gate for sensitive content.

### Terminology

- **Agent** = a configured AI posting account (has niche, topics, tone, channels). Each "page" maps to one Agent.
- **Channel** = a connected social platform account (Instagram, Facebook, etc.). An Agent posts to one or more Channels.
- **AccountGroup** = a niche grouping of Agents with shared settings.

## Architecture: Event-Driven Pipeline

5-stage pipeline connected via BullMQ queues, fitting the existing worker architecture.

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  DISCOVER    │───▶│   SCORE &    │───▶│   GENERATE   │───▶│   REVIEW     │───▶│  SCHEDULE &  │
│  Trending    │    │   MATCH      │    │   Content     │    │   Gate       │    │  PUBLISH     │
│  Content     │    │   to Agents  │    │   Per Agent   │    │   Auto/Human │    │              │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
```

### New BullMQ Queues

- `TREND_DISCOVER` — fetch from sources (Google News, NewsAPI, Reddit, Twitter/X trends)
- `TREND_SCORE` — score relevance, match to agents, deduplicate
- `CONTENT_GENERATE` — AI content creation (text + image via Gemini)
- `AUTOPILOT_SCHEDULE` — smart timing + queue for publish

### New Workers

- `trend-discover.worker.ts` — fetches from all sources, creates TrendingItem records
- `trend-score.worker.ts` — scores items, matches to agents, creates AutopilotPost records
- `content-generate.worker.ts` — generates caption + image per AutopilotPost
- `review-gate.worker.ts` — auto-approves LOW sensitivity, routes MEDIUM/HIGH to review queue
- `autopilot-schedule.worker.ts` — picks time slots and queues POST_PUBLISH jobs
- `autopilot-cleanup.worker.ts` — expires old trending items, auto-rejects unreviewed posts

### New Cron Jobs

- `autopilot-pipeline` — runs every 15 minutes, kicks off the discovery stage
- `autopilot-cleanup` — runs every hour, expires old items and auto-rejects timed-out reviews

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

### Circuit Breaker

Each source has a circuit breaker: after 3 consecutive failures, disable that source for 30 minutes and log an alert. Other sources continue working independently.

### Data Model — `TrendingItem`

```prisma
enum TrendingSource {
  GOOGLE_NEWS
  NEWSAPI
  REDDIT
  TWITTER
  RSS
}

enum TrendingItemStatus {
  NEW
  SCORED
  GENERATING
  GENERATED
  POSTED
  EXPIRED
  REJECTED
}

enum SensitivityLevel {
  LOW
  MEDIUM
  HIGH
}

model TrendingItem {
  id                String              @id @default(cuid())
  organizationId    String
  sourceType        TrendingSource
  sourceId          String              // dedupe key — URL hash or external ID
  titleHash         String              // normalized title hash for cross-source dedup
  title             String
  summary           String?
  fullText          String?
  imageUrl          String?
  sourceUrl         String
  sourceName        String              // e.g., "Reuters", "r/technology"
  topics            String[]            // extracted topics: ["tech", "ai", "startup"]
  region            String              // IN, US, UK, GLOBAL
  publishedAt       DateTime
  trendScore        Float               @default(0)
  status            TrendingItemStatus  @default(NEW)
  sensitivity       SensitivityLevel    @default(LOW)
  expiresAt         DateTime            // trending items expire after 24-48h
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt

  organization   Organization    @relation(fields: [organizationId], references: [id])
  autopilotPosts AutopilotPost[]

  @@unique([sourceId, organizationId])
  @@index([titleHash, organizationId]) // cross-source dedup
  @@index([status, organizationId])
  @@index([expiresAt])
}
```

### Deduplication

**Same-source:** Unique constraint on `[sourceId, organizationId]` — URL hash or external ID.

**Cross-source:** `titleHash` — normalized title (lowercase, strip punctuation, remove stop words) hashed. Before inserting, check if a TrendingItem with the same `titleHash` already exists. If so, merge topic tags and keep the version with the richest content (most text, best image).

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
| **Niche Relevance** | Topic overlap with agent's niche + LLM scoring for edge cases |

### Agent Matching

Each Agent has a niche profile (`Agent.niche` + `Agent.topics[]`). The matcher:

1. Filters trending items by `trendScore >= threshold` (configurable per AccountGroup, default 40)
2. Matches item topics against agent topics — needs at least 1 topic overlap
3. Ranks matches by niche relevance score
4. Caps at agent's `postsPerDay` limit — only top N items get through
5. Checks daily quota via Redis counter — skips agents that already hit their limit

### Daily Quota Management

Uses atomic Redis counter `autopilot:quota:{agentId}:{YYYY-MM-DD}`:
- Incremented when an AutopilotPost is created at match time
- Decremented if the AutopilotPost is later rejected or expires
- Prevents race conditions across concurrent pipeline runs

### Sensitivity Detection

Gemini Flash classifier scans title + summary:

- Political content → `HIGH`
- Death/violence/disaster → `HIGH`
- Opinion/controversy → `MEDIUM`
- Everything else → `LOW`

`LOW` → auto-approve in review gate. `MEDIUM`/`HIGH` → human review queue.

### Output — AutopilotPost

For each match, creates an `AutopilotPost` record and queues a `CONTENT_GENERATE` job:

```prisma
enum AutopilotPostStatus {
  PENDING
  GENERATING
  GENERATED
  REVIEWING
  APPROVED
  REJECTED
  SCHEDULED
  PUBLISHED
  FAILED
  EXPIRED
}

model AutopilotPost {
  id              String              @id @default(cuid())
  organizationId  String
  trendingItemId  String
  agentId         String
  postId          String?             // populated after Post record is created
  status          AutopilotPostStatus @default(PENDING)
  sensitivity     SensitivityLevel
  trendScore      Float
  nicheAngle      String?
  errorMessage    String?
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])
  trendingItem TrendingItem @relation(fields: [trendingItemId], references: [id])
  agent        Agent        @relation(fields: [agentId], references: [id])
  post         Post?        @relation(fields: [postId], references: [id])

  @@unique([trendingItemId, agentId]) // idempotency guard — one post per story per agent
  @@index([agentId, status])
  @@index([status, organizationId])
  @@index([trendingItemId])
}
```

The `@@unique([trendingItemId, agentId])` constraint prevents duplicate post generation on worker retry.

---

## Stage 3: Content Generation

**Single format for all platforms: Static news post image (via Gemini) + Caption + Hashtags**

### Per AutopilotPost

1. **Check idempotency** — if AutopilotPost already has a `postId`, skip (handles retries).

2. **Generate caption** — AI writes unique take on the story from the agent's niche/tone angle. Uses smart router for provider selection. Includes a hook/opinion line, not just a restatement of the headline.

3. **Generate hashtags** — existing `hashtag-suggestion.chain`, platform-aware (more on Instagram, fewer on Facebook).

4. **Generate news post image** — Gemini image generation with:
   - **Reference image** from the agent's saved style reference (stored in media library)
   - **Prompt**: "Generate a news post image in the exact same visual style as the reference. Headline: [trending item title]. Keep the same layout, colors, fonts, and design language."
   - Output: 1080x1080 for Instagram, 1200x675 for Facebook/others
   - **Fallback**: If Gemini fails, use existing `generateNewsCardImage()` HTML template

5. **Create platform variants** — same style but different dimensions + caption adjusted for platform char limits.

6. **Create Post + PostTarget records** with generated image + caption. Post `createdById` = `"autopilot-system"`.

7. **Update AutopilotPost** — set `postId` and status to `GENERATED`.

### New Field on Agent Model

- `referenceImageUrl String?` — URL to the page's style reference image (from media library)

### Unique Spin Per Agent

Different caption angle (each agent's tone/niche/custom prompt produces a different written take) + different visual template (each page has its own reference image style).

### Concurrency & Rate Limits

10 parallel generation workers. Each job takes ~5-10 seconds (AI text + image).

**Peak throughput estimate:** 200 agents × 3 posts/day = 600 jobs/day. Worst case burst (20 trending items × 50 agents each in one cycle) = 1000 jobs → ~8-17 minutes to drain at 10 workers. Gemini API rate limits should be monitored; add BullMQ rate limiter if needed.

---

## Stage 4: Review Gate

The `review-gate.worker.ts` processes each generated AutopilotPost:

| Sensitivity | Action | Destination |
|-------------|--------|-------------|
| `LOW` | Auto-approve | Sets status to `APPROVED`, queues `AUTOPILOT_SCHEDULE` job |
| `MEDIUM` | Human review | Sets status to `REVIEWING`, appears in review dashboard |
| `HIGH` | Human review | Sets status to `REVIEWING`, flagged as priority in dashboard |

AccountGroups with `skipReviewGate = true` auto-approve regardless of sensitivity.

### Review Dashboard (`/autopilot/review`)

- Cards showing: image preview, caption, target agent/page, sensitivity badge, score
- Actions: Approve, Reject, Edit caption & re-approve
- Bulk approve/reject for batch processing
- Filter by sensitivity level, account group
- Auto-reject by cleanup worker if not reviewed within 24h

### Human Approval Flow

When a human approves/rejects via the dashboard:
- **Approve**: Updates AutopilotPost status to `APPROVED`, queues `AUTOPILOT_SCHEDULE` job
- **Reject**: Updates status to `REJECTED`, decrements Redis quota counter

---

## Stage 5: Auto-Scheduling & Publishing

Once approved (or auto-approved):

1. **Check agent's daily quota** — verify Redis counter hasn't been exceeded by race condition
2. **Pick time slot** — distribute posts evenly across the day per agent
   - If `postsPerDay = 3` → slots at roughly 9am, 1pm, 6pm (agent's timezone from AccountGroup)
   - If a slot already has a post, push to next available gap (minimum 2h between posts)
3. **Rate limiting** — BullMQ rate limiter on POST_PUBLISH queue: max 50 jobs per minute across all agents
4. **Stagger same story** — when the same trending story goes to 30 agents, posts are staggered over 1-2 hours
5. **Create publish job** — uses existing `POST_PUBLISH` queue with delay until scheduled time
6. **Update AutopilotPost** status to `SCHEDULED`

Actual publishing uses the existing `post-publish.worker.ts` unchanged.

---

## Pipeline Observability

### PipelineRun Model

```prisma
model PipelineRun {
  id              String   @id @default(cuid())
  organizationId  String
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  status          String   @default("RUNNING") // RUNNING, COMPLETED, FAILED
  itemsDiscovered Int      @default(0)
  itemsScored     Int      @default(0)
  postsGenerated  Int      @default(0)
  postsApproved   Int      @default(0)
  postsScheduled  Int      @default(0)
  postsFailed     Int      @default(0)
  errors          Json?    // array of error messages per stage
  createdAt       DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id])

  @@index([organizationId, startedAt])
}
```

Each pipeline run (triggered every 15 min by cron) creates a PipelineRun record and updates counters as items flow through stages.

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
- Manual override: force-add a story to specific agents or reject a story

**3. Review Queue** (`/autopilot/review`)
- Described in Stage 4 above

**4. Account Groups** (`/autopilot/accounts`)
- Create/manage niche groups (e.g., "Tech Pages", "Sports Pages")
- Assign agents to groups
- Per-group settings: topics, posting frequency, trend score threshold, review preference
- Upload reference image per agent

**5. Pipeline Logs** (`/autopilot/logs`)
- Timeline view of PipelineRun records
- Error tracking per stage
- Per-agent posting history

### New Prisma Model — `AccountGroup`

```prisma
model AccountGroup {
  id                    String   @id @default(cuid())
  organizationId        String
  name                  String   // "Tech Pages", "Sports Pages"
  topics                String[]
  trendScoreThreshold   Float    @default(40)
  skipReviewGate        Boolean  @default(false) // skip review regardless of sensitivity
  postsPerDay           Int      @default(3)
  timezone              String   @default("UTC") // for scheduling time slots
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id])
  agents       Agent[]

  @@index([organizationId])
}
```

---

## Schema Changes Summary

1. **New enums:** `TrendingSource`, `TrendingItemStatus`, `SensitivityLevel`, `AutopilotPostStatus`
2. **New model: `TrendingItem`** — stores discovered trending content with scores, status, and cross-source dedup
3. **New model: `AutopilotPost`** — tracks per-agent-per-item lifecycle with idempotency guard
4. **New model: `AccountGroup`** — groups agents by niche with shared settings and timezone
5. **New model: `PipelineRun`** — observability for pipeline execution history
6. **Agent model additions:**
   - `referenceImageUrl String?` — style reference image for Gemini generation
   - `accountGroupId String?` — relation to AccountGroup
7. **Organization model additions:**
   - `trendingItems TrendingItem[]`
   - `autopilotPosts AutopilotPost[]`
   - `accountGroups AccountGroup[]`
   - `pipelineRuns PipelineRun[]`
8. **New queues:** `TREND_DISCOVER`, `TREND_SCORE`, `CONTENT_GENERATE`, `AUTOPILOT_SCHEDULE`
9. **New workers:** `trend-discover.worker.ts`, `trend-score.worker.ts`, `content-generate.worker.ts`, `review-gate.worker.ts`, `autopilot-schedule.worker.ts`, `autopilot-cleanup.worker.ts`
10. **New cron jobs:** `autopilot-pipeline` (every 15 min), `autopilot-cleanup` (every hour)

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
- Circuit breaker per discovery source (3 failures → 30 min cooldown)
- Expired trending items cleaned by `autopilot-cleanup` worker after 48h
- Unreviewed posts auto-rejected by cleanup worker after 24h
- If Gemini image generation fails, fall back to existing `generateNewsCardImage()` HTML template
- Duplicate generation prevented by `@@unique([trendingItemId, agentId])` on AutopilotPost
- Daily quota races prevented by atomic Redis counters
- Rate limiting on POST_PUBLISH queue: max 50 per minute via BullMQ rate limiter
- If all content sources fail, existing agent-based posting continues as normal (this is additive, not replacing)
