import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import { resolveVideoThumbnailUrl, supportsInstagramCover } from "../utils/video-thumbnail";
import {
  parseCommentsPage,
  isCommentPermissionDeniedError,
  isCommentObjectGoneError,
  COMMENT_PERMISSION_DENIED_MESSAGE,
  COMMENT_OBJECT_GONE_MESSAGE,
  COMMENT_LIST_FAILED_MESSAGE,
  COMMENT_REPLY_FAILED_MESSAGE,
  COMMENT_REPLY_UNCONFIRMED_MESSAGE,
  IG_COMMENT_FIELDS,
  IG_COMMENT_FIELDS_MINIMAL,
  type InstagramCommentPage,
  type InstagramOwnAccount,
} from "../utils/instagram-comments";
import { isGraphFieldError } from "../utils/social-comments";
import {
  isStoryFormat,
  isStoryModePost,
  buildStoryUserTags,
  readStoryMentions,
  storyPermalinkFallback,
  storyTrayUrl,
  pickStoryCandidate,
  readStoryContainerCheckpoint,
  classifyContainerStatus,
  isUserTagRejection,
  type StoryMediaKind,
} from "../utils/instagram-story";
import type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  AnalyticsDegradation,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
  ExternalPostPage,
  ExternalPostSummary,
  ListPostsOptions,
} from "../abstract/social.types";
import {
  diagnoseEmptyInsights,
  diagnoseMetaError,
  worstDegradation,
} from "../utils/meta-insight-diagnosis";
import { fetchT } from "../utils/fetch-timeout";
import {
  AmbiguousPublishError,
  isIndeterminatePublishError,
} from "../utils/ambiguous-publish";
import {
  RECONCILE_MAX_PAGES,
  RECONCILE_SKEW_MS,
  captionsMatch,
  reconcileSettleMs,
} from "../utils/publish-reconcile";

/** Max pagination pages fetched during connect (~500 Pages at limit=25). */
const MAX_CONNECT_PAGINATION_PAGES = 20;

/**
 * How long to wait for a VIDEO container to reach FINISHED.
 *
 * Was a flat 90s, which is duration-blind: Instagram's own transcode scales with
 * reel length, so a 102s reel needs far longer than a 10s one. On 2026-08-07 a
 * single 102s reel fanned out to 39 channels lost 22 of them to
 * "media processing timed out after 90 seconds" — the containers were still
 * IN_PROGRESS, not broken. Raised to 4 min so a long reel under load finishes
 * instead of being marked FAILED. Bounded (not unbounded) because the poll holds
 * a publish-worker slot; still far inside the watchdog's 30-min idle reap.
 */
const VIDEO_READY_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.IG_VIDEO_READY_TIMEOUT_MS || "", 10) || 240_000
);

/** See reconcileSettleMs — tunable with IG_RECONCILE_SETTLE_MS. */
const RECONCILE_SETTLE_MS = reconcileSettleMs("IG_RECONCILE_SETTLE_MS");

/**
 * How long a media container remains publishable (Meta: containers expire after
 * 24 hours). Used ONLY to bound the story-container resume: past this age an
 * unreadable container can no longer have produced a live story, so creating a
 * fresh one is safe rather than a duplicate risk.
 */
const STORY_CONTAINER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read timeout for ONE container-status GET inside waitForMediaReady (2026-09-16).
 *
 * The poll used to be an unbounded `fetch`, so a single hung read could hold a
 * publish-worker slot until the job itself died. A short bound is correct here
 * — unlike the upload/publish fetches fetch-timeout.ts warns about — because
 * this is a tiny metadata READ (`?fields=status_code,status`), not a media
 * transfer, and it runs BEFORE media_publish: nothing it does can create a post,
 * so abandoning a slow read and polling again is always duplicate-safe.
 */
const POLL_READ_TIMEOUT_MS = 15_000;

/**
 * Unreadable status polls tolerated IN A ROW before giving up. A blip (a proxy
 * 502, a slow read, Meta's `code: 2`) should not fail a 4-minute reel wait, but a
 * poll that never reads should not silently burn the whole budget either.
 */
const MAX_CONSECUTIVE_POLL_READ_FAILURES = 3;

/**
 * Graph codes meaning the token itself is unusable. Mirrors TOKEN_INVALID_CODES
 * in utils/meta-insight-diagnosis.ts (not exported from there).
 */
const POLL_TOKEN_INVALID_CODES = new Set([190, 102, 463, 467]);

/**
 * Should a Graph error body returned by a container-status poll end the wait
 * NOW — and with what message? A dead token (190/102/463/467) or a container
 * that no longer exists (#24, or #100 with subcode 33 "object does not exist")
 * can never turn into FINISHED, so polling on only delayed the inevitable by
 * the full budget — up to 4 minutes per target on 2026-09-16's measured
 * dead-token fan-outs — before a generic "did not finish" error that hid the
 * real cause. Returns null for any other body.
 *
 * The message is worded for the worker's
 * substring classifier (adversarial review, 2026-09-16): a raw
 * `"code":100`/`"code":102` body matched its `code":10` PERMISSION pattern, so
 * a vanished container read "Missing permissions" and a 102 dead session never
 * reached the dead-credential path.
 *   - token codes → "access token invalid" + the JSON (keeps `"code":NNN`
 *     for isDefiniteAuthFailure) → classified token_expired;
 *   - vanished container → plain words, no JSON → classified unknown and
 *     shown verbatim.
 */
function fatalStatusPollMessage(error: { code?: unknown; error_subcode?: unknown }): string | null {
  const code = Number(error?.code);
  if (POLL_TOKEN_INVALID_CODES.has(code)) {
    return `Instagram media status check failed: access token invalid (code ${code}) ${JSON.stringify(error)}`;
  }
  if (code === 24 || (code === 100 && Number(error?.error_subcode) === 33)) {
    return `Instagram media container no longer exists (Graph code ${code}${code === 100 ? "/33" : ""}) — it must be created again`;
  }
  return null;
}

/**
 * Graph error bodies that mean "slow down / try again shortly" rather than
 * "this read failed": Meta's transient codes (1, 2, or is_transient) and the
 * rate-limit family. Waited out within the poll budget and NOT counted as read
 * failures — HEAD before 2026-09-16 kept polling through them, and giving up
 * after four would burn a new container (a fresh download + transcode) in the
 * middle of the very throttle that caused them.
 */
const POLL_WAIT_OUT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80001, 80002]);
function isWaitOutStatusPollError(error: { code?: unknown; is_transient?: unknown }): boolean {
  return error?.is_transient === true || POLL_WAIT_OUT_CODES.has(Number(error?.code));
}

/**
 * A NEUTRAL description of why a status poll could not be read.
 *
 * ⚠️ Raw transport text ("fetch failed", "The operation was aborted due to
 * timeout", ETIMEDOUT, ECONNRESET) must never reach the thrown message. Those
 * are the shapes isIndeterminatePublishError and the worker's inner retry loop
 * read as "a write was dispatched and its outcome is unknown" — and this error
 * is PRE-write by construction, so it must classify as a definite failure.
 */
function describePollReadFailure(err: unknown, fallback: string): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `no response within ${Math.round(POLL_READ_TIMEOUT_MS / 1000)}s`;
  }
  return fallback;
}

/**
 * Carousel children created + awaited at once (2026-09-16). Each child is a
 * pre-write container, so parallelism cannot publish anything; 3 keeps the
 * per-account Graph traffic modest while cutting a 10-slide carousel's
 * sequential create→wait chain to roughly a third.
 */
const CAROUSEL_CHILD_CONCURRENCY = 3;

/**
 * Run `task` over `items` with at most `limit` in flight, returning results in
 * INPUT order regardless of completion order.
 *
 * Failure contract:
 *   - once any task has failed, no NEW task is started (the sequential loop this
 *     replaced stopped at the first failure too — no point minting containers
 *     for a carousel that can no longer be built);
 *   - every task already STARTED is awaited before rejecting, so nothing is left
 *     running unobserved after the caller has moved on;
 *   - the rejection is the error of the LOWEST failing index, which is the error
 *     the sequential loop would have thrown. (Unstarted tasks all have higher
 *     indices than any started one, so not starting them cannot change it.)
 */
async function mapInOrderWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;

  const runLane = async (): Promise<void> => {
    while (next < items.length && failures.length === 0) {
      const index = next++;
      try {
        results[index] = await task(items[index]!, index);
      } catch (error) {
        failures.push({ index, error });
      }
    }
  };

  // Lanes never reject (each task's error is captured above), so this resolves
  // only once every started task has settled.
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runLane));

  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    throw failures[0]!.error;
  }
  return results;
}

