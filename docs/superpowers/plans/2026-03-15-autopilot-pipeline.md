# Autopilot Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end autopilot pipeline that discovers trending content, scores/matches it to 200+ agents, generates unique news posts (static image via Gemini + caption + hashtags), routes through a hybrid review gate, and auto-schedules publishing.

**Architecture:** 5-stage event-driven pipeline using BullMQ queues. Each stage has its own worker. A cron job triggers discovery every 15 minutes. New Prisma models (TrendingItem, AutopilotPost, AccountGroup, PipelineRun) track lifecycle. The review gate auto-approves LOW sensitivity items and routes MEDIUM/HIGH to a dashboard for human review.

**Tech Stack:** TypeScript, BullMQ, Prisma/PostgreSQL, Redis, tRPC, Next.js, Gemini API, NewsAPI, Reddit API, X API v2, Zod

**Spec:** `docs/superpowers/specs/2026-03-15-autopilot-pipeline-design.md`

---

## Review Fixes (Apply During Implementation)

The following corrections MUST be applied when implementing the tasks below:

### Fix 1: TrendingItem needs `viralSignal` field (Task 2)
Add `viralSignal Float? @default(0)` to the TrendingItem model — needed for scoring.

### Fix 2: Post media uses PostMedia join table, NOT `mediaUrls` (Task 15)
The Post model has no `mediaUrls` field. Media is stored via `Media` + `PostMedia` models. In the content generation worker, instead of `mediaUrls: [dataUrl]`, you must:
1. Create a `Media` record with the image buffer uploaded to MinIO
2. Create a `PostMedia` record linking it to the Post

### Fix 3: Use `suggestHashtags` not `generateHashtags` (Task 15)
The AI package exports `suggestHashtags({ content, platform })` returning `string[]`. Fix the import and call.

### Fix 4: PostPublishJobData requires all fields (Task 16)
The actual `PostPublishJobData` interface requires: `postId`, `postTargetId`, `channelId`, `platform`, and `organizationId`. Include all five when queuing publish jobs.

### Fix 5: Fix review gate logic for skipReviewGate (Task 15)
Replace the broken finalStatus logic with:
```typescript
const skipReview = agent.accountGroup?.skipReviewGate || autopilotPost.sensitivity === "LOW";
const finalStatus = skipReview ? "APPROVED" : "REVIEWING";
```

### Fix 6: Export circuit breaker from AI package index (Tasks 10-11)
Don't use deep subpath imports. Add to `packages/ai/src/index.ts`:
```typescript
export { isSourceOpen, recordSourceFailure, recordSourceSuccess } from "./tools/trending-sources/circuit-breaker";
```

### Fix 7: Use ESM import for crypto (Task 11)
Replace `require("crypto")` with `import crypto from "crypto"` at the top of the file.

### Fix 8: Make region configurable (Task 11)
Don't hardcode `"IN"`. Get region from AccountGroup settings or organization config.

### Fix 9: Add quota decrement on rejection (Task 19)
In the `rejectPost` mutation, decrement the Redis quota counter:
```typescript
const redis = createRedisConnection();
const dateKey = new Date().toISOString().slice(0, 10);
await redis.decr(`autopilot:quota:${post.agentId}:${dateKey}`);
```

### Fix 10: Register workers with health checks (Tasks 11, 14, 15, 16)
When adding workers to `apps/worker/src/index.ts`, also add `registerWorker("trend-discover")` etc. and `markWorkerStopped()` calls matching the existing pattern.

### Fix 11: Move rate limiter to POST_PUBLISH queue (Task 16)
The `limiter: { max: 50, duration: 60000 }` belongs on the POST_PUBLISH queue config, not the AUTOPILOT_SCHEDULE worker.

### Fix 12: Store meaningful trendScore on TrendingItem (Task 14)
When updating the item to SCORED status, store the max score across all agent matches, not 0.

---

## Chunk 1: Database Schema & Queue Infrastructure

### Task 1: Add Prisma Enums

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1: Add enums to schema.prisma**

Add these enums before the models section:

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
```

- [ ] **Step 2: Run prisma format to validate**

Run: `cd packages/db && npx prisma format`
Expected: "Formatted schema.prisma"

- [ ] **Step 3: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(schema): add autopilot pipeline enums"
```

---

### Task 2: Add TrendingItem Model

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1: Add TrendingItem model**

Add after the existing models:

```prisma
model TrendingItem {
  id             String             @id @default(cuid())
  organizationId String
  sourceType     TrendingSource
  sourceId       String
  titleHash      String
  title          String
  summary        String?            @db.Text
  fullText       String?            @db.Text
  imageUrl       String?
  sourceUrl      String
  sourceName     String
  topics         String[]
  region         String             @default("GLOBAL")
  publishedAt    DateTime
  trendScore     Float              @default(0)
  status         TrendingItemStatus @default(NEW)
  sensitivity    SensitivityLevel   @default(LOW)
  expiresAt      DateTime
  createdAt      DateTime           @default(now())
  updatedAt      DateTime           @updatedAt

  organization   Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  autopilotPosts AutopilotPost[]

  @@unique([sourceId, organizationId])
  @@index([titleHash, organizationId])
  @@index([status, organizationId])
  @@index([expiresAt])
}
```

- [ ] **Step 2: Add relation to Organization model**

Find the Organization model and add:
```prisma
trendingItems TrendingItem[]
```

- [ ] **Step 3: Run prisma format**

Run: `cd packages/db && npx prisma format`
Expected: "Formatted schema.prisma"

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(schema): add TrendingItem model"
```

---

### Task 3: Add AccountGroup Model

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1: Add AccountGroup model**

```prisma
model AccountGroup {
  id                  String   @id @default(cuid())
  organizationId      String
  name                String
  topics              String[]
  trendScoreThreshold Float    @default(40)
  skipReviewGate      Boolean  @default(false)
  postsPerDay         Int      @default(3)
  timezone            String   @default("UTC")
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  agents       Agent[]

  @@index([organizationId])
}
```

- [ ] **Step 2: Add fields to Agent model**

Add these fields to the existing Agent model:

```prisma
referenceImageUrl String?
accountGroupId    String?
accountGroup      AccountGroup? @relation(fields: [accountGroupId], references: [id])
```

- [ ] **Step 3: Add relation to Organization model**

```prisma
accountGroups AccountGroup[]
```

- [ ] **Step 4: Run prisma format**

Run: `cd packages/db && npx prisma format`

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(schema): add AccountGroup model and Agent reference fields"
```

---

### Task 4: Add AutopilotPost Model

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1: Add AutopilotPost model**

```prisma
model AutopilotPost {
  id             String              @id @default(cuid())
  organizationId String
  trendingItemId String
  agentId        String
  postId         String?
  status         AutopilotPostStatus @default(PENDING)
  sensitivity    SensitivityLevel
  trendScore     Float
  nicheAngle     String?
  errorMessage   String?             @db.Text
  createdAt      DateTime            @default(now())
  updatedAt      DateTime            @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  trendingItem TrendingItem @relation(fields: [trendingItemId], references: [id], onDelete: Cascade)
  agent        Agent        @relation(fields: [agentId], references: [id], onDelete: Cascade)
  post         Post?        @relation(fields: [postId], references: [id])

  @@unique([trendingItemId, agentId])
  @@index([agentId, status])
  @@index([status, organizationId])
  @@index([trendingItemId])
}
```

- [ ] **Step 2: Add relations to Agent, Post, and Organization models**

Agent model:
```prisma
autopilotPosts AutopilotPost[]
```

Post model:
```prisma
autopilotPost AutopilotPost?
```

Organization model:
```prisma
autopilotPosts AutopilotPost[]
```

- [ ] **Step 3: Run prisma format**

Run: `cd packages/db && npx prisma format`

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(schema): add AutopilotPost model with idempotency guard"
```

---

### Task 5: Add PipelineRun Model

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1: Add PipelineRun model**

```prisma
model PipelineRun {
  id              String    @id @default(cuid())
  organizationId  String
  startedAt       DateTime  @default(now())
  completedAt     DateTime?
  status          String    @default("RUNNING")
  itemsDiscovered Int       @default(0)
  itemsScored     Int       @default(0)
  postsGenerated  Int       @default(0)
  postsApproved   Int       @default(0)
  postsScheduled  Int       @default(0)
  postsFailed     Int       @default(0)
  errors          Json?
  createdAt       DateTime  @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, startedAt])
}
```

- [ ] **Step 2: Add relation to Organization model**

```prisma
pipelineRuns PipelineRun[]
```

- [ ] **Step 3: Run prisma format**

Run: `cd packages/db && npx prisma format`

- [ ] **Step 4: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(schema): add PipelineRun model for pipeline observability"
```

---

### Task 6: Generate and Apply Migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma`

- [ ] **Step 1: Generate migration**

Run: `cd packages/db && npx prisma migrate dev --name add_autopilot_pipeline_models`
Expected: Migration created and applied successfully

- [ ] **Step 2: Generate Prisma client**

Run: `cd packages/db && npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 3: Commit migration files**

```bash
git add packages/db/prisma/
git commit -m "feat(schema): apply autopilot pipeline migration"
```

---

### Task 7: Add BullMQ Queue Definitions

**Files:**
- Modify: `packages/queue/src/queues.ts`
- Modify: `packages/queue/src/types.ts`
- Modify: `packages/queue/src/index.ts` (if needed to export new queues)

- [ ] **Step 1: Add queue name constants**

In `packages/queue/src/queues.ts`, add to `QUEUE_NAMES`:

```typescript
TREND_DISCOVER: "trend-discover",
TREND_SCORE: "trend-score",
CONTENT_GENERATE: "content-generate",
AUTOPILOT_SCHEDULE: "autopilot-schedule",
```

- [ ] **Step 2: Add job data types**

In `packages/queue/src/types.ts`, add:

```typescript
export interface TrendDiscoverJobData {
  organizationId: string;
  pipelineRunId: string;
}

export interface TrendScoreJobData {
  trendingItemId: string;
  organizationId: string;
  pipelineRunId: string;
}

export interface ContentGenerateJobData {
  autopilotPostId: string;
  organizationId: string;
  pipelineRunId: string;
}

