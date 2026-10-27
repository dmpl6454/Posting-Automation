import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";
import { fetchT } from "../utils/fetch-timeout";
import { AmbiguousPublishError, isIndeterminatePublishError } from "../utils/ambiguous-publish";
import { PublishRefusedError } from "../utils/publish-refused";
import { headRemoteMedia, fetchByteRange } from "../utils/ranged-media";
import {
  TIKTOK_CANNOT_POST_CODES,
  TIKTOK_CHECKPOINT_KEY,
  TIKTOK_MAX_VIDEO_BYTES,
  classifyTikTokStatus,
  fitTikTokTitle,
  parseCreatorInfo,
  planTikTokChunks,
  readTikTokCheckpoint,
  readTikTokSettings,
  tiktokContentRange,
  tiktokInteractionFlags,
  tiktokPostUrl,
  validateTikTokSettings,
  type TikTokChunkPlan,
  type TikTokCreatorInfo,
  type TikTokPostSettings,
  type TikTokPublishCheckpoint,
} from "../utils/tiktok-posting";

/**
 * TikTok — Content Posting API, Direct Post (rewritten 2026-10-28).
 *
 * Flow: creator_info/query (fresh, every post) → video/init → checkpoint the
 * publish_id → [FILE_UPLOAD chunks] → status/fetch until done.
 *
 * ⚠️ DUPLICATE SAFETY — read before changing anything here.
 *  - `video/init` with PULL_FROM_URL is the irreversible step: TikTok starts
 *    pulling and posting the moment it accepts it. A request that may have
 *    reached TikTok but whose reply was lost is an AmbiguousPublishError —
 *    never a plain error, because every plain error leads some retry layer to
 *    init AGAIN (the old provider produced up to six copies of one video).
 *  - The publish_id is checkpointed through `onCheckpoint` before anything else
 *    happens. Every later attempt RESUMES that publish with status/fetch and
 *    only inits again once TikTok says it FAILED. That is why a slow publish can
 *    safely end in a plain retryable "still processing" error.
 *  - Success is `error.code === "ok"` — TikTok's success body CARRIES an error
 *    object. The old code treated it as a failure.
 *  - No TikTok body ever reaches an error message: its `log_id` is a digit run
 *    that can contain "401"/"403", which the worker's classifyError substring-
 *    matches and routes into a branch that publishes again. Messages here are
 *    fixed text plus, at most, a sanitized TikTok error CODE or publish id.
 *  - Tests: __tests__/tiktok-publish.test.ts, tiktok-connect.test.ts, and the
 *    worker's tiktok-message-classification.test.ts (which runs every message
 *    below through the worker's real classifier).
 */

const API = "https://open.tiktokapis.com/v2";
const CREATOR_INFO_URL = `${API}/post/publish/creator_info/query/`;
const INIT_URL = `${API}/post/publish/video/init/`;
const STATUS_URL = `${API}/post/publish/status/fetch/`;
const TOKEN_URL = `${API}/oauth/token/`;
const USER_INFO_URL = `${API}/user/info/?fields=open_id,union_id,avatar_url,display_name`;

const CONNECT_TIMEOUT_MS = 25_000;
const INIT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
const CHUNK_PUT_TIMEOUT_MS = 120_000;
const MEDIA_HEAD_TIMEOUT_MS = 30_000;
const MEDIA_RANGE_TIMEOUT_MS = 60_000;

/** status/fetch allows 30 req/min per token; every 5 s leaves room for two posts at once. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** How long one attempt waits on TikTok; a retry resumes from the checkpoint. */
export const TIKTOK_POLL_BUDGET_MS = 8 * 60_000;
const CHUNK_ATTEMPTS = 3;
/** onProgress at least this often while waiting, so the watchdog sees a live target. */
const PROGRESS_HEARTBEAT_MS = 30_000;

const SUPPORTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i;

/** fail_reason values TikTok itself documents as retryable. */
const RETRYABLE_FAIL_REASONS = new Set(["internal", "video_pull_failed"]);

/**
 * Every fixed message this provider throws. Exported so the worker's
 * classification test can run each one through classifyError — the retryable
 * ones must land on the branch named next to them, never on a re-publishing one.
 */
