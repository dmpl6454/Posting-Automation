# Publish pipeline — speed, timing accuracy, multi-tenant fairness

Audit + phased plan, 2026-07-18. Phase 1 shipped on branch
`perf/publish-throughput-2026-07-18`.

## How publishing works (one paragraph)

`post.create` with `scheduledAt` writes a `SCHEDULED` Post + PostTargets and
enqueues **nothing** — the `publishScheduledPosts` cron scan finds due posts,
enqueues ONE BullMQ job per target on the `post-publish` queue, and flips the
post to `PUBLISHING`. Interactive paths (`post.publishNow`, chat
`publish_now`, newsgrid `bulkPublish`) enqueue their targets directly with
`delay: 0`. A single worker container consumes the queue; per-target
correctness is protected by the atomic `SCHEDULED→PUBLISHING` claim + the
`publishedId` short-circuit (no double-posting even with duplicate jobs).

## Measured bottlenecks (before Phase 1)

| # | Bottleneck | Effect |
|---|-----------|--------|
| 1 | Cron scan every **2 min** | every scheduled post is 0–120s late before its job even exists |
| 2 | Stagger `delay = index × 10s` blind to platform | 1 post × 60 channels: last channel publishes **~10 min** after the first, even across 60 unrelated platforms |
| 3 | Worker `concurrency: 3` + limiter `3 per 5s` (global) | max 36 job-starts/min for the WHOLE platform; 3 slow jobs (FB in its 60s-pause throttle loop, a YouTube video upload) freeze publishing for **every org** |
| 4 | `take: 50` posts per scan, no drain loop | >50 posts due in the same minute → the rest wait +2 min per extra batch |
| 5 | No priority lanes | one org's 200-target scheduled burst queues ahead of another org's "Publish now" |

### Scenario math (before → after Phase 1)

- **1 post → 60 channels (multi-platform, e.g. 6 platforms × 10 channels):**
  first channel `scheduledAt + 0–120s`, last `+ ~12 min` → first
  `+ 0–30s`, last `+ ~2 min` (worst per-platform tail: 9 × 10s for a Meta
  group). Single-platform 60-channel bursts intentionally keep the full
  10s spacing (shared Meta/X app quota — see stagger tiers).
- **60 posts × 1 channel, same minute:** spread over ~3–7 min (limiter +
  take-50) → drains in **~30–60s** (120 starts/min, drain loop).
- **Several orgs at once:** FIFO + global 3/5s limiter → interactive
  publishes now ride the unprioritized fast lane; bulk/cron/autopilot/retries
  carry explicit lower priorities; 10 concurrency slots stop the
  three-slow-jobs freeze.

## Phase 1 (SHIPPED) — pacing, fairness, cadence

1. **Platform-aware stagger** — `apps/worker/src/lib/publish-stagger.ts`
   (pure, unit-tested). Stagger only within a platform group: Meta/X 10s
   (shared app quota, FB 368 throttles last hours), other OAuth 5s,
   token-based (Telegram/Discord/…) 2s. First target of EVERY platform starts
   at delay 0.
2. **Scan cadence 2 min → 30s + drain loop** (`publishScheduledPosts`):
   batches of 50 until drained, capped at 10 batches/scan; module-level
   re-entrancy guard (the target claim already prevents double-posting;
   the guard prevents wasted duplicate jobs).
3. **Concurrency 3 → 10, limiter 3/5s → 10/5s**, env-tunable
   (`PUBLISH_CONCURRENCY`, `PUBLISH_LIMITER_MAX`).
4. **Priority lanes** (`apps/worker/src/lib/publish-priority.ts`):
   interactive publishes stay **unprioritized** (BullMQ drains the plain wait
   list before ANY prioritized job — verified against bullmq@5 moveToActive);
   cron + autopilot = `priority: 5`; rate-limit retry re-queues =
   `priority: 10`. **Invariant: do NOT add a priority to the interactive
   producers** — unprioritized IS the fast lane.

## Phase 2 (SHIPPED 2026-07-20, branch `feat/exact-time-publish-2026-07-20`) — exact-time scheduling (±2s instead of ≤30s)

