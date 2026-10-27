# TikTok video posting — design (2026-10-28)

Owner ask: "work on TikTok video posting". Owner decisions: the team connects TikTok accounts
**on a VPN** (TikTok's sign-in page redirects India to `tiktok.com/in/about`), and the TikTok app
on production has the **Content Posting API with Direct Post approved** (audited — public posts).
The production server (Mumbai) reaches `open.tiktokapis.com` fine, so token refresh and publishing
run server-side; only the consent step needs the VPN.

A 6-agent audit (`wf_1d6dca23-035`) found the existing code cannot connect or publish:

- `getProfile` and `video/init` treat TikTok's success body (`"error":{"code":"ok"}`) as a failure —
  every connect ends in "Sign-in failed"; every successful publish throws, and the worker's retry
  branches then post the video again (up to six copies; a `log_id` containing "401" is read as an
  expired token and re-publishes in the same attempt).
- The whole video is downloaded into memory and never used; the poll gives up after 75 s and a
  retry re-inits (duplicate); the post URL is `@me/video/<publish_id>` (not a real URL).
- No `creator_info/query`, privacy defaults to `SELF_ONLY`, interactions are all switched ON —
  all against TikTok's Content Sharing Guidelines, which the audited app must keep following.
- A failed token refresh blocks all later cron refreshes for that channel (fixed BullMQ jobId +
  retained failed job); access tokens live 24 h, and nobody can reconnect without a VPN.

## Decisions

1. **Settings are per channel and server-written:** `Post.metadata.tiktokByChannel =
   { [channelId]: TikTokPostSettings }` from post.create / post.update's `tiktok.byChannel` input.
   A raw client copy (and the old top-level `privacyLevel`) is stripped. The worker hands the
   provider only its own channel's block as `metadata.tiktok`. Survives target recreation.
2. **No defaults.** A TikTok target with no settings is refused before anything is sent ("choose who
   can see this TikTok post"). Unattended producers (autopilot, agents) skip TikTok channels.
3. **Fresh creator_info before every post** (provider) and live in Compose (`tiktok.creatorInfo`):
   privacy must be in `privacy_level_options`, interactions cannot be allowed when the creator
   disabled them, branded content cannot be private, duration ≤ `max_video_post_duration_sec`,
   and the can't-post codes (`spam_risk_*`, `reached_active_user_cap`) stop the post with a message.
4. **PULL_FROM_URL first** (TikTok: "if the video is already on your servers, do not use
   FILE_UPLOAD"); the domain-verification file is already served
   (`apps/web/public/tiktok4XVx…txt`). `url_ownership_unverified` is pre-write, so the provider
   falls back to a streamed **FILE_UPLOAD** (ranged 10 MiB chunks, `planTikTokChunks`).
5. **Duplicate safety:** init is the irreversible step. A lost init reply → `AmbiguousPublishError`.
   Once init returns a `publish_id` it is checkpointed (`PostTarget.metadata.tiktokPublish`); a
   failed checkpoint write is ambiguous. Every later attempt resumes from the checkpoint with
   `status/fetch` — COMPLETE ⇒ adopt, PROCESSING ⇒ keep waiting, FAILED ⇒ a new init is allowed,
   unreadable ⇒ ambiguous. Never re-init while a checkpointed publish might still land.
6. **Polling** in the job for up to ~8 minutes (status limit 30/min per token → every 5 s with
   `onProgress` from `downloaded_bytes` so the watchdog sees activity). Still processing after that
   ⇒ a plain retryable "TikTok is still processing" — safe, because the retry resumes from the
   checkpoint instead of re-initing.
7. **Errors are fixed text, never TikTok's JSON** (its `log_id` digits trip `classifyError`).
   Definite refusals are `PublishRefusedError`; `access_token_invalid` on init (nothing created)
   reads as an expired token so the worker refreshes and retries.
8. **Ids:** 19-digit post ids are read from the raw body (`extractPublicPostIds`); the URL is
   `tiktok.com/@<creator_username>/video/<id>` or the profile when TikTok has no public id yet.
9. **Connect:** username/nickname/avatar come from creator_info (the real @handle; `user/info`
   `display_name` is not a handle). Scopes unchanged (`user.info.basic, video.publish,
   video.upload`) — analytics (`video.list`) is deferred until the scope is confirmed enabled on
   the app, because requesting a scope the app lacks breaks every connect.
10. **Out of scope:** analytics, photo posts, inbox (draft) uploads, webhooks.

## Contract

`packages/social/src/utils/tiktok-posting.ts` (dependency-free; the browser deep-imports it):
settings/checkpoint keys and readers, `parseCreatorInfo`, `validateTikTokSettings`,
`tiktokInteractionFlags`, `tiktokConsentText`, `planTikTokChunks`, `classifyTikTokStatus`,
`extractPublicPostIds`, `tiktokPostUrl`, `TIKTOK_CANNOT_POST_CODES`.

tRPC `tiktok.creatorInfo({ channelId })` → `{ creator: TikTokCreatorInfo | null, canPost: boolean,
reason: string | null }` (refreshes an expired token first; fixed-text reasons).