export const TIKTOK_MESSAGES = {
  // ── PublishRefusedError (terminal: nothing was created) ──
  settingsMissing:
    "Choose who can see this TikTok post (privacy) in Content Studio, then publish again. Nothing was sent to TikTok.",
  videoRequired:
    "A TikTok post needs exactly one video (MP4, MOV or WebM). Attach one video and publish again. Nothing was sent to TikTok.",
  reconnect:
    "TikTok didn't allow posting for this account. Reconnect TikTok and allow posting, then publish again. Nothing was posted on TikTok.",
  tooBig: "This video is larger than TikTok's 4 GB limit. Nothing was posted on TikTok.",
  // ── plain, retryable — classifyError: token_expired (refresh + publish again) ──
  /** Raised only before init, or while a checkpoint guarantees the retry RESUMES. */
  tokenExpired: "TikTok access token expired.",
  // ── plain, retryable — classifyError: rate_limit (re-queued with backoff) ──
  rateLimited: "TikTok rate limit reached — the post will be retried shortly.",
  // ── plain, retryable — classifyError: unknown (BullMQ retry) ──
  unreachable: "TikTok couldn't be reached — the post will be tried again. Nothing was posted on TikTok.",
  noPostingOptions:
    "TikTok didn't return the posting options for this account — the post will be tried again. Nothing was posted on TikTok.",
  uploadUnconfirmed:
    "TikTok's reply to the upload request was lost — the post will be tried again. Nothing was posted on TikTok.",
  mediaUnreadable: "The video file couldn't be read from storage for TikTok — the post will be tried again.",
  uploadIncomplete: "The video upload to TikTok didn't finish — the post will be tried again.",
  stillProcessing: "TikTok is still processing this video — it will be checked again.",
  checkpointUnsaved:
    "The TikTok upload couldn't be recorded before sending the video — the post will be tried again. Nothing was posted on TikTok.",
  // ── AmbiguousPublishError (parked for a human check) ──
  initUnconfirmed:
    "TikTok may have accepted this video, but its reply was lost. Check the TikTok account before publishing again — the video may already be posted.",
} as const;

/** A TikTok error/fail code, or "unknown" — never arbitrary text. */
function safeCode(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(v) ? v : "unknown";
}

function isCannotPostCode(code: string): boolean {
  return (TIKTOK_CANNOT_POST_CODES as readonly string[]).includes(code) || code.startsWith("spam_risk");
}

export function tiktokCannotPostMessage(code: string): string {
  return `This TikTok account can't post right now (TikTok limit: ${safeCode(code)}) — try again later. Nothing was posted on TikTok.`;
}

/** The fixed message for a definite init refusal. Exported for the worker classification test. */
export function tiktokInitRefusalMessage(rawCode: string): string {
  const code = safeCode(rawCode);
  if (isCannotPostCode(code)) return tiktokCannotPostMessage(code);
  switch (code) {
    case "privacy_level_option_mismatch":
      return "TikTok rejected the visibility chosen for this post (privacy_level_option_mismatch). Choose a visibility this TikTok account allows in Content Studio, then publish again. Nothing was posted on TikTok.";
    case "invalid_param":
    case "invalid_params":
      return `TikTok rejected this post's settings (${code}). Check the TikTok options in Content Studio, then publish again. Nothing was posted on TikTok.`;
    case "unaudited_client_can_only_post_to_private_accounts":
      return "TikTok only lets this app post to private accounts right now (unaudited_client_can_only_post_to_private_accounts). Nothing was posted on TikTok.";
    default:
      return `TikTok refused this post (${code}). Nothing was posted on TikTok.`;
  }
}

/** The fixed message for a FAILED status. Exported for the worker classification test. */
export function tiktokFailedMessage(rawReason: string): string {
  const reason = safeCode(rawReason);
  if (RETRYABLE_FAIL_REASONS.has(reason)) {
    return `TikTok couldn't finish this video (${reason}) — the post will be tried again.`;
  }
  if (/_check_failed$/.test(reason)) {
    return `TikTok couldn't publish this video (${reason}). Check it meets TikTok's video requirements (MP4, MOV or WebM; 23–60 fps; 360–4096 px per side; up to 10 minutes), then publish again.`;
  }
  if (reason === "auth_removed") {
    return "TikTok couldn't publish this video (auth_removed): the account removed this app's access. Reconnect TikTok, then publish again.";
  }
  if (reason.startsWith("spam_risk")) return `TikTok stopped this post (${reason}). Nothing was posted on TikTok.`;
  return `TikTok couldn't publish this video (${reason}).`;
}

function statusUnknownMessage(code: string, publishId: string): string {
  return (
    `TikTok can no longer report on this video's publish (${code}), so whether it posted can't be confirmed. ` +
    `Check the TikTok account before publishing again. (publish id ${publishId})`
  );
}

/* ───────────────────────────── response reading ───────────────────────────── */

interface TikTokReply {
  status: number;
  /** Raw body text. NEVER put this in a message. */
  text: string;
  json: Record<string, unknown> | null;
  /** TikTok's error code ("ok" on success); null when the body carried none. */
  code: string | null;
  /** HTTP 2xx AND a readable body AND (no `error` OR `error.code === "ok"`). */
  ok: boolean;
}

/**
 * Read a TikTok v2 response as TEXT first, so an HTML 502 cannot throw a
 * SyntaxError out of the provider. Throws only when the body itself could not
 * be read (the connection died mid-reply) — callers treat that as transport.
 */
