# @dashmani/social-scrapers

Reusable, **dependency-free** TypeScript scrapers for social-platform **follower counts**
(account growth) and **per-post engagement** (views / likes / comments). Extracted from a
production system that tracks tens of thousands of links across ~450 accounts.

- **No database, no ORM, no env coupling.** Every function takes an optional
  `ScraperOptions` object — you inject `fetch`, telemetry, timeout, and logging.
- **Fail-open by contract.** Every function returns `null` on any miss / block / timeout
  and **never throws**. A scrape can only ever *improve* your data, never corrupt it —
  on a miss you keep whatever value you already had.
- **No credentials required** for the scrapers (YouTube-API and Meta-Graph paths are
  optional upgrades that need a key/token). The scrapers read only public data.

> ⚠️ **Scrapers depend on live HTML/JSON shapes that platforms change without notice.**
> Verify each one **from the same network origin you'll run it on** before trusting it in
> production — a datacenter IP can hit different login walls than a residential IP. This is
> not a "set and forget" library; it is a set of *currently-working techniques* with the
> hard-won parsing rules baked in.

---

## What's included

| Platform  | Follower count | Per-post engagement | Technique |
|-----------|:---:|:---:|---|
| **YouTube**   | ✅ scrape **or** API | — | HTML `accessibilityLabel`, or Data API v3 (`channels.list`) |
| **Instagram** | ✅ scrape **or** Graph | captions via Graph | `web_profile_info` JSON endpoint, or Graph `business_discovery` |
| **Facebook**  | ✅ scrape | ✅ reel views/likes/comments | `og:description` (Devanagari-aware), reel HTML JSON |
| **Snapchat**  | ✅ scrape | ✅ Spotlight views/comments/shares | JSON-LD `FollowAction`, Spotlight `__NEXT_DATA__` |
| **X / Twitter** | ✅ (guest token) | — | anonymous guest-token GraphQL `UserByScreenName` |

**No scrapeable path exists** for: TikTok (client-rendered SPA), LinkedIn (HTTP 999 on bot
UAs), or per-post likes on Instagram/Snapchat Stories. Those need manual entry.

---

## Install & build

```bash
npm install          # dev-deps only (typescript, @types/node)
npm run build        # → dist/  (ESM + .d.ts)
npm run typecheck    # strict, no emit
```

Node ≥ 18 (uses global `fetch`).

---

## Quick start

```ts
import {
  scrapeFollowerCount,        // one-call dispatcher (per account)
  scrapeEngagement,           // one-call dispatcher (per post)
  fetchTwitterFollowerMap,    // batch X handles with one guest token
  scrapeFacebookReelEngagement,
} from "@dashmani/social-scrapers";

// Follower count — routes to the right platform scraper, always fail-open:
const yt = await scrapeFollowerCount({ platform: "youtube", handle: "MrBeast", profileUrl: "https://www.youtube.com/@MrBeast" });
// → { followers: 320000000 } or { followers: null } on a miss

// Per-post engagement (Facebook reel / Snapchat spotlight only):
const eng = await scrapeEngagement("facebook", "1234567890123456");
// → { views, likes, comments, shares: null, caption }

// X/Twitter is batch-oriented — activate ONE guest token, reuse for ~150 handles:
const xMap = await fetchTwitterFollowerMap(["NASA", "elonmusk"]);
// → Map { "nasa" => 71000000, "elonmusk" => 200000000 }
```

### Injecting options

```ts
const opts = {
  fetchImpl: myProxyFetch,                       // default: global fetch
  onUsage: (u) => costSheet.record(u),           // default: no-op
  timeoutMs: 15_000,                             // default: 12_000
  logger: myLogger,                              // default: console (pass null to silence)
};
await scrapeSnapchatFollowers("bollywoodsociety", "https://snapchat.com/t/abc123", opts);
```

---

## The scrapers, one by one

### YouTube — followers
Two paths. **Prefer the API if you have a key.**