export interface AutopilotScheduleJobData {
  autopilotPostId: string;
  organizationId: string;
  pipelineRunId: string;
}
```

- [ ] **Step 3: Add queue instances**

In `packages/queue/src/queues.ts`, add queue instances:

```typescript
export const trendDiscoverQueue = new Queue<TrendDiscoverJobData>(
  QUEUE_NAMES.TREND_DISCOVER,
  { connection: redisConnection }
);

export const trendScoreQueue = new Queue<TrendScoreJobData>(
  QUEUE_NAMES.TREND_SCORE,
  { connection: redisConnection }
);

export const contentGenerateQueue = new Queue<ContentGenerateJobData>(
  QUEUE_NAMES.CONTENT_GENERATE,
  { connection: redisConnection }
);

export const autopilotScheduleQueue = new Queue<AutopilotScheduleJobData>(
  QUEUE_NAMES.AUTOPILOT_SCHEDULE,
  { connection: redisConnection }
);
```

- [ ] **Step 4: Export new queues and types from package index**

Ensure `packages/queue/src/index.ts` exports the new queues and types.

- [ ] **Step 5: Build the queue package**

Run: `cd packages/queue && pnpm build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add packages/queue/
git commit -m "feat(queue): add autopilot pipeline queue definitions and job types"
```

---

## Chunk 2: Trending Content Discovery (Stage 1)

### Task 8: Write Trending Discovery Source Fetchers

**Files:**
- Create: `packages/ai/src/tools/trending-sources/newsapi.ts`
- Create: `packages/ai/src/tools/trending-sources/reddit.ts`
- Create: `packages/ai/src/tools/trending-sources/twitter-trends.ts`
- Create: `packages/ai/src/tools/trending-sources/index.ts`
- Modify: `packages/ai/src/index.ts`

Each source fetcher returns a common `DiscoveredItem` interface.

- [ ] **Step 1: Create the shared types file**

Create `packages/ai/src/tools/trending-sources/index.ts`:

```typescript
export interface DiscoveredItem {
  sourceType: "GOOGLE_NEWS" | "NEWSAPI" | "REDDIT" | "TWITTER" | "RSS";
  sourceId: string;
  title: string;
  summary?: string;
  fullText?: string;
  imageUrl?: string;
  sourceUrl: string;
  sourceName: string;
  topics: string[];
  region: string;
  publishedAt: Date;
  viralSignal?: number; // reddit upvotes, twitter mentions, etc.
}

export { fetchFromNewsApi } from "./newsapi";
export { fetchFromReddit } from "./reddit";
export { fetchFromTwitterTrends } from "./twitter-trends";
```

- [ ] **Step 2: Create NewsAPI fetcher**

Create `packages/ai/src/tools/trending-sources/newsapi.ts`:

```typescript
import crypto from "crypto";

import type { DiscoveredItem } from "./index";

const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const NEWSAPI_BASE = "https://newsapi.org/v2";

const TOPIC_TO_CATEGORY: Record<string, string> = {
  tech: "technology",
  business: "business",
  science: "science",
  health: "health",
  sports: "sports",
  entertainment: "entertainment",
};

export async function fetchFromNewsApi(
  topics: string[],
  region: string = "in",
  limit: number = 20
): Promise<DiscoveredItem[]> {
  if (!NEWSAPI_KEY) {
    console.warn("[NewsAPI] No API key configured, skipping");
    return [];
  }

  const items: DiscoveredItem[] = [];

  for (const topic of topics) {
    const category = TOPIC_TO_CATEGORY[topic] || "general";
    const url = `${NEWSAPI_BASE}/top-headlines?country=${region}&category=${category}&pageSize=${limit}&apiKey=${NEWSAPI_KEY}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[NewsAPI] HTTP ${res.status} for topic ${topic}`);
        continue;
      }
      const data = (await res.json()) as {
        articles: Array<{
          title: string;
          description?: string;
          content?: string;
          url: string;
          urlToImage?: string;
          source: { name: string };
          publishedAt: string;
        }>;
      };

      for (const article of data.articles || []) {
        if (!article.title || article.title === "[Removed]") continue;
        items.push({
          sourceType: "NEWSAPI",
          sourceId: crypto.createHash("md5").update(article.url).digest("hex"),
          title: article.title,
          summary: article.description || undefined,
          fullText: article.content || undefined,
          imageUrl: article.urlToImage || undefined,
          sourceUrl: article.url,
          sourceName: article.source.name,
          topics: [topic],
          region: region.toUpperCase(),
          publishedAt: new Date(article.publishedAt),
        });
      }
    } catch (err) {
      console.error(`[NewsAPI] Error fetching topic ${topic}:`, err);
    }
  }

  return items;
}
```

- [ ] **Step 3: Create Reddit fetcher**

Create `packages/ai/src/tools/trending-sources/reddit.ts`:

```typescript
import crypto from "crypto";

import type { DiscoveredItem } from "./index";

const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;

const NICHE_TO_SUBREDDITS: Record<string, string[]> = {
  tech: ["technology", "gadgets", "programming"],
  business: ["business", "economics", "finance"],
  science: ["science", "space", "environment"],
  health: ["health", "medicine"],
  sports: ["sports", "soccer", "cricket"],
  entertainment: ["entertainment", "movies", "music"],
  gaming: ["gaming", "games"],
  crypto: ["cryptocurrency", "bitcoin"],
};

let accessToken: string | null = null;
let tokenExpiresAt = 0;

async function getRedditToken(): Promise<string | null> {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
    console.warn("[Reddit] No API credentials configured, skipping");
    return null;
  }

  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;

  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60000;
  return accessToken;
}

export async function fetchFromReddit(
  topics: string[],
  limit: number = 10
): Promise<DiscoveredItem[]> {
  const token = await getRedditToken();
  if (!token) return [];

  const items: DiscoveredItem[] = [];
  const subreddits = new Set<string>();

  for (const topic of topics) {
    const subs = NICHE_TO_SUBREDDITS[topic] || [topic];
    subs.forEach((s) => subreddits.add(s));
  }

  for (const sub of subreddits) {
    try {
      const res = await fetch(`https://oauth.reddit.com/r/${sub}/hot?limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "PostAutomation/1.0" },
      });

      if (!res.ok) {
        console.error(`[Reddit] HTTP ${res.status} for r/${sub}`);
        continue;
      }

      const data = (await res.json()) as {
        data: {
          children: Array<{
            data: {
              id: string;
              title: string;
              selftext?: string;
              url: string;
              permalink: string;
              thumbnail?: string;
              subreddit: string;
              created_utc: number;
              ups: number;
              stickied: boolean;
            };
          }>;
        };
      };

      for (const child of data.data.children) {
        const post = child.data;
        if (post.stickied) continue;

        const matchedTopics = topics.filter(
          (t) => NICHE_TO_SUBREDDITS[t]?.includes(sub) || t === sub
        );

        items.push({
          sourceType: "REDDIT",
          sourceId: crypto.createHash("md5").update(`reddit:${post.id}`).digest("hex"),
          title: post.title,
          summary: post.selftext?.slice(0, 500) || undefined,
          imageUrl: post.thumbnail && post.thumbnail.startsWith("http") ? post.thumbnail : undefined,
          sourceUrl: `https://reddit.com${post.permalink}`,
          sourceName: `r/${post.subreddit}`,
          topics: matchedTopics.length > 0 ? matchedTopics : [sub],
          region: "GLOBAL",
          publishedAt: new Date(post.created_utc * 1000),
          viralSignal: post.ups,
        });
      }
    } catch (err) {
      console.error(`[Reddit] Error fetching r/${sub}:`, err);
    }
  }

  return items;
}
```

- [ ] **Step 4: Create Twitter/X trends fetcher**

Create `packages/ai/src/tools/trending-sources/twitter-trends.ts`:

```typescript
import crypto from "crypto";

import type { DiscoveredItem } from "./index";

const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

export async function fetchFromTwitterTrends(
  region: string = "IN",
  limit: number = 20
): Promise<DiscoveredItem[]> {
  if (!TWITTER_BEARER_TOKEN) {
    console.warn("[Twitter] No bearer token configured, skipping");
    return [];
  }

  try {
    // Twitter API v2 trending topics
    // WOEID: 1 = worldwide, 23424848 = India, 23424977 = US, 23424975 = UK
    const woeidMap: Record<string, number> = {
      IN: 23424848,
      US: 23424977,
      UK: 23424975,
      GLOBAL: 1,
    };

    const woeid = woeidMap[region] || 1;
    const res = await fetch(
      `https://api.twitter.com/1.1/trends/place.json?id=${woeid}`,
      {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
      }
    );

    if (!res.ok) {
      console.error(`[Twitter] HTTP ${res.status}`);
      return [];
    }

    const data = (await res.json()) as Array<{
      trends: Array<{
        name: string;
        url: string;
        tweet_volume: number | null;
        query: string;
      }>;
    }>;

    const trends = data[0]?.trends || [];
    return trends.slice(0, limit).map((trend) => ({
      sourceType: "TWITTER" as const,
      sourceId: crypto.createHash("md5").update(`twitter:${trend.query}`).digest("hex"),
      title: trend.name,
      summary: undefined,
      sourceUrl: trend.url,
      sourceName: "Twitter/X Trends",
      topics: [], // will be classified by topic extraction
      region,
      publishedAt: new Date(),
      viralSignal: trend.tweet_volume || 0,
    }));
  } catch (err) {
    console.error("[Twitter] Error fetching trends:", err);
    return [];
  }
}
```

- [ ] **Step 5: Export from ai package**

In `packages/ai/src/index.ts`, add:

```typescript
export type { DiscoveredItem } from "./tools/trending-sources/index";
export { fetchFromNewsApi } from "./tools/trending-sources/newsapi";
export { fetchFromReddit } from "./tools/trending-sources/reddit";
export { fetchFromTwitterTrends } from "./tools/trending-sources/twitter-trends";
```

- [ ] **Step 6: Build ai package**

Run: `cd packages/ai && pnpm build`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add packages/ai/src/tools/trending-sources/ packages/ai/src/index.ts
git commit -m "feat(ai): add NewsAPI, Reddit, and Twitter trending source fetchers"
```

---

### Task 9: Write Topic Extraction and Title Hashing Utilities

**Files:**
- Create: `packages/ai/src/tools/topic-extractor.ts`
- Modify: `packages/ai/src/index.ts`

- [ ] **Step 1: Create topic extractor**

