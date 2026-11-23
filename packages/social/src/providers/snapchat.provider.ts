import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  SocialAnalytics,
  PlatformConstraints,
} from "../abstract/social.types";
import { fetchT } from "../utils/fetch-timeout";
import { AmbiguousPublishError } from "../utils/ambiguous-publish";
import {
  SNAP_API,
  SNAP_MAX_FILE_BYTES,
  SNAP_MAX_PARTS,
  STORY_ID_PREFIX,
  chooseSnapSurface,
  encryptedParts,
  isVideoMedia,
  newSnapEncryption,
  profileUrl,
  readSnapStats,
  snapDescription,
  snapErrorMessage,
  snapRequestOk,
  spotlightUrl,
  type SnapSurface,
} from "../utils/snapchat-publish";
import { scrapeSnapchatSpotlightEngagement } from "@postautomation/social-scrapers";

/**
 * Snapchat provider — Public Profile API (connect, post, delete, insights).
 *
 * Verified against developers.snap.com/marketing-api/Public-Profile-API
 * (GetStarted, Profiles, ProfileAssetManagement, Metrics — read 2026-11-23):
 *   - The OAuth app MUST be created in Ads Manager → Business Dashboard →
 *     Business Details. Snap: "Do not use the Developer Portal to generate the
 *     OAuth App. The Client ID will not work with the Public Profile API."
 *   - Authorize: https://accounts.snapchat.com/login/oauth2/authorize
 *   - Token:     https://accounts.snapchat.com/login/oauth2/access_token
 *     (authorization_code | refresh_token, form-urlencoded; access TTL 1h; the
 *     refresh response returns a new refresh_token — persist it.)
 *   - Scope: snapchat-profile-api. The API is ALLOWLIST-ONLY: until Snap
 *     allowlists the client id every call is 403 AUTHORIZATION_PERMISSION_DENIED.
 *   - Profile: GET /v1/public_profiles/my_profile → public_profile.id is the
 *     channel platformId and the {profile_id} in every posting/stats path.
 *
 * Posting pipeline: see utils/snapchat-publish.ts.
 *
 * DUPLICATE SAFETY (the 2026-08-18 lesson): a Spotlight/Story create is not
 * idempotent, and a Story returns no id to reconcile on. So the media id and a
 * `dispatchedAt` stamp are checkpointed (FATAL, via onCheckpoint) BEFORE the
 * create request. A later attempt that finds `dispatchedAt` set never posts
 * again: a Spotlight is adopted if its listing shows it, otherwise the target is
 * parked as "needs check" (AmbiguousPublishError). A definite refusal clears the
 * stamp so a plain retry is safe.
 */