```ts
// Zero-key HTML scrape:
import { scrapeYouTubeSubscribers } from "@dashmani/social-scrapers";
await scrapeYouTubeSubscribers("https://www.youtube.com/@Handle");   // → number | null

// Official Data API v3 (batched, exact):
import { fetchYouTubeSubscriberCounts } from "@dashmani/social-scrapers";
await fetchYouTubeSubscriberCounts(
  [{ id: "acc1", handle: "UCX6OQ3DkcsbYNE6H8uQQuVA", profileUrl: "" }],
  { apiKey: process.env.YOUTUBE_API_KEY },
);
```
- **HTML gotcha:** the channel's own count is the `accessibilityLabel` mentioning
  "subscribers" — the sidebar's `subscriberCountText` is a *different* channel's number.
- **API gotcha:** `channels.list` costs 1 quota unit; `search.list` costs **100**. Resolve
  by channel ID whenever possible; `forHandle` is unreliable and often returns empty.
  `subscriberCount` is a **string** — always `parseInt`. Hidden counts → skip (never `0`).

### Instagram — followers + captions
```ts
// Zero-key public web endpoint (rate-limited hard from datacenter IPs):
import { scrapeInstagramFollowers } from "@dashmani/social-scrapers";
await scrapeInstagramFollowers("natgeo");   // → number | null

// Meta Graph business_discovery (ToS-compliant, needs a System-User token):
import { fetchPublicInstagramFollowerMap, fetchPublicInstagramCaptions } from "@dashmani/social-scrapers";
await fetchPublicInstagramFollowerMap(["natgeo"], { token: process.env.META_SYSTEM_USER_TOKEN });
```
- **Scrape gotcha:** the magic headers are `User-Agent: Instagram 275.0.0.27.98` +
  `X-IG-App-ID: 936619743392459`. IG rate-limits (429/401) fast from a datacenter IP — the
  scraper backs off once, then marks the whole run rate-limited. Call
  `resetInstagramRateLimit()` before a new batch. Good for a handful of accounts, not thousands.
- **Graph gotcha (⚠️ live-only):** `business_discovery` is a **two-step** call (find one
  administered IG node, then query by username). **Never** use the nested
  `instagram_business_account{id}` sub-selection — the live API returns only `{id}` for the
  bare field and 500s for the nested form. Always live-probe against the real token; mocks
  can't catch a field-shape lie.

### Facebook — followers + reel engagement
```ts
import { scrapeFacebookFollowers, scrapeFacebookReelEngagement } from "@dashmani/social-scrapers";
await scrapeFacebookFollowers("https://facebook.com/profile.php?id=100...", "pagehandle");
await scrapeFacebookReelEngagement("1234567890123456");   // numeric reel id only
```
- **Follower gotcha:** numeric-ID profiles resolve via the **mobile** site (mobile-Safari
  UA, un-walled); vanity slugs resolve via `www.facebook.com` with a **Googlebot** UA
  (default UAs get a login wall / HTTP 400). Indian Pages localise the count to **Devanagari
  digits** — decoded automatically.
- **Reel gotcha (⚠️ the "7476 likes on 46 reels" bug):** a reel page is a **feed** of ~22
  recommended reels. Read only **target-scoped** fields:
  - `views` = `video_view_count` (single-occurrence; verified 5/5 EXACT vs Graph). **Never**
    `play_count` — that's per-carousel-reel noise, unstable across fetches.
  - `comments` = `total_comment_count` (single-occurrence).
  - `likes` = parsed from the **og:title** share-preview (`"… · 264 प्रतिक्रिया | …"`),
    Devanagari- and Hindi-unit aware. Null when og:title has no reactions segment — an
    honest null beats a wrong carousel number.

