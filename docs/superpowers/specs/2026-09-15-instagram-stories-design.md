# Instagram Stories in Content Studio — design

**Date:** 2026-09-15 · **Branch:** `feat/instagram-stories-2026-09-15` · **Status:** approved for implementation (autonomous session — assumptions listed in §9; owner may override any of them after the fact)

## 1. Goal

Let a user publish an image or a video as an **Instagram Story** from Content Studio → Compose, to one or many connected Instagram accounts at once, optionally **tagging people** (`@username` mentions), as a mode that is visibly distinct from a normal post and cannot accidentally also create a feed post on the same channel.

Non-goals (v1): Facebook Page stories; story stickers (link/poll/location — Meta's API does not support them); multi-media story sequences; editing a story post after creation; stories from the Super Agent / Bulk / Repurpose tabs.

## 2. Ground truth this design rests on

**Meta Content Publishing API (docs fetched 2026-09-15, "Updated Aug 12 2026"):**

| fact | consequence |
|---|---|
| `POST /{ig-user}/media` with `media_type=STORIES` + `image_url` **or** `video_url` | image stories are one param away from the existing feed-image container |
| `user_tags=[{username}]` — "Required for user tagging in images, videos, **and stories**"; `x`/`y` are **optional for stories** | tagging is a real API feature, not a visual hack; we send usernames only |
| Story limitations: "Publishing stickers … is not supported; however **mentioning users without a sticker is supported**" | exactly what was asked |
| `collaborators`, `alt_text`, `cover_url` — **not supported for stories** | never send them on a STORIES container (cover already gated by `supportsInstagramCover`) |
| Image story: JPEG, ≤8MB, 9:16 recommended. Video story: MP4/MOV, **3–60s**, ≤100MB, ≤1920px wide | client + server pre-flight copy; IG remains the authoritative validator |
| Stories **expire after 24h**; `GET /{ig-user}/media` does **not** list stories — `GET /{ig-user}/stories` does | (a) analytics after 24h is pointless; (b) duplicate-prevention reconciliation must not use `/media` for stories |
| Rate limit: 100 API publishes / account / 24h (stories count) | unchanged; existing `enforcePlanLimit` protects the shared quota |

**Codebase (already present — reuse, do not duplicate):**

- `PostTarget.format PostFormat?` with enum `FEED|REEL|STORY|SHORT|VIDEO|CAROUSEL`; `post.create` accepts `formatByChannelId`; the publish worker merges `format` into the provider metadata ([post-publish.worker.ts](../../../apps/worker/src/workers/post-publish.worker.ts) ~L541).
- [instagram.provider.ts](../../../packages/social/src/providers/instagram.provider.ts) `publishPost` already maps `metadata.format === "STORY"` → `media_type: "STORIES"` — **for videos only**. Images always get `image_url` with no `media_type` (= FEED).
- The IG analytics path already has a `STORY` metric set (`reach,shares,views,total_interactions,replies,navigation`) keyed on `media_product_type`.
- Compose already has a per-channel "Post Format" card (Reel/Story for IG **videos**), a Groups quick-select row, platform filter pills, draft persistence via `useActiveTask`, and a shared video classifier (`isVideoMediaItem` / `VIDEO_EXT_RE`).
- Duplicate-prevention: `publishContainer` → on an indeterminate `media_publish` outcome → `findPublishedMatch` (caption match via `/media`) → else `AmbiguousPublishError` (human check). `captionsMatch` returns **false** for an empty caption.
- `diagnoseMetaError` returns `undefined` for `#100` (incl. subcode 33 object-not-found) → an **expired story never produces a `needs_reconnect` verdict**. Good — no health-banner work needed.

## 3. Approaches considered

1. **Post-level "Story" mode reusing `PostTarget.format = STORY` on every target + `Post.metadata.instagramStory` for mentions** — *recommended*. No schema change, reuses the whole format→provider plumbing, byte-identical for every non-story post, and matches the user's mental model ("this post IS a story").
2. Extend the existing per-channel Post Format picker with a Story option for images too, plus a mentions field. Rejected: keeps Story buried inside a per-channel widget that only appears when a video is attached, does not stop the same submit from also feed-posting to other channels, and cannot express "only Instagram channels" for groups.
3. A separate "Stories" tab in Content Studio. Rejected: duplicates the media/schedule/channel UI; the request is for a toggle within Compose.

## 4. Data contract

No Prisma schema change.

| where | value | meaning |
|---|---|---|
| `PostTarget.format` | `"STORY"` on **every** target of a story post | the worker already forwards it as `metadata.format` |
| `Post.metadata.instagramStory` | `{ mentions: string[] }` (usernames without `@`, deduped, ≤20, each `^[A-Za-z0-9._]{1,30}$`) | present **only** for story posts; `mentions` may be `[]` |
| `post.create` input | new optional `story: { mentions: string[] }` | presence of `story` = story mode |

`post.create` in story mode:
- `content` may be **empty** (schema relaxed to `z.string()`; a manual "Content is required" check keeps the old rule for non-story posts).
- every `channelId` must be `INSTAGRAM` (else `BAD_REQUEST` naming the offending channels).
- `mediaIds.length` must be exactly **1** when `scheduledAt` is set; ≤1 for drafts.
- `formatByChannelId` and `uniqueCaptions` from the client are **ignored** (server forces `format: "STORY"`, `uniqueCaptions: false`).
- `metadata.videoThumbnail` is dropped (covers are reels-only; the provider gate already refuses it, so this is belt-and-braces).
- mentions are normalized server-side (`normalizeStoryMentions`); invalid usernames → `BAD_REQUEST` naming them.

`post.update` with `channelIds` on a story post (`existing.metadata.instagramStory` present): the same IG-only check, and recreated targets get `format: "STORY"`. Non-story posts are byte-identical to today.

## 5. Publish path (packages/social + worker)

`InstagramProvider.publishPost`:
```
isStory = metadata.format === "STORY"
if mediaUrls.length > 1:
    if isStory → throw "An Instagram story takes exactly one image or video (N attached)"   // before any network call
    else carousel (unchanged)
video:  media_type = isStory ? STORIES : REELS        // unchanged
image:  image_url; + media_type = "STORIES" when isStory   // NEW (absent ⇒ byte-identical FEED request)
isStory && mentions.length > 0 → user_tags = [{username}, …]   // NEW; JSON array in the JSON body, same shape as `children`
```
- `buildStoryUserTags(metadata)` (pure, `packages/social/src/utils/instagram-story.ts`) re-validates every username against the same regex (defense in depth — metadata comes from the DB) and returns `null` when there is nothing to send, so the non-tagged request stays byte-identical.
- `caption` keeps being sent exactly as the existing video-story path does (Meta ignores it on stories; changing it would alter the frozen request).
- **Published URL**: for a story, the `permalink` fetch is tried first; fallback `https://www.instagram.com/stories/{channelUsername}/{id}/` (the worker adds `channelUsername` to provider metadata **only when `format === "STORY"`**, so non-story metadata is unchanged).
- **Duplicate prevention for stories** (three-outcome contract preserved):
  - post-write indeterminate outcome → `findPublishedStory` reads `GET /{ig-user}/stories?fields=id,timestamp,media_type,permalink`; candidates = stories with `timestamp ≥ windowStart` and matching media kind (IMAGE/VIDEO). **Exactly one** candidate ⇒ adopt; zero or several ⇒ `AmbiguousPublishError` (human check). A degraded/unreadable listing ⇒ throw (cannot tell). Never consults `/media` (a same-caption FEED post must never be adopted as the story).
  - pre-write `findExistingPost` for a story ⇒ `null` (the window starts at `post.createdAt`, which for a scheduled post spans days of manual stories — adopting there is the expensive mistake). This is the documented empty-caption risk level, stated in code.
- **Worker**: skip the "auto-generate an AI image when IG has no media" branch when `postTarget.format === "STORY"` (a story must be the user's media; the provider then fails with the clear "requires at least one image or video" message instead of publishing an AI image as a story).

## 6. Analytics (worker + cron)

Stories expire after 24h, so:
- at-age checkpoints for a `STORY` target: **only `24h`** (`atAgeWindowsForFormat(format)` — pure helper); `reconcileAtAgeCheckpoints` skips the 7d/15d/30d tags for STORY targets so it does not re-enqueue what was deliberately never scheduled.
- `scheduleAnalyticsSync` (6-hourly, ≤7d) excludes STORY targets published more than 24h ago; `scheduleLongTailAnalyticsSync` (7–90d) excludes STORY entirely. Implemented as one shared Prisma `where` fragment (`excludeExpiredStoriesWhere(now)`) so the two crons cannot drift.
- Snapshots keep the existing STORY metric set. Any capture failure on an expired story is `#100` → no degradation → no reconnect nag (verified in `diagnoseMetaError`).

## 7. UI (apps/web)

**Mode switch** at the top of the Compose left column: segmented control **Post | Story** (Story shows the Instagram glyph and an "Instagram only · disappears after 24h" hint). Persisted in the compose draft (`draft.postType`, `draft.storyMentions`) and restored.

In **Story** mode:
- **Channels**: list shows only `INSTAGRAM` channels; platform pills hidden; description reads "Stories publish only to Instagram accounts". Switching into Story mode prunes non-Instagram ids from the selection (toast names how many were removed).
- **Groups row**: a group pill unions/removes only its **active Instagram** members; the count shows the Instagram count; groups with zero Instagram members are hidden. Pure helper `groupSelectableIds(group, liveChannels, mode)` shared by the pill state and the click handler so they cannot disagree.
- **Media**: copy "One image or video · 9:16 recommended · image ≤8MB JPEG, video 3–60s ≤100MB". More than one attachment shows an inline warning and blocks submit. Generate-Carousel and the per-tile Thumbnail control are hidden (covers are reels-only).
- **Text**: label "Note (optional)" + helper "Stories don't display a caption — this note is kept with the post for your records." The "Create with AI" caption card, the per-channel "Post Format" card and the "Unique caption per channel" card are hidden.
- **Tag people** card (new, story-only): chip input for usernames (`@` optional, comma/space/Enter separated), inline validation, max 20, helper "Tagged accounts must be public; Instagram notifies them. Added as mentions (no sticker)."
- **Preview**: `InstagramStoryPreview` (new component) — 9:16 frame, story progress bar, avatar + username of the first selected Instagram channel with "+N more" when several, the media (through `PreviewMedia`, so the video/image safety rules hold), mention chips over the media. Rendered **instead of** `PostPreviewSwitcher` in story mode so the five `PostPreviewProps` copies + the switcher rebuild are untouched.
- **Buttons**: "Publish story" / "Schedule story"; disabled reason from pure `storyBlockReason({ mediaCount, selectedCount, uploading })`. Content is not required.
- **Payload**: `content`, `channelIds`, `mediaIds`, `scheduledAt`, `story: { mentions }`, and `metadata.superText` if the video tile has a strip (burn works on any IG video). No `formatByChannelId`, `uniqueCaptions`, `videoThumbnail`.

**Everywhere else**: a compact **"Story"** badge next to the platform badge on post-detail target rows and on Posts-list rows when any target has `format === "STORY"` (`post.list` already includes full target rows). Publish emails already show the platform URL, which for stories is the `/stories/…` link.

## 8. Testing

Pure helpers carry the logic; each gets a vitest file, and the byte-identity of the non-story path is asserted explicitly.

| file | asserts |
|---|---|
| `packages/social/src/__tests__/instagram-story-publish.test.ts` | fetch-mocked container POST body: image story ⇒ `media_type:"STORIES"` + `image_url` + `user_tags`; video story ⇒ `STORIES`, **no** `cover_url` even with a thumbnail; no mentions ⇒ no `user_tags` key; non-story image ⇒ body identical to today; story with 2 media ⇒ throws before any fetch; `buildStoryUserTags` rejects malformed usernames |
| `packages/social/src/__tests__/instagram-story-reconcile.test.ts` | `pickStoryCandidate`: exactly-one ⇒ adopt, zero/many ⇒ inconclusive, degraded ⇒ throw; `findExistingPost` returns null for stories |
| `packages/api/src/__tests__/instagram-story-create.test.ts` | `normalizeStoryMentions`, `validateStoryPost` (non-IG channel, >1 media, 0 media when scheduling, empty content allowed), non-story input untouched |
| `apps/web/lib/instagram-story.test.ts` | `parseMentionInput`, `storySelectableChannels`, `pruneToInstagram`, `groupSelectableIds`, `storyBlockReason` |
| `apps/worker/src/__tests__/story-analytics.test.ts` | `atAgeWindowsForFormat`, `excludeExpiredStoriesWhere` |

Gates before merge: full `pnpm test`, `pnpm type-check`, `SKIP_ENV_VALIDATION=1 pnpm --filter @postautomation/web build`, the golden-render gates unchanged (0 snapshots written), and a browser walk-through of Story mode on the local dev server (mode switch, channel filtering, group pill, mentions, preview, submit disabled reasons).

## 8b. Amendments after the adversarial design review (2026-09-15)

A 4-lens review (publish safety, API validation, Compose UI, analytics) of §1–§9 against the real code produced these corrections. They supersede the matching sentences above.

**Publish idempotency — the container id is the key (replaces §5's "pre-write returns null" and "exactly-one ⇒ adopt").**
- A story has no caption to reconcile on, so §5 as written re-opened the 2026-08-18 duplicate path: provider publishes → PUBLISHED write fails → target reaped FAILED → Retry → pre-flight finds nothing → NEW container → second live story. The fix uses Meta's own idempotency primitive: an IG container's `status_code` becomes `PUBLISHED` once `media_publish` consumes it, and a container is single-use.
- `SocialPostPayload` gains an optional `onCheckpoint(patch)` callback (additive; only the IG story path calls it). The worker wires it to a best-effort merge into `PostTarget.metadata` AND into the in-memory provider metadata, so a retry — any layer — sees `metadata.igStoryContainer = { id, createdAt, kind }`.
- Story `publishPost`: if a prior container is recorded (same media kind) → `GET /{container}?fields=status_code`. `PUBLISHED` ⇒ the story IS live: identify it via `GET /{ig-user}/stories` (exactly one candidate of that kind since `createdAt` ⇒ adopt its id/permalink; otherwise return `platformPostId = containerId` with `metadata.storyMediaUnresolved = true` and the account's `/stories/{username}/` tray URL — PUBLISHED, honest, no fabricated media id). `FINISHED`/`IN_PROGRESS` ⇒ reuse the container (skip creation; `media_publish` on the same `creation_id` cannot create a second story). `ERROR`/`EXPIRED`/not-found ⇒ create a fresh one. A status read that fails for any other reason throws a plain (retryable, pre-write) error — never a guess.
- Post-write indeterminate `media_publish`: the container status is the evidence, `/stories` only identifies the media. `PUBLISHED` ⇒ identify as above; anything else ⇒ keep retrying the same container inside the loop, then `AmbiguousPublishError` (human check). The container id is already persisted, so a later "It didn't publish" → retry reuses it instead of creating a duplicate. **Never adopt a `/stories` candidate unless the container reports PUBLISHED** — a manual story, or the same IG account connected in another org, posts stories in that window.
- `findExistingPost` still returns `null` for stories, now because `publishPost` owns story idempotency via the checkpoint.

**Scope of `format === "STORY"` (corrects §9.4).** The Post-mode per-channel Reel/Story picker for videos stays, and those targets DO inherit the story publish/analytics path (STORIES container, `/stories` reconciliation, story URL, 24h analytics, no AI image, Story badge) — all improvements over today's `/p/`-URL, `/media`-reconciled, 30-day-polled behaviour. The ONE hard change (2+ media ⇒ throw instead of carousel) is keyed on the Story-**mode** marker `metadata.instagramStory`, not on `format`, so Post-mode behaviour with several media is unchanged. To stop a stale picker value from turning an IMAGE post into a story: `post.create` in Post mode persists `REEL|STORY` (IG video formats) and `SHORT|VIDEO` (YouTube) **only when the post has a video attachment**, and rejects a format whose platform does not match the channel (`STORY|REEL` ⇒ INSTAGRAM, `SHORT|VIDEO` ⇒ YOUTUBE). Compose also prunes the map at submit to selected channels and only when a video is attached.

**`post.update` carries `format` (pre-existing bug fixed).** Channel replacement recreated targets with `format: null`, silently turning a story into a REEL on "Add channel". Now each kept channel's existing `format` is carried; new channels get `STORY` on a story-mode post (and pass the IG-only check), `null` otherwise. `content` becomes optional on update for story-mode posts (the manual "Content is required" rule stays for everything else). A story-mode post that is being armed to publish (update with `scheduledAt`, `publishNow`, `bulk.bulkSchedule`) must hold exactly one media; the worker remains the backstop (no AI image for STORY ⇒ clear failure).

**Server-side hardening.** `metadata.instagramStory` is stripped from the client's passthrough metadata (the only writer is the `story` input path). Mention rejection by Meta at container creation (private/non-existent username) is wrapped in an actionable message naming the tags; it fails pre-write, so it is duplicate-safe.

**Analytics (corrects §6).**
- `#10 "Not enough viewers for the media to show insights"` is what Meta returns for a story under 5 viewers; it is in `MISSING_SCOPE_CODES` and would have raised a false `needs_reconnect` banner. `diagnoseMetaError` now returns no degradation for that message.
- The story at-age checkpoint fires at **23h** (tagged `24h` — the last hour of the story's life, before Meta withdraws metrics); `reconcileAtAgeCheckpoints` skips STORY targets entirely (a late 24h capture is post-expiry by definition).
- The recurring-pass exclusion is an explicit **`OR: [{format: null}, {format: {not: "STORY"}}, {format: "STORY", publishedAt ≥ now−24h}]`**. The obvious `NOT {format: "STORY", publishedAt < x}` is a NULL trap: for a legacy target `format IS NULL`, `NOT (NULL AND TRUE)` is NULL and the row is dropped — every pre-existing target would silently leave both analytics passes. Verified against the local Postgres before merge.
- The fragment lives in **`packages/queue`** (like `insights-population.ts`) so `analytics.triggerSync` ("Sync Now") applies the same exclusion as the worker crons.
- Story captures declare `likes`/`comments`/`saved` **unavailable** (Meta lists those insight metrics for FEED/REELS only), the ladder does not descend past the STORY set (BASE_SET would 400 with certainty), and the media-fields read retries with `fields=media_product_type` alone if `like_count` is rejected on the node.
- Reports: the at-age arm excludes STORY rows for the 7d/15d/30d windows (`pt.format IS DISTINCT FROM 'STORY' OR window = '24h'` — a story never has those checkpoints and would render as a permanent "—" row indistinguishable from a missed capture); both SQL arms select `format` so Reports rows carry a Story badge.

**Compose (additions to §7).** `youtubeBlockReason` is gated off in Story mode; the platform filter is ignored (not reset) in Story mode and its `· PLATFORM` label hidden; the draft-task label/description say "story"; the image input is single-select in Story mode; a cover set in Post mode is not shown on the tile in Story mode (it is never sent); `createPost.onSuccess` clears mentions; the contract tests that pin ComposeTab source text (`thumbnail-ui-contract.test.ts`, `super-text-create.test.ts`) are respected by WRAPPING existing expressions in conditionals, never rewriting them. Empty story content renders as "Instagram story" (never a blank title) in the Posts list, Bulk tab and post-detail header; the post-detail "Add channel" row offers only Instagram channels on a story post.

## 9. Assumptions made in this autonomous session

1. Story = **exactly one** image or video per post (Meta's container model; multi-story sequences are out of scope).
2. Stories are **Instagram-only**; Facebook Page stories are not built.
3. Mentions are **post-level** (the same tags go to every selected account), per the request "post the same story (also tagging individuals) to multiple connected instagram channels".
4. The existing per-channel Reel/Story picker for videos in **Post** mode is left as is (it is an existing, working path); Story **mode** is the distinct, first-class way to post stories.
5. A caption/note is optional for a story and is not displayed by Instagram; we keep sending it in `caption` exactly as the existing video-story path does.
6. No live story is published to a real account during this session (outward-facing action); the request shape is proven by unit tests against the documented contract, and the UI by a browser walk-through.