export class SnapchatProvider extends SocialProvider {
  readonly platform: SocialPlatform = "SNAPCHAT";
  readonly displayName = "Snapchat";
  readonly constraints: PlatformConstraints = {
    // Spotlight description cap (Public Profile API). Longer text is trimmed at
    // a word boundary by snapDescription rather than rejected.
    maxContentLength: 160,
    supportedMediaTypes: ["video/mp4", "image/jpeg", "image/png"],
    maxMediaCount: 1,
    maxMediaSize: SNAP_MAX_FILE_BYTES,
    supportsScheduling: false,
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      // Snapchat scopes are space-delimited (like Google), so join(" ") — do NOT
      // comma-join (that's Meta-specific).
      scope: config.scopes.join(" "),
      state,
    });
    return `https://accounts.snapchat.com/login/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetchT("https://accounts.snapchat.com/login/oauth2/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: "authorization_code",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Snapchat token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetchT("https://accounts.snapchat.com/login/oauth2/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Snapchat token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      // Snapchat returns a NEW refresh token on refresh — persist it, falling back
      // to the incoming one only if the response omits it. Do NOT copy YouTube's
      // reuse-the-old-token behavior, or the channel dies on the next refresh.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    // Resolve the Public Profile the connected user administers. Requires the
    // `snapchat-profile-api` scope AND our client ID to be allowlisted — until
    // then this returns 403 AUTHORIZATION_PERMISSION_DENIED, which surfaces as a
    // clean connect error (never an unguarded throw of raw text).
    const res = await fetchT(`${SNAP_API}/v1/public_profiles/my_profile`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Snapchat profile fetch failed: ${JSON.stringify(data)}`);

    const profile = data.public_profile;
    if (!profile?.id) throw new Error("Snapchat profile fetch failed: no public profile found");

    return {
      id: profile.id,
      name: profile.display_name ?? profile.snap_user_name ?? "Snapchat Profile",
      // snap_user_name has no leading "@"; strip defensively so the UI can
      // safely prepend its own "@" without doubling.
      username: profile.snap_user_name?.replace(/^@+/, "") ?? undefined,
      avatar: profile.logo_urls?.original_logo_url ?? undefined,
    };
  }

  /** The Public Profile id: from the worker (channel.platformId), else my_profile. */
  private async profileId(tokens: OAuthTokens, metadata?: Record<string, unknown>): Promise<string> {
    const known = metadata?.snapProfileId ?? tokens.metadata?.snapProfileId;
    if (typeof known === "string" && known) return known;
    return (await this.getProfile(tokens)).id;
  }

  private async snapFetch(url: string, init: RequestInit, timeoutMs = 60_000) {
    const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    let data: any = null;
    let unreadable = false;
    try {
      data = await res.json();
    } catch {
      unreadable = true;
    }
    return { res, data, unreadable };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const meta = (payload.metadata ?? {}) as Record<string, unknown>;
    const mediaUrl = payload.mediaUrls?.[0];
    if (!mediaUrl) throw new Error("Snapchat posts need one image or video.");
    if ((payload.mediaUrls?.length ?? 0) > 1) {
      throw new Error("Snapchat posts take a single image or video — remove the extra media for this channel.");
    }
    const isVideo = isVideoMedia(payload.mediaTypes?.[0], mediaUrl);
    const surface = chooseSnapSurface({ format: meta.format, isVideo });
    const profileId = await this.profileId(tokens, meta);
    const username = typeof meta.channelUsername === "string" ? meta.channelUsername : undefined;
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const description = snapDescription(payload.content ?? "");

    // ── A previous attempt already sent the create request: never post again.
    const prior = meta.snapPublish as
      | { mediaId?: string; surface?: SnapSurface; dispatchedAt?: string | null }
      | undefined;
    if (prior?.dispatchedAt) {
      if (prior.surface === "SPOTLIGHT") {
        const found = await this.findRecentSpotlight(auth, profileId, prior.dispatchedAt, description);
        if (found) {
          return {
            platformPostId: found,
            url: spotlightUrl(found),
            metadata: { snapSurface: "SPOTLIGHT", snapMediaId: prior.mediaId, adopted: true },
          };
        }
      }
      throw new AmbiguousPublishError(
        `An earlier attempt sent this ${prior.surface === "STORY" ? "Story" : "Spotlight"} to Snapchat and did not ` +
          `get a clear answer. It may already be live — check the Snapchat profile before retrying.`,
        { platform: "SNAPCHAT" }
      );
    }

    // ── 1. Create the media container.
    const enc = newSnapEncryption();
    const created = await this.snapFetch(`${SNAP_API}/v1/public_profiles/${encodeURIComponent(profileId)}/media`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: isVideo ? "VIDEO" : "IMAGE",
        name: `postautomation-${Date.now()}`,
        key: enc.key64,
        iv: enc.iv64,
      }),
    });
    if (!snapRequestOk(created.res, created.data) || !created.data?.media_id) {
      throw new Error(snapErrorMessage(created.data, created.res.status));
    }
    const mediaId: string = created.data.media_id;
    const addPath: string = created.data.add_path;
    const finalizePath: string = created.data.finalize_path ?? addPath;
    if (typeof addPath !== "string" || !addPath.startsWith("/")) {
      throw new Error("Snapchat did not return an upload path for the media.");
    }
    await payload.onProgress?.(5);

    // ── 2. Download → encrypt → upload in ≤32 MB parts (streamed).
    const src = await fetch(mediaUrl, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!src.ok || !src.body) throw new Error(`Could not download the media for Snapchat (HTTP ${src.status}).`);
    const declared = Number(src.headers.get("content-length") ?? 0);
    if (declared > SNAP_MAX_FILE_BYTES) throw new Error("Snapchat accepts files up to 1 GB.");

    let part = 0;
    let sent = 0;
    for await (const chunk of encryptedParts(src.body as unknown as AsyncIterable<Uint8Array>, enc.key, enc.iv)) {
      part += 1;
      sent += chunk.length;
      if (part > SNAP_MAX_PARTS || sent > SNAP_MAX_FILE_BYTES + 16) {
        throw new Error("Snapchat accepts files up to 1 GB.");
      }
      await this.uploadPart(auth, addPath, part, chunk);
      if (declared > 0) await payload.onProgress?.(Math.min(90, 5 + Math.round((sent / declared) * 85)));
    }
    if (part === 0) throw new Error("The media file is empty.");

    const fin = await this.snapFetch(
      `${SNAP_API}${finalizePath}`,
      { method: "POST", headers: auth, body: formOf({ action: "FINALIZE" }) },
      5 * 60_000
    );
    if (!snapRequestOk(fin.res, fin.data)) throw new Error(snapErrorMessage(fin.data, fin.res.status));
    await payload.onProgress?.(92);

    // ── 3. Checkpoint BEFORE the create (fatal if it cannot be stored).
    const dispatchedAt = new Date().toISOString();
    await payload.onCheckpoint?.({ snapPublish: { mediaId, surface, dispatchedAt } });

    // ── 4. Post.
    const path = surface === "SPOTLIGHT" ? "spotlights" : "stories";
    const body =
      surface === "SPOTLIGHT"
        ? {
            media_id: mediaId,
            ...(description ? { description } : {}),
            locale: typeof meta.snapLocale === "string" && meta.snapLocale ? meta.snapLocale : "en_US",
          }
        : { media_id: mediaId };
    let posted: Awaited<ReturnType<SnapchatProvider["snapFetch"]>>;
    try {
      posted = await this.snapFetch(
        `${SNAP_API}/v1/public_profiles/${encodeURIComponent(profileId)}/${path}`,
        { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) },
        120_000
      );
    } catch (err) {
      throw new AmbiguousPublishError(
        `The request to post this ${surface === "STORY" ? "Story" : "Spotlight"} to Snapchat did not complete. ` +
          `It may already be live — check the Snapchat profile before retrying.`,
        { platform: "SNAPCHAT", cause: err }
      );
    }
    const { res, data, unreadable } = posted;

    // Snap is still processing the same media — the original post will finish.
    if (data?.error_code === "MEDIA_POSTING_ALREADY_IN_PROGRESS") {
      throw new AmbiguousPublishError(
        "Snapchat is already posting this media from an earlier attempt. Check the profile in a few minutes.",
        { platform: "SNAPCHAT" }
      );
    }
    if (res.status >= 500 || unreadable) {
      throw new AmbiguousPublishError(
        `Snapchat did not confirm the post (HTTP ${res.status}). It may already be live — check the profile before retrying.`,
        { platform: "SNAPCHAT", cause: new Error(unreadable ? "unreadable response body" : JSON.stringify(data)) }
      );
    }
    if (!snapRequestOk(res, data)) {
      // A definite refusal (validation, permission): nothing was posted, so a
      // retry may start over with fresh media.
      await payload.onCheckpoint?.({ snapPublish: { mediaId, surface, dispatchedAt: null } });
      throw new Error(snapErrorMessage(data, res.status));
    }
    await payload.onProgress?.(100);

    if (surface === "SPOTLIGHT") {
      const id: string | undefined = data?.spotlight_id;
      if (!id) {
        throw new AmbiguousPublishError(
          "Snapchat accepted the Spotlight but returned no id. Check the profile before retrying.",
          { platform: "SNAPCHAT" }
        );
      }
      return {
        platformPostId: id,
        url: spotlightUrl(id),
        // A new Spotlight is SUBMITTED and goes LIVE only after Snap's review.
        metadata: { snapSurface: "SPOTLIGHT", snapMediaId: mediaId, snapStatus: "SUBMITTED" },
      };
    }
    // Stories return no id. The media id stands in (prefixed) and the link goes
    // to the profile, where the Story shows for 24 hours.
    return {
      platformPostId: `${STORY_ID_PREFIX}${mediaId}`,
      url: profileUrl(username),
      metadata: {
        snapSurface: "STORY",
        snapMediaId: mediaId,
        ...(description ? { captionNotPosted: true } : {}),
      },
    };
  }

  /** One multipart ADD with a few retries — re-sending a part number replaces it. */
  private async uploadPart(auth: Record<string, string>, addPath: string, partNumber: number, bytes: Buffer) {
    let lastErr = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await this.snapFetch(
          `${SNAP_API}${addPath}`,
          { method: "POST", headers: auth, body: formOf({ action: "ADD", part_number: String(partNumber) }, bytes) },
          10 * 60_000
        );
        if (snapRequestOk(r.res, r.data)) return;
        lastErr = snapErrorMessage(r.data, r.res.status);
        if (r.res.status < 500 && r.res.status !== 429) break;
      } catch (err: any) {
        lastErr = err?.message ?? String(err);
      }
      if (attempt < 4) await new Promise((res) => setTimeout(res, 1000 * 3 ** (attempt - 1)));
    }
    throw new Error(`Uploading to Snapchat failed on part ${partNumber}: ${lastErr}`);
  }

  /** A Spotlight created at/after `since` with this description, if listed. */
  private async findRecentSpotlight(
    auth: Record<string, string>,
    profileId: string,
    since: string,
    description: string
  ): Promise<string | null> {
    try {
      const r = await this.snapFetch(
        `${SNAP_API}/v1/public_profiles/${encodeURIComponent(profileId)}/spotlights?limit=20`,
        { headers: auth }
      );
      if (!snapRequestOk(r.res, r.data)) return null;
      const floor = Date.parse(since) - 120_000;
      const hits = (Array.isArray(r.data?.spotlights) ? r.data.spotlights : [])
        .map((s: any) => s?.spotlight)
        .filter((s: any) => s?.id && Date.parse(s.created_at ?? "") >= floor)
        .filter((s: any) => !description || (s.caption ?? s.title ?? "").trim() === description.trim());
      return hits.length === 1 ? hits[0].id : null;
    } catch {
      return null;
    }
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    if (platformPostId.startsWith(STORY_ID_PREFIX)) {
      throw new Error("Snapchat Stories can't be deleted through the API — remove it in the Snapchat app.");
    }
    const profileId = await this.profileId(tokens);
    const r = await this.snapFetch(
      `${SNAP_API}/v1/public_profiles/${encodeURIComponent(profileId)}/spotlights/${encodeURIComponent(platformPostId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    if (!snapRequestOk(r.res, r.data)) throw new Error(snapErrorMessage(r.data, r.res.status));
  }

  /**
   * Spotlight stats from the Public Profile API (lifetime). Falls back to the
   * public-page scraper when the API refuses (e.g. before allowlisting). Stories
   * have no id to ask about, so they report nothing.
   */
  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    if (!platformPostId || platformPostId.startsWith(STORY_ID_PREFIX)) return null;
    try {
      const profileId = await this.profileId(tokens);
      const r = await this.snapFetch(
        `${SNAP_API}/v1/public_profiles/${encodeURIComponent(profileId)}/spotlights/${encodeURIComponent(platformPostId)}/stats`,
        { headers: { Authorization: `Bearer ${tokens.accessToken}` } },
        30_000
      );
      if (snapRequestOk(r.res, r.data)) {
        const m = readSnapStats(r.data);
        const pick = (...names: string[]) => names.map((n) => m.get(n)).find((v) => v !== undefined);
        const views = pick("SPOTLIGHT_VIEWS", "VIEWS");
        if (views !== undefined) {
          const reach = pick("SPOTLIGHT_UNIQUES", "VIEWERS");
          const likes = pick("SPOTLIGHT_FAVORITES", "FAVORITES");
          const shares = pick("SPOTLIGHT_SHARES", "SHARES");
          const engaged = (likes ?? 0) + (shares ?? 0);
          return {
            // Snapchat has no impressions metric; views is the honest column.
            impressions: views,
            views,
            reach: reach ?? 0,
            likes: likes ?? 0,
            shares: shares ?? 0,
            comments: 0,
            clicks: 0,
            engagementRate: views > 0 ? engaged / views : 0,
            source: "api",
            likeKind: "likes",
            reachIsDistinct: reach !== undefined,
            metricsAvailable: {
              impressions: false,
              views: true,
              reach: reach !== undefined,
              likes: likes !== undefined,
              shares: shares !== undefined,
              comments: false,
              clicks: false,
            },
          };
        }
      }
    } catch {
      // fall through to the scraper
    }
    return this.scrapedAnalytics(platformPostId);
  }

  /**
   * Spotlight analytics via the public scraper. Fail-open: null on any miss,
   * never a fabricated number. Snapchat's public page shows no likes.
   */
  private async scrapedAnalytics(platformPostId: string): Promise<SocialAnalytics | null> {
    const e = await scrapeSnapchatSpotlightEngagement(platformPostId);
    if (!e || e.views == null) return null;
    const impressions = e.views;
    const comments = e.comments ?? 0;
    const shares = e.shares ?? 0;
    return {
      impressions,
      clicks: 0,
      likes: 0,
      shares,
      comments,
      reach: impressions,
      engagementRate: impressions > 0 ? (comments + shares) / impressions : 0,
      source: "scrape",
      likeKind: "likes",
      reachIsDistinct: false,
      metricsAvailable: { likes: false, clicks: false, reach: false },
    };
  }
}

/** multipart/form-data body; the file part (if any) is named "file". */
function formOf(fields: Record<string, string>, file?: Buffer): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("file", new Blob([new Uint8Array(file)]), "media.enc");
  return fd;
}
