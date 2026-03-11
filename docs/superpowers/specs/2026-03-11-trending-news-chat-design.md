# Trending News in AI Chat — Design Spec

## Overview

Add real-time trending news from Google News RSS into the existing AI chat interface. When a user asks about trending news, the system fetches live headlines, the AI presents them, auto-drafts a social media post from the most relevant article, and generates a news card image — all within the chat. The user then confirms which platform(s) and timing before posting.

## Architecture: Server-Side Fetch on Demand

No new DB tables, no background jobs. Headlines are fetched in real-time when the user asks, injected into the AI's context, and the AI responds with headlines + drafted post + image.

Latency of ~1-2s for RSS fetch is negligible since AI streaming itself takes longer.

## Data Source

Google News RSS (free, no API key required):

- General: `https://news.google.com/rss?hl=en-US&gl=US`
- By search: `https://news.google.com/rss/search?q={query}&hl=en-US&gl=US`
- Tech topic: `https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB`
- Business topic: `https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB`

## Intent Detection

Lightweight keyword matching in the streaming route on the last user message:

```
Keywords: "trending", "news", "headlines", "what's happening", "latest news", "current events"
```

If matched, extract optional topic (e.g. "trending in **tech**" -> topic = "tech") and fetch the corresponding Google News RSS feed.

## News Image Generation

Two styles, AI picks based on context (user can override):

1. **News card** (default for factual/breaking news) — HTML template rendered to PNG via Puppeteer. Fast, free, consistent.
2. **AI-generated image** (for creative/lifestyle topics) — DALL-E. Unique but costs per generation.

### News Card Template

- 1080x1080 (Instagram) or 1200x675 (Twitter/LinkedIn) based on target platform
- Gradient background (configurable)
- Bold headline text (auto-sized)
- Source attribution
- Org logo (top-left, pulled from Organization.logo or user-uploaded)
- Date stamp and optional user handle

### Logo Support

- Default: pull from `Organization.logo` field (already exists in schema)
- Override: user can upload a different logo via chat file attachment
- Option to exclude: `includeLogo: false`

## Posting Flow

After generating news + image + post draft, the AI MUST ask:

1. Which platform(s) to post to (lists user's connected channels)
2. Post now or schedule for later
3. Confirm logo inclusion (default yes if org logo exists)

Only emit `schedule_post` action after user confirms.

## Action Payloads

### generate_news_image

```json
{
  "type": "generate_news_image",
  "payload": {
    "headline": "Article headline",
    "source": "Source name",
    "sourceUrl": "https://...",
    "imageStyle": "news_card | ai_generated",
    "includeLogo": true,
    "logoUrl": "https://storage.../org-logo.png",
    "platform": "INSTAGRAM | TWITTER | LINKEDIN | FACEBOOK",
    "content": "The accompanying post text with hashtags"
  }
}
```

## Files

### Create

| File | Purpose |
|------|---------|
| `packages/ai/src/tools/trending-news.ts` | `fetchTrendingNews(topic?)` — fetches Google News RSS, parses, returns structured headlines |
| `packages/ai/src/utils/rss-parser.ts` | Shared RSS parser extracted from worker (DRY) |
| `packages/ai/src/tools/news-image-generator.ts` | `generateNewsCardImage(options)` — renders HTML template to PNG via Puppeteer |
| `packages/ai/src/tools/news-card-template.ts` | HTML/CSS template function for the news card |

### Modify

| File | Change |
|------|--------|
| `apps/worker/src/workers/rss-sync.worker.ts` | Import parser from shared `rss-parser.ts` instead of inline |
| `packages/ai/src/chains/chat-agent.chain.ts` | Add `trendingNews?` and `orgLogo?` to ChatContext, add `generate_news_image` to action types, inject headlines into system prompt |
| `packages/ai/src/prompts/chat-agent.prompt.ts` | Add Trending News capability (#5), image generation instructions, posting confirmation flow |
| `apps/web/app/api/chat/stream/route.ts` | Detect trending intent, fetch news, load org logo, pass as context |
| `packages/api/src/routers/chat.router.ts` | Handle `generate_news_image` action — generate image, upload to storage, attach to message |
| `apps/web/components/chat/MessageBubble.tsx` | Render news image inline in chat bubble |
| `packages/ai/src/index.ts` | Export `fetchTrendingNews`, `generateNewsCardImage` |

### Dependencies

| Package | Addition |
|---------|----------|
| `packages/ai/package.json` | `puppeteer` or `puppeteer-core` for HTML-to-PNG rendering |

## No New DB Tables

- Headlines: fetched on-demand, passed through AI context, not persisted
- Generated images: stored as `Media` (existing model), attached via `ChatAttachment` (existing model)
- Posts: created via existing `Post` + `PostTarget` models

## User Flow

```
User: "What's trending in tech?"

AI: Here are today's top tech headlines:
    1. AI Startup Raises $500M — TechCrunch
    2. OpenAI Launches GPT-5 — The Verge
    3. Apple's New AR Glasses — Bloomberg
    4. Google Cloud Revenue Surges — Reuters
    5. Tesla Robotaxi Expands — CNBC

    I've drafted a post based on #1 and created a news image:

    [News card image with headline + org logo]

    "Breaking: AI startup secures massive $500M funding round...
     #AI #Funding #TechNews"

    Where would you like to post this?
    Your channels: LinkedIn (@company), Twitter (@handle), Instagram (@brand)
    Post now or schedule?

User: "Post to LinkedIn and Twitter now"

AI: Done! Posted to LinkedIn and Twitter with the news image attached.
```