A delayed job per target is enqueued **at post-creation/update time**
(`delay = scheduledAt − now` + platform stagger) with **deterministic jobIds**
`sched:{targetId}:{scheduledAtEpoch}` (exactly 3 colon segments — BullMQ
constraint). The 30s cron still runs, now as a **reconciliation sweep** using
the SAME helper → the SAME ids → BullMQ dedupes; whichever producer runs
first wins. What shipped:

- `packages/queue/src/schedule-publish.ts` — `buildScheduledPublishJobs`
  (pure, tested) + `enqueueScheduledPublishJobs`. The stagger + priority libs
  moved from `apps/worker/src/lib/` into `packages/queue/src/` so the API can
  import them.
- `post.create` and `post.update` call the helper **best-effort**
  (try/catch): a Redis blip at save time never fails the mutation — the cron
  reconciles, costing ≤30s of exactness, never the post.
- **Stale-job guard instead of `queue.remove`**: rescheduling keeps target
  ids, so old-time jobs survive — the worker checks
  `isStaleScheduleJob(job.data.enqueuedFor, post.scheduledAt)` BEFORE the
  atomic claim and skips orphans (reschedule/unschedule/publishNow/delete all
  change or null `scheduledAt`). Simpler and race-free vs. chasing job
  removal.
- Cron keeps the post-level SCHEDULED→PUBLISHING flip — it is **load-bearing
  for the rate-limit retry path** (a retried target flips back to SCHEDULED;
  the post-level flip is what keeps reconciliation from re-enqueuing it ahead
  of its long FB backoff).
- caption-fanout flips and chat `schedule_post` stay on the cron path (≤30s
  late — both already promise "within a couple of minutes").

## Phase 3 (SHIPPED 2026-07-20, branch `feat/phase3-leader-activity-2026-07-20`) — scale-out prep + activity management

- **Cron leader gate** (`CRON_LEADER`, default leader): `startCronJobs()` is
  skipped when `CRON_LEADER=false`, so additional worker replicas can be
  added later as pure queue processors without double-firing every cron.
  Single-worker deploys are unchanged.
- **Autopilot stagger** now reuses `computePublishDelays` for the channel
  dimension (was a flat `(i×channels+chIdx)×10s`); cross-post spacing within
  a run stays `i×10s`.
- **Activity management** (owner request): `Post.archivedAt` soft archive
  (view-level only — deliberately NOT a `PostStatus`; SCHEDULED/PUBLISHING
  posts refuse archiving because their delayed jobs would still publish),
  `post.archive`/`post.unarchive` mutations (org-scoped, audited),
  `post.list` gains additive `sort` (newest/oldest/recently_updated) +
  `archived` inputs (defaults byte-identical to before), PostsTab gets the
  sort dropdown + Archived tab + per-card archive buttons, ActivityPanel
  gets client-side status filter chips (All/Done/Active/Errors; header
  badges keep counting the unfiltered feed).

## Phase 4 (SHIPPED 2026-07-20, branch `feat/large-video-streaming-2026-07-20`) — large-video (3–4GB) support end to end

Creators upload 3–4GB source files for Shorts/Reels. Before this phase the
pipeline had two hard ceilings: the multipart-upload router capped videos at
500MB, and the buffer-upload platforms (YouTube resumable, X chunked,
LinkedIn instruction-chunked) downloaded the ENTIRE video into worker RAM
before uploading — a 4GB video meant 4GB of RAM per concurrent job.

- **`packages/social/src/utils/ranged-media.ts`** (pure-ish, tested):
  `headRemoteMedia` (size/type without downloading — HEAD, falling back to a
  1-byte ranged GET), `fetchByteRange` (**fail-closed**: a host that ignores
  Range and streams the full body makes it THROW rather than silently buffer
  gigabytes), `computeByteRanges`.
- **YouTube**: files ≤64MB (`YT_STREAM_THRESHOLD_BYTES`) keep the classic
  buffered path byte-for-byte (incl. buffer-based Shorts probe). Larger files
  stream: each resumable chunk (16MB) is range-fetched just before its PUT.
  Large Shorts are probed by `ffprobe <url>` directly (it range-seeks; only
  metadata atoms transfer).