### Snapchat — followers + Spotlight engagement
```ts
import { scrapeSnapchatFollowers, scrapeSnapchatSpotlightEngagement } from "@dashmani/social-scrapers";
await scrapeSnapchatFollowers("handle", "https://snapchat.com/t/abc123");   // pass the /t/ link
await scrapeSnapchatSpotlightEngagement("W7_EDlXWTBiXAEEniNoMPwAAYcnJu...");
```
- **Follower gotcha:** the count lives on the `/p/<uuid>` page reached via the stored
  `/t/<code>` share link (**not** `/add/<handle>`, which 404s for most real accounts). Parsed
  from JSON-LD `FollowAction` (whose `interactionType` is an **object**, not a string) +
  inline `"subscriberCount":"N"`.
- **Engagement gotcha:** **only** the `/spotlight/<id>` page exposes engagement. On a
  `/p/<uuid>/<storyId>` **Story** page the counts are sentinels (`"viewCount":"-1"`) — never
  parse them. On a spotlight page, read `spotlightStories[0]` **only** (index 1..24 are
  recommended neighbors). Snapchat exposes **no public like metric** → `likes` is **always
  null**.

### X / Twitter — followers
```ts
import { fetchTwitterFollowerMap } from "@dashmani/social-scrapers";
await fetchTwitterFollowerMap(["NASA", "elonmusk"]);   // one guest token, reused for the batch
```
- **Gotcha (⚠️ rotates):** both the public bearer token **and** the GraphQL query id
  (`UserByScreenName`) rotate periodically on X's side. If it fails across the board it is
  almost certainly **not** a code bug — re-probe live (twitter.com devtools → network tab)
  and update the two constants in `src/twitter.ts`. One guest token is good for ~150 calls;
  activate once per batch.

---

## Design contract (read this before modifying anything)

1. **Fail-open, always.** Any non-200 / login wall / short body / parse miss / timeout /
   throw → `null` (or `{ followers: null }` / all-null engagement), **never** a throw and
   **never** a wrong number. A `walled: true` flag distinguishes a hard block from "loaded
   but no data" so callers can short-circuit after N consecutive walls.
2. **Target-scoping over first-match.** Feed pages (FB reels, SC spotlights) carry many
   posts' data. Only read fields that are single-occurrence for the target, or explicitly
   read index 0. `play_count` / loose `reaction_count` / `viewCount` on a Story page are
   traps — see each platform's note.
3. **Honest null over fabricated zero.** A metric a platform genuinely doesn't publish
   (Snapchat likes; a low-engagement FB reel's likes) is `null`, not `0`. When you format
   these, render `—`, not `0`.
4. **Indian-locale aware.** Counts may arrive as Devanagari digits (`१,४१,६३,०५२`) and
   Hindi units (लाख = 1e5, करोड़/कोटी = 1e7). `parseCount` / `devanagariToAscii` handle both.
5. **Verify from the deploy IP.** Residential success ≠ datacenter success.

---

## API surface (exports)

**Dispatchers:** `scrapeFollowerCount`, `scrapeEngagement`
**YouTube:** `scrapeYouTubeSubscribers`, `parseYouTubeChannelHtml`, `parseYouTubeSubscribers`, `fetchYouTubeSubscriberCounts`, `scrapeYouTubeFollowers`
**Instagram:** `scrapeInstagramFollowers`, `resetInstagramRateLimit`, `fetchPublicInstagramFollowerMap`, `fetchPublicInstagramCaptions`
**Facebook:** `scrapeFacebookFollowers`, `scrapeFacebookReelEngagement`, `parseFbReelHtml`
**Snapchat:** `scrapeSnapchatFollowers`, `parseSnapchatProfileHtml`, `snapchatCandidateUrls`, `scrapeSnapchatSpotlightEngagement`, `parseSnapchatSpotlightHtml`
**Twitter:** `fetchTwitterFollowerMap`, `parseTwitterFollowersResponse`
**Meta Graph:** `graphFetch`, `metaConfigured`, `getMetaToken`, `isRateLimitError`
**Shared:** `parseCount`, `devanagariToAscii`, `decodeHtmlEntities`, `GOOGLEBOT_UA`, types `ScraperOptions` / `FollowerResult` / `EngagementResult`

The `parse*Html` / `parse*Response` functions are **pure and synchronous** — unit-test them
with captured fixture HTML/JSON, no network.