Create `packages/ai/src/tools/topic-extractor.ts`:

```typescript
import crypto from "crypto";

const TOPIC_KEYWORDS: Record<string, string[]> = {
  tech: ["ai", "artificial intelligence", "software", "app", "startup", "tech", "google", "apple", "microsoft", "meta", "amazon", "openai", "robot", "cyber", "hack", "data", "cloud", "chip", "semiconductor"],
  business: ["market", "stock", "economy", "trade", "investment", "company", "ceo", "revenue", "profit", "merger", "acquisition", "ipo", "startup", "billion", "million"],
  science: ["research", "study", "discovery", "nasa", "space", "planet", "climate", "species", "quantum", "physics", "biology", "lab", "experiment"],
  health: ["health", "medical", "doctor", "hospital", "vaccine", "disease", "cancer", "mental health", "fitness", "diet", "drug", "fda", "who"],
  sports: ["cricket", "football", "soccer", "nba", "nfl", "tennis", "olympic", "match", "tournament", "championship", "player", "coach", "goal", "score"],
  entertainment: ["movie", "film", "music", "celebrity", "album", "tv", "show", "netflix", "disney", "actor", "actress", "concert", "award", "oscar", "grammy"],
  politics: ["election", "president", "minister", "parliament", "congress", "vote", "government", "policy", "law", "bill", "senate", "political", "party"],
  crypto: ["bitcoin", "ethereum", "crypto", "blockchain", "nft", "defi", "token", "web3", "mining"],
  gaming: ["game", "gaming", "playstation", "xbox", "nintendo", "esports", "steam", "console"],
};

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "not", "no", "this", "that", "these", "those", "it", "its", "he",
  "she", "they", "we", "you", "i", "my", "your", "his", "her", "our",
]);

export function extractTopics(title: string, summary?: string): string[] {
  const text = `${title} ${summary || ""}`.toLowerCase();
  const matchedTopics: string[] = [];

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const matches = keywords.filter((kw) => text.includes(kw));
    if (matches.length >= 1) {
      matchedTopics.push(topic);
    }
  }

  return matchedTopics.length > 0 ? matchedTopics : ["general"];
}

export function generateTitleHash(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => !STOP_WORDS.has(w))
    .sort()
    .join(" ");

  return crypto.createHash("md5").update(normalized).digest("hex");
}
```

- [ ] **Step 2: Export from ai package**

In `packages/ai/src/index.ts`, add:

```typescript
export { extractTopics, generateTitleHash } from "./tools/topic-extractor";
```

- [ ] **Step 3: Build and commit**

Run: `cd packages/ai && pnpm build`

```bash
git add packages/ai/src/tools/topic-extractor.ts packages/ai/src/index.ts
git commit -m "feat(ai): add topic extraction and title hashing utilities"
```

---

### Task 10: Write Circuit Breaker Utility

**Files:**
- Create: `packages/ai/src/tools/trending-sources/circuit-breaker.ts`

- [ ] **Step 1: Create circuit breaker**

```typescript
import { createRedisConnection } from "@postautomation/queue";

const redis = createRedisConnection();

const MAX_FAILURES = 3;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export async function isSourceOpen(source: string): Promise<boolean> {
  const key = `circuit:${source}`;
  const data = await redis.get(key);
  if (!data) return true;

  const { failures, openedAt } = JSON.parse(data) as { failures: number; openedAt: number };

  if (failures >= MAX_FAILURES) {
    if (Date.now() - openedAt < COOLDOWN_MS) {
      console.log(`[CircuitBreaker] ${source} is in cooldown, skipping`);
      return false;
    }
    // Cooldown expired, reset
    await redis.del(key);
    return true;
  }

  return true;
}

export async function recordSourceFailure(source: string): Promise<void> {
  const key = `circuit:${source}`;
  const data = await redis.get(key);

  let failures = 1;
  if (data) {
    const parsed = JSON.parse(data) as { failures: number };
    failures = parsed.failures + 1;
  }

  await redis.set(key, JSON.stringify({ failures, openedAt: Date.now() }), "EX", 3600);
  console.warn(`[CircuitBreaker] ${source} failure #${failures}/${MAX_FAILURES}`);
}

export async function recordSourceSuccess(source: string): Promise<void> {
  const key = `circuit:${source}`;
  await redis.del(key);
}
```

- [ ] **Step 2: Export and commit**

```bash
git add packages/ai/src/tools/trending-sources/circuit-breaker.ts
git commit -m "feat(ai): add circuit breaker for trending source resilience"
```

---

### Task 11: Write Trend Discovery Worker

**Files:**
- Create: `apps/worker/src/workers/trend-discover.worker.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Create the discovery worker**

Create `apps/worker/src/workers/trend-discover.worker.ts`:

```typescript
import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type TrendDiscoverJobData,
  type TrendScoreJobData,
  createRedisConnection,
  trendScoreQueue,
} from "@postautomation/queue";
import {
  fetchTrendingNews,
  fetchFromNewsApi,
  fetchFromReddit,
  fetchFromTwitterTrends,
  extractTopics,
  generateTitleHash,
  type DiscoveredItem,
} from "@postautomation/ai";
import {
  isSourceOpen,
  recordSourceFailure,
  recordSourceSuccess,
} from "@postautomation/ai/tools/trending-sources/circuit-breaker";

async function fetchAllSources(topics: string[], region: string): Promise<DiscoveredItem[]> {
  const allItems: DiscoveredItem[] = [];

  // Google News (existing)
  if (await isSourceOpen("GOOGLE_NEWS")) {
    try {
      const headlines = await fetchTrendingNews(undefined, 20, { country: region.toLowerCase() as "in" | "us" | "uk", hl: "en", gl: region });
      for (const h of headlines) {
        allItems.push({
          sourceType: "GOOGLE_NEWS",
          sourceId: require("crypto").createHash("md5").update(h.link).digest("hex"),
          title: h.title,
          summary: h.summary,
          sourceUrl: h.link,
          sourceName: h.source,
          topics: extractTopics(h.title, h.summary),
          region,
          publishedAt: h.published || new Date(),
        });
      }
      await recordSourceSuccess("GOOGLE_NEWS");
    } catch (err) {
      console.error("[TrendDiscover] Google News error:", err);
      await recordSourceFailure("GOOGLE_NEWS");
    }
  }

  // NewsAPI
  if (await isSourceOpen("NEWSAPI")) {
    try {
      const newsItems = await fetchFromNewsApi(topics, region.toLowerCase(), 20);
      allItems.push(...newsItems);
      await recordSourceSuccess("NEWSAPI");
    } catch (err) {
      console.error("[TrendDiscover] NewsAPI error:", err);
      await recordSourceFailure("NEWSAPI");
    }
  }

  // Reddit
  if (await isSourceOpen("REDDIT")) {
    try {
      const redditItems = await fetchFromReddit(topics, 10);
      allItems.push(...redditItems);
      await recordSourceSuccess("REDDIT");
    } catch (err) {
      console.error("[TrendDiscover] Reddit error:", err);
      await recordSourceFailure("REDDIT");
    }
  }

  // Twitter/X
  if (await isSourceOpen("TWITTER")) {
    try {
      const twitterItems = await fetchFromTwitterTrends(region, 20);
      // Classify topics for twitter items (they come without topics)
      for (const item of twitterItems) {
        if (item.topics.length === 0) {
          item.topics = extractTopics(item.title);
        }
      }
      allItems.push(...twitterItems);
      await recordSourceSuccess("TWITTER");
    } catch (err) {
      console.error("[TrendDiscover] Twitter error:", err);
      await recordSourceFailure("TWITTER");
    }
  }

  return allItems;
}

export function createTrendDiscoverWorker() {
  const worker = new Worker<TrendDiscoverJobData>(
    QUEUE_NAMES.TREND_DISCOVER,
    async (job: Job<TrendDiscoverJobData>) => {
      const { organizationId, pipelineRunId } = job.data;
      console.log(`[TrendDiscover] Starting discovery for org ${organizationId}`);

      // Get all unique topics from active agents in this org
      const agents = await prisma.agent.findMany({
        where: { organizationId, isActive: true },
        select: { topics: true },
      });

      const allTopics = [...new Set(agents.flatMap((a) => a.topics))];
      if (allTopics.length === 0) {
        console.log("[TrendDiscover] No active agents with topics, skipping");
        return { itemsDiscovered: 0 };
      }

      const items = await fetchAllSources(allTopics, "IN");
      let itemsDiscovered = 0;

      for (const item of items) {
        const titleHash = generateTitleHash(item.title);

        // Cross-source dedup: check if title already exists
        const existing = await prisma.trendingItem.findFirst({
          where: { titleHash, organizationId },
        });

        if (existing) {
          // Merge topics if richer
          const mergedTopics = [...new Set([...existing.topics, ...item.topics])];
          if (mergedTopics.length > existing.topics.length || (item.fullText && !existing.fullText)) {
            await prisma.trendingItem.update({
              where: { id: existing.id },
              data: {
                topics: mergedTopics,
                fullText: item.fullText || existing.fullText,
                imageUrl: item.imageUrl || existing.imageUrl,
              },
            });
          }
          continue;
        }

        // Same-source dedup via unique constraint
        try {
          await prisma.trendingItem.create({
            data: {
              organizationId,
              sourceType: item.sourceType as any,
              sourceId: item.sourceId,
              titleHash,
              title: item.title,
              summary: item.summary,
              fullText: item.fullText,
              imageUrl: item.imageUrl,
              sourceUrl: item.sourceUrl,
              sourceName: item.sourceName,
              topics: item.topics,
              region: item.region,
              publishedAt: item.publishedAt,
              expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h
            },
          });

          itemsDiscovered++;
        } catch (err: any) {
          // Unique constraint violation = duplicate, skip
          if (err?.code === "P2002") continue;
          throw err;
        }
      }

      // Queue scoring for all NEW items
      const newItems = await prisma.trendingItem.findMany({
        where: { organizationId, status: "NEW" },
        select: { id: true },
      });

      for (const item of newItems) {
        await trendScoreQueue.add(
          `score-${item.id}`,
          { trendingItemId: item.id, organizationId, pipelineRunId },
          { removeOnComplete: true, removeOnFail: 100 }
        );
      }

      // Update pipeline run
      await prisma.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { itemsDiscovered },
      });

      console.log(`[TrendDiscover] Discovered ${itemsDiscovered} new items, queued ${newItems.length} for scoring`);
      return { itemsDiscovered };
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[TrendDiscover] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[TrendDiscover] Job ${job.id} completed`);
  });

  return worker;
}
```

- [ ] **Step 2: Register worker in index.ts**

In `apps/worker/src/index.ts`, add:

```typescript
import { createTrendDiscoverWorker } from "./workers/trend-discover.worker";
```

In the worker instantiation section:
```typescript
const trendDiscoverWorker = createTrendDiscoverWorker();
```

In the shutdown section:
```typescript
await trendDiscoverWorker.close();
```

- [ ] **Step 3: Build worker**

Run: `cd apps/worker && pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/workers/trend-discover.worker.ts apps/worker/src/index.ts
git commit -m "feat(worker): add trend discovery worker with multi-source fetching"
```

---

## Chunk 3: Scoring, Matching & Content Selection (Stage 2)

### Task 12: Write Scoring Utilities

**Files:**
- Create: `packages/ai/src/tools/trend-scorer.ts`
- Modify: `packages/ai/src/index.ts`

- [ ] **Step 1: Create trend scorer**

Create `packages/ai/src/tools/trend-scorer.ts`:

```typescript
const SOURCE_CREDIBILITY: Record<string, number> = {
  "Reuters": 95, "AP News": 95, "BBC": 90, "CNN": 85, "The Guardian": 85,
  "The New York Times": 90, "Bloomberg": 90, "TechCrunch": 80, "The Verge": 80,
  "Wired": 80, "Ars Technica": 80, "NDTV": 75, "Times of India": 75,
  "Hindustan Times": 75, "The Hindu": 80, "India Today": 75,
  "Twitter/X Trends": 60, "default": 50,
};

