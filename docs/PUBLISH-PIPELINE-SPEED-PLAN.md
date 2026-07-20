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