- **X**: `uploadMedia` probes type/size first; videos stream 5MB APPEND
  segments range-fetched one at a time (INIT declares total_bytes, so an
  oversized file is rejected by X before any transfer). Images keep the
  buffered path.
- **LinkedIn**: init with probed size; each uploadInstruction's byte range is
  fetched individually.
- **Upload cap 500MB → 4GB** (`media.router.ts` presigned-multipart path
  only — those bytes go browser→S3 directly in 8MB parts and never transit
  the web container; the proxied small-file `/api/upload` route keeps its
  old caps because it buffers in the web process).
- **Watermark overlay gate**: IG/FB videos above `VIDEO_OVERLAY_MAX_MB`
  (default 250) skip the ffmpeg re-encode and post the original (a multi-GB
  re-encode would exhaust worker disk/CPU).
- **Watchdog large-upload fix**: a PUBLISHING post whose non-terminal target
  has a RECENT `updatedAt` (upload-progress writes touch it) is skipped, not
  failed — a 40-minute 4GB YouTube upload no longer gets falsely FAILED at
  the 30-minute mark. Idle-target semantics unchanged.
- Platform-side realities (not ours to fix): X caps video ~512MB (rejected
  at INIT, fast), IG rejects oversized Reels after ITS OWN url-pull (no
  worker bandwidth spent), YouTube happily takes multi-GB.

### Adversarial-review fixes folded in before merge (24-agent workflow, 15 findings → 5 real defects)

- **`Media.fileSize` Int→BigInt** (the critical catch): int4 caps at
  ~2.1GB — a 3GB upload would land fully in S3 then crash `media.create`
  with an int4 overflow, orphaning the object. Column widened (int8, safe
  in-place), Prisma still accepts plain numbers on write; reads return
  bigint → `Number(...)` at every arithmetic/display site (tsc-enumerated).
  `upload.complete` fileSize input also bounded (was unbounded).
- **Fail-closed guard actually fails closed now**: the 200-response branches
  in `fetchByteRange`/`headRemoteMedia` decide from the Content-Length /
  Content-Range HEADERS and `body.cancel()` unread — previously they read
  the body first, which would have materialized the full multi-GB file in
  RAM on exactly the Range-ignoring hosts the guard exists for. Tests prove
  it with never-ending mock streams (a body-read would hang the test).
- **`probeVideoUrl` is async with a 30s timeout** — a network-bound
  `execFileSync` would have blocked the whole worker event loop.
- **X + LinkedIn streamed uploads now emit `onProgress` per chunk** — that
  both surfaces upload progress AND feeds the watchdog's active-upload
  signal (only YouTube emitted progress before, so long X/LinkedIn uploads
  could still be falsely reaped).
- **Watchdog 12h hard ceiling** over the active-upload skip — a tight
  rate-limit retry loop also keeps targets fresh and would otherwise defer
  reaping forever.

### Deferred from Phase 3 (deliberate)

- **Per-platform token buckets**: the platform-aware stagger + reactive
  rate-limit re-queue + FB provider backoff already pace platform calls;
  a Redis token bucket in the processor adds real failure modes to the
  publish path for no observed need at current volume. Revisit only if a
  platform starts rejecting despite the stagger.
- **Actually adding a second worker container**: pointless on ONE VPS (same
  cores; publishing is I/O-bound and `PUBLISH_CONCURRENCY` already covers
  it). The leader gate makes it a compose-file change when a second box
  exists.
- Media pre-upload/pre-validation at schedule time — largest remaining
  per-job latency.

## Do-not-regress invariants

- Atomic target claim (`SCHEDULED/FAILED/DRAFT → PUBLISHING` updateMany) and
  `publishedId` short-circuit — the only things standing between duplicate
  jobs and duplicate live posts.
- FB worker publish paths keep the full 60s-pause/3-retry `graphFetch`
  backoff (protects the shared Meta app quota).
- Interactive producers stay unprioritized (fast lane).
- Same-platform stagger for FACEBOOK/INSTAGRAM/THREADS/TWITTER stays ≥10s.
