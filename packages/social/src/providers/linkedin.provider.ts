import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";
import { fetchT } from "../utils/fetch-timeout";
import { headRemoteMedia, fetchByteRange } from "../utils/ranged-media";

const API_VERSION = "202504";

function restHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

export class LinkedInProvider extends SocialProvider {
  readonly platform: SocialPlatform = "LINKEDIN";
  readonly displayName = "LinkedIn";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 3000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 20,
    maxMediaSize: 10 * 1024 * 1024,
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(" "),
      state,
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetchT("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUrl,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(","),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetchT("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const orgId = payload.metadata?.orgId as string | undefined;
    let author: string;

    if (orgId) {
      author = `urn:li:organization:${orgId}`;
    } else {
      const profile = await this.getProfile(tokens);
      author = `urn:li:person:${profile.id}`;
    }

    // Build the post body (Community Management API format)
    const body: Record<string, unknown> = {
      author,
      commentary: payload.content,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
    };

    // Upload and attach media if provided
    if (payload.mediaUrls?.length) {
      const firstUrl = payload.mediaUrls[0]!;
      const isVideo =
        /\.(mp4|mov|avi|mkv|webm)$/i.test(firstUrl) ||
        (payload.mediaTypes?.[0] ?? "").startsWith("video/");

      if (isVideo) {
        const videoUrn = await this.uploadVideo(tokens, author, firstUrl, payload.onProgress);
        body.content = { media: { id: videoUrn } };
      } else if (payload.mediaUrls.length === 1) {
        // Single image
        const imageUrn = await this.uploadImage(tokens, author, firstUrl);
        body.content = { media: { id: imageUrn } };
      } else {
        // Multiple images → multiImage
        const imageUrns: string[] = [];
        for (const url of payload.mediaUrls) {
          const urn = await this.uploadImage(tokens, author, url);
          imageUrns.push(urn);
        }
        body.content = {
          multiImage: {
            images: imageUrns.map((id) => ({ id })),
          },
        };
      }
    }

    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LinkedIn post failed: ${errText}`);
    }

    // Post ID is in the x-restli-id header
    const postId = res.headers.get("x-restli-id") ?? "";
    return {
      platformPostId: postId,
      url: `https://www.linkedin.com/feed/update/${postId}`,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await fetch(
      `https://api.linkedin.com/rest/posts/${encodeURIComponent(platformPostId)}`,
      {
        method: "DELETE",
        headers: restHeaders(tokens.accessToken),
      }
    );
    if (!res.ok) {
      const data = await res.text();
      throw new Error(`LinkedIn delete failed: ${data}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetchT("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`LinkedIn profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.sub,
      name: data.name,
      avatar: data.picture,
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    try {
      const encodedId = encodeURIComponent(platformPostId);
      const res = await fetch(
        `https://api.linkedin.com/rest/socialActions/${encodedId}`,
        { headers: restHeaders(tokens.accessToken) }
      );
      if (!res.ok) {
        console.warn(`[LinkedIn] Analytics failed ${res.status}: ${await res.text()}`);
        return null;
      }
      const data: any = await res.json();
      const likes = data.likesSummary?.totalLikes ?? 0;
      const comments = data.commentsSummary?.totalFirstLevelComments ?? 0;

      // Best-effort org-post share statistics: LinkedIn exposes
      // impressions/clicks/shares ONLY for organization (Page) posts, via
      // organizationalEntityShareStatistics. Member posts have no analytics
      // API — their zeros are a documented platform limitation. NEVER throw
      // here: at-age checkpoint jobs rethrow analytics errors, and a stats
      // hiccup must not fail an otherwise-good likes/comments snapshot.
      let impressions = 0;
      let clicks = 0;
      let shares = 0;
      let reach = 0;
      const orgId = tokens.metadata?.orgId as string | undefined;
      if (orgId) {
        try {
          const orgUrn = encodeURIComponent(`urn:li:organization:${orgId}`);
          // VIDEO posts come back from /rest/posts as urn:li:ugcPost:* and the
          // finder takes those in the separate `ugcPosts` List param — the
          // `shares` param only accepts urn:li:share:* (text/image). Wrong
          // param = 400/empty = zeros for exactly the video case.
          const statParam = platformPostId.startsWith("urn:li:ugcPost:") ? "ugcPosts" : "shares";
          const statsRes = await fetch(
            `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${orgUrn}&${statParam}=List(${encodeURIComponent(platformPostId)})`,
            { headers: restHeaders(tokens.accessToken) }
          );
          if (statsRes.ok) {
            const statsData: any = await statsRes.json();
            const stats = statsData.elements?.[0]?.totalShareStatistics;
            if (stats) {
              impressions = stats.impressionCount ?? 0;
              clicks = stats.clickCount ?? 0;
              shares = stats.shareCount ?? 0;
              reach = stats.uniqueImpressionsCount ?? 0;
            }
          } else {
            console.warn(`[LinkedIn] share statistics failed ${statsRes.status}: ${await statsRes.text().catch(() => "")}`);
          }
        } catch (err: any) {
          console.warn(`[LinkedIn] share statistics fetch errored (keeping zeros): ${err?.message}`);
        }
      }

      return {
        impressions,
        clicks,
        likes,
        shares,
        comments,
        reach,
        // 0–1 fraction, consistent with YT/IG/FB storage (Reports recomputes in SQL)
        engagementRate: impressions > 0 ? (likes + comments + shares) / impressions : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch LinkedIn Pages (organizations) the user administers.
   * Uses Community Management API endpoints.
   */
  async getPages(tokens: OAuthTokens): Promise<Array<{ id: string; name: string; avatar?: string; accessToken: string }>> {
    const pages: Array<{ id: string; name: string; avatar?: string; accessToken: string }> = [];

    const res = await fetchT(
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR",
      { headers: restHeaders(tokens.accessToken) }
    );

    if (!res.ok) {
      console.warn(`[LinkedIn] Failed to fetch organizations: ${res.status} ${await res.text()}`);
      return pages;
    }

    const data: any = await res.json();
    const elements = data.elements ?? [];

    for (const el of elements) {
      // el.organization is like "urn:li:organization:12345"
      const orgUrn = el.organization ?? "";
      const orgId = orgUrn.split(":").pop() ?? "";
      if (!orgId) continue;

      // Fetch org details
      const orgRes = await fetchT(
        `https://api.linkedin.com/rest/organizations/${orgId}`,
        { headers: restHeaders(tokens.accessToken) }
      );

      let name = `Organization ${orgId}`;
      let avatar: string | undefined;

      if (orgRes.ok) {
        const orgData: any = await orgRes.json();
        name = orgData.localizedName ?? name;
        avatar = orgData.logoV2?.["original~"]?.elements?.[0]?.identifiers?.[0]?.identifier;
      }

      pages.push({
        id: orgId,
        name,
        avatar,
        accessToken: tokens.accessToken,
      });
    }

    return pages;
  }

  // ── Media upload helpers (Community Management API) ──

  private async uploadImage(
    tokens: OAuthTokens,
    owner: string,
    mediaUrl: string
  ): Promise<string> {
    // 1. Initialize upload
    const initRes = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify({ initializeUploadRequest: { owner } }),
    });

    const initData: any = await initRes.json();
    if (!initRes.ok) throw new Error(`LinkedIn image init failed: ${JSON.stringify(initData)}`);

    const uploadUrl = initData.value.uploadUrl;
    const imageUrn = initData.value.image;

    // 2. Download the image
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to download media: ${mediaUrl}`);
    const buffer = await mediaRes.arrayBuffer();

    // 3. Upload binary
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(buffer),
    });

    if (!uploadRes.ok) {
      throw new Error(`LinkedIn image upload failed: ${uploadRes.status}`);
    }

    return imageUrn;
  }

  private async uploadVideo(
    tokens: OAuthTokens,
    owner: string,
    mediaUrl: string,
    onProgress?: (percent: number) => void | Promise<void>
  ): Promise<string> {
    // 1. Probe size WITHOUT downloading (Phase 4 large-video streaming) —
    // each LinkedIn upload instruction's byte range is fetched individually
    // below, so worker memory stays O(chunk) instead of O(file).
    const remote = await headRemoteMedia(mediaUrl);

    // 2. Initialize upload
    const initRes = await fetch("https://api.linkedin.com/rest/videos?action=initializeUpload", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify({
        initializeUploadRequest: {
          owner,
          fileSizeBytes: remote.size,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });

    const initData: any = await initRes.json();
    if (!initRes.ok) throw new Error(`LinkedIn video init failed: ${JSON.stringify(initData)}`);

    const videoUrn = initData.value.video;
    const uploadInstructions = initData.value.uploadInstructions ?? [];

    // 3. Upload each chunk — range-fetched one instruction at a time
    for (let i = 0; i < uploadInstructions.length; i++) {
      const instruction = uploadInstructions[i]!;
      const start = instruction.firstByte ?? 0;
      const lastByte = instruction.lastByte ?? remote.size - 1;
      const chunk = await fetchByteRange(mediaUrl, start, lastByte);

      const uploadRes = await fetch(instruction.uploadUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(chunk),
      });

      if (!uploadRes.ok) {
        throw new Error(`LinkedIn video chunk upload failed: ${uploadRes.status}`);
      }
      // Progress per instruction (10→90%): user-visible AND the watchdog's
      // active-upload signal (reportProgress touches target.updatedAt).
      await onProgress?.(10 + Math.round(((i + 1) / uploadInstructions.length) * 80));
    }

    // 4. Finalize upload
    const finalizeRes = await fetch("https://api.linkedin.com/rest/videos?action=finalizeUpload", {
      method: "POST",
      headers: restHeaders(tokens.accessToken),
      body: JSON.stringify({
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken: "",
          uploadedPartIds: uploadInstructions.map((_: any, i: number) => String(i)),
        },
      }),
    });

    if (!finalizeRes.ok) {
      // Throw (mirrors the init/chunk handling) — creating a post against an
      // unfinalized video URN either fails opaquely at /rest/posts or "succeeds"
      // with broken media. The worker's classify machinery turns this into a
      // visible FAILED target with the actionable finalize message.
      const errText = await finalizeRes.text().catch(() => "");
      throw new Error(`LinkedIn video finalize failed (${finalizeRes.status}): ${errText}`);
    }

    return videoUrn;
  }
}