export function calculateRecencyScore(publishedAt: Date): number {
  const ageMs = Date.now() - publishedAt.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours < 1) return 100;
  if (ageHours < 3) return 80;
  if (ageHours < 6) return 50;
  if (ageHours < 12) return 30;
  if (ageHours < 24) return 10;
  return 0;
}

export function calculateSourceCredibility(sourceName: string): number {
  // Check for partial matches
  for (const [name, score] of Object.entries(SOURCE_CREDIBILITY)) {
    if (sourceName.toLowerCase().includes(name.toLowerCase())) return score;
  }
  // Reddit sources
  if (sourceName.startsWith("r/")) return 55;
  return SOURCE_CREDIBILITY["default"];
}

export function calculateViralSignal(viralSignal?: number, sourceType?: string): number {
  if (!viralSignal) return 30; // neutral default

  if (sourceType === "REDDIT") {
    if (viralSignal > 10000) return 100;
    if (viralSignal > 5000) return 80;
    if (viralSignal > 1000) return 60;
    if (viralSignal > 100) return 40;
    return 20;
  }

  if (sourceType === "TWITTER") {
    if (viralSignal > 100000) return 100;
    if (viralSignal > 50000) return 80;
    if (viralSignal > 10000) return 60;
    if (viralSignal > 1000) return 40;
    return 20;
  }

  return 30;
}

export function calculateNicheRelevance(
  itemTopics: string[],
  agentTopics: string[]
): number {
  if (itemTopics.length === 0 || agentTopics.length === 0) return 20;

  const overlap = itemTopics.filter((t) => agentTopics.includes(t));
  const overlapRatio = overlap.length / Math.max(itemTopics.length, agentTopics.length);

  return Math.round(overlapRatio * 100);
}

export function calculateTrendScore(params: {
  publishedAt: Date;
  sourceName: string;
  viralSignal?: number;
  sourceType?: string;
  itemTopics: string[];
  agentTopics: string[];
}): number {
  const recency = calculateRecencyScore(params.publishedAt);
  const credibility = calculateSourceCredibility(params.sourceName);
  const viral = calculateViralSignal(params.viralSignal, params.sourceType);
  const relevance = calculateNicheRelevance(params.itemTopics, params.agentTopics);

  return Math.round(
    recency * 0.3 + credibility * 0.2 + viral * 0.2 + relevance * 0.3
  );
}
```

- [ ] **Step 2: Export from ai package**

In `packages/ai/src/index.ts`, add:

```typescript
export { calculateTrendScore, calculateNicheRelevance } from "./tools/trend-scorer";
```

- [ ] **Step 3: Build and commit**

```bash
cd packages/ai && pnpm build
git add packages/ai/src/tools/trend-scorer.ts packages/ai/src/index.ts
git commit -m "feat(ai): add trend scoring utilities"
```

---

### Task 13: Write Sensitivity Classifier

**Files:**
- Create: `packages/ai/src/tools/sensitivity-classifier.ts`
- Modify: `packages/ai/src/index.ts`

- [ ] **Step 1: Create sensitivity classifier**

Create `packages/ai/src/tools/sensitivity-classifier.ts`:

```typescript
import { callGemini } from "../providers/gemini";

const HIGH_KEYWORDS = [
  "killed", "dead", "death", "murder", "war", "attack", "terrorism",
  "bomb", "shooting", "violence", "riot", "protest", "arrest",
  "election", "president", "prime minister", "politician", "political",
  "parliament", "congress", "vote", "scandal", "corruption",
  "religious", "communal", "caste", "rape", "abuse",
];

const MEDIUM_KEYWORDS = [
  "controversy", "opinion", "debate", "criticism", "backlash",
  "accused", "allegation", "dispute", "conflict", "crisis",
  "layoff", "fired", "resign", "ban", "boycott",
];

export type Sensitivity = "LOW" | "MEDIUM" | "HIGH";

export function classifySensitivity(title: string, summary?: string): Sensitivity {
  const text = `${title} ${summary || ""}`.toLowerCase();

  for (const kw of HIGH_KEYWORDS) {
    if (text.includes(kw)) return "HIGH";
  }

  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw)) return "MEDIUM";
  }

  return "LOW";
}
```

- [ ] **Step 2: Export and commit**

```typescript
export { classifySensitivity, type Sensitivity } from "./tools/sensitivity-classifier";
```

```bash
cd packages/ai && pnpm build
git add packages/ai/src/tools/sensitivity-classifier.ts packages/ai/src/index.ts
git commit -m "feat(ai): add sensitivity classifier for review gate"
```

---

### Task 14: Write Trend Score Worker

**Files:**
- Create: `apps/worker/src/workers/trend-score.worker.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Create the scoring worker**

Create `apps/worker/src/workers/trend-score.worker.ts`:

```typescript
import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type TrendScoreJobData,
  type ContentGenerateJobData,
  createRedisConnection,
  contentGenerateQueue,
} from "@postautomation/queue";
import {
  calculateTrendScore,
  calculateNicheRelevance,
  classifySensitivity,
} from "@postautomation/ai";

const redis = createRedisConnection();

async function getAndIncrementQuota(agentId: string): Promise<{ current: number; allowed: boolean; limit: number }> {
  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `autopilot:quota:${agentId}:${dateKey}`;

  const current = await redis.incr(key);
  // Set TTL on first increment
  if (current === 1) {
    await redis.expire(key, 86400); // 24h
  }

  // We'll check the limit after — decrement if over limit
  return { current, allowed: true, limit: 0 };
}

async function decrementQuota(agentId: string): Promise<void> {
  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `autopilot:quota:${agentId}:${dateKey}`;
  await redis.decr(key);
}

export function createTrendScoreWorker() {
  const worker = new Worker<TrendScoreJobData>(
    QUEUE_NAMES.TREND_SCORE,
    async (job: Job<TrendScoreJobData>) => {
      const { trendingItemId, organizationId, pipelineRunId } = job.data;
      console.log(`[TrendScore] Scoring item ${trendingItemId}`);

      const item = await prisma.trendingItem.findUnique({
        where: { id: trendingItemId },
      });

      if (!item || item.status !== "NEW") {
        console.log(`[TrendScore] Item ${trendingItemId} not found or already processed`);
        return { matched: 0 };
      }

      // Get all active agents with their account group settings
      const agents = await prisma.agent.findMany({
        where: { organizationId, isActive: true },
        include: { accountGroup: true },
      });

      const sensitivity = classifySensitivity(item.title, item.summary || undefined);
      let matchedCount = 0;

      for (const agent of agents) {
        const agentTopics = agent.topics;
        const threshold = agent.accountGroup?.trendScoreThreshold ?? 40;
        const postsPerDay = agent.accountGroup?.postsPerDay ?? agent.postsPerDay;

        // Calculate score for this agent
        const score = calculateTrendScore({
          publishedAt: item.publishedAt,
          sourceName: item.sourceName,
          sourceType: item.sourceType,
          itemTopics: item.topics,
          agentTopics,
        });

        if (score < threshold) continue;

        // Check niche relevance — need at least some overlap
        const relevance = calculateNicheRelevance(item.topics, agentTopics);
        if (relevance === 0 && item.topics[0] !== "general") continue;

        // Check quota
        const quota = await getAndIncrementQuota(agent.id);
        // Need to check against agent's postsPerDay
        if (quota.current > postsPerDay) {
          await decrementQuota(agent.id);
          continue;
        }

        // Create AutopilotPost (idempotent via unique constraint)
        try {
          const autopilotPost = await prisma.autopilotPost.create({
            data: {
              organizationId,
              trendingItemId: item.id,
              agentId: agent.id,
              sensitivity,
              trendScore: score,
              nicheAngle: agent.niche || agentTopics[0] || "general",
            },
          });

          // Queue content generation
          await contentGenerateQueue.add(
            `generate-${autopilotPost.id}`,
            { autopilotPostId: autopilotPost.id, organizationId, pipelineRunId },
            { removeOnComplete: true, removeOnFail: 100 }
          );

          matchedCount++;
        } catch (err: any) {
          // Unique constraint = already matched, decrement quota
          if (err?.code === "P2002") {
            await decrementQuota(agent.id);
            continue;
          }
          throw err;
        }
      }

      // Update item status
      await prisma.trendingItem.update({
        where: { id: trendingItemId },
        data: { status: "SCORED", trendScore: 0, sensitivity },
      });

      // Update pipeline run
      await prisma.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { itemsScored: { increment: 1 } },
      });

      console.log(`[TrendScore] Item ${trendingItemId} matched ${matchedCount} agents`);
      return { matched: matchedCount };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[TrendScore] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
```