async function readReply(res: Response): Promise<TikTokReply> {
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  const err = json?.error;
  let code: string | null = null;
  if (typeof err === "string") code = err; // the OAuth token endpoint: {"error":"invalid_grant",...}
  else if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    code = (err as { code: string }).code;
  }
  const httpOk = res.status >= 200 && res.status < 300;
  const ok = httpOk && json !== null && (err === undefined || err === null || code === "ok");
  return { status: res.status, text, json, code, ok };
}

function dataOf(reply: TikTokReply): Record<string, unknown> {
  const d = reply.json?.data;
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

/** Settle with `p` or reject on timeout; the timer never outlives the race. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/* ──────────────────────────────── the provider ────────────────────────────── */

export interface TikTokProviderOptions {
  /** Total time one publish attempt waits on status/fetch (default 8 min). */
  pollBudgetMs?: number;
  /** Gap between status reads (default 5 s). */
  pollIntervalMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** What creator_info/query said, already decided. Shared by publish and Compose's TikTok card. */
export interface TikTokCreatorInfoResult {
  creator: TikTokCreatorInfo | null;
  canPost: boolean;
  /** Fixed text, never TikTok's. Null when the creator can post. */
  reason: string | null;
  /** TikTok's error code (sanitized), "ok", or null when TikTok gave none. */
  code: string | null;
  /** access_token_invalid — refresh the token and ask again. */
  tokenExpired: boolean;
  /** The token lacks video.publish — reconnect. */
  needsReconnect: boolean;
  /** Worth asking again shortly (network, 5xx, rate limit, no options). */
  retryable: boolean;
}

type PollOutcome =
  | { kind: "complete"; postIds: string[] }
  | { kind: "inbox" }
  | { kind: "failed"; reason: string }
  | { kind: "budget" };

/** How a non-ok init reply is to be read. Definite refusals are thrown instead. */
type InitFailure = "unconfirmed" | "fallback";

interface ProgressReporter {
  report(pct: number): Promise<void>;
  /** Re-send the current value now and then, so the watchdog sees a live target. */
  heartbeat(): Promise<void>;
}

export class TikTokProvider extends SocialProvider {
  readonly platform: SocialPlatform = "TIKTOK";
  readonly displayName = "TikTok";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 2200,
    supportedMediaTypes: [...SUPPORTED_VIDEO_TYPES],
    maxMediaCount: 1,
    maxMediaSize: TIKTOK_MAX_VIDEO_BYTES,
  };

  private readonly pollBudgetMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TikTokProviderOptions = {}) {
    super();
    this.pollBudgetMs = opts.pollBudgetMs ?? TIKTOK_POLL_BUDGET_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_key: config.clientId,
      response_type: "code",
      scope: config.scopes.join(","),
      redirect_uri: config.callbackUrl,
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  }

  /* ─────────────────────────────── OAuth ──────────────────────────────────── */

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    return this.tokenRequest(
      new URLSearchParams({
        client_key: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.callbackUrl,
      }),
      "TikTok sign-in"
    );
  }

  /**
   * TikTok ROTATES the refresh token: the new one is returned and must replace
   * the stored one. ⚠️ The message NAMES `invalid_grant` when TikTok said so —
   * the worker's isDefiniteAuthFailure reads that as "the credential is dead,
   * reconnect" instead of retrying. It never carries TikTok's description or
   * log_id.
   */
  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    return this.tokenRequest(
      new URLSearchParams({
        client_key: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      "TikTok token refresh"
    );
  }

  private async tokenRequest(body: URLSearchParams, what: string): Promise<OAuthTokens> {
    let reply: TikTokReply;
    try {
      const res = await fetchT(
        TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
          body,
        },
        CONNECT_TIMEOUT_MS
      );
      reply = await readReply(res);
    } catch {
      throw new Error(`${what} failed: TikTok couldn't be reached.`);
    }
    const d = reply.json ?? {};
    const accessToken = d.access_token;
    if (!reply.ok || typeof accessToken !== "string" || !accessToken) {
      if (reply.status >= 500) throw new Error(`${what} failed (TikTok server error, HTTP ${reply.status}).`);
      const code = reply.code && reply.code !== "ok" ? safeCode(reply.code) : null;
      throw new Error(code ? `${what} failed (${code}).` : `${what} failed: TikTok returned no access token.`);
    }
    const expiresIn = Number(d.expires_in);
    return {
      accessToken,
      refreshToken: typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : undefined,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : undefined,
      scopes:
        typeof d.scope === "string" && d.scope
          ? d.scope
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
    };
  }

  /* ─────────────────────────────── profile ────────────────────────────────── */

  /**
   * The id is the `open_id` (user/info). The @handle comes from creator_info's
   * `creator_username` — user/info's `display_name` is NOT a handle (the
   * channels page used to show "@John Smith"); it stands in only when
   * creator_info could not be read at all. Never returns an empty id.
   */
  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const [creatorRes, userRes] = await Promise.allSettled([
      this.call(CREATOR_INFO_URL, tokens, { method: "POST" }, CONNECT_TIMEOUT_MS),
      this.call(USER_INFO_URL, tokens, { method: "GET" }, CONNECT_TIMEOUT_MS),
    ]);

    if (userRes.status !== "fulfilled" || !userRes.value.ok) {
      throw new Error("TikTok profile could not be read. Try connecting TikTok again.");
    }
    const userRaw = dataOf(userRes.value).user;
    const user = userRaw && typeof userRaw === "object" ? (userRaw as Record<string, unknown>) : {};
    const openId = typeof user.open_id === "string" ? user.open_id.trim() : "";
    if (!openId) throw new Error("TikTok profile could not be read (no account id). Try connecting TikTok again.");
    const displayName = typeof user.display_name === "string" ? user.display_name : "";
    const userAvatar = typeof user.avatar_url === "string" && /^https:\/\//.test(user.avatar_url) ? user.avatar_url : undefined;

    if (creatorRes.status !== "fulfilled" || !creatorRes.value.ok) {
      return { id: openId, name: displayName, username: displayName || undefined, avatar: userAvatar };
    }
    const c = dataOf(creatorRes.value);
    const nickname = typeof c.creator_nickname === "string" ? c.creator_nickname : "";
    const username = typeof c.creator_username === "string" && c.creator_username ? c.creator_username : undefined;
    const creatorAvatar =
      typeof c.creator_avatar_url === "string" && /^https:\/\//.test(c.creator_avatar_url) ? c.creator_avatar_url : undefined;
    return { id: openId, name: nickname || displayName, username, avatar: creatorAvatar ?? userAvatar };
  }

  /**
   * creator_info/query — what this creator allows RIGHT NOW. Never throws; the
   * result says what to do. TikTok sends the can't-post codes with HTTP 200
   * (intentionally), so the code decides, not the HTTP status.
   */
  async fetchCreatorInfo(tokens: OAuthTokens): Promise<TikTokCreatorInfoResult> {
    const base = { creator: null, canPost: false, tokenExpired: false, needsReconnect: false, retryable: false };
    let reply: TikTokReply;
    try {
      reply = await this.call(CREATOR_INFO_URL, tokens, { method: "POST" }, CONNECT_TIMEOUT_MS);
    } catch {
      return { ...base, reason: TIKTOK_MESSAGES.unreachable, code: null, retryable: true };
    }
    const code = reply.code === null ? null : safeCode(reply.code);
    if (reply.ok) {
      const creator = parseCreatorInfo(dataOf(reply));
      if (!creator) return { ...base, reason: TIKTOK_MESSAGES.noPostingOptions, code, retryable: true };
      return { ...base, creator, canPost: true, reason: null, code };
    }
    if (code && isCannotPostCode(code)) return { ...base, reason: tiktokCannotPostMessage(code), code };
    if (code === "access_token_invalid") return { ...base, reason: TIKTOK_MESSAGES.tokenExpired, code, tokenExpired: true };
    if (code === "scope_not_authorized") return { ...base, reason: TIKTOK_MESSAGES.reconnect, code, needsReconnect: true };
    if (code === "rate_limit_exceeded" || reply.status === 429) {
      return { ...base, reason: TIKTOK_MESSAGES.rateLimited, code, retryable: true };
    }
    if (reply.status >= 500 || reply.json === null || code === null) {
      return { ...base, reason: TIKTOK_MESSAGES.unreachable, code, retryable: true };
    }
    return { ...base, reason: tiktokInitRefusalMessage(code), code };
  }

  /* ─────────────────────────────── publish ────────────────────────────────── */

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const metadata = (payload.metadata ?? {}) as Record<string, unknown>;
    const settings = readTikTokSettings(metadata);
    const progress = this.progressReporter(payload.onProgress);
    const channelUsername = typeof metadata.channelUsername === "string" ? metadata.channelUsername : null;

    // (c) RESUME FIRST. A checkpoint means an earlier attempt's init succeeded,
    // so the video may be posting or posted — its fate is settled before any
    // refusal below ("Nothing was sent to TikTok" would be false here).
    const checkpoint = readTikTokCheckpoint(metadata);
    if (checkpoint) {
      const outcome = await this.poll(tokens, checkpoint.publishId, { immediate: true, progress, size: null, base: 10 });
      // FAILED: TikTok says nothing went live, so a NEW init is allowed (below).
      if (outcome.kind !== "failed") return this.finish(outcome, checkpoint.publishId, settings, channelUsername, progress);
    }

    // (a) No defaults: TikTok's guidelines forbid guessing a privacy level.
    if (!settings) {
      throw new PublishRefusedError(TIKTOK_MESSAGES.settingsMissing, { reason: "rejected", platform: "TIKTOK" });
    }
    // (b) Exactly one video.
    const videoUrl = this.singleVideoUrl(payload);
    if (!videoUrl) {
      throw new PublishRefusedError(TIKTOK_MESSAGES.videoRequired, { reason: "rejected", platform: "TIKTOK" });
    }

    // (d) Fresh creator_info before every post (TikTok requires it).
    const info = await this.fetchCreatorInfo(tokens);
    if (!info.canPost || !info.creator) {
      if (info.tokenExpired) throw new Error(TIKTOK_MESSAGES.tokenExpired);
      if (info.needsReconnect) {
        throw new PublishRefusedError(TIKTOK_MESSAGES.reconnect, { reason: "credentials", platform: "TIKTOK" });
      }
      if (info.retryable) throw new Error(info.reason ?? TIKTOK_MESSAGES.unreachable);
      throw new PublishRefusedError(info.reason ?? tiktokInitRefusalMessage(info.code ?? "unknown"), {
        reason: "rejected",
        platform: "TIKTOK",
      });
    }
    const durationRaw = Number(metadata.videoDurationSec);
    const problem = validateTikTokSettings(settings, info.creator, {
      videoDurationSec: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null,
    });
    if (problem) throw new PublishRefusedError(problem, { reason: "rejected", platform: "TIKTOK" });
    await progress.report(5);

    const postInfo: Record<string, unknown> = {
      ...(payload.content ? { title: fitTikTokTitle(payload.content) } : {}),
      privacy_level: settings.privacyLevel,
      ...tiktokInteractionFlags(settings),
      brand_content_toggle: settings.brandContent,
      brand_organic_toggle: settings.brandOrganic,
      is_aigc: settings.isAigc,
    };
    const username = info.creator.username || channelUsername;

    // (e) PULL_FROM_URL first — TikTok: don't FILE_UPLOAD what is already on your servers.
    const pull = await this.initPull(tokens, postInfo, videoUrl);
    if (pull.kind === "fallback") {
      // (f) url_ownership_unverified is refused before any write — a streamed FILE_UPLOAD is safe.
      return this.publishByUpload(tokens, payload, postInfo, videoUrl, settings, username, progress);
    }

    // (g) TikTok is already pulling: the checkpoint is the only way a retry finds this publish.
    await this.savePullCheckpoint(payload, pull.publishId);
    await progress.report(10);
    const outcome = await this.poll(tokens, pull.publishId, { immediate: false, progress, size: null, base: 10 });
    return this.finish(outcome, pull.publishId, settings, username, progress);
  }

  /** TikTok has no API to look a post up; the resume lives in publishPost, from the checkpoint. */
  async findExistingPost(_tokens: OAuthTokens, _payload: SocialPostPayload, _since: Date): Promise<SocialPostResult | null> {
    return null;
  }

  async deletePost(_tokens: OAuthTokens, _platformPostId: string): Promise<void> {
    // TikTok Content Posting API does not provide a delete endpoint.
    throw new Error(
      "TikTok API does not support deleting posts programmatically. " +
        "Users must delete videos directly through the TikTok app."
    );
  }

  /* ─────────────────────────────── internals ──────────────────────────────── */

  private async call(url: string, tokens: OAuthTokens, init: RequestInit, timeoutMs: number): Promise<TikTokReply> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return readReply(res);
  }

  private singleVideoUrl(payload: SocialPostPayload): string | null {
    const urls = payload.mediaUrls ?? [];
    if (urls.length !== 1) return null;
    const url = urls[0];
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
    const type = (payload.mediaTypes?.[0] ?? "").toLowerCase();
    return type.startsWith("video/") || VIDEO_EXT_RE.test(url) ? url : null;
  }

  /** PULL_FROM_URL init: the publish_id, or "fallback" for url_ownership_unverified. */
  private async initPull(
    tokens: OAuthTokens,
    postInfo: Record<string, unknown>,
    videoUrl: string
  ): Promise<{ kind: "published"; publishId: string } | { kind: "fallback" }> {
    let reply: TikTokReply;
    try {
      reply = await this.call(
        INIT_URL,
        tokens,
        { method: "POST", body: JSON.stringify({ post_info: postInfo, source_info: { source: "PULL_FROM_URL", video_url: videoUrl } }) },
        INIT_TIMEOUT_MS
      );
    } catch (err) {
      // A request that provably never left (DNS, refused) is safe to retry; one
      // that may have reached TikTok is not — TikTok may be pulling it now.
      if (!isIndeterminatePublishError(err)) throw new Error(TIKTOK_MESSAGES.unreachable);
      throw new AmbiguousPublishError(TIKTOK_MESSAGES.initUnconfirmed, { platform: "TIKTOK" });
    }
    if (reply.ok) {
      const publishId = this.trackablePublishId(dataOf(reply).publish_id);
      // TikTok said ok but gave nothing we can track: it may be posting.
      if (!publishId) throw new AmbiguousPublishError(TIKTOK_MESSAGES.initUnconfirmed, { platform: "TIKTOK" });
      return { kind: "published", publishId };
    }
    const failure = this.readInitFailure(reply);
    if (failure === "fallback") return { kind: "fallback" };
    throw new AmbiguousPublishError(TIKTOK_MESSAGES.initUnconfirmed, { platform: "TIKTOK" });
  }

  /**
   * A non-ok init reply. THROWS the definite refusals (a readable TikTok code on
   * a 2xx/4xx, or a bare 4xx — TikTok created nothing); returns "unconfirmed"
   * when TikTok may have accepted it (5xx, an unreadable 2xx, anything odd), and
   * "fallback" for url_ownership_unverified.
   */
  private readInitFailure(reply: TikTokReply): InitFailure {
    const is2xx = reply.status >= 200 && reply.status < 300;
    const is4xx = reply.status >= 400 && reply.status < 500;
    if (!is2xx && !is4xx) return "unconfirmed";
    const code = reply.json === null || reply.code === null ? null : safeCode(reply.code);
    if (code === null) {
      if (is2xx) return "unconfirmed";
      if (reply.status === 429) throw new Error(TIKTOK_MESSAGES.rateLimited);
      if (reply.status === 401) throw new Error(TIKTOK_MESSAGES.tokenExpired);
      if (reply.status === 408) throw new Error(TIKTOK_MESSAGES.unreachable);
      throw new PublishRefusedError(tiktokInitRefusalMessage("unknown"), { reason: "rejected", platform: "TIKTOK" });
    }
    if (code === "url_ownership_unverified") return "fallback";
    if (code === "rate_limit_exceeded") throw new Error(TIKTOK_MESSAGES.rateLimited);
    if (code === "access_token_invalid") throw new Error(TIKTOK_MESSAGES.tokenExpired);
    if (code === "scope_not_authorized") {
      throw new PublishRefusedError(TIKTOK_MESSAGES.reconnect, { reason: "credentials", platform: "TIKTOK" });
    }
    throw new PublishRefusedError(tiktokInitRefusalMessage(code), { reason: "rejected", platform: "TIKTOK" });
  }

  /** The id, only if readTikTokCheckpoint will accept it back — an id it drops could never be resumed. */
  private trackablePublishId(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const probe = readTikTokCheckpoint({
      [TIKTOK_CHECKPOINT_KEY]: { publishId: v, createdAt: new Date().toISOString(), source: "PULL_FROM_URL" },
    });
    return probe ? v : null;
  }

  /** (g) for PULL_FROM_URL: TikTok is already pulling, so a lost checkpoint is ambiguous. */
  private async savePullCheckpoint(payload: SocialPostPayload, publishId: string): Promise<void> {
    const cp: TikTokPublishCheckpoint = { publishId, createdAt: new Date().toISOString(), source: "PULL_FROM_URL" };
    try {
      await payload.onCheckpoint?.({ [TIKTOK_CHECKPOINT_KEY]: cp });
    } catch (err) {
      throw new AmbiguousPublishError(
        "TikTok accepted this video, but its publish id could not be saved, so a retry could not find it. " +
          `Check the TikTok account before publishing again — the video may already be posted. (publish id ${publishId})`,
        { platform: "TIKTOK", cause: err }
      );
    }
  }

  /** Drop the checkpoint when TikTok provably cannot post that publish (an unfinished upload). Best-effort. */
  private async clearCheckpoint(payload: SocialPostPayload): Promise<void> {
    try {
      await payload.onCheckpoint?.({ [TIKTOK_CHECKPOINT_KEY]: null });
    } catch {
      // Keeping the old checkpoint only makes the next attempt wait on a dead
      // upload until TikTok marks it FAILED — slow, never a duplicate.
    }
  }

  private failedError(reason: string): Error {
    const msg = tiktokFailedMessage(reason);
    // A retryable reason: the next attempt resumes, reads FAILED and inits again.
    if (RETRYABLE_FAIL_REASONS.has(reason)) return new Error(msg);
    return new PublishRefusedError(msg, { reason: reason === "auth_removed" ? "credentials" : "rejected", platform: "TIKTOK" });
  }

  private async finish(
    outcome: PollOutcome,
    publishId: string,
    settings: TikTokPostSettings | null,
    username: string | null,
    progress: ProgressReporter
  ): Promise<SocialPostResult> {
    // Safe as a plain retryable error: the checkpoint makes the retry RESUME this publish.
    if (outcome.kind === "budget") throw new Error(TIKTOK_MESSAGES.stillProcessing);
    if (outcome.kind === "failed") throw this.failedError(outcome.reason);
    const postId = outcome.kind === "complete" ? outcome.postIds[0] ?? null : null;
    await progress.report(100);
    return {
      platformPostId: postId ?? publishId,
      // A private post (or one still in moderation) has no public id: link the profile.
      url: tiktokPostUrl(username, postId) ?? "",
      metadata: {
        publishId,
        postId,
        privacyLevel: settings?.privacyLevel ?? null,
        status: outcome.kind === "complete" ? "PUBLISH_COMPLETE" : "SEND_TO_USER_INBOX",
        ...(outcome.kind === "inbox"
          ? { note: "TikTok sent this video to the creator's TikTok inbox; it goes live once they finish posting it in the TikTok app." }
          : {}),
      },
    };
  }

  /**
   * (h) status/fetch until a final state or the budget runs out.
   *
   * A read that fails — network, 5xx, rate limit, an unreadable body, a status
   * we don't know — keeps polling: the checkpoint already guarantees a retry
   * resumes this publish instead of posting again, so none of these is
   * ambiguous. Only a definite answer that TikTok can no longer tell us about
   * this publish (invalid_publish_id and the like) is.
   */
  private async poll(
    tokens: OAuthTokens,
    publishId: string,
    opts: { immediate: boolean; progress: ProgressReporter; size: number | null; base: number }
  ): Promise<PollOutcome> {
    const maxReads = Math.max(1, Math.floor(this.pollBudgetMs / this.pollIntervalMs));
    const deadline = Date.now() + this.pollBudgetMs;
    for (let i = 0; i < maxReads; i++) {
      if (i > 0 || !opts.immediate) await this.sleep(this.pollIntervalMs);
      if (i > 0 && Date.now() > deadline) break;

      let reply: TikTokReply;
      try {
        reply = await this.call(STATUS_URL, tokens, { method: "POST", body: JSON.stringify({ publish_id: publishId }) }, STATUS_TIMEOUT_MS);
      } catch {
        await opts.progress.heartbeat();
        continue;
      }

      if (!reply.ok) {
        const code = reply.json === null || reply.code === null ? null : safeCode(reply.code);
        if (code === "access_token_invalid") throw new Error(TIKTOK_MESSAGES.tokenExpired); // the refreshed retry resumes
        const definite = code !== null && reply.status < 500 && code !== "rate_limit_exceeded" && code !== "internal_error";
        if (definite) throw new AmbiguousPublishError(statusUnknownMessage(code, publishId), { platform: "TIKTOK" });
        await opts.progress.heartbeat();
        continue;
      }

      const state = classifyTikTokStatus(reply.text);
      if (state.state === "complete") return { kind: "complete", postIds: state.postIds };
      if (state.state === "inbox") return { kind: "inbox" };
      if (state.state === "failed") return { kind: "failed", reason: safeCode(state.failReason) };
      const d = dataOf(reply);
      const moved = Number(d.downloaded_bytes ?? d.uploaded_bytes);
      if (opts.size && Number.isFinite(moved) && moved > 0) {
        await opts.progress.report(opts.base + Math.floor((Math.min(moved, opts.size) / opts.size) * (90 - opts.base)));
      } else {
        await opts.progress.heartbeat();
      }
    }
    return { kind: "budget" };
  }

  /* ─────────────────────────────── FILE_UPLOAD ────────────────────────────── */

  private async publishByUpload(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    postInfo: Record<string, unknown>,
    videoUrl: string,
    settings: TikTokPostSettings,
    username: string | null,
    progress: ProgressReporter
  ): Promise<SocialPostResult> {
    // Size + type WITHOUT downloading the video.
    let size: number;
    let headType: string;
    try {
      const head = await withTimeout(headRemoteMedia(videoUrl), MEDIA_HEAD_TIMEOUT_MS);
      size = head.size;
      headType = head.contentType;
    } catch {
      throw new Error(TIKTOK_MESSAGES.mediaUnreadable);
    }
    let plan: TikTokChunkPlan;
    try {
      plan = planTikTokChunks(size);
    } catch {
      throw new PublishRefusedError(TIKTOK_MESSAGES.tooBig, { reason: "rejected", platform: "TIKTOK" });
    }
    const contentType = this.chunkContentType(payload.mediaTypes?.[0], headType, videoUrl);

    // FILE_UPLOAD init only opens an upload task: TikTok posts nothing until
    // every chunk has arrived, and the upload_url exists only in this reply. A
    // lost reply therefore cannot become a post — retryable, not ambiguous.
    let reply: TikTokReply;
    try {
      reply = await this.call(
        INIT_URL,
        tokens,
        {
          method: "POST",
          body: JSON.stringify({
            post_info: postInfo,
            source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunkCount },
          }),
        },
        INIT_TIMEOUT_MS
      );
    } catch (err) {
      throw new Error(isIndeterminatePublishError(err) ? TIKTOK_MESSAGES.uploadUnconfirmed : TIKTOK_MESSAGES.unreachable);
    }
    if (!reply.ok) {
      const failure = this.readInitFailure(reply);
      if (failure === "fallback") {
        throw new PublishRefusedError(tiktokInitRefusalMessage("url_ownership_unverified"), { reason: "rejected", platform: "TIKTOK" });
      }
      throw new Error(TIKTOK_MESSAGES.uploadUnconfirmed);
    }
    const d = dataOf(reply);
    const publishId = this.trackablePublishId(d.publish_id);
    const uploadUrl = typeof d.upload_url === "string" && /^https:\/\//.test(d.upload_url) ? d.upload_url : null;
    if (!publishId || !uploadUrl) throw new Error(TIKTOK_MESSAGES.uploadUnconfirmed);

    // (g) Checkpoint before the first chunk: once the last chunk lands TikTok
    // posts, and a crash after that must resume, not upload again. Nothing has
    // been sent yet, so failing to record it is safe to abort.
    try {
      const cp: TikTokPublishCheckpoint = { publishId, createdAt: new Date().toISOString(), source: "FILE_UPLOAD" };
      await payload.onCheckpoint?.({ [TIKTOK_CHECKPOINT_KEY]: cp });
    } catch {
      throw new Error(TIKTOK_MESSAGES.checkpointUnsaved);
    }
    await progress.report(10);

    await this.uploadChunks(payload, videoUrl, uploadUrl, plan, contentType, progress);

    const outcome = await this.poll(tokens, publishId, { immediate: false, progress, size: null, base: 80 });
    return this.finish(outcome, publishId, settings, username, progress);
  }

  private chunkContentType(declared: string | undefined, headType: string, url: string): string {
    const pick = (t: string | undefined) => {
      const v = (t ?? "").split(";")[0]!.trim().toLowerCase();
      return (SUPPORTED_VIDEO_TYPES as readonly string[]).includes(v) ? v : null;
    };
    const fromExt = /\.mov(?:[?#]|$)/i.test(url) ? "video/quicktime" : /\.webm(?:[?#]|$)/i.test(url) ? "video/webm" : null;
    return pick(declared) ?? pick(headType) ?? fromExt ?? "video/mp4";
  }

  /**
   * PUT each chunk in order, one chunk in memory at a time (read with a Range
   * request just before its PUT — the video is never downloaded whole). A chunk
   * is retried up to 3 times on a transport error, 5xx or 429; any other answer
   * (400, 403 expired upload_url, 404, 416) ends the upload.
   *
   * When the upload cannot finish:
   *  - a NON-final chunk failed ⇒ the final chunk never went out, so TikTok can
   *    never post this publish: the checkpoint is cleared and the retry starts a
   *    fresh upload;
   *  - the FINAL chunk failed in a way TikTok may still have received it
   *    (network, 5xx, 416) ⇒ the checkpoint stays, and the retry checks it.
   */
  private async uploadChunks(
    payload: SocialPostPayload,
    videoUrl: string,
    uploadUrl: string,
    plan: TikTokChunkPlan,
    contentType: string,
    progress: ProgressReporter
  ): Promise<void> {
    const last = plan.ranges.length - 1;
    for (let i = 0; i <= last; i++) {
      const range = plan.ranges[i]!;
      let mayHaveLanded = false;
      let done = false;

      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS && !done; attempt++) {
        if (attempt > 1) await this.sleep(2_000 * (attempt - 1));
        let bytes: Buffer;
        try {
          bytes = await withTimeout(fetchByteRange(videoUrl, range.start, range.end), MEDIA_RANGE_TIMEOUT_MS);
        } catch {
          continue; // never sent — read it again
        }
        let status: number;
        try {
          const res = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(bytes.length),
              "Content-Range": tiktokContentRange(range, plan.videoSize),
            },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(CHUNK_PUT_TIMEOUT_MS),
          });
          status = res.status;
          await res.body?.cancel().catch(() => undefined);
        } catch (err) {
          if (isIndeterminatePublishError(err)) mayHaveLanded = true;
          continue;
        }
        if (status === 200 || status === 201 || status === 206) {
          done = true;
        } else if (status >= 500 || status === 429) {
          if (status >= 500) mayHaveLanded = true;
        } else {
          // TikTok's own progress differs from ours: it may already hold this chunk.
          if (status === 416) mayHaveLanded = true;
          break;
        }
      }

      if (!done) {
        if (i !== last || !mayHaveLanded) await this.clearCheckpoint(payload);
        throw new Error(TIKTOK_MESSAGES.uploadIncomplete);
      }
      await progress.report(10 + Math.floor(((range.end + 1) / plan.videoSize) * 70));
    }
  }

  /* ─────────────────────────────── progress ───────────────────────────────── */

  private progressReporter(onProgress: SocialPostPayload["onProgress"]): ProgressReporter {
    let last = 0;
    let lastAt = 0;
    const emit = async (pct: number) => {
      last = pct;
      lastAt = Date.now();
      try {
        await onProgress?.(pct);
      } catch {
        // progress is cosmetic; it must never fail a publish
      }
    };
    return {
      report: async (pct: number) => {
        const v = Math.max(0, Math.min(100, Math.round(pct)));
        if (v > last) await emit(v);
      },
      heartbeat: async () => {
        if (last > 0 && Date.now() - lastAt >= PROGRESS_HEARTBEAT_MS) await emit(last);
      },
    };
  }
}