export class InstagramProvider extends SocialProvider {
  readonly platform: SocialPlatform = "INSTAGRAM";
  readonly displayName = "Instagram";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 2200,
    supportedMediaTypes: ["image/jpeg", "image/png"],
    maxMediaCount: 10,
    maxMediaSize: 8 * 1024 * 1024,
  };

  private readonly apiVersion = "v18.0";
  private readonly graphBaseUrl = "https://graph.facebook.com";

  getOAuthUrl(config: OAuthConfig, state: string): string {
    // Instagram Graph API uses Facebook OAuth flow
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(","),
      state,
      response_type: "code",
    });
    return `https://www.facebook.com/${this.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    // Exchange authorization code for a short-lived token via Facebook OAuth
    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      code,
    });

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram token exchange failed: ${JSON.stringify(data)}`);

    // Exchange short-lived token for a long-lived token
    const longLivedTokens = await this.exchangeForLongLivedToken(
      data.access_token,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  async refreshAccessToken(_refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    // Instagram (via Facebook) does not use traditional refresh tokens.
    // Exchange the existing long-lived token for a new long-lived token.
    const longLivedTokens = await this.exchangeForLongLivedToken(
      _refreshToken,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  validateContent(payload: SocialPostPayload): string[] {
    const errors = super.validateContent(payload);
    if (!payload.mediaUrls || payload.mediaUrls.length === 0) {
      errors.push("Instagram requires at least one image or video to publish a post.");
    } else if (!payload.mediaUrls[0]?.startsWith("http")) {
      errors.push("Instagram requires a valid publicly accessible media URL (must start with http/https).");
    }
    return errors;
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const igUserId = (payload.metadata?.igUserId as string) || (await this.getInstagramBusinessAccountId(tokens));

    // Story mode (2026-09-15) promises "one image or video". The per-channel
    // Reel/Story picker also yields format STORY, and that PRE-EXISTING path
    // must keep publishing a carousel for multiple media — so the refusal is
    // keyed on the story-MODE marker, never on the format alone.
    if (payload.mediaUrls && payload.mediaUrls.length > 1) {
      if (isStoryModePost(payload.metadata)) {
        throw new Error(
          `An Instagram story takes exactly one image or video — this post has ${payload.mediaUrls.length} attachments.`
        );
      }
      return this.publishCarouselPost(tokens, payload, igUserId);
    }

    // Single image or single video post
    const mediaUrl = payload.mediaUrls?.[0];
    if (!mediaUrl || !mediaUrl.startsWith("http")) {
      throw new Error("Instagram requires a valid publicly accessible media URL to publish a post.");
    }

    // Detect if this is a video
    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(mediaUrl) ||
      (payload.mediaTypes?.[0] ?? "").startsWith("video/");

    // Stories take a separate, container-checkpointed path: they carry no caption
    // to reconcile on, so a lost acknowledgement is recovered from the CONTAINER
    // rather than by listing the account. See publishStory.
    if (isStoryFormat(payload.metadata)) {
      return this.publishStory(tokens, igUserId, payload, mediaUrl, isVideo);
    }

    // Step 1: Create a media container (image_url for images, video_url for videos)
    const containerParams: Record<string, string> = {
      caption: payload.content,
    };

    if (isVideo) {
      containerParams["video_url"] = mediaUrl;
      const fmt = String(payload.metadata?.format ?? "REEL").toUpperCase();
      const mediaType = fmt === "STORY" ? "STORIES" : "REELS";
      containerParams["media_type"] = mediaType;

      // Optional user-uploaded cover. Meta cURLs `cover_url` server-side exactly
      // as it already cURLs `video_url`, so this costs no extra request and needs
      // no new permission — instagram_content_publish already covers it.
      //
      // ⚠️ REELS ONLY. cover_url on a STORIES container 400s container creation
      // and fails the whole publish, so the gate is on the resolved media_type,
      // never on "is this a video".
      //
      // ⚠️ When absent, containerParams is byte-identical to the pre-feature
      // request — the IG publish path is contractually frozen.
      const coverUrl = resolveVideoThumbnailUrl(payload.metadata);
      if (coverUrl && supportsInstagramCover(mediaType)) {
        containerParams["cover_url"] = coverUrl;
      }
    } else {
      containerParams["image_url"] = mediaUrl;
    }

    const containerId = await this.createMediaContainer(tokens, igUserId, containerParams);

    // Wait for the container to reach FINISHED before publishing. Instagram
    // processes ALL media asynchronously — not just videos. Publishing an image
    // container too soon returns OAuthException code 9007 / subcode 2207027
    // ("Media ID is not available / The media is not ready to be published").
    // Videos can take 30-90s; images are usually a few seconds but are NOT
    // instant, especially larger files. Poll faster (2s) and shorter (30s) for
    // images so the common case stays snappy; keep the long 90s budget for video.
    await this.waitForMediaReady(
      tokens,
      containerId,
      isVideo ? VIDEO_READY_TIMEOUT_MS : 30000,
      isVideo ? 5000 : 2000,
    );

    // Step 2: Publish the container
    return this.publishContainer(tokens, igUserId, containerId, payload.content);
  }

  /**
   * Publish ONE image or video as an Instagram Story.
   *
   * ── Why this is not just "the normal path with media_type=STORIES" ──────────
   * Every other publish here recovers a lost `media_publish` acknowledgement by
   * listing the account and matching the CAPTION. A story has no caption, and
   * `GET /{ig-user}/media` does not list stories at all. Matching "a story
   * appeared recently" instead would adopt one the user posted from their phone,
   * or one published by the SAME IG account connected to another organization —
   * recording a foreign id as ours while the user's story never goes out.
   *
   * So the CONTAINER is the identity. A container is single-use and its
   * `status_code` turns `PUBLISHED` once `media_publish` consumes it, so:
   *   - the id is checkpointed the moment the container exists, BEFORE publishing;
   *   - any later attempt asks Meta about THAT container first;
   *   - `PUBLISHED` ⇒ the story is live, so we identify it instead of writing;
   *   - anything usable ⇒ publish the SAME container (cannot duplicate);
   *   - only an explicitly dead container earns a fresh one.
   */
  private async publishStory(
    tokens: OAuthTokens,
    igUserId: string,
    payload: SocialPostPayload,
    mediaUrl: string,
    isVideo: boolean
  ): Promise<SocialPostResult> {
    const kind: StoryMediaKind = isVideo ? "VIDEO" : "IMAGE";
    const channelUsername = payload.metadata?.channelUsername;

    // ── Resume from a checkpointed container, if this is a retry ──────────────
    const checkpoint = readStoryContainerCheckpoint(payload.metadata);
    if (checkpoint && checkpoint.kind === kind) {
      const disposition = await this.readContainerDisposition(tokens, checkpoint.id, checkpoint.createdAt);
      // ⚠️ `windowStart`, not `createdAt`: identification needs the back-dated
      // window so a story's own Meta timestamp cannot sort before it.
      const resumeWindow = new Date(checkpoint.windowStart ?? checkpoint.createdAt);
      if (disposition === "published") {
        console.warn(
          `[Instagram] story container ${checkpoint.id} is already PUBLISHED on ${igUserId} — adopting it instead of publishing again`
        );
        return this.identifyPublishedStory(tokens, igUserId, resumeWindow, kind, channelUsername, checkpoint.id);
      }
      if (disposition === "reusable") {
        console.warn(
          `[Instagram] reusing story container ${checkpoint.id} for ${igUserId} — a second container would be a second story`
        );
        await this.waitForMediaReady(
          tokens,
          checkpoint.id,
          isVideo ? VIDEO_READY_TIMEOUT_MS : 30000,
          isVideo ? 5000 : 2000
        );
        return this.publishContainer(tokens, igUserId, checkpoint.id, payload.content, {
          mediaKind: kind,
          channelUsername,
          containerCreatedAt: resumeWindow,
        });
      }
      // "dead" — the container errored or expired, so a fresh one is safe.
    } else if (checkpoint) {
      // Anomalous: a checkpoint for the OTHER media kind. Not reachable today —
      // a post's media cannot change after creation (post.update does not touch
      // attachments) — but if it ever becomes reachable, creating a fresh
      // container while an old one may have published is a duplicate, so say so
      // loudly rather than failing silently.
      console.warn(
        `[Instagram] story checkpoint for ${checkpoint.id} is ${checkpoint.kind} but this publish is ${kind} — ignoring it and creating a new container`
      );
    }

    // ── Create the container ──────────────────────────────────────────────────
    // Anchor the identification window BEFORE the container exists, so a story
    // created from it can never sort before this timestamp.
    const containerCreatedAt = new Date(Date.now() - RECONCILE_SKEW_MS);

    const containerParams: Record<string, unknown> = {
      // Meta ignores `caption` on a story. It is sent anyway so the request keeps
      // the shape the pre-existing video-story path has always used; an empty
      // note is simply an empty string.
      caption: payload.content,
      media_type: "STORIES",
      ...(isVideo ? { video_url: mediaUrl } : { image_url: mediaUrl }),
    };

    // ⚠️ NO cover_url: Meta rejects it on a STORIES container and that fails the
    // WHOLE publish (supportsInstagramCover already refuses STORIES; stories also
    // do not support collaborators or alt_text).
    const userTags = buildStoryUserTags(payload.metadata);
    if (userTags) containerParams["user_tags"] = userTags;

    let containerId: string;
    try {
      containerId = await this.createMediaContainer(tokens, igUserId, containerParams);
    } catch (err) {
      // A private / non-existent tagged account fails container creation for every
      // selected channel at once, and the generic "container creation failed" text
      // sends the operator looking for a media problem. This is PRE-write, so it
      // is duplicate-safe — the remedy is to drop the tag.
      if (userTags && isUserTagRejection((err as { body?: unknown })?.body)) {
        const tagged = readStoryMentions(payload.metadata).map((u) => `@${u}`).join(", ");
        throw new Error(
          `Instagram rejected a tagged account (${tagged}). Tagged accounts must be public and exist. ` +
            `Remove the tag and try again. Platform error: ${(err as Error).message}`
        );
      }
      throw err;
    }

    // Checkpoint BEFORE publishing — this is the whole point, and it is NOT
    // best-effort.
    //
    // ⚠️ A failure here must ABORT, not warn. This record is the only thing that
    // lets a later attempt discover container C1 instead of creating C2, so
    // publishing without it means a lost DB write downstream (same client, same
    // database, correlated failure) leaves a live story no retry can ever find —
    // and the retry then posts a second one. Aborting costs one orphaned
    // container that Meta expires in 24h, and cannot duplicate anything, because
    // nothing has been sent to Instagram yet.
    //
    // `createdAt` is the TRUE creation time (used for the container's age);
    // `windowStart` is the deliberately back-dated identification window. They
    // must stay separate — see readContainerDisposition.
    try {
      await payload.onCheckpoint?.({
        igStoryContainer: {
          id: containerId,
          createdAt: new Date().toISOString(),
          windowStart: containerCreatedAt.toISOString(),
          kind,
        },
      });
    } catch (err) {
      throw new Error(
        `Could not record the Instagram story container ${containerId} — refusing to publish a story that a retry could not find. ` +
          `Nothing was sent to Instagram. Cause: ${(err as Error)?.message}`
      );
    }

    await this.waitForMediaReady(
      tokens,
      containerId,
      isVideo ? VIDEO_READY_TIMEOUT_MS : 30000,
      isVideo ? 5000 : 2000
    );

    return this.publishContainer(tokens, igUserId, containerId, payload.content, {
      mediaKind: kind,
      channelUsername,
      containerCreatedAt,
    });
  }

  /**
   * What happened to a previously-created story container?
   *
   * ⚠️ An UNREADABLE status THROWS rather than assuming anything. "Create another
   * container" is the one irreversible option here, so it is never taken on a
   * guess — a dead token or a Graph outage fails this read AND would fail the
   * creation anyway, and the ordinary retry path covers both.
   *
   * The single exception is a container older than Meta's 24h container lifetime:
   * it can no longer be published, and any story made from it has itself expired,
   * so a fresh container is bounded and safe.
   */
  private async readContainerDisposition(
    tokens: OAuthTokens,
    containerId: string,
    createdAtIso: string
  ): Promise<"published" | "reusable" | "dead"> {
    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/${containerId}?fields=status_code&access_token=${tokens.accessToken}`
    );
    const data: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      const ageMs = Date.now() - new Date(createdAtIso).getTime();
      if (Number.isFinite(ageMs) && ageMs > STORY_CONTAINER_TTL_MS) {
        console.warn(
          `[Instagram] story container ${containerId} unreadable and older than ${STORY_CONTAINER_TTL_MS / 3_600_000}h — treating as expired`
        );
        return "dead";
      }
      throw new Error(
        `Instagram could not report the status of story container ${containerId} ` +
          `(${JSON.stringify(data?.error ?? data).slice(0, 200)}) — refusing to create a second container`
      );
    }

    return classifyContainerStatus(data?.status_code);
  }

  /**
   * Name the story a PUBLISHED container produced.
   *
   * ⚠️ Identification only. It runs after the container has already proved the
   * story exists — using it to decide WHETHER a story published is exactly the
   * foreign-adoption bug this design avoids.
   *
   * When the media cannot be named (listing unreadable, or several stories in the
   * window), the result is still PUBLISHED: the container id stands in for the
   * media id and the URL points at the account's story tray. A post that is
   * genuinely live must never be reported as failed.
   */
  private async identifyPublishedStory(
    tokens: OAuthTokens,
    igUserId: string,
    since: Date,
    kind: StoryMediaKind,
    channelUsername: unknown,
    containerId: string
  ): Promise<SocialPostResult> {
    const unresolved = (why: string): SocialPostResult => {
      console.warn(`[Instagram] story from container ${containerId} is live but could not be identified (${why})`);
      return {
        platformPostId: containerId,
        url: storyTrayUrl(channelUsername),
        metadata: { storyMediaUnresolved: true, storyContainerId: containerId },
      };
    };

    let data: any;
    try {
      const res = await fetchT(
        `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/stories` +
          `?fields=id,timestamp,media_type,permalink&access_token=${tokens.accessToken}`
      );
      data = await res.json().catch(() => ({}));
      if (!res.ok) return unresolved(`stories listing failed: ${JSON.stringify(data?.error ?? data).slice(0, 160)}`);
    } catch (err) {
      return unresolved(`stories listing threw: ${(err as Error).message}`);
    }

    const picked = pickStoryCandidate(Array.isArray(data?.data) ? data.data : [], since, kind);
    if (picked.outcome === "match") {
      return {
        platformPostId: picked.story.id,
        url: picked.story.permalink ?? storyPermalinkFallback(channelUsername, picked.story.id),
      };
    }
    return unresolved(picked.outcome === "many" ? `${picked.count} candidate stories` : "no candidate story listed");
  }

  /**
   * Poll until the media container status is FINISHED (ready to publish).
   * Applies to images AND videos — Instagram processes all media asynchronously.
   * Video processing can take 30-90s; images are usually a few seconds.
   * Treats a still-IN_PROGRESS / missing status_code as "keep waiting" (the
   * status field can lag right after container creation), only failing on an
   * explicit ERROR/EXPIRED or after the timeout budget is exhausted.
   *
   * ── Fail-fast rules (2026-09-16) ───────────────────────────────────────────
   * This runs BEFORE media_publish, so nothing it does can publish anything —
   * every throw here is pre-write and duplicate-safe.
   *   - A dead token or a vanished container ends the wait on the FIRST such
   *     read. Before, a `{"error":{"code":190}}` body carried no status_code, so
   *     it was polled for the full budget (4 min for a reel) and then reported as
   *     a generic "did not finish". The error is re-thrown as JSON so the worker's
   *     classifier still sees the literal `"code":190`.
   *   - A transient read failure (thrown fetch incl. the read timeout, an
   *     unparseable body, any other Graph error body) is tolerated up to
   *     MAX_CONSECUTIVE_POLL_READ_FAILURES in a row, and still consumes an
   *     attempt. Before, the first thrown fetch or non-JSON body escaped raw.
   */
  private async waitForMediaReady(
    tokens: OAuthTokens,
    containerId: string,
    maxWaitMs = 90000,
    pollInterval = 5000,
  ): Promise<void> {
    const maxAttempts = Math.ceil(maxWaitMs / pollInterval);
    const startedAt = Date.now();
    // Reset by every poll that returns a readable status, so scattered blips
    // across a long reel wait never add up to a failure.
    let consecutiveReadFailures = 0;
    // Graph code of the last wait-out (transient/rate-limit) reply, cleared by
    // any readable status — so a budget that ran out on throttle replies says
    // so instead of claiming the media "is still processing".
    let lastWaitOutCode: number | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, pollInterval));

      let res: Response | undefined;
      let data: any;
      let readFailure: string | null = null;
      try {
        // Plain fetch + its own short signal, not fetchT: fetchT is documented as
        // connect-path only. See POLL_READ_TIMEOUT_MS for why a bound is right
        // for this particular read.
        res = await fetch(
          `${this.graphBaseUrl}/${this.apiVersion}/${containerId}?fields=status_code,status&access_token=${tokens.accessToken}`,
          { signal: AbortSignal.timeout(POLL_READ_TIMEOUT_MS) }
        );
        data = await res.json();
      } catch (readErr) {
        readFailure = describePollReadFailure(readErr, res ? "unreadable response body" : "read error");
      }

      // Classified OUTSIDE the try so the fatal throw below is never swallowed
      // as a "read error" by the catch above.
      if (!readFailure) {
        const graphError = data?.error;
        if (graphError) {
          const fatal = fatalStatusPollMessage(graphError);
          if (fatal) throw new Error(fatal);
          if (isWaitOutStatusPollError(graphError)) {
            lastWaitOutCode = Number(graphError.code);
            // Keep waiting (consumes an attempt, not the failure allowance).
            console.warn(
              `[Instagram] status poll for container ${containerId} got a transient/rate-limit body ` +
                `(code ${Number(graphError.code)}) — still waiting`
            );
            continue;
          }
          // Only the numeric code — Meta's free text stays out of the message.
          const code = Number(graphError.code);
          readFailure = `graph error code ${Number.isFinite(code) ? code : "unknown"}`;
        } else if (!data || typeof data !== "object") {
          readFailure = "empty response body";
        } else if (res && !res.ok && data.status_code === undefined) {
          readFailure = `HTTP ${res.status ?? "error"}`;
        }
      }

      if (readFailure) {
        consecutiveReadFailures++;
        if (consecutiveReadFailures > MAX_CONSECUTIVE_POLL_READ_FAILURES) {
          // ⚠️ Keep this message free of transport wording — see
          // describePollReadFailure. It must read as a DEFINITE, pre-write failure.
          throw new Error(
            `Instagram media status could not be read (${consecutiveReadFailures} consecutive errors): ${readFailure}`
          );
        }
        console.warn(
          `[Instagram] status poll for container ${containerId} unreadable (${readFailure}) — ` +
            `${consecutiveReadFailures}/${MAX_CONSECUTIVE_POLL_READ_FAILURES} tolerated, still waiting`
        );
        continue;
      }
      consecutiveReadFailures = 0;
      lastWaitOutCode = null;

      // FINISHED = ready to publish; PUBLISHED = already published (defensive).
      if (data.status_code === "FINISHED" || data.status_code === "PUBLISHED") return;
      if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
        throw new Error(`Instagram media processing failed: ${data.status || data.status_code}`);
      }
      // IN_PROGRESS or an unknown status → keep polling.
    }

    // Report ACTUAL elapsed, not the budget: each iteration sleeps `pollInterval`
    // and then awaits a network read, so a busy worker overshoots the nominal
    // budget. Printing the budget made the 2026-08-07 incident look like a hard
    // 90s cutoff when the real waits were longer — hiding how close these
    // containers were to finishing.
    const waitedSec = Math.round((Date.now() - startedAt) / 1000);
    if (lastWaitOutCode !== null) {
      // The status was never readable at the end — Meta kept answering with a
      // transient/throttle reply. Pre-write, definite; worded without the
      // classifier's rate-limit phrases so it takes the ordinary failure +
      // BullMQ retry path, exactly as a budget timeout always has.
      throw new Error(
        `Instagram did not report the media status within ${waitedSec}s ` +
          `(budget ${Math.round(maxWaitMs / 1000)}s; Meta kept replying with Graph code ${lastWaitOutCode})`
      );
    }
    throw new Error(
      `Instagram media processing did not finish within ${waitedSec}s ` +
        `(budget ${Math.round(maxWaitMs / 1000)}s) — the video is still processing on Instagram's side, not rejected`
    );
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    // Instagram Graph API does not natively support deleting posts via the API.
    // Attempt the deletion; this may fail depending on permissions.
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?access_token=${tokens.accessToken}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Instagram delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    // First get the Instagram Business Account ID via Facebook Pages
    const igUserId = await this.getInstagramBusinessAccountId(tokens);

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}?fields=id,username,profile_picture_url&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      name: data.username || data.id,
      username: data.username,
      avatar: data.profile_picture_url,
    };
  }

  /**
   * Fetch ALL Instagram Business Accounts linked to the user's Facebook Pages.
   * Returns an array of IG accounts with their profile info.
   */
  async getAllInstagramAccounts(tokens: OAuthTokens): Promise<Array<{
    id: string;
    name: string;
    username?: string;
    avatar?: string;
  }>> {
    const accounts: Array<{ id: string; name: string; username?: string; avatar?: string }> = [];
    let url: string | null = `${this.graphBaseUrl}/${this.apiVersion}/me/accounts?fields=id,instagram_business_account&limit=25&access_token=${tokens.accessToken}`;
    let pageCount = 0;

    while (url) {
      if (pageCount >= MAX_CONNECT_PAGINATION_PAGES) {
        console.warn(`[Instagram] getAllInstagramAccounts: pagination capped at ${MAX_CONNECT_PAGINATION_PAGES} pages (${accounts.length} accounts loaded) — truncating`);
        break;
      }
      pageCount++;

      const pagesRes = await fetchT(url);
      const pagesData: any = await pagesRes.json();
      if (!pagesRes.ok) {
        // Keep the break (return whatever was collected so far — same contract),
        // but don't be silent about the partial result.
        console.warn(`[Instagram] getAllInstagramAccounts: pagination response not ok (HTTP ${pagesRes.status}) — returning partial result (${accounts.length} accounts): ${JSON.stringify(pagesData?.error ?? pagesData)}`);
        break;
      }

      for (const page of pagesData.data || []) {
        if (page.instagram_business_account?.id) {
          // Fetch IG profile details
          try {
            const igRes = await fetchT(
              `${this.graphBaseUrl}/${this.apiVersion}/${page.instagram_business_account.id}?fields=id,username,profile_picture_url&access_token=${tokens.accessToken}`
            );
            const igData: any = await igRes.json();
            if (igRes.ok) {
              accounts.push({
                id: igData.id,
                name: igData.username || igData.id,
                username: igData.username,
                avatar: igData.profile_picture_url,
              });
            }
          } catch {
            // Skip this account if profile fetch fails
          }
        }
      }

      url = pagesData.paging?.next || null;
    }

    return accounts;
  }

  /**
   * List the IG account's own media — including posts made directly in the app.
   *
   *   GET /{ig-user-id}/media
   *       ?fields=id,timestamp,caption,media_product_type,media_type,permalink
   *       &since=<unix>&limit=25
   *
   * ⚠️ IG media ids are BARE (e.g. 17912345678901234) and are the SAME ids that
   * publishing returns, so dedup against PostTarget.publishedId is an exact string
   * match — no resolution step, unlike Facebook's bare Video-node ids. Measured: all 60
   * app-published IG targets since 2026-08-01 carry bare ids.
   *
   * ⚠️ `media_product_type` is captured here because IG insight metric sets are
   * PER PRODUCT TYPE and MUTUALLY EXCLUSIVE (FEED / REELS / STORY). Mixing them 400s
   * the entire call and zeroes every metric — the all-or-nothing regression PR #148
   * already fixed once. Persisting it lets the metric pass pick the right set without
   * a second media read.
   *
   * ⚠️ REALITY CHECK (measured 2026-08-06): 0 of 12 sampled IG tokens were alive — every
   * one returned 190/460 "session invalidated". This method is correct and will start
   * returning data the moment owners reconnect; until then it degrades honestly rather
   * than reporting "no posts".
   */
  async listRecentPosts(
    tokens: OAuthTokens,
    igUserId: string,
    opts: ListPostsOptions
  ): Promise<ExternalPostPage> {
    const since = Math.floor(opts.since.getTime() / 1000);
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const cursor = opts.cursor ? `&after=${encodeURIComponent(opts.cursor)}` : "";

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media` +
        `?fields=id,timestamp,caption,media_product_type,media_type,permalink` +
        `&since=${since}&limit=${limit}${cursor}&access_token=${tokens.accessToken}`
    );
    const data: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.warn(`[Instagram] listRecentPosts failed for ${igUserId}: ${JSON.stringify(data?.error ?? data).slice(0, 300)}`);
      return { posts: [], degraded: diagnoseMetaError(data?.error) };
    }

    const posts: ExternalPostSummary[] = [];
    for (const row of Array.isArray(data?.data) ? data.data : []) {
      if (!row?.id || !row?.timestamp) continue;
      const when = new Date(row.timestamp);
      if (Number.isNaN(when.getTime())) continue;
      // Defensive: `since` has been unreliable on some IG API versions, so enforce the
      // floor locally too. A post older than the window must never enter the store.
      if (when.getTime() < opts.since.getTime()) continue;
      posts.push({
        platformPostId: String(row.id),
        publishedAt: when,
        ...(row.permalink ? { permalink: String(row.permalink) } : {}),
        ...(row.caption ? { message: String(row.caption).slice(0, 2000) } : {}),
        ...(row.media_type ? { mediaType: String(row.media_type) } : {}),
        ...(row.media_product_type ? { productType: String(row.media_product_type) } : {}),
      });
    }

    return {
      posts,
      ...(data?.paging?.cursors?.after && data?.paging?.next
        ? { nextCursor: String(data.paging.cursors.after) }
        : {}),
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    // Fetch the media object FIRST — media_product_type decides which insights
    // metric set is valid. Every IG video publishes as REELS (or STORIES), and
    // Meta's insights endpoint is all-or-nothing: requesting a FEED metric
    // (impressions/engagement) on a Reel fails the WHOLE call with error #100,
    // zeroing even valid metrics like reach.
    const mediaRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?fields=like_count,comments_count,media_product_type&access_token=${tokens.accessToken}`
    );

    const mediaData: any = await mediaRes.json();
    if (!mediaRes.ok) {
      console.warn(`[Instagram] media fields failed for ${platformPostId}: ${JSON.stringify(mediaData)}`);
      // A dead or under-scoped token fails HERE, before insights are ever
      // attempted — the single most common failure mode in production. Returning
      // a bare null loses the diagnosis, so the channel keeps rendering zeros
      // with no hint that it needs reconnecting. Instead, return a fully
      // UNAVAILABLE row carrying the reason: every metric renders "—" exactly as
      // it did before (so the visible table is unchanged), but the reconnect
      // signal now reaches the UI. Non-actionable errors keep the old null.
      const mediaDegradation = diagnoseMetaError(mediaData?.error);
      if (!mediaDegradation) return null;
      return {
        impressions: 0,
        clicks: 0,
        likes: 0,
        shares: 0,
        comments: 0,
        reach: 0,
        engagementRate: 0,
        likeKind: "likes",
        reachIsDistinct: true,
        source: "api",
        metricsAvailable: {
          impressions: false,
          reach: false,
          likes: false,
          comments: false,
          shares: false,
          clicks: false,
        },
        degraded: mediaDegradation,
      };
    }
    const likes = mediaData.like_count || 0;
    const comments = mediaData.comments_count || 0;
    const productType = String(mediaData.media_product_type ?? "").toUpperCase();

    // Metric sets per media_product_type — LIVE-VERIFIED by probing every metric
    // name INDIVIDUALLY on real REELS / FEED media (2026-07-24, re-verified and
    // EXTENDED 2026-08-06 with `instagram_manage_insights` granted).
    //
    // Meta's /insights?metric= is ALL-OR-NOTHING: one unsupported name fails the
    // WHOLE call with #100 and zeroes every metric in the set. Verified-valid:
    //   FEED  (incl. carousels — a carousel is media_product_type FEED with
    //          media_type CAROUSEL_ALBUM):
    //     reach,saved,shares,views,likes,comments,total_interactions,
    //     profile_visits,profile_activity,follows
    //   REELS:
    //     reach,saved,shares,views,likes,comments,total_interactions,
    //     ig_reels_avg_watch_time,ig_reels_video_view_total_time
    //   STORY (no saved/likes/comments; adds replies/navigation):
    //     reach,shares,views,total_interactions,replies,navigation
    //
    // ⚠️ The sets are MUTUALLY EXCLUSIVE — never union them. `profile_visits`,
    // `profile_activity` and `follows` are NOT supported for REELS: adding them
    // to a shared set makes the combined REELS call fail outright (verified:
    // "#100 does not support the profile_visits, profile_activity, follows metric
    // for this media product type"), zeroing every metric for that Reel. That is
    // the same all-or-nothing regression PR #148 already fixed once.
    //
    // Do NOT re-add `impressions` ("no longer supported" from v22.0), `plays`,
    // `engagement`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`
    // or `video_views` — all verified invalid.
    // `views` carries the impressions slot; `total_interactions` the engagement
    // slot. Verified real sample (a Reel): reach=106, views=115, saved=1,
    // total_interactions=1, ig_reels_avg_watch_time=3038ms.
    const BASE_SET = "reach,saved,shares,views,likes,comments,total_interactions";
    const preferredSet =
      productType === "STORY"
        ? "reach,shares,views,total_interactions,replies,navigation"
        : productType === "REELS"
          ? `${BASE_SET},ig_reels_avg_watch_time,ig_reels_video_view_total_time`
          : productType === "FEED"
            ? `${BASE_SET},profile_visits,profile_activity,follows`
            : BASE_SET;

    const metrics: Record<string, number> = {};
    /** Metric names Meta actually RETURNED — the basis for honest availability. */
    const present = new Set<string>();
    let degraded: AnalyticsDegradation | undefined;

    const readInsights = async (metricParam: string): Promise<boolean> => {
      const res = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=${metricParam}&access_token=${tokens.accessToken}`
      );
      const data: any = await res.json();
      if (!res.ok) {
        console.warn(`[Instagram] insights (${metricParam}) failed for ${platformPostId}: ${JSON.stringify(data)}`);
        // Only permission/token problems are actionable; an unsupported-metric
        // #100 is a set-shape problem the ladder below handles itself.
        degraded = worstDegradation(degraded, diagnoseMetaError(data?.error));
        return false;
      }
      const rows: any[] = Array.isArray(data?.data) ? data.data : [];
      for (const metric of rows) {
        metrics[metric.name] = metric.values?.[0]?.value || metric.value || 0;
        present.add(metric.name);
      }
      // A 200 carrying zero rows is the silent-empty signature of a missing
      // scope (same class as the FB feed edge) — `reach` is always returned when
      // permitted, for every media product type.
      if (rows.length === 0) {
        degraded = worstDegradation(
          degraded,
          diagnoseEmptyInsights(0, true, "instagram_manage_insights")
        );
        return false;
      }
      return true;
    };

    // Degradation ladder: preferred (type-specific, richest) → base (the set
    // verified safe for every type) → `reach` alone. Because /insights is
    // all-or-nothing, this guarantees a newly-added type-specific metric can
    // NEVER cost us the base metrics if Meta rejects it for some media type.
    // Descends only on failure, so the happy path stays a single call.
    const isStoryMedia = productType === "STORY";
    if (!(await readInsights(preferredSet))) {
      // ⚠️ A STORY skips the BASE_SET rung. BASE_SET carries `saved,likes,comments`,
      // which Meta supports for FEED/REELS ONLY — for a story that call is a
      // guaranteed #100, so the rung can only ever cost a wasted round-trip on a
      // path that is already failing.
      if (preferredSet !== BASE_SET && !isStoryMedia) {
        if (!(await readInsights(BASE_SET))) await readInsights("reach");
      } else {
        await readInsights("reach");
      }
    }

    // Instagram has NO impressions metric — Meta deleted it in v22.0 ("the
    // impressions metric is no longer supported for the queried media"), and no
    // permission restores it. What this provider has always stored in the
    // `impressions` slot is Meta's `views` count, which is a genuinely different
    // quantity from `reach`: measured across 62,324 prod rows, views > reach on
    // 62,081 of them (mean ratio 3.49x for REELS, 2.07x for FEED).
    //
    // ⚠️ The value is written to BOTH slots on purpose. `views` is the honest
    // column the UI renders; `impressions` is retained so the engagement-rate
    // denominator and every historical row keep working byte-identically. The
    // capability map declares INSTAGRAM impressions unavailable, so the UI never
    // shows the same number twice under two names.
    const views = metrics.views ?? 0;
    const impressions = views;
    const totalEngagement = metrics.total_interactions ?? likes + comments;
    const engagementRate = impressions > 0 ? totalEngagement / impressions : 0;

    return {
      impressions,
      ...(present.has("views") ? { views } : {}),
      clicks: 0, // Instagram does not expose click counts via the API
      likes,
      shares: metrics.shares ?? 0,
      comments,
      reach: metrics.reach ?? 0,
      engagementRate,
      saved: present.has("saved") ? metrics.saved : undefined,
      // Reels watch time, in milliseconds (undefined for non-Reels).
      ...(present.has("ig_reels_avg_watch_time")
        ? { avgWatchTimeMs: metrics.ig_reels_avg_watch_time }
        : {}),
      ...(present.has("ig_reels_video_view_total_time")
        ? { totalWatchTimeMs: metrics.ig_reels_video_view_total_time }
        : {}),
      likeKind: "likes",
      reachIsDistinct: true, // IG reach is a genuine unique-reach metric
      source: "api",
      // Availability is derived from what Meta ACTUALLY returned, per metric.
      // The old `hasInsights` flag was a single boolean OR'd across the whole
      // call, so a partial success (product-type set fails, `reach`-only retry
      // succeeds) declared impressions and shares "available" while they had
      // never been returned — reporting a fake 0. `likes`/`comments` come from
      // the media fields object (instagram_basic), not insights, so they are
      // available whenever the media read succeeded.
      metricsAvailable: {
        clicks: false, // IG has no click metric at all
        // Both keyed on the SAME returned metric, because they hold the same
        // number. `impressions` stays declared so historical rows and the
        // engagement-rate denominator behave exactly as before; the static
        // capability map is what stops the UI rendering it as a second column.
        // ⚠️ `impressions: false` is REQUIRED, not optional — and an OMITTED key
        // is NOT equivalent. Per-capture `metricsAvailable` OVERRIDES the static
        // platform map at every consumer (gatePostReportRow, availExpr,
        // effectiveChannelUnavailable), and an omitted key reads as AVAILABLE.
        // Declaring `true` here (or omitting it) made Instagram render Impressions
        // AND Views as two columns holding the identical number — the exact
        // duplication this metric was introduced to remove. Measured on prod:
        // 66,073 IG rows, views == impressions on 100% of them, both summing
        // 2.26B, printed twice.
        impressions: false,
        views: present.has("views"),
        reach: present.has("reach"),
        shares: present.has("shares"),
        // A STORY has no like or comment surface — Meta lists both insight
        // metrics for FEED/REELS only, and `like_count`/`comments_count` on the
        // media node are not meaningful for one. They must be declared FALSE
        // rather than omitted: an omitted key reads as AVAILABLE, which would
        // print a confident "0 likes / 0 comments" on every story row and feed
        // that 0 into channel sums. Omitted for every other product type, so
        // FEED/REELS captures are byte-identical.
        ...(isStoryMedia ? { likes: false, comments: false, saved: false } : {}),
      },
      ...(degraded ? { degraded } : {}),
    };
  }

  /**
   * Exchange a short-lived or existing long-lived token for a new long-lived token.
   */
  private async exchangeForLongLivedToken(
    accessToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: accessToken,
    });

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram long-lived token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      // Store the long-lived token as the refresh token so it can be re-exchanged before expiry.
      refreshToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
      scopes: data.token_type ? [data.token_type] : undefined,
    };
  }

  /**
   * Retrieve the Instagram Business Account ID connected to the user's Facebook Page.
   */
  private async getInstagramBusinessAccountId(tokens: OAuthTokens): Promise<string> {
    // Get the list of Facebook Pages the user manages, with pagination
    let url: string | null = `${this.graphBaseUrl}/${this.apiVersion}/me/accounts?fields=id,instagram_business_account&limit=25&access_token=${tokens.accessToken}`;
    let pageCount = 0;

    while (url) {
      if (pageCount >= MAX_CONNECT_PAGINATION_PAGES) {
        console.warn(`[Instagram] getInstagramBusinessAccountId: pagination capped at ${MAX_CONNECT_PAGINATION_PAGES} pages without finding an IG Business Account — truncating`);
        break;
      }
      pageCount++;

      const pagesRes = await fetchT(url);
      const pagesData: any = await pagesRes.json();

      if (!pagesRes.ok) {
        console.error("Instagram: Failed to fetch Facebook pages:", JSON.stringify(pagesData));
        throw new Error(`Failed to fetch Facebook pages: ${JSON.stringify(pagesData)}`);
      }

      // Find the first page with an Instagram Business Account linked
      for (const page of pagesData.data || []) {
        if (page.instagram_business_account?.id) {
          return page.instagram_business_account.id;
        }
      }

      // Check next page
      url = pagesData.paging?.next || null;
    }

    throw new Error(
      "No Instagram Business Account found. Ensure a Facebook Page is connected to an Instagram Professional account."
    );
  }

  /**
   * Create a media container for a single image post.
   */
  private async createMediaContainer(
    tokens: OAuthTokens,
    igUserId: string,
    // `unknown` (not `string`) because a STORIES container carries `user_tags` as
    // a real JSON array of objects — the same transport shape the carousel path
    // already uses for `children`. Serialization is unchanged for string-only
    // params, so every pre-existing request body is byte-identical.
    params: Record<string, unknown>
  ): Promise<string> {
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...params,
          access_token: tokens.accessToken,
        }),
      }
    );

    const data: any = await res.json();
    if (!res.ok) {
      // The parsed body rides along so a caller can classify the failure (e.g. a
      // rejected story user_tag) without re-parsing the message string.
      const err = new Error(`Instagram media container creation failed: ${JSON.stringify(data)}`) as Error & {
        body?: unknown;
      };
      err.body = data;
      throw err;
    }

    return data.id;
  }

  /**
   * Publish a media container.
   *
   * `caption` is passed for RECONCILIATION ONLY — it is never re-sent to Meta. It
   * is how a post Instagram already created is recognised on the account when the
   * publish call's own response is lost.
   *
   * `story` (2026-09-15) switches that recovery to the CONTAINER: a story has no
   * caption to match on, and `/media` never lists stories. Null ⇒ byte-identical
   * to the pre-story behaviour.
   */
  private async publishContainer(
    tokens: OAuthTokens,
    igUserId: string,
    containerId: string,
    caption: string,
    story: { mediaKind: StoryMediaKind; channelUsername: unknown; containerCreatedAt: Date } | null = null
  ): Promise<SocialPostResult> {
    // Anchor the reconciliation window BEFORE the first write attempt.
    const windowStart = new Date(Date.now() - RECONCILE_SKEW_MS);

    // Even after the container reports FINISHED, media_publish can briefly still
    // return subcode 2207027 ("media is not ready to be published"). Retry a few
    // times with backoff so a one-off race resolves inside this call instead of
    // failing the whole job (which the user sees as a red "Failed" before the
    // BullMQ retry eventually fixes it). Only this specific transient subcode is
    // retried here; any other error is classified below.
    let data: any;
    let res: Response;
    const maxPublishAttempts = 5;
    // ⚠️ STICKY. Once ANY attempt has left the outcome unknown, the post may exist
    // — and every later attempt in this loop reuses the SAME creation_id, so a
    // definite-looking error from one of them (Meta rejecting an already-consumed
    // container, say) is NOT evidence that nothing was created. Reporting a clean
    // failure at that point would drop the target back into the claim set and
    // invite a re-publish of a live post.
    let sawIndeterminate = false;
    for (let attempt = 0; attempt < maxPublishAttempts; attempt++) {
      const isLastAttempt = attempt >= maxPublishAttempts - 1;

      try {
        res = await fetch(
          `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media_publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              creation_id: containerId,
              access_token: tokens.accessToken,
            }),
          }
        );
      } catch (netErr) {
        // ⚠️ The write was DISPATCHED and its outcome never came back. Replaying
        // it is precisely how the 2026-08-13 duplicates were produced, so stop
        // writing and go look at the account instead.
        return this.resolveUnknownPublish(tokens, igUserId, caption, windowStart, netErr, story, containerId);
      }

      try {
        data = await res.json();
      } catch (parseErr) {
        // A body we cannot read (a proxy's HTML 502, a truncated response) says
        // NOTHING about whether Meta created the post.
        return this.resolveUnknownPublish(tokens, igUserId, caption, windowStart, parseErr, story, containerId);
      }
      if (res.ok) break;

      const subcode = data?.error?.error_subcode;
      const isNotReady = subcode === 2207027 || /not ready to be published|Media ID is not available/i.test(data?.error?.error_user_msg || data?.error?.message || "");
      if (isNotReady && !isLastAttempt) {
        // Linear-ish backoff: 3s, 6s, 9s, 12s — gives the container time to settle.
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }

      const failure = new Error(`Instagram publish failed: ${JSON.stringify(data)}`);

      // Meta flagged this transient (`is_transient` / code 2). That claim is about
      // the REQUEST, not the WRITE: measured on production 2026-08-13, 11 of 11
      // Instagram targets that failed this way were ACTUALLY LIVE.
      //
      // A 5xx counts too, whatever the body says: Meta returns code 1 "unknown
      // error" on some server faults, which the body-only classifier would read as
      // a definite rejection.
      const indeterminate = res.status >= 500 || isIndeterminatePublishError(failure);
      if (indeterminate) sawIndeterminate = true;

      if (indeterminate) {
        // A container is single-use, so re-sending media_publish with the SAME
        // creation_id cannot create a second post — this is the one safe place to
        // retry. (Re-running publishPost is NOT safe: it mints a NEW container,
        // which is a new post. That is the layer the incident retried at.)
        if (!isLastAttempt) {
          // For a story the CONTAINER is the evidence: if media_publish already
          // consumed it, the story is live and re-publishing would be a duplicate.
          const quick = story
            ? await this.adoptIfContainerPublished(tokens, igUserId, containerId, story).catch(() => null)
            : await this.findPublishedMatch(tokens, igUserId, caption, windowStart, true).catch(() => null);
          if (quick) return quick;
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        return this.resolveUnknownPublish(tokens, igUserId, caption, windowStart, failure, story, containerId);
      }

      // Definite error — but only trustworthy if NO earlier attempt was ambiguous.
      if (sawIndeterminate) {
        return this.resolveUnknownPublish(tokens, igUserId, caption, windowStart, failure, story, containerId);
      }

      throw failure;
    }

    // media_publish returns a numeric media ID, not a shortcode.
    // Fetch the permalink field to get the real post URL. `/p/{id}` is a 404 for
    // a story, so that branch falls back to the account's /stories/ path.
    let url = story
      ? storyPermalinkFallback(story.channelUsername, String(data.id))
      : `https://www.instagram.com/p/${data.id}`;
    try {
      const permalinkRes = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${data.id}?fields=permalink&access_token=${tokens.accessToken}`
      );
      const permalinkData: any = await permalinkRes.json();
      if (permalinkData.permalink) url = permalinkData.permalink;
    } catch {
      // Fall back to the numeric ID URL — better than nothing
    }

    return {
      platformPostId: data.id,
      url,
      metadata: data,
    };
  }

  /**
   * Last word on a publish whose outcome Instagram never confirmed: adopt the
   * post if the account already has it, otherwise refuse to guess.
   *
   * ⚠️ This NEVER returns "it definitely failed". Instagram's `/media` edge is
   * eventually consistent, so an absent listing is not proof of absence — and the
   * two mistakes are not symmetric. Being wrong about "failed" puts a duplicate
   * in front of a real audience; being wrong about "ambiguous" costs one manual
   * re-publish, which the post detail page offers in a single click.
   */
  private async resolveUnknownPublish(
    tokens: OAuthTokens,
    igUserId: string,
    caption: string,
    since: Date,
    cause: unknown,
    story: { mediaKind: StoryMediaKind; channelUsername: unknown; containerCreatedAt: Date } | null = null,
    containerId?: string
  ): Promise<SocialPostResult> {
    // Let Instagram index before asking.
    if (RECONCILE_SETTLE_MS > 0) {
      await new Promise((r) => setTimeout(r, RECONCILE_SETTLE_MS));
    }

    const match = await (story && containerId
      ? // A story is recognised by its CONTAINER, never by "a story appeared
        // recently" — that would adopt one posted from the phone, or one belonging
        // to another organization that shares this IG account.
        this.adoptIfContainerPublished(tokens, igUserId, containerId, story)
      : this.findPublishedMatch(tokens, igUserId, caption, since, true)
    ).catch((e) => {
      console.warn(`[Instagram] reconciliation read failed for ${igUserId}: ${(e as Error)?.message}`);
      return null;
    });
    if (match) {
      console.warn(
        `[Instagram] media_publish did not acknowledge, but ${match.platformPostId} is already live on ${igUserId} — adopting it instead of re-publishing`
      );
      return match;
    }

    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new AmbiguousPublishError(
      story
        ? "Instagram did not confirm this story and it may already be live on the account. " +
          "Nothing was re-sent, so there is no duplicate, and the media container was kept — " +
          `a retry reuses it rather than posting a second story. Platform error: ${detail}`
        : "Instagram did not confirm this post and it may already be live on the account. " +
          "Nothing was re-sent, so there is no duplicate — open the account to check, then " +
          `use "It didn't publish" if you need to try again. Platform error: ${detail}`,
      { platform: "INSTAGRAM", cause }
    );
  }

  /**
   * Story recovery inside the publish loop: did `media_publish` already consume
   * this container? Returns the adopted story when it did, null when the
   * container is still unpublished, and THROWS when the status cannot be read
   * (the three outcomes stay distinct, exactly as for the feed path).
   */
  private async adoptIfContainerPublished(
    tokens: OAuthTokens,
    igUserId: string,
    containerId: string,
    story: { mediaKind: StoryMediaKind; channelUsername: unknown; containerCreatedAt: Date }
  ): Promise<SocialPostResult | null> {
    const disposition = await this.readContainerDisposition(
      tokens,
      containerId,
      story.containerCreatedAt.toISOString()
    );
    if (disposition !== "published") return null;
    return this.identifyPublishedStory(
      tokens,
      igUserId,
      story.containerCreatedAt,
      story.mediaKind,
      story.channelUsername,
      containerId
    );
  }

  /**
   * Does this account already hold a post with this exact caption, published at
   * or after `since`?
   *
   * Returns the post when found, `null` when the account was readable and has no
   * such post, and THROWS when it could not be determined. Callers must keep
   * those three outcomes distinct — collapsing "cannot tell" into `null` is what
   * turns a lost acknowledgement into a duplicate.
   */
  private async findPublishedMatch(
    tokens: OAuthTokens,
    igUserId: string,
    caption: string,
    since: Date,
    /**
     * ⚠️ Does an EMPTY first page mean "cannot tell" or "not there"?
     *
     * Only AFTER a write does empty imply something is wrong — we just published
     * to this account, so it should not look empty. BEFORE a write (the worker's
     * pre-flight) an empty listing is the EXPECTED answer, and throwing there made
     * the worker park a post as "may already be live" and never publish it at all.
     */
    emptyIsInconclusive: boolean
  ): Promise<SocialPostResult | null> {
    let cursor: string | undefined;

    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      const listed = await this.listRecentPosts(tokens, igUserId, {
        since,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });

      // `listRecentPosts` swallows Graph errors into an empty page (correct for the
      // insights sweep, fatal here). A degradation is an explicit "cannot tell";
      // and on the FIRST page an empty result is equally inconclusive, because we
      // have just tried to publish to this account — it should not look empty.
      if (listed.degraded) {
        throw new Error(
          `Instagram listing unavailable (${listed.degraded.reason}) — cannot confirm whether the post published`
        );
      }
      if (emptyIsInconclusive && page === 0 && listed.posts.length === 0) {
        throw new Error(
          "Instagram returned no recent media — cannot confirm whether the post published"
        );
      }

      for (const post of listed.posts) {
        if (post.publishedAt.getTime() < since.getTime()) continue;
        if (captionsMatch(post.message ?? "", caption)) {
          return {
            platformPostId: post.platformPostId,
            url: post.permalink ?? `https://www.instagram.com/p/${post.platformPostId}`,
          };
        }
      }

      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }

    return null;
  }

  /**
   * Optional cross-provider hook (see SocialProvider.findExistingPost): used by
   * the publish worker as a PRE-FLIGHT check before it re-runs a publish, so a
   * retry whose predecessor succeeded-but-was-not-recorded adopts that post
   * instead of creating a second one.
   */
  async findExistingPost(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    since: Date
  ): Promise<SocialPostResult | null> {
    // Stories own their idempotency in `publishStory`, via the checkpointed
    // container. This caption-matching pre-flight cannot serve them: `/media`
    // does not list stories, and matching by recency instead would adopt a story
    // posted from the phone or one belonging to another org that shares this IG
    // account. Returning null here is not a gap — it defers to a stronger check.
    if (isStoryFormat(payload.metadata)) return null;
    const igUserId =
      (payload.metadata?.igUserId as string) || (await this.getInstagramBusinessAccountId(tokens));
    // PRE-write: an empty listing means "not published", so publishing must proceed.
    return this.findPublishedMatch(tokens, igUserId, payload.content, since, false);
  }

  /**
   * Publish a carousel (multi-image) post.
   * 1. Upload each image as an individual media container (not published).
   * 2. Create a carousel container referencing all individual containers.
   * 3. Publish the carousel container.
   */
  private async publishCarouselPost(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    igUserId: string
  ): Promise<SocialPostResult> {
    const mediaUrls = payload.mediaUrls!;
    const mediaTypes = payload.mediaTypes ?? [];

    // Step 1: Create individual item containers (children of the carousel)
    // Video children require video_url + media_type=VIDEO and must wait for processing.
    //
    // Bounded-parallel since 2026-09-16 (was strictly one child at a time, so a
    // 10-slide carousel waited out ten create→FINISHED cycles back to back).
    // Safe because a child is only a container — nothing is published until
    // publishContainer below. `childContainerIds` stays in INPUT order whatever
    // order the children finish in, because that array IS the slide order.
    const childContainerIds = await mapInOrderWithConcurrency(
      mediaUrls,
      CAROUSEL_CHILD_CONCURRENCY,
      async (url, i): Promise<string> => {
        const mime = mediaTypes[i] ?? "";
        const isChildVideo = mime.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(url);

        const childParams: Record<string, unknown> = { is_carousel_item: true, access_token: tokens.accessToken };
        if (isChildVideo) {
          childParams["video_url"] = url;
          childParams["media_type"] = "VIDEO";
        } else {
          childParams["image_url"] = url;
        }

        const res = await fetch(
          `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(childParams),
          }
        );

        const data: any = await res.json();
        if (!res.ok) throw new Error(`Instagram carousel item upload failed: ${JSON.stringify(data)}`);
        const childId: string = data.id;

        // Every child container must be FINISHED before the carousel container can
        // be created — images included (not just videos). Use the short image
        // budget for images, the long one for videos. The video budget is the
        // same VIDEO_READY_TIMEOUT_MS the single-video path uses: the old
        // hard-coded 90s is exactly what the 2026-08-07 reel incident proved too
        // short for Instagram's length-scaled transcode.
        await this.waitForMediaReady(
          tokens,
          childId,
          isChildVideo ? VIDEO_READY_TIMEOUT_MS : 30000,
          isChildVideo ? 5000 : 2000,
        );

        return childId;
      }
    );

    // Step 2: Create the carousel container
    const carouselRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "CAROUSEL",
          caption: payload.content,
          children: childContainerIds,
          access_token: tokens.accessToken,
        }),
      }
    );

    const carouselData: any = await carouselRes.json();
    if (!carouselRes.ok) throw new Error(`Instagram carousel container creation failed: ${JSON.stringify(carouselData)}`);

    // The carousel container itself is processed asynchronously too — wait for
    // it to finish before publishing, or media_publish returns subcode 2207027.
    await this.waitForMediaReady(tokens, carouselData.id, 60000, 3000);

    // Step 3: Publish the carousel
    return this.publishContainer(tokens, igUserId, carouselData.id, payload.content);
  }

  /**
   * List top-level comments on a published IG Media. Requires
   * `instagram_manage_comments` — see instagram-comments.ts for the current
   * permission status. `after` is the cursor from a previous page's
   * `nextCursor` (undefined = first page).
   *
   * Connect-path-shaped call (interactive, user-initiated, low frequency) —
   * uses fetchT like getProfile/getAllInstagramAccounts, not the worker's
   * unbounded publish-path fetch.
   */
  async getMediaComments(
    tokens: OAuthTokens,
    mediaId: string,
    after?: string,
    own?: InstagramOwnAccount
  ): Promise<InstagramCommentPage> {
    let { res, data } = await this.fetchMediaCommentsPage(tokens, mediaId, IG_COMMENT_FIELDS, after);

    // Two-rung ladder — see FacebookProvider.getPostComments. Graph does not
    // validate field names on an empty edge, so a renamed field surfaces only on
    // the first media that HAS comments; degrade instead of breaking.
    if (!res.ok && isGraphFieldError(data?.error)) {
      console.error(
        `[Instagram] comment field rejected — retrying with the minimal field set. Update IG_COMMENT_FIELDS:`,
        String(data?.error?.message ?? "")
      );
      ({ res, data } = await this.fetchMediaCommentsPage(tokens, mediaId, IG_COMMENT_FIELDS_MINIMAL, after));
    }

    if (!res.ok) {
      if (isCommentPermissionDeniedError(data?.error)) {
        throw new Error(COMMENT_PERMISSION_DENIED_MESSAGE);
      }
      if (isCommentObjectGoneError(data?.error)) {
        throw new Error(COMMENT_OBJECT_GONE_MESSAGE);
      }
      // The raw body is LOGGED, never thrown: it becomes a TRPCError message on
      // the client, and humanizeError does not recognise Graph JSON as technical,
      // so it would render verbatim in the UI.
      console.error(
        `[Instagram] comment list failed (HTTP ${res.status}):`,
        data === null ? "unreadable response body" : JSON.stringify(data)
      );
      throw new Error(COMMENT_LIST_FAILED_MESSAGE);
    }

    // An OK response we cannot parse is NOT an empty comment list. Returning
    // one would render "No comments yet" for a post that may have hundreds —
    // a displayed value the API never reported.
    if (data === null) {
      console.error(`[Instagram] comment list returned an unreadable body on HTTP ${res.status}`);
      throw new Error(COMMENT_LIST_FAILED_MESSAGE);
    }

    return parseCommentsPage(data, own);
  }

  private async fetchMediaCommentsPage(
    tokens: OAuthTokens,
    mediaId: string,
    fields: string,
    after?: string
  ): Promise<{ res: Response; data: any }> {
    const params = new URLSearchParams({ fields, access_token: tokens.accessToken });
    if (after) params.set("after", after);

    // encodeURIComponent on every interpolated PATH segment — see
    // GRAPH_OBJECT_ID_RE. mediaId is DB-derived today, but encoding here means a
    // future caller cannot turn this into the path-injection the reply endpoint
    // was vulnerable to.
    let res: Response;
    try {
      res = await fetchT(
        `${this.graphBaseUrl}/${this.apiVersion}/${encodeURIComponent(mediaId)}/comments?${params.toString()}`
      );
    } catch (err: any) {
      // Timeout / network failure: a read, so a plain "try again" is correct —
      // but never let the raw AbortError text reach the UI.
      console.error(`[Instagram] comment list request did not complete:`, err?.message ?? err);
      throw new Error(COMMENT_LIST_FAILED_MESSAGE);
    }
    // ⚠️ `.catch(() => null)` like every sibling Graph call in this file: a
    // proxy's HTML 502/504 would otherwise throw a raw SyntaxError PAST the
    // classifiers (the documented failure class from the 2026-08-18 incident —
    // "an unreadable body is indeterminate").
    const data: any = await res.json().catch(() => null);
    return { res, data };
  }

  /**
   * Reply to a comment on media owned by this account. Meta's own
   * authorization model is what stops one connected account's token from
   * replying to a comment on ANOTHER account's media — the token can only
   * act on media the granting account owns — so no extra ownership check of
   * `commentId` against `mediaId` is needed here beyond the org-scoping the
   * router already does on the CHANNEL whose token gets used.
   */
  async replyToComment(tokens: OAuthTokens, commentId: string, message: string): Promise<{ id: string }> {
    // fetchT, not bare fetch: this runs in the WEB process on a user-triggered
    // request, so an unbounded hang would hold the request until nginx 504s.
    // 🔴 encodeURIComponent is LOAD-BEARING here: commentId is client-supplied,
    // and raw interpolation made this an arbitrary authenticated Graph POST.
    // The router's GRAPH_OBJECT_ID_RE check is the first layer; this is the
    // second, so the provider is safe even if called from somewhere else.
    let res: Response;
    try {
      res = await fetchT(`${this.graphBaseUrl}/${this.apiVersion}/${encodeURIComponent(commentId)}/replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, access_token: tokens.accessToken }),
      });
    } catch (err: any) {
      // Timeout / connection reset AFTER dispatch: Instagram may have processed
      // the reply. "Failed" would invite a retry that double-posts it.
      console.error(`[Instagram] comment reply request did not complete:`, err?.message ?? err);
      throw new Error(COMMENT_REPLY_UNCONFIRMED_MESSAGE);
    }
    const data: any = await res.json().catch(() => null);

    if (!res.ok) {
      // A 5xx is indeterminate whatever the body says (the 2026-08-18 lesson) —
      // the reply may exist. Only a 4xx is a definite refusal.
      if (res.status >= 500) {
        console.error(
          `[Instagram] comment reply outcome unknown (HTTP ${res.status}):`,
          data === null ? "unreadable response body" : JSON.stringify(data)
        );
        throw new Error(COMMENT_REPLY_UNCONFIRMED_MESSAGE);
      }
      if (isCommentPermissionDeniedError(data?.error)) {
        throw new Error(COMMENT_PERMISSION_DENIED_MESSAGE);
      }
      if (isCommentObjectGoneError(data?.error)) {
        throw new Error(COMMENT_OBJECT_GONE_MESSAGE);
      }
      console.error(
        `[Instagram] comment reply failed (HTTP ${res.status}):`,
        data === null ? "unreadable response body" : JSON.stringify(data)
      );
      throw new Error(COMMENT_REPLY_FAILED_MESSAGE);
    }

    // ⚠️ An OK response we cannot read leaves the outcome UNKNOWN, and creating
    // a reply is NOT idempotent. Reporting a plain failure here would invite the
    // user to retry and post the reply twice — the same reasoning as
    // AmbiguousPublishError on the publish path, one severity tier down. Say
    // plainly that it may already be live instead.
    if (data === null || !data.id) {
      throw new Error(COMMENT_REPLY_UNCONFIRMED_MESSAGE);
    }

    return { id: data.id };
  }
}