- [ ] **Step 2: Register in worker index.ts**

Add import, instantiation, and shutdown for `createTrendScoreWorker`.

- [ ] **Step 3: Build and commit**

```bash
cd apps/worker && pnpm build
git add apps/worker/src/workers/trend-score.worker.ts apps/worker/src/index.ts
git commit -m "feat(worker): add trend scoring worker with quota management"
```

---

## Chunk 4: Content Generation (Stage 3)

### Task 15: Write Content Generation Worker

**Files:**
- Create: `apps/worker/src/workers/content-generate.worker.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Create the content generation worker**

Create `apps/worker/src/workers/content-generate.worker.ts`:

```typescript
import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type ContentGenerateJobData,
  createRedisConnection,
  autopilotScheduleQueue,
  postPublishQueue,
} from "@postautomation/queue";
import {
  generateContent,
  generateHashtags,
  generateNewsImage,
} from "@postautomation/ai";

export function createContentGenerateWorker() {
  const worker = new Worker<ContentGenerateJobData>(
    QUEUE_NAMES.CONTENT_GENERATE,
    async (job: Job<ContentGenerateJobData>) => {
      const { autopilotPostId, organizationId, pipelineRunId } = job.data;
      console.log(`[ContentGenerate] Processing ${autopilotPostId}`);

      const autopilotPost = await prisma.autopilotPost.findUnique({
        where: { id: autopilotPostId },
        include: {
          trendingItem: true,
          agent: { include: { accountGroup: true } },
        },
      });

      if (!autopilotPost) {
        console.log(`[ContentGenerate] AutopilotPost ${autopilotPostId} not found`);
        return;
      }

      // Idempotency: skip if already generated
      if (autopilotPost.postId) {
        console.log(`[ContentGenerate] AutopilotPost ${autopilotPostId} already has post, skipping`);
        return;
      }

      const { trendingItem, agent } = autopilotPost;

      try {
        // Update status
        await prisma.autopilotPost.update({
          where: { id: autopilotPostId },
          data: { status: "GENERATING" },
        });

        // 1. Generate caption with unique spin
        const captionPrompt = [
          `Write a social media caption about this news story.`,
          `Headline: ${trendingItem.title}`,
          trendingItem.summary ? `Summary: ${trendingItem.summary}` : "",
          `Write from the perspective of a ${agent.niche || "general"} focused page.`,
          `Tone: ${agent.tone}`,
          `Language: ${agent.language}`,
          agent.customPrompt ? `Additional instructions: ${agent.customPrompt}` : "",
          `Do NOT copy the headline. Create an original take with a hook.`,
          `Keep it under 2000 characters.`,
          `Do not include hashtags — they will be added separately.`,
        ].filter(Boolean).join("\n");

        const caption = await generateContent({
          provider: agent.aiProvider as any,
          platform: "instagram",
          userPrompt: captionPrompt,
          tone: agent.tone,
        });

        // 2. Generate hashtags
        const hashtagResult = await generateHashtags({
          content: caption,
          platform: "instagram",
          count: 15,
        });
        const hashtags = hashtagResult || "";

        // 3. Generate news post image via Gemini
        let imageBase64: string;
        let imageMimeType = "image/png";

        if (agent.referenceImageUrl) {
          // Use Gemini to generate image matching reference style
          try {
            const { callGeminiWithImage } = await import("@postautomation/ai/providers/gemini");
            // For now, use the news card template as fallback
            const newsImage = await generateNewsImage("news_card", {
              headline: trendingItem.title,
              source: trendingItem.sourceName,
              sourceUrl: trendingItem.sourceUrl,
              logoUrl: agent.referenceImageUrl,
              handle: agent.name,
              platform: "instagram",
            });
            imageBase64 = newsImage.imageBase64;
            imageMimeType = newsImage.mimeType;
          } catch (imgErr) {
            console.warn(`[ContentGenerate] Gemini image failed, using news card:`, imgErr);
            const newsImage = await generateNewsImage("news_card", {
              headline: trendingItem.title,
              source: trendingItem.sourceName,
              platform: "instagram",
            });
            imageBase64 = newsImage.imageBase64;
          }
        } else {
          // No reference image — use HTML news card template
          const newsImage = await generateNewsImage("news_card", {
            headline: trendingItem.title,
            source: trendingItem.sourceName,
            sourceUrl: trendingItem.sourceUrl,
            handle: agent.name,
            platform: "instagram",
          });
          imageBase64 = newsImage.imageBase64;
        }

        // 4. Upload image to media storage (MinIO)
        const imageBuffer = Buffer.from(imageBase64, "base64");
        const fileName = `autopilot-${autopilotPostId}.png`;

        // Store via media service (import from wherever media upload lives)
        // For now, store as base64 data URL in mediaUrls
        const mediaDataUrl = `data:${imageMimeType};base64,${imageBase64}`;

        // 5. Create Post + PostTarget records
        const fullContent = `${caption}\n\n${hashtags}`;
        const channelIds = agent.channelIds;

        if (channelIds.length === 0) {
          throw new Error(`Agent ${agent.id} has no connected channels`);
        }

        const channels = await prisma.channel.findMany({
          where: { id: { in: channelIds }, isActive: true },
        });

        const post = await prisma.post.create({
          data: {
            organizationId,
            content: fullContent,
            mediaUrls: [mediaDataUrl],
            status: "DRAFT",
            aiGenerated: true,
            createdById: "autopilot-system",
            targets: {
              create: channels.map((ch) => ({
                channelId: ch.id,
                platform: ch.platform,
                status: "DRAFT",
              })),
            },
          },
        });

        // 6. Update AutopilotPost
        const nextStatus = autopilotPost.sensitivity === "LOW"
          ? (agent.accountGroup?.skipReviewGate ? "APPROVED" : "APPROVED")
          : "REVIEWING";

        // LOW sensitivity = auto-approve
        const finalStatus = autopilotPost.sensitivity === "LOW" ? "APPROVED" : "REVIEWING";

        await prisma.autopilotPost.update({
          where: { id: autopilotPostId },
          data: {
            postId: post.id,
            status: finalStatus,
          },
        });

        // If auto-approved, queue scheduling
        if (finalStatus === "APPROVED" || agent.accountGroup?.skipReviewGate) {
          await autopilotScheduleQueue.add(
            `schedule-${autopilotPostId}`,
            { autopilotPostId, organizationId, pipelineRunId },
            { removeOnComplete: true, removeOnFail: 100 }
          );
        }

        // Update pipeline run
        await prisma.pipelineRun.update({
          where: { id: pipelineRunId },
          data: {
            postsGenerated: { increment: 1 },
            ...(finalStatus === "APPROVED" ? { postsApproved: { increment: 1 } } : {}),
          },
        });

        console.log(`[ContentGenerate] Generated post for autopilot ${autopilotPostId}, status: ${finalStatus}`);
      } catch (err: any) {
        console.error(`[ContentGenerate] Failed for ${autopilotPostId}:`, err.message);
        await prisma.autopilotPost.update({
          where: { id: autopilotPostId },
          data: { status: "FAILED", errorMessage: err.message },
        });

        await prisma.pipelineRun.update({
          where: { id: pipelineRunId },
          data: { postsFailed: { increment: 1 } },
        });
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[ContentGenerate] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
```

- [ ] **Step 2: Register in worker index.ts**

Add import, instantiation, and shutdown for `createContentGenerateWorker`.

- [ ] **Step 3: Build and commit**

```bash
cd apps/worker && pnpm build
git add apps/worker/src/workers/content-generate.worker.ts apps/worker/src/index.ts
git commit -m "feat(worker): add content generation worker with Gemini image + caption"
```

---

## Chunk 5: Scheduling, Cleanup & Cron (Stage 5)

### Task 16: Write Autopilot Schedule Worker

**Files:**
- Create: `apps/worker/src/workers/autopilot-schedule.worker.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Create the scheduling worker**

Create `apps/worker/src/workers/autopilot-schedule.worker.ts`:

```typescript
import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type AutopilotScheduleJobData,
  createRedisConnection,
  postPublishQueue,
} from "@postautomation/queue";

function getScheduleSlots(postsPerDay: number): number[] {
  const slots: Record<number, number[]> = {
    1: [10],
    2: [9, 17],
    3: [9, 13, 18],
    4: [8, 11, 15, 19],
    5: [8, 10, 13, 16, 19],
    6: [7, 9, 11, 14, 17, 20],
    7: [7, 9, 11, 13, 15, 17, 20],
    8: [7, 9, 10, 12, 14, 16, 18, 20],
    9: [7, 8, 10, 11, 13, 15, 17, 18, 20],
    10: [7, 8, 9, 10, 12, 13, 15, 16, 18, 20],
  };
  return slots[Math.min(postsPerDay, 10)] || slots[3];
}

function getNextAvailableSlot(
  usedSlots: number[],
  allSlots: number[],
  timezone: string
): Date {
  const now = new Date();
  // Simple timezone offset (for production, use a proper tz library)
  const currentHour = now.getUTCHours(); // simplified; real impl should use timezone

  for (const hour of allSlots) {
    if (hour > currentHour && !usedSlots.includes(hour)) {
      const scheduled = new Date();
      scheduled.setUTCHours(hour, Math.floor(Math.random() * 30), 0, 0); // random minute offset for staggering
      return scheduled;
    }
  }

  // All slots today are taken or past — schedule for tomorrow first slot
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const firstSlot = allSlots[0] || 9;
  tomorrow.setUTCHours(firstSlot, Math.floor(Math.random() * 30), 0, 0);
  return tomorrow;
}

export function createAutopilotScheduleWorker() {
  const worker = new Worker<AutopilotScheduleJobData>(
    QUEUE_NAMES.AUTOPILOT_SCHEDULE,
    async (job: Job<AutopilotScheduleJobData>) => {
      const { autopilotPostId, organizationId, pipelineRunId } = job.data;
      console.log(`[AutopilotSchedule] Scheduling ${autopilotPostId}`);

      const autopilotPost = await prisma.autopilotPost.findUnique({
        where: { id: autopilotPostId },
        include: {
          agent: { include: { accountGroup: true } },
          post: { include: { targets: true } },
        },
      });

      if (!autopilotPost || !autopilotPost.post) {
        console.log(`[AutopilotSchedule] AutopilotPost ${autopilotPostId} not found or no post`);
        return;
      }

      if (autopilotPost.status !== "APPROVED") {
        console.log(`[AutopilotSchedule] AutopilotPost ${autopilotPostId} not approved, status: ${autopilotPost.status}`);
        return;
      }

      const { agent, post } = autopilotPost;
      const postsPerDay = agent.accountGroup?.postsPerDay ?? agent.postsPerDay;
      const timezone = agent.accountGroup?.timezone ?? "UTC";

      // Find today's already scheduled posts for this agent
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);

      const todaysScheduled = await prisma.post.findMany({
        where: {
          createdById: "autopilot-system",
          organizationId,
          scheduledAt: { gte: todayStart },
          targets: { some: { channelId: { in: agent.channelIds } } },
        },
        select: { scheduledAt: true },
      });

      const usedSlots = todaysScheduled
        .map((p) => p.scheduledAt?.getUTCHours())
        .filter((h): h is number => h != null);

      const allSlots = getScheduleSlots(postsPerDay);
      const scheduledAt = getNextAvailableSlot(usedSlots, allSlots, timezone);
      const delay = scheduledAt.getTime() - Date.now();

      // Update post to SCHEDULED
      await prisma.post.update({
        where: { id: post.id },
        data: { status: "SCHEDULED", scheduledAt },
      });

      // Update post targets
      await prisma.postTarget.updateMany({
        where: { postId: post.id },
        data: { status: "SCHEDULED" },
      });

      // Queue publish jobs for each target with delay
      for (const target of post.targets) {
        await postPublishQueue.add(
          `publish-${target.id}`,
          { postTargetId: target.id },
          {
            delay: Math.max(delay, 0),
            removeOnComplete: true,
            removeOnFail: 100,
          }
        );
      }

      // Update autopilot post status
      await prisma.autopilotPost.update({
        where: { id: autopilotPostId },
        data: { status: "SCHEDULED" },
      });

      // Update pipeline run
      await prisma.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { postsScheduled: { increment: 1 } },
      });

      console.log(`[AutopilotSchedule] Scheduled post for ${scheduledAt.toISOString()}, delay: ${Math.round(delay / 60000)}min`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      limiter: { max: 50, duration: 60000 }, // max 50 per minute
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[AutopilotSchedule] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
```

- [ ] **Step 2: Register in worker index.ts**

- [ ] **Step 3: Build and commit**

```bash
cd apps/worker && pnpm build
git add apps/worker/src/workers/autopilot-schedule.worker.ts apps/worker/src/index.ts
git commit -m "feat(worker): add autopilot scheduling worker with smart time slots"
```

---

### Task 17: Write Autopilot Cleanup Worker

**Files:**
- Create: `apps/worker/src/workers/autopilot-cleanup.worker.ts`

- [ ] **Step 1: Create cleanup logic**

This runs as a cron-triggered function, not a queue worker. Add it to the cron jobs file.

In `apps/worker/src/scheduler/cron-jobs.ts`, add:

```typescript
export async function runAutopilotCleanup() {
  console.log("[Cron] Running autopilot cleanup");

  // 1. Expire old trending items
  const expired = await prisma.trendingItem.updateMany({
    where: {
      expiresAt: { lt: new Date() },
      status: { notIn: ["EXPIRED", "POSTED"] },
    },
    data: { status: "EXPIRED" },
  });
  if (expired.count > 0) {
    console.log(`[Cleanup] Expired ${expired.count} trending items`);
  }

  // 2. Auto-reject unreviewed posts older than 24h
  const staleReviews = await prisma.autopilotPost.updateMany({
    where: {
      status: "REVIEWING",
      createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    data: { status: "EXPIRED" },
  });
  if (staleReviews.count > 0) {
    console.log(`[Cleanup] Auto-expired ${staleReviews.count} unreviewed posts`);
  }

  // 3. Complete pipeline runs that have been running for > 1h
  const stalePipelines = await prisma.pipelineRun.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
    },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  if (stalePipelines.count > 0) {
    console.log(`[Cleanup] Completed ${stalePipelines.count} stale pipeline runs`);
  }
}
```

- [ ] **Step 2: Register cleanup cron in startCronJobs**

Add to `startCronJobs()`:

```typescript
setInterval(runAutopilotCleanup, 60 * 60 * 1000); // every hour
runAutopilotCleanup(); // run once on startup
```

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/scheduler/cron-jobs.ts
git commit -m "feat(worker): add autopilot cleanup cron for expired items and stale reviews"
```

---

### Task 18: Write Autopilot Pipeline Cron Trigger

**Files:**
- Modify: `apps/worker/src/scheduler/cron-jobs.ts`

- [ ] **Step 1: Add pipeline trigger function**

In `apps/worker/src/scheduler/cron-jobs.ts`, add:

```typescript
import { trendDiscoverQueue } from "@postautomation/queue";

export async function triggerAutopilotPipeline() {
  console.log("[Cron] Triggering autopilot pipeline");

  // Get all organizations with active agents
  const orgs = await prisma.organization.findMany({
    where: {
      agents: { some: { isActive: true } },
    },
    select: { id: true },
  });

  for (const org of orgs) {
    // Create pipeline run
    const run = await prisma.pipelineRun.create({
      data: { organizationId: org.id },
    });

    // Queue discovery
    await trendDiscoverQueue.add(
      `discover-${org.id}-${run.id}`,
      { organizationId: org.id, pipelineRunId: run.id },
      {
        jobId: `discover-${org.id}-${run.id}`,
        removeOnComplete: true,
        removeOnFail: 100,
      }
    );
  }

  console.log(`[Cron] Triggered pipeline for ${orgs.length} organizations`);
}
```

- [ ] **Step 2: Register in startCronJobs**

```typescript
setInterval(triggerAutopilotPipeline, 15 * 60 * 1000); // every 15 minutes
// Don't run on startup — let the system warm up first
setTimeout(triggerAutopilotPipeline, 60 * 1000); // start after 1 minute
```

- [ ] **Step 3: Build and commit**

```bash
cd apps/worker && pnpm build
git add apps/worker/src/scheduler/cron-jobs.ts
git commit -m "feat(worker): add autopilot pipeline cron trigger every 15 minutes"
```

---

## Chunk 6: API Routes (tRPC)

### Task 19: Write Autopilot Router

**Files:**
- Create: `packages/api/src/routers/autopilot.router.ts`
- Modify: `packages/api/src/root.ts`

- [ ] **Step 1: Create autopilot router**

Create `packages/api/src/routers/autopilot.router.ts`:

```typescript
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { autopilotScheduleQueue } from "@postautomation/queue";

export const autopilotRouter = createRouter({
  // Dashboard overview stats
  overview: orgProcedure.query(async ({ ctx }) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const [trendingCount, pendingReview, postsToday, latestRun] = await Promise.all([
      ctx.prisma.trendingItem.count({
        where: { organizationId: ctx.organizationId, status: { in: ["NEW", "SCORED"] }, expiresAt: { gt: new Date() } },
      }),
      ctx.prisma.autopilotPost.count({
        where: { organizationId: ctx.organizationId, status: "REVIEWING" },
      }),
      ctx.prisma.autopilotPost.count({
        where: { organizationId: ctx.organizationId, createdAt: { gte: today } },
      }),
      ctx.prisma.pipelineRun.findFirst({
        where: { organizationId: ctx.organizationId },
        orderBy: { startedAt: "desc" },
      }),
    ]);

    return { trendingCount, pendingReview, postsToday, latestRun };
  }),

  // Trending items feed
  trendingItems: orgProcedure
    .input(z.object({
      status: z.enum(["NEW", "SCORED", "GENERATING", "GENERATED", "POSTED", "EXPIRED", "REJECTED"]).optional(),
      topic: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const items = await ctx.prisma.trendingItem.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.topic ? { topics: { has: input.topic } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return { items, nextCursor };
    }),

  // Review queue
  reviewQueue: orgProcedure
    .input(z.object({
      sensitivity: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.autopilotPost.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: "REVIEWING",
          ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
        },
        include: {
          trendingItem: true,
          agent: true,
          post: { include: { targets: true } },
        },
        orderBy: [{ sensitivity: "desc" }, { trendScore: "desc" }],
        take: input.limit,
      });
    }),

  // Approve a post
  approvePost: orgProcedure
    .input(z.object({ autopilotPostId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.autopilotPost.findUnique({
        where: { id: input.autopilotPostId },
      });

      if (!post || post.organizationId !== ctx.organizationId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (post.status !== "REVIEWING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Post is not in review" });
      }

      await ctx.prisma.autopilotPost.update({
        where: { id: input.autopilotPostId },
        data: { status: "APPROVED" },
      });

      // Queue scheduling
      await autopilotScheduleQueue.add(
        `schedule-${input.autopilotPostId}`,
        {
          autopilotPostId: input.autopilotPostId,
          organizationId: ctx.organizationId,
          pipelineRunId: "manual-approval",
        },
        { removeOnComplete: true, removeOnFail: 100 }
      );

      return { success: true };
    }),

  // Reject a post
  rejectPost: orgProcedure
    .input(z.object({ autopilotPostId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.autopilotPost.findUnique({
        where: { id: input.autopilotPostId },
      });

      if (!post || post.organizationId !== ctx.organizationId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      await ctx.prisma.autopilotPost.update({
        where: { id: input.autopilotPostId },
        data: { status: "REJECTED" },
      });

      return { success: true };
    }),

  // Bulk approve
  bulkApprove: orgProcedure
    .input(z.object({ autopilotPostIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      for (const id of input.autopilotPostIds) {
        try {
          await ctx.prisma.autopilotPost.update({
            where: { id, organizationId: ctx.organizationId, status: "REVIEWING" },
            data: { status: "APPROVED" },
          });

          await autopilotScheduleQueue.add(
            `schedule-${id}`,
            { autopilotPostId: id, organizationId: ctx.organizationId, pipelineRunId: "manual-approval" },
            { removeOnComplete: true, removeOnFail: 100 }
          );
        } catch {
          // Skip posts that can't be approved
        }
      }

      return { approved: input.autopilotPostIds.length };
    }),

  // Bulk reject
  bulkReject: orgProcedure
    .input(z.object({ autopilotPostIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.autopilotPost.updateMany({
        where: { id: { in: input.autopilotPostIds }, organizationId: ctx.organizationId },
        data: { status: "REJECTED" },
      });

      return { rejected: input.autopilotPostIds.length };
    }),

  // Pipeline runs (logs)
  pipelineRuns: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.pipelineRun.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { startedAt: "desc" },
        take: input.limit,
      });
    }),

  // Manually trigger pipeline
  triggerPipeline: orgProcedure
    .mutation(async ({ ctx }) => {
      const { trendDiscoverQueue } = await import("@postautomation/queue");

      const run = await ctx.prisma.pipelineRun.create({
        data: { organizationId: ctx.organizationId },
      });

      await trendDiscoverQueue.add(
        `discover-manual-${ctx.organizationId}`,
        { organizationId: ctx.organizationId, pipelineRunId: run.id },
        { removeOnComplete: true, removeOnFail: 100 }
      );

      return { pipelineRunId: run.id };
    }),
});
```

- [ ] **Step 2: Create account group router**

Create `packages/api/src/routers/account-group.router.ts`:

```typescript
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";

export const accountGroupRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.accountGroup.findMany({
      where: { organizationId: ctx.organizationId },
      include: { agents: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
  }),

  create: orgProcedure
    .input(z.object({
      name: z.string().min(1).max(255),
      topics: z.array(z.string()).default([]),
      trendScoreThreshold: z.number().min(0).max(100).default(40),
      skipReviewGate: z.boolean().default(false),
      postsPerDay: z.number().min(1).max(10).default(3),
      timezone: z.string().default("UTC"),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.accountGroup.create({
        data: { ...input, organizationId: ctx.organizationId },
      });
    }),

  update: orgProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(1).max(255).optional(),
      topics: z.array(z.string()).optional(),
      trendScoreThreshold: z.number().min(0).max(100).optional(),
      skipReviewGate: z.boolean().optional(),
      postsPerDay: z.number().min(1).max(10).optional(),
      timezone: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.prisma.accountGroup.update({
        where: { id, organizationId: ctx.organizationId },
        data,
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Unlink agents first
      await ctx.prisma.agent.updateMany({
        where: { accountGroupId: input.id },
        data: { accountGroupId: null },
      });
      return ctx.prisma.accountGroup.delete({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
    }),

  addAgents: orgProcedure
    .input(z.object({
      groupId: z.string(),
      agentIds: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.agent.updateMany({
        where: { id: { in: input.agentIds }, organizationId: ctx.organizationId },
        data: { accountGroupId: input.groupId },
      });
      return { updated: input.agentIds.length };
    }),

  removeAgent: orgProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.agent.update({
        where: { id: input.agentId, organizationId: ctx.organizationId },
        data: { accountGroupId: null },
      });
      return { success: true };
    }),
});
```

- [ ] **Step 3: Register routers in root.ts**

In `packages/api/src/root.ts`, add:

```typescript
import { autopilotRouter } from "./routers/autopilot.router";
import { accountGroupRouter } from "./routers/account-group.router";

// In the createRouter call:
autopilot: autopilotRouter,
accountGroup: accountGroupRouter,
```

- [ ] **Step 4: Build API package**

Run: `cd packages/api && pnpm build`

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routers/autopilot.router.ts packages/api/src/routers/account-group.router.ts packages/api/src/root.ts
git commit -m "feat(api): add autopilot and account group tRPC routers"
```

---

## Chunk 7: Dashboard UI

### Task 20: Autopilot Overview Page

**Files:**
- Create: `apps/web/app/dashboard/autopilot/page.tsx`
- Create: `apps/web/app/dashboard/autopilot/layout.tsx`

- [ ] **Step 1: Create layout with sub-navigation**

Create `apps/web/app/dashboard/autopilot/layout.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const tabs = [
  { name: "Overview", href: "/dashboard/autopilot" },
  { name: "Trending", href: "/dashboard/autopilot/trending" },
  { name: "Review Queue", href: "/dashboard/autopilot/review" },
  { name: "Account Groups", href: "/dashboard/autopilot/accounts" },
  { name: "Pipeline Logs", href: "/dashboard/autopilot/logs" },
];

export default function AutopilotLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Autopilot</h1>
        <p className="text-muted-foreground">Automated trending content pipeline</p>
      </div>

      <nav className="flex space-x-1 border-b">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px",
              pathname === tab.href
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.name}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}
```

- [ ] **Step 2: Create overview page**

Create `apps/web/app/dashboard/autopilot/page.tsx`:

```tsx
"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Play, TrendingUp, Eye, Calendar, AlertCircle } from "lucide-react";

export default function AutopilotOverviewPage() {
  const { data: overview, isLoading } = trpc.autopilot.overview.useQuery();
  const triggerMutation = trpc.autopilot.triggerPipeline.useMutation();

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Pipeline Status</h2>
        <Button
          onClick={() => triggerMutation.mutate()}
          disabled={triggerMutation.isPending}
          size="sm"
        >
          {triggerMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Run Pipeline Now
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Trending Items</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview?.trendingCount ?? 0}</div>
            <p className="text-xs text-muted-foreground">Active items in pipeline</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Review</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview?.pendingReview ?? 0}</div>
            <p className="text-xs text-muted-foreground">Awaiting human approval</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Posts Today</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview?.postsToday ?? 0}</div>
            <p className="text-xs text-muted-foreground">Generated today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Last Run</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview?.latestRun?.status ?? "None"}</div>
            <p className="text-xs text-muted-foreground">
              {overview?.latestRun?.startedAt
                ? new Date(overview.latestRun.startedAt).toLocaleTimeString()
                : "No runs yet"}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/dashboard/autopilot/
git commit -m "feat(ui): add autopilot overview page with stats and manual trigger"
```

---

### Task 21: Review Queue Page

**Files:**
- Create: `apps/web/app/dashboard/autopilot/review/page.tsx`

- [ ] **Step 1: Create review queue page**

Create `apps/web/app/dashboard/autopilot/review/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Check, X, Image as ImageIcon } from "lucide-react";

export default function ReviewQueuePage() {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const utils = trpc.useUtils();

  const { data: posts, isLoading } = trpc.autopilot.reviewQueue.useQuery({ limit: 50 });
  const approveMutation = trpc.autopilot.approvePost.useMutation({
    onSuccess: () => utils.autopilot.reviewQueue.invalidate(),
  });
  const rejectMutation = trpc.autopilot.rejectPost.useMutation({
    onSuccess: () => utils.autopilot.reviewQueue.invalidate(),
  });
  const bulkApproveMutation = trpc.autopilot.bulkApprove.useMutation({
    onSuccess: () => {
      setSelectedIds([]);
      utils.autopilot.reviewQueue.invalidate();
    },
  });
  const bulkRejectMutation = trpc.autopilot.bulkReject.useMutation({
    onSuccess: () => {
      setSelectedIds([]);
      utils.autopilot.reviewQueue.invalidate();
    },
  });

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>;
  }

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const sensitivityColor = (s: string) => {
    if (s === "HIGH") return "destructive";
    if (s === "MEDIUM") return "secondary";
    return "outline";
  };

  return (
    <div className="space-y-4">
      {selectedIds.length > 0 && (
        <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
          <span className="text-sm font-medium">{selectedIds.length} selected</span>
          <Button
            size="sm"
            onClick={() => bulkApproveMutation.mutate({ autopilotPostIds: selectedIds })}
            disabled={bulkApproveMutation.isPending}
          >
            <Check className="mr-1 h-4 w-4" /> Approve All
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => bulkRejectMutation.mutate({ autopilotPostIds: selectedIds })}
            disabled={bulkRejectMutation.isPending}
          >
            <X className="mr-1 h-4 w-4" /> Reject All
          </Button>
        </div>
      )}

      {!posts?.length && (
        <div className="text-center p-8 text-muted-foreground">
          No posts pending review
        </div>
      )}

      <div className="grid gap-4">
        {posts?.map((ap) => (
          <Card key={ap.id}>
            <CardContent className="p-4">
              <div className="flex gap-4">
                <Checkbox
                  checked={selectedIds.includes(ap.id)}
                  onCheckedChange={() => toggleSelect(ap.id)}
                />

                {/* Image preview */}
                <div className="w-24 h-24 bg-muted rounded flex items-center justify-center shrink-0">
                  {ap.post?.mediaUrls?.[0] ? (
                    <img
                      src={ap.post.mediaUrls[0]}
                      alt=""
                      className="w-full h-full object-cover rounded"
                    />
                  ) : (
                    <ImageIcon className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={sensitivityColor(ap.sensitivity)}>
                      {ap.sensitivity}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      Score: {ap.trendScore}
                    </span>
                    <span className="text-sm font-medium">{ap.agent.name}</span>
                  </div>
                  <p className="font-medium text-sm mb-1">{ap.trendingItem.title}</p>
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {ap.post?.content?.slice(0, 200)}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 shrink-0">
                  <Button
                    size="sm"
                    onClick={() => approveMutation.mutate({ autopilotPostId: ap.id })}
                    disabled={approveMutation.isPending}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => rejectMutation.mutate({ autopilotPostId: ap.id })}
                    disabled={rejectMutation.isPending}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/dashboard/autopilot/review/
git commit -m "feat(ui): add autopilot review queue page with bulk actions"
```

---

### Task 22: Trending Feed Page

**Files:**
- Create: `apps/web/app/dashboard/autopilot/trending/page.tsx`

- [ ] **Step 1: Create trending feed page**

Create `apps/web/app/dashboard/autopilot/trending/page.tsx`:

```tsx
"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ExternalLink } from "lucide-react";

export default function TrendingFeedPage() {
  const { data, isLoading } = trpc.autopilot.trendingItems.useQuery({ limit: 50 });

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>;
  }

  const sourceColor = (s: string) => {
    const colors: Record<string, string> = {
      GOOGLE_NEWS: "bg-blue-100 text-blue-800",
      NEWSAPI: "bg-green-100 text-green-800",
      REDDIT: "bg-orange-100 text-orange-800",
      TWITTER: "bg-sky-100 text-sky-800",
      RSS: "bg-purple-100 text-purple-800",
    };
    return colors[s] || "bg-gray-100 text-gray-800";
  };

  return (
    <div className="space-y-4">
      {!data?.items.length && (
        <div className="text-center p-8 text-muted-foreground">
          No trending items yet. Pipeline runs every 15 minutes.
        </div>
      )}

      {data?.items.map((item) => (
        <Card key={item.id}>
          <CardContent className="p-4">
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs px-2 py-0.5 rounded ${sourceColor(item.sourceType)}`}>
                    {item.sourceType}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.sourceName}</span>
                  <Badge variant="outline">Score: {Math.round(item.trendScore)}</Badge>
                  <Badge variant={item.status === "POSTED" ? "default" : "secondary"}>
                    {item.status}
                  </Badge>
                </div>
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-sm hover:underline flex items-center gap-1"
                >
                  {item.title}
                  <ExternalLink className="h-3 w-3" />
                </a>
                {item.summary && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{item.summary}</p>
                )}
                <div className="flex gap-1 mt-2">
                  {item.topics.map((t) => (
                    <Badge key={t} variant="outline" className="text-xs">{t}</Badge>
                  ))}
                </div>
              </div>
              <div className="text-xs text-muted-foreground shrink-0">
                {new Date(item.publishedAt).toLocaleString()}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/dashboard/autopilot/trending/
git commit -m "feat(ui): add autopilot trending feed page"
```

---

### Task 23: Account Groups Page

**Files:**
- Create: `apps/web/app/dashboard/autopilot/accounts/page.tsx`

- [ ] **Step 1: Create account groups page**

Create `apps/web/app/dashboard/autopilot/accounts/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function AccountGroupsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [topics, setTopics] = useState("");
  const [postsPerDay, setPostsPerDay] = useState(3);
  const [skipReview, setSkipReview] = useState(false);

  const utils = trpc.useUtils();
  const { data: groups, isLoading } = trpc.accountGroup.list.useQuery();
  const createMutation = trpc.accountGroup.create.useMutation({
    onSuccess: () => {
      setShowCreate(false);
      setName("");
      setTopics("");
      utils.accountGroup.list.invalidate();
    },
  });
  const deleteMutation = trpc.accountGroup.delete.useMutation({
    onSuccess: () => utils.accountGroup.list.invalidate(),
  });

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Account Groups</h2>
        <Dialog open={showCreate} onOpenChange={setShowCreate}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="mr-2 h-4 w-4" /> New Group</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Account Group</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tech Pages" />
              </div>
              <div>
                <Label>Topics (comma-separated)</Label>
                <Input value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="tech, ai, startup" />
              </div>
              <div>
                <Label>Posts Per Day</Label>
                <Input type="number" value={postsPerDay} onChange={(e) => setPostsPerDay(+e.target.value)} min={1} max={10} />
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={skipReview} onCheckedChange={setSkipReview} />
                <Label>Skip review gate (auto-approve all)</Label>
              </div>
              <Button
                onClick={() => createMutation.mutate({
                  name,
                  topics: topics.split(",").map((t) => t.trim()).filter(Boolean),
                  postsPerDay,
                  skipReviewGate: skipReview,
                })}
                disabled={!name || createMutation.isPending}
              >
                Create Group
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {!groups?.length && (
        <div className="text-center p-8 text-muted-foreground">
          No account groups yet. Create one to organize your agents.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {groups?.map((group) => (
          <Card key={group.id}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{group.name}</CardTitle>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => deleteMutation.mutate({ id: group.id })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  <span>{group.agents.length} agents</span>
                </div>
                <div>Topics: {group.topics.join(", ") || "None"}</div>
                <div>Posts/day: {group.postsPerDay}</div>
                <div>Score threshold: {group.trendScoreThreshold}</div>
                <div>Auto-approve: {group.skipReviewGate ? "Yes" : "No"}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/dashboard/autopilot/accounts/
git commit -m "feat(ui): add account groups management page"
```

---

### Task 24: Pipeline Logs Page

**Files:**
- Create: `apps/web/app/dashboard/autopilot/logs/page.tsx`

- [ ] **Step 1: Create logs page**

Create `apps/web/app/dashboard/autopilot/logs/page.tsx`:

```tsx
"use client";

import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

export default function PipelineLogsPage() {
  const { data: runs, isLoading } = trpc.autopilot.pipelineRuns.useQuery({ limit: 20 });

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>;
  }

  return (
    <div className="space-y-4">
      {!runs?.length && (
        <div className="text-center p-8 text-muted-foreground">
          No pipeline runs yet.
        </div>
      )}

      {runs?.map((run) => (
        <Card key={run.id}>
          <CardContent className="p-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <Badge variant={run.status === "COMPLETED" ? "default" : run.status === "FAILED" ? "destructive" : "secondary"}>
                  {run.status}
                </Badge>
                <span className="text-sm">
                  {new Date(run.startedAt).toLocaleString()}
                </span>
              </div>
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>Discovered: {run.itemsDiscovered}</span>
                <span>Scored: {run.itemsScored}</span>
                <span>Generated: {run.postsGenerated}</span>
                <span>Approved: {run.postsApproved}</span>
                <span>Scheduled: {run.postsScheduled}</span>
                {run.postsFailed > 0 && (
                  <span className="text-red-500">Failed: {run.postsFailed}</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/dashboard/autopilot/logs/
git commit -m "feat(ui): add pipeline logs page"
```

---

### Task 25: Add Autopilot to Dashboard Navigation

**Files:**
- Modify: The sidebar/navigation component (find the existing nav that lists "Agents", "Posts", "RSS", etc.)

- [ ] **Step 1: Find and update the sidebar navigation**

Search for the existing sidebar component that contains links to `/dashboard/agents`, `/dashboard/posts`, etc. Add a new entry:

```tsx
{
  name: "Autopilot",
  href: "/dashboard/autopilot",
  icon: Zap, // or Bot, or Rocket from lucide-react
}
```

- [ ] **Step 2: Commit**

```bash
git add <sidebar-file>
git commit -m "feat(ui): add Autopilot link to dashboard navigation"
```

---

## Chunk 8: Integration Testing & Build Verification

### Task 26: Build and Verify All Packages

- [ ] **Step 1: Build all packages**

Run: `pnpm build`
Expected: All packages build successfully

- [ ] **Step 2: Run existing tests**

Run: `pnpm test`
Expected: All existing tests still pass

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit` (or equivalent typecheck script)
Expected: No type errors

- [ ] **Step 4: Commit any fixes**

If any build/type issues found, fix and commit.

---

### Task 27: Write Integration Tests for Pipeline

**Files:**
- Create: `packages/ai/src/__tests__/trend-scorer.test.ts`
- Create: `packages/ai/src/__tests__/sensitivity-classifier.test.ts`
- Create: `packages/ai/src/__tests__/topic-extractor.test.ts`

- [ ] **Step 1: Write trend scorer tests**

```typescript
import { describe, it, expect } from "vitest";
import {
  calculateRecencyScore,
  calculateSourceCredibility,
  calculateNicheRelevance,
  calculateTrendScore,
} from "../tools/trend-scorer";

describe("calculateRecencyScore", () => {
  it("returns 100 for items less than 1 hour old", () => {
    expect(calculateRecencyScore(new Date())).toBe(100);
  });

  it("returns 0 for items over 24 hours old", () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(calculateRecencyScore(old)).toBe(0);
  });
});

describe("calculateSourceCredibility", () => {
  it("returns high score for Reuters", () => {
    expect(calculateSourceCredibility("Reuters")).toBe(95);
  });

  it("returns default for unknown source", () => {
    expect(calculateSourceCredibility("random-blog.com")).toBe(50);
  });

  it("returns reddit score for subreddits", () => {
    expect(calculateSourceCredibility("r/technology")).toBe(55);
  });
});

describe("calculateNicheRelevance", () => {
  it("returns high score for matching topics", () => {
    expect(calculateNicheRelevance(["tech", "ai"], ["tech", "startup"])).toBeGreaterThan(0);
  });

  it("returns 20 for empty topics", () => {
    expect(calculateNicheRelevance([], ["tech"])).toBe(20);
  });
});

describe("calculateTrendScore", () => {
  it("returns a score between 0 and 100", () => {
    const score = calculateTrendScore({
      publishedAt: new Date(),
      sourceName: "Reuters",
      itemTopics: ["tech"],
      agentTopics: ["tech"],
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Write sensitivity classifier tests**

```typescript
import { describe, it, expect } from "vitest";
import { classifySensitivity } from "../tools/sensitivity-classifier";

describe("classifySensitivity", () => {
  it("returns HIGH for political content", () => {
    expect(classifySensitivity("President announces new policy")).toBe("HIGH");
  });

  it("returns HIGH for violence content", () => {
    expect(classifySensitivity("10 killed in explosion")).toBe("HIGH");
  });

  it("returns MEDIUM for controversial content", () => {
    expect(classifySensitivity("Company faces boycott over controversy")).toBe("MEDIUM");
  });

  it("returns LOW for neutral content", () => {
    expect(classifySensitivity("New iPhone 17 features revealed")).toBe("LOW");
  });
});
```

- [ ] **Step 3: Write topic extractor tests**

```typescript
import { describe, it, expect } from "vitest";
import { extractTopics, generateTitleHash } from "../tools/topic-extractor";

describe("extractTopics", () => {
  it("extracts tech topics", () => {
    const topics = extractTopics("Google launches new AI model");
    expect(topics).toContain("tech");
  });

  it("returns general for unclassifiable content", () => {
    const topics = extractTopics("Something happened somewhere");
    expect(topics).toContain("general");
  });
});

describe("generateTitleHash", () => {
  it("generates same hash for similar titles", () => {
    const h1 = generateTitleHash("The New iPhone is Amazing!");
    const h2 = generateTitleHash("the new iphone is amazing");
    expect(h1).toBe(h2);
  });

  it("generates different hashes for different titles", () => {
    const h1 = generateTitleHash("iPhone launch event");
    const h2 = generateTitleHash("Samsung Galaxy release date");
    expect(h1).not.toBe(h2);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd packages/ai && pnpm test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/__tests__/
git commit -m "test: add unit tests for trend scorer, sensitivity classifier, and topic extractor"
```

---

### Task 28: Final Build and End-to-End Verification

- [ ] **Step 1: Full project build**

Run: `pnpm build`

- [ ] **Step 2: Run all tests**

Run: `pnpm test`

- [ ] **Step 3: Verify database migration applies cleanly**

Run: `cd packages/db && npx prisma migrate status`
Expected: All migrations applied

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: fix build and test issues for autopilot pipeline"
```
